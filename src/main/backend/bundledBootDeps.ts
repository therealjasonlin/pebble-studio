import type { PlatformId } from "../../shared/types.js";
import type { BootToken, SpawnDeps, BootProbe } from "./bootEmulator.js";
import { BootAborted } from "./bootEmulator.js";
import { winHostPaths } from "./hostPaths.js";
import { tasklistArgs, parseTasklistAlive, taskkillByImageArgs, taskkillByPidArgs, parseStatePids } from "./winProc.js";
import { connect as netConnect } from "node:net";
import { readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import type { PebbleCommand } from "./pebbleCli.js";

const VNC_RFB_PORT = 5901;
const WS_PORT = 6080;

/** Argv runner (shell:false). Injected so tests don't spawn real processes. */
export type WinRunner = (cmd: string, args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Builds the bundled pebble-tool invocation for a given pebble argv (see
 * winRuntime.pebbleCmd: cmd=bundled python, args prefixed with run_tool(), env
 * carrying PEBBLE_QEMU_PATH + XDG_DATA_HOME). Injected by createDriver; the
 * default below is bare `pebble` on PATH for non-bundled/legacy use.
 */
export type PebbleCmdBuilder = (args: string[]) => PebbleCommand;

export interface BundledBootDepsImpl {
  run: WinRunner;
  /** Read a file as utf8; resolves "" if missing. Injected for tests. */
  readFile?: (path: string) => Promise<string>;
  /** Remove a file (ignore-missing). Injected for tests. */
  rm?: (path: string) => Promise<void>;
  /** Launch a long-running detached process (Job Object assignment lives here in
   * production). The `env` (merged over process.env by the spawner) carries the
   * bundled-pebble runtime env. Resolves once launched. Injected for tests. */
  detachSpawn?: (cmd: string, args: string[], env?: Record<string, string>) => Promise<void>;
  /** Build the bundled pebble-tool invocation. Defaults to bare `pebble` on PATH. */
  pebble?: PebbleCmdBuilder;
  /** Override host paths (tests). Defaults to winHostPaths(). */
  paths?: { emuInfo: string; emuLog: string; sdkRoot: string };
  /**
   * Probe whether a TCP port is open; resolve true if open.
   * Injected for tests so the killAll settle loop doesn't touch real sockets.
   * Defaults to portOpen() which uses net.connect with a 1s timeout.
   */
  portOpen?: (host: string, port: number) => Promise<boolean>;
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    s.setTimeout(1000);
    const no = () => { s.destroy(); resolve(false); };
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", no);
    s.once("timeout", no);
  });
}

function stateHasLivePid(json: string, id: PlatformId): boolean {
  try {
    const o = JSON.parse(json) as Record<string, Record<string, { qemu?: { pid?: number } }>>;
    const vers = o[id];
    if (!vers) return false;
    for (const v of Object.values(vers)) if (v?.qemu?.pid) return true;
    return false;
  } catch { return false; }
}

export function makeBundledBootDeps(impl: BundledBootDepsImpl): SpawnDeps {
  const run = impl.run;
  const readFile = impl.readFile ?? (async (p: string) => fsReadFile(p, "utf8").catch(() => ""));
  const rm = impl.rm ?? (async (p: string) => { await fsRm(p, { force: true }).catch(() => {}); });
  // no real default — the production caller (createDriver) MUST provide this; the real impl needs detached-spawn + Job Object wiring.
  const detachSpawn = impl.detachSpawn ?? (async () => { throw new Error("detachSpawn not provided"); });
  // Default: bare `pebble` on PATH (legacy / non-bundled). Production injects the
  // bundled-python invocation (winRuntime.pebbleCmd) carrying the runtime env.
  const pebble = impl.pebble ?? ((args: string[]): PebbleCommand => ({ cmd: "pebble", args }));
  const paths = impl.paths ?? (process.platform === "win32" ? winHostPaths() : { emuInfo: "/tmp/pb-emulator.json", emuLog: "/tmp/pebble-emu.log", sdkRoot: "" });
  const checkPortOpen = impl.portOpen ?? portOpen;

  const diagnose = async (): Promise<BootProbe> => {
    let qemuAlive = false;
    if (process.platform === "win32") {
      const tl = await run("tasklist", tasklistArgs("qemu-pebble.exe")).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      qemuAlive = parseTasklistAlive(tl.stdout);
    } else {
      const tl = await run("pgrep", ["-f", "[q]emu-pebble"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      qemuAlive = tl.code === 0;
    }
    const stateRaw = await readFile(paths.emuInfo);
    const [rfbOpen, wsOpen] = await Promise.all([
      checkPortOpen("127.0.0.1", VNC_RFB_PORT),
      checkPortOpen("127.0.0.1", WS_PORT),
    ]);
    return { qemuAlive, stateFile: stateRaw.trim().length > 0, rfbOpen, wsOpen };
  };

  const waitForEmuInfo = async (id: PlatformId, timeoutMs: number, token?: BootToken): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (token?.cancelled) throw new BootAborted();
      const raw = await readFile(paths.emuInfo);
      if (raw.trim() && stateHasLivePid(raw, id)) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for emulator info for ${id}`);
      await new Promise((r) => setTimeout(r, 300));
      if (token?.cancelled) throw new BootAborted();
    }
  };

  const waitForPort = (host: string, port: number, timeoutMs: number, token?: BootToken): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = async () => {
        if (token?.cancelled) return reject(new BootAborted());
        if (await checkPortOpen(host, port)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${host}:${port}`));
        setTimeout(() => { void attempt().catch(reject); }, 300);
      };
      void attempt().catch(reject);
    });
  };

  const safeRun = (cmd: string, args: string[]): Promise<unknown> =>
    run(cmd, args).catch(() => ({ code: 0, stdout: "", stderr: "" }));

  const killAll = async (): Promise<void> => {
    // 1. Ask pebble-tool to kill the emulator FIRST. emu-control supervises qemu
    //    and would respawn it if we killed qemu alone, so the clean shutdown must
    //    bring the supervisor down before we force-kill the rest. Best-effort.
    const k = pebble(["kill"]);
    await run(k.cmd, k.args, k.env).catch(() => {});
    // 2. Force-kill by PID from the state file.
    const pids = parseStatePids(await readFile(paths.emuInfo));
    if (process.platform === "win32") {
      for (const pid of pids) await safeRun("taskkill", taskkillByPidArgs(pid));
      await safeRun("taskkill", taskkillByImageArgs("qemu-pebble.exe"));
    } else {
      for (const pid of pids) await safeRun("kill", ["-9", pid.toString()]);
      await safeRun("pkill", ["-9", "-f", "[q]emu-pebble"]);
      await safeRun("pkill", ["-9", "-f", "[e]mu-control"]);
      await safeRun("pkill", ["-9", "-f", "[w]ebsockify"]);
      await safeRun("pkill", ["-9", "-f", "[m] pypkjs"]);
    }
    await rm(paths.emuInfo);
    // taskkill /F is async; we settle on ports free as a proxy for exit (the port
    // is released on process exit on Windows).
    // Settle: poll the ports free (best-effort; never hang).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await checkPortOpen("127.0.0.1", VNC_RFB_PORT)) && !(await checkPortOpen("127.0.0.1", WS_PORT))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const preflight = async (): Promise<void> => {
    // Runs ONCE before the boot retry loop, AFTER killAll has freed OUR stack. If
    // the VNC/ws ports are STILL occupied, a FOREIGN process owns them — most
    // commonly a WSL Pebble emulator (WSL2 mirrors localhost to Windows) or a
    // second Pebble Studio instance. emu-control hardcodes -vnc :1 (5901), so we
    // cannot pick alternate ports for v0.0.1; surface a clear, actionable error
    // instead of letting the fresh qemu die on the cryptic "address already in use".
    const [rfb, ws] = await Promise.all([
      checkPortOpen("127.0.0.1", VNC_RFB_PORT),
      checkPortOpen("127.0.0.1", WS_PORT),
    ]);
    if (!rfb && !ws) return;
    const which = [rfb ? String(VNC_RFB_PORT) : null, ws ? String(WS_PORT) : null].filter(Boolean).join(" and ");
    throw new Error(
      `Emulator port ${which} is already in use by another process — likely a WSL Pebble emulator or a second Pebble Studio instance. Close it, then try again.`,
    );
  };

  const ensureKeymap = async (): Promise<void> => {
    // No-op: keymaps are seeded ONCE at first-run provisioning
    // (winSdkProvision.provisionWinSdk), which copies the qemu bundle's
    // pc-bios\keymaps into the WRITABLE persist dir (XDG_DATA_HOME) that
    // pebble-tool resolves SDKs\current against — the correct location. The old
    // per-boot stub targeted winHostPaths().sdkRoot (%LOCALAPPDATA%), which the
    // invocation contract does not use, so it never seeded the keymaps qemu reads.
  };

  return {
    bootControl: (id: PlatformId) => {
      const c = pebble(["emu-control", "--emulator", id, "--vnc"]);
      return detachSpawn(c.cmd, c.args, c.env);
    },
    ensureKeymap,
    preflight,
    diagnose,
    waitForPort,
    waitForEmuInfo,
    killAll,
    wipe: async () => { const c = pebble(["wipe"]); await run(c.cmd, c.args, c.env).catch(() => {}); },
    readBootLog: async () => readFile(paths.emuLog),
  };
}
