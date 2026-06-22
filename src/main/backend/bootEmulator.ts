import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import type { PlatformId } from "../../shared/types.js";
import type { VncEndpoint } from "./BackendDriver.js";
import { EMU_INFO_PATH, EMU_LOG_PATH, SDK_ROOT } from "./hostPaths.js";
// isShimReady() reads the module-level readiness cache populated by
// ensureTimeShim() (driver.ensureTimeShim(), called from ipc before each boot).
// bootEmulator never deploys the shim itself; it only reads the result to
// decide whether to route qemu through the wrapper.
import { isShimReady, WRAPPER } from "./timeShim.js";

/**
 * Real-boot orchestration for the qemu-pebble emulator (Task 1.5).
 *
 * APPROACH 1 (empirically verified to work): we let the `pebble` tool own the
 * whole emulator stack (qemu + pypkjs + websockify) via
 *   `pebble emu-control --emulator <platform> --vnc`
 *
 * The pebble-tool spawns:
 *   - qemu-pebble with `-vnc :1` (raw RFB on localhost:5901)
 *   - pypkjs (phone-sim websocket bridge)
 *   - websockify --heartbeat=30 6080 localhost:5901  (ws://localhost:6080/)
 * and records pids/ports in /tmp/pb-emulator.json.
 *
 * Because the tool reuses the running qemu/pypkjs (by pid, from that json file)
 * for subsequent discrete commands (`pebble install`, `pebble emu-button ...`),
 * those commands hit the SAME running emulator and do NOT tear down the VNC.
 *
 * The one obstacle the spike found: the tool's VNC boot passes
 *   `-L <sdk-root>/toolchain/lib/pc-bios`
 * for the qemu keymap, but that dir has no `en-us` keymap, so qemu aborts.
 * We pre-seed that keymap (idempotent) before booting.
 *
 * TWO HOSTS, ONE INTERFACE (Task: WSL-aware boot):
 * Every shell operation goes through a `Shell` abstraction with two impls:
 *   - native: `bash -lc "<cmdline>"` directly (Linux/macOS host).
 *   - wsl:    `wsl.exe -- bash -lc "<cmdline>"` (Windows host driving WSL2).
 * The cmdlines are identical; only the launcher differs. WSL2 forwards
 * localhost ports to the Windows host, so readiness checks stay on localhost.
 */

// SDK_ROOT (imported from hostPaths) uses the `current` symlink rather than a
// hardcoded version so any active SDK works. On a WSL host the path is resolved
// INSIDE wsl via `bash -lc`, so it stays a literal POSIX path / shell expansion
// rather than a Node path. PC_BIOS / STUB_KEYMAP stay derived here — they are
// boot-keymap details, not host-path policy.
const PC_BIOS = `${SDK_ROOT}/toolchain/lib/pc-bios`;
const STUB_KEYMAP = "$HOME/.pebble-qemu-data/keymaps/en-us";
const VNC_RFB_PORT = 5901;
const WS_PORT = 6080;

/**
 * Cancellation token for an in-flight boot. The orchestrator and the poll
 * helpers check `cancelled` between retries; flipping it true makes an active
 * wait loop abort (throw `BootAborted`) within ~300ms instead of blocking up to
 * the full readiness timeout (60s). IPC owns the token and flips it on
 * abort/stop.
 */
export interface BootToken {
  cancelled: boolean;
}

/** Thrown by `bootEmulator` (and its wait loops) when the token is cancelled. */
export class BootAborted extends Error {
  constructor(message = "boot aborted") {
    super(message);
    this.name = "BootAborted";
  }
}

/**
 * A point-in-time health snapshot of the emulator stack, used to annotate boot
 * progress so a stuck boot shows EXACTLY which component hasn't come up:
 *   - qemuAlive  — a `qemu-pebble` process is running (pgrep -f, argv match)
 *   - stateFile  — /tmp/pb-emulator.json exists and is non-empty
 *   - rfbOpen    — qemu's raw VNC (RFB :5901) is accepting connections
 *   - wsOpen     — websockify's proxy (ws :6080) is accepting connections
 * The classic stuck-boot signature is qemuAlive=false + rfbOpen=true: a stale
 * listener still holds :5901 so the fresh qemu died on "address already in use".
 */
export interface BootProbe {
  qemuAlive: boolean;
  stateFile: boolean;
  rfbOpen: boolean;
  wsOpen: boolean;
}

export interface SpawnDeps {
  /** Spawn `pebble emu-control --emulator <id> --vnc` detached; resolve once launched. */
  bootControl: (id: PlatformId) => Promise<void>;
  /** Ensure the qemu keymap exists at the pc-bios path the tool's VNC boot uses. */
  ensureKeymap: () => Promise<void>;
  /**
   * Optional fail-fast preflight, run ONCE after the initial teardown and BEFORE
   * the boot retry loop. Throws a clear, actionable error if a FOREIGN process
   * still holds the VNC/ws ports (e.g. a WSL Pebble emulator or a second Pebble
   * Studio instance) — emu-control hardcodes -vnc :1 so we cannot pick alternate
   * ports. Omitted by the POSIX/WSL deps (no behavior change there).
   */
  preflight?: () => Promise<void>;
  /** One-shot health snapshot used to annotate boot progress (diagnostics). */
  diagnose: () => Promise<BootProbe>;
  /** Resolve once a TCP connection to host:port succeeds (or reject on timeout).
   * Honors the optional cancellation token: a cancelled token aborts an active
   * retry loop promptly with `BootAborted`. */
  waitForPort: (host: string, port: number, timeoutMs: number, token?: BootToken) => Promise<void>;
  /** Resolve once /tmp/pb-emulator.json contains a live entry for the platform.
   * Honors the optional cancellation token (aborts active polling promptly). */
  waitForEmuInfo: (id: PlatformId, timeoutMs: number, token?: BootToken) => Promise<void>;
  /** Stop any prior emulator + websockify so we boot a clean stack. */
  killAll: () => Promise<void>;
  /**
   * Wipe all emulator persistent data (`pebble wipe`). Used ONLY as a last-resort
   * recovery when every normal boot attempt fails: a corrupt SPI flash (e.g. left
   * by a bridge/pypkjs crash mid-install) makes the firmware hang on boot with no
   * console marker, which looks exactly like the `_wait_for_qemu` stall. Wiping
   * regenerates a clean flash; the renderer reinstalls the app library afterward,
   * so no user .pbw is lost. Optional — omitted in unit tests that don't want it.
   */
  wipe?: () => Promise<void>;
  /**
   * Read the raw emu-control boot log (EMU_LOG_PATH). On a failed attempt we mine
   * it for the actual qemu-launch error to surface in the diagnostics. Optional.
   */
  readBootLog?: () => Promise<string>;
}

/**
 * A shell abstraction: it knows how to run a POSIX command line (as it would be
 * typed at a `bash -lc` prompt), either directly (native) or via wsl.exe.
 */
export interface Shell {
  /** Run a command line to completion; capture stdout+stderr+exit code. */
  run(cmdline: string): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Launch a long-running command line and return WITHOUT waiting for it.
   * The command must survive after this call returns (nohup/setsid + bg).
   */
  spawnDetached(cmdline: string): Promise<void>;
}

/** Low-level: run argv to completion, capturing stdout + stderr. */
function execArgv(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // windowsHide suppresses a console-window flash for each spawned helper. No-op off Windows.
    const child = spawn(cmd, args, { env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** Native shell: `bash -lc "<cmdline>"` (login shell ⇒ ~/.local/bin on PATH). */
export function makeNativeShell(): Shell {
  return {
    run: (cmdline) => execArgv("bash", ["-lc", cmdline]),
    async spawnDetached(cmdline) {
      // Wrap in setsid+nohup so the process survives this bash exiting, and
      // detach the Node child so our event loop isn't held open by it.
      const wrapped = `setsid nohup bash -lc ${shQuote(cmdline)} >${EMU_LOG_PATH} 2>&1 &`;
      const child = spawn("bash", ["-lc", wrapped], { detached: true, stdio: "ignore", env: process.env, windowsHide: true });
      child.unref();
      child.on("error", () => { /* readiness is checked via ports */ });
    },
  };
}

/** WSL shell: `wsl.exe -- bash -lc "<cmdline>"` (same distro, login shell). */
export function makeWslShell(): Shell {
  return {
    run: (cmdline) => execArgv("wsl.exe", ["--", "bash", "-lc", cmdline]),
    async spawnDetached(cmdline) {
      // CRITICAL (Windows host): wsl.exe returns as soon as the inner bash exits.
      // To keep qemu/websockify alive after wsl.exe returns, the emulator must be
      // fully detached from that bash via `setsid nohup ... &`, with stdio
      // redirected to a file so the pipe closing doesn't kill it. We then exit 0
      // immediately so wsl.exe returns while the emulator keeps running.
      const inner = `setsid nohup bash -lc ${shQuote(cmdline)} >${EMU_LOG_PATH} 2>&1 & exit 0`;
      // We DON'T await wsl.exe's exit beyond it returning; run() resolves on close.
      await execArgv("wsl.exe", ["--", "bash", "-lc", inner]);
    },
  };
}

/** Single-quote a string for safe embedding inside a POSIX shell command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultWaitForPort(host: string, port: number, timeoutMs: number, token?: BootToken): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      // Bail before opening a fresh socket if the boot was cancelled.
      if (token?.cancelled) { reject(new BootAborted()); return; }
      const sock = netConnect({ host, port });
      sock.setTimeout(1000);
      const fail = () => {
        sock.destroy();
        if (token?.cancelled) reject(new BootAborted());
        else if (Date.now() > deadline) reject(new Error(`timeout waiting for ${host}:${port}`));
        // Re-check the token between retries so cancellation interrupts the loop
        // within one poll interval (~300ms) rather than at the full timeout.
        else setTimeout(() => {
          if (token?.cancelled) reject(new BootAborted());
          else attempt();
        }, 300);
      };
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", fail);
      sock.once("timeout", fail);
    };
    attempt();
  });
}

/**
 * Poll the emulator state file for a live qemu pid. We read the file THROUGH the
 * shell (`cat`), not Node fs, because on a real Windows host the file lives in
 * the WSL filesystem and Node (running on Windows) cannot read that POSIX path.
 */
function makeWaitForEmuInfo(shell: Shell) {
  return async function waitForEmuInfo(id: PlatformId, timeoutMs: number, token?: BootToken): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (token?.cancelled) throw new BootAborted();
      const { code, stdout } = await shell.run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
      if (code === 0 && stdout.trim()) {
        try {
          const json = JSON.parse(stdout) as Record<string, Record<string, { qemu?: { pid?: number } }>>;
          const versions = json[id];
          if (versions) {
            for (const v of Object.values(versions)) {
              if (v?.qemu?.pid) return;
            }
          }
        } catch {
          /* partial write; retry */
        }
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for emulator info for ${id}`);
      // Re-check the token after the poll delay so an in-flight cancel aborts the
      // loop within ~300ms rather than waiting out the full timeout.
      await new Promise((r) => setTimeout(r, 300));
      if (token?.cancelled) throw new BootAborted();
    }
  };
}

/**
 * Build a shell-backed health probe. ONE quote-free bash one-liner (it crosses
 * the WSL double-shell-hop, so per the hard-won rule it must contain ZERO ' and
 * ZERO " — see pebbleCli.setTzOffsetCmd / bridgeHealth.buildHealthCommand) prints
 * four 0/1 flags: `q<0|1> i<0|1> r<0|1> w<0|1>`. A bare `/dev/tcp` connect tests a
 * port without nc/timeout; a refused connect fails immediately.
 */
export function makeDiagnose(shell: Shell) {
  const cmd =
    // Match qemu by its argv PATH (not comm) with a self-excluding character
    // class — see makeKillAll for the full rationale. `pgrep -x qemu-pebble`
    // misses the process whenever it is still the `#!/bin/sh` time-shim wrapper
    // (comm `sh`/`dash`) that has not yet `exec`d the real binary, which is why
    // the diagnostics line could show `qemu ✗` for a live emulator.
    //
    // This command MUST stay quote-free (it crosses the WSL double-shell-hop —
    // see the not-toMatch(/['"]/) test). So instead of quoting the [q] class we
    // disable globbing with `set -f`, which keeps `[q]emu-pebble` literal for
    // pgrep regardless of the shell's cwd (an unquoted [q]…  would otherwise be
    // pathname-expanded if a matching file happened to exist).
    `set -f; ` +
    `Q=0; pgrep -f [q]emu-pebble >/dev/null 2>&1 && Q=1; ` +
    `I=0; [ -s ${EMU_INFO_PATH} ] && I=1; ` +
    `R=0; (exec 3<>/dev/tcp/localhost/${VNC_RFB_PORT}) 2>/dev/null && R=1; ` +
    `W=0; (exec 3<>/dev/tcp/localhost/${WS_PORT}) 2>/dev/null && W=1; ` +
    `echo q$Q i$I r$R w$W`;
  return async function diagnose(): Promise<BootProbe> {
    try {
      const { stdout } = await shell.run(cmd);
      const t = stdout;
      return {
        qemuAlive: /q1/.test(t),
        stateFile: /i1/.test(t),
        rfbOpen: /r1/.test(t),
        wsOpen: /w1/.test(t),
      };
    } catch {
      // A probe failure is itself a (degraded) signal; report all-unknown=false.
      return { qemuAlive: false, stateFile: false, rfbOpen: false, wsOpen: false };
    }
  };
}

/** Format a probe as a compact one-line note for the diagnostics boot log. */
export function fmtProbe(p: BootProbe): string {
  const m = (ok: boolean): string => (ok ? "✓" : "✗");
  return `qemu ${m(p.qemuAlive)} · state-file ${m(p.stateFile)} · RFB:${VNC_RFB_PORT} ${m(p.rfbOpen)} · ws:${WS_PORT} ${m(p.wsOpen)}`;
}

/**
 * Pull the meaningful ERROR lines out of the emu-control boot log. That log is
 * mostly the watch screen rendered as ANSI block-art (noise), but on a failed
 * boot the real cause is in there as plain text (e.g. "Address already in use",
 * an LD_PRELOAD/shim error, a Python traceback, "command not found"). We strip
 * ANSI escapes, drop the block-art lines, keep only error-shaped lines, and
 * return the last few. Pure + unit-testable; filtering in Node sidesteps the
 * WSL quote-free constraint that a shell-side grep would hit.
 */
export function extractBootErrors(log: string, maxLines = 4): string {
  if (!log) return "";
  const ESC = String.fromCharCode(27);
  const lines = log
    .split("\n")
    // Strip ANSI SGR escapes (the block-art coloring) and trim.
    .map((l) => l.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").trim())
    // Drop empties and the screen block-art (runs of two-space cells).
    .filter((l) => l.length > 0 && !/^[\s]*$/.test(l) && !/^( {2}){4,}$/.test(l));
  const ERR = /error|fail|cannot|refus|address already|in use|preload|no such|traceback|exception|not found|abort|denied|missing/i;
  const hits = lines.filter((l) => ERR.test(l));
  return hits.slice(-maxLines).join(" | ");
}

function makeEnsureKeymap(shell: Shell) {
  return async function ensureKeymap(): Promise<void> {
    // -p / -n keep this idempotent. Done in one shell so $HOME expands in-distro.
    await shell.run(
      `mkdir -p "${PC_BIOS}/keymaps" && ` +
      `cp -n "${STUB_KEYMAP}" "${PC_BIOS}/keymaps/en-us" 2>/dev/null || touch "${PC_BIOS}/keymaps/en-us"; ` +
      `cp -n "${STUB_KEYMAP}" "${PC_BIOS}/en-us" 2>/dev/null || touch "${PC_BIOS}/en-us"; true`,
    );
  };
}

function makeBootControl(shell: Shell) {
  return async function bootControl(id: PlatformId): Promise<void> {
    // emu-control --vnc owns the whole stack and stays alive. We detach it so it
    // survives the launching shell returning (critical on the WSL host path).
    //
    // When the time shim deployed OK, route qemu through the wrapper via
    // pebble-tool's first-class PEBBLE_QEMU_PATH hook (emulator.py:279). The
    // env assignment is part of the (quote-free) cmdline so it crosses the
    // WSL boundary inside the same single shQuote layer as the rest.
    const prefix = isShimReady() ? `PEBBLE_QEMU_PATH=${WRAPPER} ` : "";
    await shell.spawnDetached(`${prefix}pebble emu-control --emulator ${id} --vnc`);
  };
}

/**
 * Probe whether RFB port 5901 is FREE (refusing connections). Resolves true if
 * the port is free (connection refused/errored/timed out), false if something is
 * still accepting connections there. Ports are localhost-forwarded on both hosts
 * (WSL2 mirrors localhost to Windows), so a native net.connect to 127.0.0.1 is
 * host-agnostic for this free-or-not check.
 */
function defaultPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port });
    sock.setTimeout(1000);
    const free = () => { sock.destroy(); resolve(true); };
    sock.once("connect", () => { sock.destroy(); resolve(false); });
    sock.once("error", free);
    sock.once("timeout", free);
  });
}

/** Injectable deps for `waitUntilDead` so it's testable without real procs/sockets. */
export interface WaitUntilDeadDeps {
  /** Probe a TCP port; resolve true iff it is FREE (refusing connections). */
  portFree?: (host: string, port: number) => Promise<boolean>;
  /** Override the inter-poll delay (ms) — tests set this to 0 for speed. */
  pollIntervalMs?: number;
}

/**
 * Block until the prior emulator stack is TRULY gone, or the timeout elapses.
 *
 * ROOT CAUSE THIS GUARDS (the "watchface hang"): `killAll` SIGKILLs qemu and then
 * waits a FIXED 800ms with NO verification. SIGKILL is async — the kernel may not
 * have reaped qemu (and released VNC display :1 / RFB port 5901) within 800ms.
 * A same-model relaunch then races the lingering stack: the fresh
 * `emu-control --vnc` collides with the still-bound display/port and the watch
 * never paints. Booting a DIFFERENT model takes longer (and starts a different
 * machine), which accidentally gives the stale stack time to fully release —
 * exactly the "helpfulness" the user observed. This makes that settling
 * DETERMINISTIC: poll until ALL of (a) no `qemu-pebble` process remains,
 * (b) RFB port 5901 is free, AND (c) websockify's ws port 6080 is free,
 * before letting a new boot proceed.
 *
 * `pgrep -f '[q]emu-pebble'` matches qemu by its argv PATH, with the same
 * self-excluding character class killAll uses. The argv form (not `pgrep -x`,
 * which matches comm) is required because the time-shim wrapper runs qemu as a
 * `#!/bin/sh` script: until it `exec`s the real binary its comm is `sh`/`dash`,
 * so `-x qemu-pebble` would falsely report it dead and let a relaunch race a
 * still-live (or stuck-pre-exec) process.
 *
 * If the timeout elapses we resolve anyway (never hang the app); after a SIGKILL
 * it normally resolves within a poll or two.
 */
export async function waitUntilDead(
  shell: Shell,
  timeoutMs = 5000,
  deps: WaitUntilDeadDeps = {},
): Promise<void> {
  const portFree = deps.portFree ?? defaultPortFree;
  const pollIntervalMs = deps.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // (a) No qemu-pebble process: pgrep exits non-zero (and prints nothing) when
    // there is no match.
    const { code, stdout } = await shell.run("pgrep -f '[q]emu-pebble'");
    const qemuGone = code !== 0 && stdout.trim() === "";
    // (b) RFB port released.
    const rfbFree = qemuGone ? await portFree("127.0.0.1", VNC_RFB_PORT) : false;
    // (c) websockify released the websocket port too — a relaunch's websockify
    // would otherwise collide with the lingering 6080 listener.
    const wsFree = rfbFree ? await portFree("127.0.0.1", WS_PORT) : false;
    if (qemuGone && rfbFree && wsFree) return;
    if (Date.now() >= deadline) return; // give up gracefully; never hang the app
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

function makeKillAll(shell: Shell) {
  // CRITICAL — SELF-MATCH HAZARD: this sweep runs inside `bash -lc "<cmdline>"`,
  // so the controlling shell's OWN argv literally CONTAINS these patterns. A naive
  // `pkill -9 -f qemu-pebble` therefore matches (and kills) the very shell running
  // it, before it reaches the real emulator. The defense for EVERY pattern is the
  // `[c]haracter class` self-exclusion trick: `[w]ebsockify` matches the string
  // "websockify" in the TARGET's argv, but our own cmdline contains the literal
  // "[w]ebsockify", which does NOT match.
  //   * websockify / emu-control / pypkjs run as `python …` so `-f` (argv match)
  //     is mandatory.
  //   * qemu ALSO needs `-f '[q]emu-pebble'` (argv match), NOT `-x qemu-pebble`
  //     (comm match): the time-shim wrapper launches qemu as a `#!/bin/sh` script,
  //     so until it `exec`s the real binary its comm is `sh`/`dash` — `-x` would
  //     miss it and leave a stale process holding RFB :5901, causing the next
  //     boot to die on "address already in use". The argv carries the wrapper
  //     PATH (…/qemu-pebble) in both the pre- and post-exec states, so `-f` reaps
  //     it either way.
  //
  // ORDER MATTERS: the `emu-control --vnc` session SUPERVISES qemu and respawns it
  // if killed alone, so we kill the supervisor FIRST, then qemu/websockify/pypkjs,
  // then `pebble kill` for any state-file pids. We sweep TWICE (with a short settle)
  // to catch anything that respawned in the race window, then delete the state file.
  const sweep =
    `pkill -9 -f '[e]mu-control' 2>/dev/null; ` +
    `pkill -9 -f '[q]emu-pebble' 2>/dev/null; ` +
    `pkill -9 -f '[w]ebsockify' 2>/dev/null; ` +
    `pkill -9 -f '[m] pypkjs' 2>/dev/null; ` +
    `pebble kill 2>/dev/null; true`;
  return async function killAll(): Promise<void> {
    await shell.run(`${sweep}; sleep 0.4; ${sweep}; rm -f ${EMU_INFO_PATH} 2>/dev/null; true`);
    // Give the OS a beat to release the VNC display + ports…
    await new Promise((r) => setTimeout(r, 800));
    // …then VERIFY the stack is actually gone before returning. SIGKILL is async,
    // so the fixed settle above is NOT a guarantee; without this gate a same-model
    // relaunch races a not-yet-reaped qemu / still-bound RFB port 5901 and the
    // watchface hangs. waitUntilDead makes teardown deterministic (the same
    // settling a slower different-model boot accidentally provided).
    await waitUntilDead(shell);
  };
}

/** Read the emu-control boot log through the shell (quote-free `cat`). */
function makeReadBootLog(shell: Shell) {
  return async function readBootLog(): Promise<string> {
    const { code, stdout } = await shell.run(`cat ${EMU_LOG_PATH} 2>/dev/null`);
    return code === 0 ? stdout : "";
  };
}

/** Wipe all emulator persistent data via `pebble wipe` (last-resort recovery). */
function makeWipe(shell: Shell) {
  return async function wipe(): Promise<void> {
    // `pebble wipe` has no --emulator flag; it clears all platforms' data. It can
    // exit nonzero on benign stderr warnings, so we don't throw on a bad code.
    await shell.run("pebble wipe 2>/dev/null; true");
  };
}

/** Build the SpawnDeps for a given shell (native or wsl). */
function makeBootDeps(shell: Shell): SpawnDeps {
  return {
    bootControl: makeBootControl(shell),
    ensureKeymap: makeEnsureKeymap(shell),
    diagnose: makeDiagnose(shell),
    waitForPort: defaultWaitForPort,
    waitForEmuInfo: makeWaitForEmuInfo(shell),
    killAll: makeKillAll(shell),
    wipe: makeWipe(shell),
    readBootLog: makeReadBootLog(shell),
  };
}

/** SpawnDeps wired to run everything in the native (current-host) shell. */
export function makeNativeBootDeps(): SpawnDeps {
  return makeBootDeps(makeNativeShell());
}

/** SpawnDeps wired to run everything inside WSL via wsl.exe. */
export function makeWslBootDeps(): SpawnDeps {
  return makeBootDeps(makeWslShell());
}

const defaultDeps: SpawnDeps = makeNativeBootDeps();

/**
 * Optional progress callback. `bootEmulator` calls it with a short human label
 * before each major step ("Killing stale emulator…", …, "Ready") so the renderer
 * can surface verbose boot notes in diagnostic mode. Always optional; omitting it
 * leaves the boot unchanged.
 */
export type OnStep = (msg: string) => void;

/** How often (ms) to re-probe + re-emit a detailed note during a long wait. */
const PROGRESS_TICK_MS = 1500;

/**
 * Per-attempt timeout for the pebble state file to appear. This is where the
 * `_wait_for_qemu` marker hang shows up; a healthy boot writes the file within a
 * few seconds. The native stack has no wsl.exe per-call latency, so 20s is a
 * generous ceiling that still fails a HUNG attempt fast enough to retry — since
 * the stall is a race, a clean relaunch wins more often than a longer wait (was
 * 30s; 60s before that, which made a double-stall feel like forever).
 */
const STATE_FILE_TIMEOUT_MS = 20_000;
/** Per-attempt timeout for the RFB / websockify ports (fast once the state file lands). */
const PORT_TIMEOUT_MS = 30_000;
/**
 * Boot attempts before giving up. The stall is a race, so a clean relaunch wins
 * more often than waiting — 3 fast attempts beat 1 long wait + 1 long retry both
 * on success odds and on worst-case time-to-failure.
 */
const MAX_BOOT_ATTEMPTS = 3;

/**
 * Run `body` while emitting a detailed progress note for `phase` — immediately,
 * then every PROGRESS_TICK_MS with elapsed seconds + a fresh health snapshot —
 * so a stuck wait shows precisely what is (not) up and for how long. The ticker
 * is overlap-guarded and always cleared when `body` settles.
 */
async function runWithProgress<T>(
  phase: string,
  step: OnStep,
  diagnose: () => Promise<BootProbe>,
  body: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  step(phase); // immediate phase marker (before the first probe lands)
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const p = await diagnose();
        const secs = Math.round((Date.now() - started) / 1000);
        step(`${phase} · ${secs}s · ${fmtProbe(p)}`);
      } catch {
        /* probe errors are non-fatal — the next tick retries */
      } finally {
        busy = false;
      }
    })();
  }, PROGRESS_TICK_MS);
  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
}

export async function bootEmulator(
  platformId: PlatformId,
  deps: Partial<SpawnDeps> = {},
  token?: BootToken,
  onStep?: OnStep,
): Promise<VncEndpoint> {
  const d: SpawnDeps = { ...defaultDeps, ...deps };
  // Best-effort step notifier; never let a bad callback break the boot.
  const step = (msg: string): void => { try { onStep?.(msg); } catch { /* ignore */ } };

  // Throw promptly if cancellation already happened (e.g. force-close fired
  // before/right after start). Each wait step below also rechecks the token.
  if (token?.cancelled) throw new BootAborted();
  // 1. Tear down any prior emulator so we own a clean stack.
  step("Killing stale emulator…");
  await d.killAll();
  // Probe right after teardown: if RFB:5901 / ws:6080 are STILL open here, a
  // stale listener survived the kill and the fresh qemu will die on
  // "address already in use" — the classic stuck-boot cause. Surface it.
  try {
    const after = await d.diagnose();
    step(`Stale stack cleared · ${fmtProbe(after)}`);
  } catch { /* probe is best-effort */ }
  // 1b. Fail-fast preflight (native): if a FOREIGN process still holds the VNC/ws
  // ports after our teardown, abort now with a clear error rather than letting the
  // fresh qemu die on "address already in use" three attempts in a row. Runs once,
  // before the retry loop; a throw here propagates straight out (not retried).
  if (d.preflight) {
    step("Checking emulator ports…");
    await d.preflight();
  }
  // 2. Make the tool's VNC keymap path valid.
  step("Preparing keymap…");
  await d.ensureKeymap();
  // 3+4. Boot the full stack (qemu + pypkjs + websockify) under the pebble tool,
  // then wait for readiness: state file, raw RFB, and the websocket proxy. The
  // token threads into each wait so a cancel interrupts the active loop.
  const attempt = async (): Promise<VncEndpoint> => {
    step("Launching qemu (pebble emu-control --vnc)…");
    await d.bootControl(platformId);
    // Each wait emits periodic elapsed + health-snapshot notes so a stall shows
    // which component is hung. waitForEmuInfo → the pebble state file gets a pid;
    // RFB :5901 → qemu's VNC is up; ws :6080 → websockify proxy is up (the slower,
    // last-to-bind step). The probe pinpoints the stall: qemu✓/state-file✗/RFB✓
    // is pebble-tool's `_wait_for_qemu` console-marker hang (qemu booted, but the
    // tool never wrote the state file nor spawned websockify) — the dominant cause
    // of a stuck boot. We fail this attempt FAST (STATE_FILE_TIMEOUT_MS) rather
    // than waiting a full minute, because a clean relaunch wins the race more
    // often than waiting does.
    await runWithProgress("Waiting for emulator state file…", step, d.diagnose, () =>
      d.waitForEmuInfo(platformId, STATE_FILE_TIMEOUT_MS, token),
    );
    await runWithProgress("Waiting for qemu VNC (RFB :5901)…", step, d.diagnose, () =>
      d.waitForPort("localhost", VNC_RFB_PORT, PORT_TIMEOUT_MS, token),
    );
    await runWithProgress("Waiting for websockify (ws :6080)…", step, d.diagnose, () =>
      d.waitForPort("localhost", WS_PORT, PORT_TIMEOUT_MS, token),
    );
    return { host: "localhost", port: WS_PORT, wsPath: "/" };
  };
  // Known flakiness: the managed boot intermittently hangs in pebble-tool's
  // `_wait_for_qemu` (a connect-after-marker race) — qemu comes up but the state
  // file is never written. It is a RACE, so a clean kill + relaunch usually wins
  // where waiting would not. We try up to MAX_BOOT_ATTEMPTS, killing cleanly
  // between tries (the production killAll ends with waitUntilDead so the relaunch
  // never races a not-yet-released qemu/port). Cancellation is never retried.
  let lastErr: unknown;
  for (let i = 1; i <= MAX_BOOT_ATTEMPTS; i++) {
    if (token?.cancelled) throw new BootAborted();
    if (i > 1) {
      step(`Boot stalled — clean retry ${i} of ${MAX_BOOT_ATTEMPTS}…`);
      await d.killAll();
    }
    try {
      const ep = await attempt();
      step("Ready");
      return ep;
    } catch (err) {
      if (err instanceof BootAborted || token?.cancelled) throw err;
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      step(`Attempt ${i} of ${MAX_BOOT_ATTEMPTS} failed: ${msg}`);
      // Surface the REAL qemu-launch error from emu-control's log (e.g. a port
      // collision, LD_PRELOAD/shim failure, or missing binary) so a `qemu ✗`
      // stall isn't a mystery. Best-effort; the log is mostly screen art.
      if (d.readBootLog) {
        try {
          const errs = extractBootErrors(await d.readBootLog());
          if (errs) step(`qemu launch error: ${errs}`);
        } catch { /* diagnostics only */ }
      }
    }
  }

  // LAST-RESORT RECOVERY: every normal attempt stalled. The dominant cause of a
  // persistent stall (qemu up, but the state file never lands) is a CORRUPT SPI
  // flash — typically left by a bridge/pypkjs crash mid-install — which makes the
  // firmware hang on boot. Plain relaunches can't fix that; only a wipe can. We
  // regenerate a clean flash and try once more. The renderer reinstalls the app
  // library after boot, so no user .pbw is lost (watch-side settings do reset).
  if (d.wipe && !token?.cancelled) {
    step("Boot keeps stalling — emulator data may be corrupt; wiping and retrying…");
    await d.killAll();
    try {
      await d.wipe();
    } catch (err) {
      step(`Wipe failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (token?.cancelled) throw new BootAborted();
    try {
      const ep = await attempt();
      step("Ready (recovered after wipe)");
      return ep;
    } catch (err) {
      if (err instanceof BootAborted || token?.cancelled) throw err;
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      step(`Recovery attempt after wipe failed: ${msg}`);
    }
  }

  // Every attempt (incl. the wipe recovery) failed — propagate the last error.
  throw lastErr;
}

export async function stopEmulator(deps: Partial<Pick<SpawnDeps, "killAll">> = {}): Promise<void> {
  const killAll = deps.killAll ?? defaultDeps.killAll;
  await killAll();
}
