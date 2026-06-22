/**
 * winInputChannel.ts — a PERSISTENT input channel for the windows-native driver.
 *
 * WHY THIS EXISTS (input-latency fix): the old path ran a full
 * `pebble emu-button …` process for EVERY button press — each press paid a fresh
 * bundled-python interpreter startup + pebble-tool init + websocket connect to
 * pypkjs (300–700ms on Windows), so the emulator felt sluggish and laggy.
 *
 * Instead we keep ONE long-lived python helper (pb-input-helper.py) connected to
 * the running emulator's pypkjs websocket and feed it one-line commands over
 * stdin (`click select`, `hold up`, `release`, `tap x+`). Sending a press is then
 * a pipe write (~0ms) rather than a process spawn. The helper sends the SAME
 * `QemuButton`/`QemuTap` relay packet `pebble emu-button` would, so behavior is
 * identical — only the latency changes.
 *
 * The channel is keyed on the pypkjs port (read from the emulator state file): a
 * reboot/auto-relaunch assigns a new port, which `ensure()` detects and respawns
 * the helper against. If anything fails, callers fall back to the per-press CLI.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** Paths needed to launch the helper: the bundled python and the deployed script. */
export interface InputHelperPaths {
  pythonExe: string;
  helperPath: string;
}

/** Default timeout (ms) for a framebuffer screenshot before the channel gives up
 * and the caller falls back to the canvas grab. Sized comfortably above the
 * helper's own 8s grab watchdog so the helper's `ERR timed out` wins the race
 * (a clean failure) rather than this outer cutoff firing first. */
const SCREENSHOT_TIMEOUT_MS = 10_000;

/** Allowed characters for a timeline pin id. The helper parses the id as a single
 * whitespace-delimited token, so spaces/control chars would break parsing (and a
 * CR/LF would be a command-injection vector); restrict to a safe slug charset. */
const PIN_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Minimal child surface the channel needs (injectable for tests). */
export interface InputChild {
  /** Write a line (already newline-terminated) to the helper's stdin. */
  stdinWrite(line: string): void;
  /** Force-terminate the helper. */
  kill(): void;
  /** Whether the helper is still running. */
  alive(): boolean;
  /** Subscribe to the helper's stdout, delivered as whole newline-terminated
   * lines. Used ONLY by the framebuffer screenshot path to resolve `OK`/`ERR`
   * acks; the input path never reads stdout (it stays fire-and-forget). Optional
   * so existing test fakes that only drive input need not implement it. */
  onLine?(cb: (line: string) => void): void;
}

export interface BundledInputChannelDeps {
  helper: InputHelperPaths;
  /** Current pypkjs port from the emulator state file, or null if not booted. */
  readPort: () => number | null;
  /** Spawn the helper child. Defaults to a real detached-stdin node spawn. */
  spawnChild?: (pythonExe: string, args: string[]) => InputChild;
}

function defaultSpawnChild(pythonExe: string, args: string[]): InputChild {
  // windowsHide so the helper never flashes a console; stdin piped. stdout is
  // piped (not ignored) so the framebuffer screenshot path can read `OK`/`ERR`
  // acks — input remains fire-and-forget regardless. stderr stays ignored.
  const c = nodeSpawn(pythonExe, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let dead = false;
  c.on("error", () => { dead = true; });
  c.on("exit", () => { dead = true; });
  return {
    stdinWrite: (line) => { c.stdin?.write(line); },
    kill: () => { try { c.kill(); } catch { /* already gone */ } },
    alive: () => !dead && c.exitCode === null && !c.killed,
    onLine: (cb) => {
      let buf = "";
      c.stdout?.setEncoding("utf8");
      c.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          cb(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      });
    },
  };
}

export class BundledInputChannel {
  private child: InputChild | null = null;
  private port: number | null = null;
  private readonly spawnChild: (pythonExe: string, args: string[]) => InputChild;
  /** Resolver for an in-flight ack request (screenshot/pin/unpin). The helper
   * emits exactly one OK/ERR line per such command, and they can't fire
   * concurrently, so a single slot suffices. */
  private pendingAck: ((ok: boolean) => void) | null = null;

  constructor(private readonly deps: BundledInputChannelDeps) {
    this.spawnChild = deps.spawnChild ?? defaultSpawnChild;
  }

  /** Ensure a live helper exists for the CURRENT pypkjs port; (re)spawn if needed. */
  private ensure(): boolean {
    const port = this.deps.readPort();
    if (port == null) return false; // not booted yet → caller falls back to CLI
    if (this.child && this.child.alive() && this.port === port) return true;
    // Port changed (reboot) or the helper died — replace it.
    this.stop();
    this.child = this.spawnChild(this.deps.helper.pythonExe, [this.deps.helper.helperPath, String(port)]);
    this.port = port;
    // Wire stdout acks for the framebuffer screenshot path. The input path never
    // reads stdout, so this never affects button/tap latency. The `ready` line
    // and any stray output are ignored; only `OK`/`ERR` resolve a pending shot.
    this.child.onLine?.((line) => {
      const tok = line.trim().split(/\s+/, 1)[0];
      if (tok === "OK" || tok === "ERR") this.resolveAck(tok === "OK");
    });
    return true;
  }

  /** Resolve the in-flight ack request (if any) and clear the slot. */
  private resolveAck(ok: boolean): void {
    const r = this.pendingAck;
    this.pendingAck = null;
    if (r) r(ok);
  }

  /**
   * Take a BACKLIGHT-FREE framebuffer screenshot via the persistent helper,
   * writing a PNG to `outPath`. Resolves true when the helper acks `OK`, false on
   * `ERR`, timeout, or an unavailable channel (caller falls back to the VNC-canvas
   * grab). Robust by design: any failure resolves false rather than throwing.
   *
   * NOTE: the underlying framebuffer grab is UNVERIFIED LIVE — see winHelpers.ts.
   */
  screenshot(outPath: string, timeoutMs = SCREENSHOT_TIMEOUT_MS): Promise<boolean> {
    // Path may contain spaces; the helper takes everything after the verb as the path.
    return this.awaitAck(`screenshot ${outPath}`, timeoutMs);
  }

  /** Default ack timeout (ms) for pin insert/delete. */
  private static readonly ACK_TIMEOUT_MS = 8_000;

  /** Write one command and resolve on the helper's OK/ERR ack (false on timeout,
   * broken pipe, busy slot, or an unavailable/stdout-less channel). */
  private awaitAck(line: string, timeoutMs: number): Promise<boolean> {
    // The helper reads ONE command per stdin line, so an embedded CR/LF would let
    // a caller's argument inject a second command. Refuse such lines outright.
    if (/[\r\n]/.test(line)) return Promise.resolve(false);
    if (!this.ensure() || !this.child || !this.child.onLine) return Promise.resolve(false);
    if (this.pendingAck) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        if (this.pendingAck === settle) this.pendingAck = null;
        finish(false);
      }, timeoutMs);
      const settle = (ok: boolean): void => finish(ok);
      this.pendingAck = settle;
      try {
        this.child!.stdinWrite(line + "\n");
      } catch {
        this.child = null;
        this.port = null;
        if (this.pendingAck === settle) this.pendingAck = null;
        finish(false);
      }
    });
  }

  /** Insert a timeline pin (id, absolute unix time, title) via the helper. The id
   * is parsed as a single whitespace-delimited token by the helper, so it is
   * constrained to a safe charset; the title may contain spaces but no control
   * chars (defense-in-depth — awaitAck also rejects CR/LF). Invalid input → false. */
  insertPin(id: string, unixTime: number, title: string, timeoutMs = BundledInputChannel.ACK_TIMEOUT_MS): Promise<boolean> {
    if (!PIN_ID_RE.test(id) || !Number.isFinite(unixTime) || /[\x00-\x1f]/.test(title)) {
      return Promise.resolve(false);
    }
    return this.awaitAck(`pin ${id} ${Math.trunc(unixTime)} ${title}`, timeoutMs);
  }

  /** Delete the timeline pin with the given id (same id constraint as insertPin). */
  deletePin(id: string, timeoutMs = BundledInputChannel.ACK_TIMEOUT_MS): Promise<boolean> {
    if (!PIN_ID_RE.test(id)) return Promise.resolve(false);
    return this.awaitAck(`unpin ${id}`, timeoutMs);
  }

  /**
   * Send one helper command (without a trailing newline). Returns true if it was
   * written to a live helper; false if the channel is unavailable (caller should
   * fall back to the per-press CLI path).
   */
  send(line: string): boolean {
    if (!this.ensure() || !this.child) return false;
    try {
      this.child.stdinWrite(line + "\n");
      return true;
    } catch {
      // Broken pipe — drop the child so the next send respawns it.
      this.child = null;
      this.port = null;
      return false;
    }
  }

  /** Terminate the helper (called on emulator stop). Idempotent. */
  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.port = null;
    // Fail any in-flight ack so its promise can't hang past teardown.
    this.resolveAck(false);
  }
}

/**
 * Read the pypkjs websocket port out of pebble-tool's emulator state file
 * (%TEMP%\pb-emulator.json). Returns the first live pypkjs.port across all
 * platform/version entries, or null when the file is missing/partial. Pure
 * (readFile injectable) so it is unit-testable.
 */
export function readPypkjsPort(
  emuInfoPath: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): number | null {
  try {
    const raw = readFile(emuInfoPath);
    const o = JSON.parse(raw) as Record<string, Record<string, { pypkjs?: { port?: number } }>>;
    for (const vers of Object.values(o)) {
      if (!vers || typeof vers !== "object") continue;
      for (const v of Object.values(vers)) {
        const p = v?.pypkjs?.port;
        if (typeof p === "number" && Number.isFinite(p) && p > 0) return p;
      }
    }
  } catch {
    /* missing / partial / malformed → no port */
  }
  return null;
}
