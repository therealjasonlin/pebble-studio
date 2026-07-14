import { access } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { spawnRunner } from "./spawnRunner.js";
import { selectDriverKind, type ProbeResult, type DriverKind } from "./driverFactory.js";
import { NativeDriver } from "./NativeDriver.js";
import { WslDriver } from "./WslDriver.js";
import { WindowsNativeDriver } from "./WindowsNativeDriver.js";
import { bootEmulator, stopEmulator, makeWslBootDeps } from "./bootEmulator.js";
import { makeWinBootDeps } from "./winBootDeps.js";
import { defaultCtx, pebbleCmd, bundledToolsPresent, pebblePyExe, qemuExe, pebbleDataDir } from "./winRuntime.js";
import { winFakeTimeCtlPath, winQemuFakeTimeLogPath } from "./winTimeShim.js";
import { simEnvPath } from "./simEnv.js";
import { EMU_INFO_PATH, winHostPaths } from "./hostPaths.js";
import { deployWinHelpers } from "./winHelpers.js";
import { WinInputChannel, readPypkjsPort } from "./winInputChannel.js";
import { ensureWinSdkProvisioned } from "./winSdkProvision.js";
import { SnapshotManager, realSnapFs, realMonitorTransport, type SnapshotContext } from "./snapshotManager.js";
import { parseMonitorPort } from "./backlight.js";
import { stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import { join as pathJoin, win32 as winPath } from "node:path";
import type { PlatformId } from "../../shared/types.js";
import type { BackendDriver } from "./BackendDriver.js";

/**
 * Check whether a command is findable by the OS.
 *
 * On Linux/macOS we use `which <cmd>` (an actual executable, unlike the
 * `command` shell builtin which cannot be spawned directly).
 * On Windows we use `where <cmd>`.
 */
async function onPath(cmd: string): Promise<boolean> {
  const [probe, args] =
    process.platform === "win32"
      ? ["where", [cmd]]
      : ["which", [cmd]];
  const r = await spawnRunner(probe, args).catch(() => ({ code: 1 } as { code: number }));
  return r.code === 0;
}

/**
 * Like `onPath` but also accepts an absolute path that the user may have
 * configured via an environment variable, or checks known SDK install locations
 * as a fallback.
 *
 * For `qemu-pebble` specifically, the pebble-tool ships qemu-pebble inside its
 * SDK toolchain directory (`~/.local/share/pebble-sdk/SDKs/<ver>/toolchain/bin/`)
 * which is not on the system PATH. We probe that well-known path so that an SDK
 * install without a manual PATH entry still registers as available.
 */
async function qemuAvailable(): Promise<boolean> {
  if (await onPath("qemu-pebble")) return true;
  if (process.env.PEBBLE_QEMU_PATH) return true;

  // Probe the well-known pebble-tool SDK location used by bootEmulator.ts.
  const home = process.env.HOME ?? "";
  const sdkQemu = `${home}/.local/share/pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble`;
  try {
    await access(sdkQemu);
    return true;
  } catch {
    /* fall through */
  }

  // Probe the Pebble SDK location used by Pebble Tool on macOS.
  if (process.platform === "darwin") {
    const macSdkQemu = pathJoin(
      home,
      "Library",
      "Application Support",
      "Pebble SDK",
      "SDKs",
      "current",
      "toolchain",
      "bin",
      "qemu-pebble",
    );
    try {
      await access(macSdkQemu);
      return true;
    } catch {
      /* fall through */
    }
  }

  // Probe the Windows bundled SDK location (win32 only).
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const winSdkQemu = `${local}\\pebble-sdk\\SDKs\\current\\toolchain\\bin\\qemu-pebble.exe`;
    try {
      await access(winSdkQemu);
      return true;
    } catch {
      /* fall through */
    }
  }

  return false;
}

type DriverClass = typeof NativeDriver | typeof WslDriver | typeof WindowsNativeDriver;

/** Maps a driver kind to its class (used by createDriver + a construction test).
 * The `never` guard makes a new DriverKind member a compile error here. */
export function driverClassForKind(kind: DriverKind): DriverClass {
  if (kind === "native") return NativeDriver;
  if (kind === "wsl") return WslDriver;
  if (kind === "windows-native") return WindowsNativeDriver;
  const _never: never = kind;
  throw new Error(`Unknown driver kind: ${String(_never)}`);
}

export async function createDriver(override?: DriverKind): Promise<{ driver: BackendDriver; kind: DriverKind }> {
  // On win32, resolve the self-contained native stack once. When the bundled
  // qemu + python are present, selection prefers windows-native regardless of
  // the system PATH; the same ctx builds the path-independent pebble invocation.
  const winCtx = process.platform === "win32" ? await defaultCtx() : null;
  const bundled = winCtx ? bundledToolsPresent(winCtx) : false;

  const probe: ProbeResult = {
    platform: process.platform,
    nativePebbleOnPath: bundled || (await onPath("pebble")),
    nativeQemuOnPath: bundled || (await qemuAvailable()),
    wslAvailable: process.platform === "win32" ? await onPath("wsl.exe") : false,
    override,
  };
  const kind = selectDriverKind(probe);

  let driver: BackendDriver;
  if (kind === "windows-native") {
    // windows-native is only selectable on win32, so winCtx is non-null here.
    const ctx = winCtx!;
    // Custom-time control file. Custom time / freeze / rate is now built INTO the
    // bundled qemu-pebble.exe: the Pebble RTC reads PEBBLE_FAKETIME_FILE directly
    // (qemu hw/timer/stm32_pebble_rtc.c → pebble_faketime_us()). This replaced the
    // injected-DLL shim (which could not reach the host-clock path mingw's
    // gettimeofday() actually uses, so custom time reverted to real time). Custom
    // time is therefore ALWAYS available natively — no DLL injection, no
    // launcher.exe, no AV-blockable CreateRemoteThread.
    const ctlPath = winFakeTimeCtlPath();
    // The pebble invocation: pebbleCmd already points PEBBLE_QEMU_PATH at the
    // bundled qemu; we just hand qemu the control-file path. A live switch to System
    // writes an absolute "<now> 1"; the file is also reset to "- 1" at each boot
    // (WindowsNativeDriver.start) so a fresh qemu reads "-" as real time. An
    // absent/empty file is likewise treated as real time by qemu.
    const ftLogPath = winQemuFakeTimeLogPath();
    const simEnvFile = simEnvPath(ctx.userDataDir);

    // ROOT FIX for the Frozen custom-time "random time" bug:
    // pebble-tool's commands/base.py post_connect sends SetUTC(int(time.time()))
    // on EVERY libpebble2 connect. The bundled python's sitecustomize only fakes
    // time.time() when PEBBLE_FAKETIME_FILE is present in that process's env; any
    // connecting child spawned WITHOUT it (the long-lived emu-control supervisor
    // and its reconnects, future helpers) pushes the REAL host time onto the
    // watch. At 1×/2×/… qemu re-jams the RTC from the fake clock every tick and
    // erases that clobber; a FROZEN clock never re-jams, so the host-time SetUTC
    // sticks on the watchface until a manual repaint (menu→back) — i.e. the
    // displayed time goes "random". Exporting these into THIS process's env makes
    // every inherited spawn (spawnRunner / input helper / health / emu-control)
    // clobber-immune: their post_connect now carries the FAKE custom time. Safe
    // for System time — its control file reads as real time, so post_connect
    // sends real time exactly as before. (The per-command env below is kept as an
    // explicit belt-and-suspenders for the discrete `pebble` invocations.)
    process.env.PEBBLE_FAKETIME_FILE = ctlPath;
    process.env.PEBBLE_FAKETIME_LOG = ftLogPath;
    process.env.PEBBLE_SIM_ENV_FILE = simEnvFile;

    const pebble = (args: string[]) => {
      const c = pebbleCmd(args, ctx);
      // PEBBLE_FAKETIME_LOG: qemu records (to %TEMP%) that the control file arrived
      // and what time it serves — readable to confirm/diagnose custom time.
      c.env = {
        ...c.env,
        PEBBLE_FAKETIME_FILE: ctlPath,
        PEBBLE_FAKETIME_LOG: ftLogPath,
        // Path to the simulated location/weather control file, read by the bundled
        // python's sitecustomize -> pebble_studio_sim. Always set; the file's
        // presence + `enabled` flag decide whether interception is active.
        PEBBLE_SIM_ENV_FILE: simEnvFile,
      };
      return c;
    };
    // Spawn the pebble-tool supervisor (emu-control) WITHOUT `detached`. On
    // Windows `detached: true` sets DETACHED_PROCESS, which conflicts with
    // windowsHide and leaves the python supervisor with a visible console
    // window each launch. windowsHide alone gives it a hidden console
    // (CREATE_NO_WINDOW) that its children inherit — and emu-control's own
    // children (qemu/pypkjs/websockify) are spawned CREATE_NEW_PROCESS_GROUP by
    // the patched pebble-tool, so they already survive the supervisor exiting;
    // on Windows a non-detached child also outlives the parent (no cascade
    // kill), and teardown is by PID via killAll. unref() keeps Node's event
    // loop from waiting on it. (Job Object assignment is a later increment.)
    //
    // The supervisor's output is redirected to EMU_LOG_PATH (truncated per boot,
    // mirroring the POSIX path's `>` redirect) so a failed boot can be mined for
    // the real qemu-launch error by readBootLog/extractBootErrors; with
    // stdio:"ignore" nothing wrote that file and the diagnostic never fired.
    const detachSpawn = async (cmd: string, args: string[], env?: Record<string, string>): Promise<void> => {
      let logFd: number | undefined;
      try { logFd = openSync(winHostPaths().emuLog, "w"); } catch { /* diagnostics are best-effort */ }
      const stdio = logFd === undefined
        ? (["ignore", "ignore", "ignore"] as const)
        : (["ignore", logFd, logFd] as const);
      const child = spawn(cmd, args, { windowsHide: true, stdio: [...stdio], env: { ...process.env, ...env } });
      if (logFd !== undefined) { try { closeSync(logFd); } catch { /* child owns it now */ } }
      child.unref();
      child.on("error", () => { /* readiness is checked via ports/state file */ });
    };
    // QEMU snapshot restore (Tasks 6+7). One SnapshotManager keyed to the current
    // firmware/SDK/exe identity: the boot path consults it to restore instantly,
    // and ipc drives creation after a cold boot reaches Live. resolveContext is
    // provision-aware (ensureWinSdkProvisioned is cached) and computes the exe
    // stamp (size+mtime) so a new emulator build cleanly discards old streams.
    const resolveSnapshotContext = async (): Promise<SnapshotContext> => {
      const prov = await ensureWinSdkProvisioned(ctx);
      const persistSdkRoot = winPath.join(pebbleDataDir(ctx), "pebble-sdk");
      const fwRev = (await fsReadFile(winPath.join(prov.sdkCoreDir, ".fw-rev"), "utf8").catch(() => "")).trim();
      const st = await fsStat(qemuExe(ctx));
      return { persistSdkRoot, version: prov.version, fwRev, exeStamp: `${st.size}-${Math.round(st.mtimeMs)}` };
    };
    const snapshot = new SnapshotManager({
      fs: realSnapFs(),
      monitor: realMonitorTransport(),
      resolveContext: resolveSnapshotContext,
      log: (m) => console.warn(m),
    });
    // Read the qemu HMP monitor port from the native state file (Node fs; a Windows
    // host must NOT read it through a WSL shell — see backlight.ts).
    const readMonitorPort = async (): Promise<number | null> => {
      const raw = await fsReadFile(winHostPaths().emuInfo, "utf8").catch(() => "");
      return raw ? parseMonitorPort(raw) : null;
    };
    const winDeps = makeWinBootDeps({
      run: spawnRunner,
      detachSpawn,
      pebble,
      // attempt 1 restores (if a valid bundle exists); a retry/wipe invalidates it
      // and cold-boots (an `-incoming` source is invalid after killAll/wipe).
      restore: {
        beforeAttempt: async (attempt: number, board: PlatformId): Promise<string | null> => {
          if (attempt >= 2) { await snapshot.invalidate(board); return null; }
          return snapshot.prepareRestore(board);
        },
      },
    });
    // Deploy the persistent input helper and wire it to the bundled interpreter.
    // The input channel removes the per-press `pebble emu-button` spawn latency.
    const pyExe = pebblePyExe(ctx);
    const { inputHelperPath } = deployWinHelpers(pathJoin(ctx.userDataDir, "helpers"));
    const emuInfoPath = winHostPaths().emuInfo;
    const inputChannel = new WinInputChannel({
      helper: { pythonExe: pyExe, helperPath: inputHelperPath },
      readPort: () => readPypkjsPort(emuInfoPath),
    });
    driver = new WindowsNativeDriver({
      run: spawnRunner,
      pebble,
      boot: (id, token, onStep) => bootEmulator(id, winDeps, token, onStep),
      stop: () => stopEmulator({ killAll: winDeps.killAll }),
      // Startup orphan reaper (no graceful pebble kill) — backend:init calls this
      // before enabling Launch to self-heal a prior session's leftover stack.
      reap: () => winDeps.reap(),
      inputChannel,
      // Health activation helper (writes/runs pb-activate-health.py next to this
      // path). SEPARATE from timeHelper, which stays unset so setTzOffset remains
      // a no-op (custom time is the qemu RTC; a SetUTC push would clobber it).
      healthHelper: { pythonExe: pyExe, helperPath: inputHelperPath },
      timeShim: { ctlPath, ftLogPath },
      // Fire-and-forget snapshot creation after a cold boot reaches Live: read the
      // qemu monitor port, then drive the SnapshotManager (never throws).
      snapshotCreate: async (board, isCancelled) => {
        const port = await readMonitorPort();
        if (port == null) return;
        await snapshot.createAfterLive(board, port, { isCancelled });
      },
    });
  } else if (kind === "native") {
    const whichResult = await spawnRunner("which", ["pebble"]);
    const pebblePath = whichResult.stdout.trim();
    const launcher = await fsReadFile(pebblePath, "utf8");
    const pyExe = launcher.split(/\r?\n/, 1)[0].replace(/^#!/, "").trim();

    const { inputHelperPath } = deployWinHelpers(
      pathJoin(tmpdir(), "pebble-studio-helpers"),
    );
    const inputChannel = new WinInputChannel({
      helper: { pythonExe: pyExe, helperPath: inputHelperPath },
      readPort: () => readPypkjsPort(EMU_INFO_PATH),
    });
    driver = new NativeDriver({
      run: spawnRunner,
      inputChannel,
    });
  } else {
    driver = new WslDriver({
      run: spawnRunner,
      // On a Windows host the emulator lifecycle must run inside WSL via
      // wsl.exe, not as Node-spawned Linux binaries on the Windows host. The
      // token threads through so a force-close aborts the in-WSL boot.
      // onStep MUST be forwarded too — without it the WSL boot emits NO
      // progress notes, so the diagnostics boot log is blank on Windows (the
      // long-standing "no detailed steps on the .exe" bug, fixed v0.0.13.7).
      boot: (id, token, onStep) => bootEmulator(id, makeWslBootDeps(), token, onStep),
      stop: () => stopEmulator({ killAll: makeWslBootDeps().killAll }),
    });
  }
  return { driver, kind };
}
