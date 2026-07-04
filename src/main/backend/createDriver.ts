import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { spawnRunner } from "./spawnRunner.js";
import { selectDriverKind, type ProbeResult, type DriverKind } from "./driverFactory.js";
import { NativeDriver, type NativeDriverDeps } from "./NativeDriver.js";
import { WslDriver } from "./WslDriver.js";
import { WindowsNativeDriver } from "./WindowsNativeDriver.js";
import { bootEmulator, stopEmulator, makeWslBootDeps } from "./bootEmulator.js";
import { makeWinBootDeps } from "./winBootDeps.js";
import { defaultCtx, pebbleCmd, bundledToolsPresent, pebblePyExe } from "./winRuntime.js";
import { winFakeTimeCtlPath, winQemuFakeTimeLogPath } from "./winTimeShim.js";
import { macStudioDir, macDeployPaths, ensureMacSitecustomize } from "./macTimeShim.js";
import { simEnvPath } from "./simEnv.js";
import { winHostPaths } from "./hostPaths.js";
import { deployWinHelpers } from "./winHelpers.js";
import { WinInputChannel, readPypkjsPort } from "./winInputChannel.js";
import { join as pathJoin } from "node:path";
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
 * Resolve an absolute `qemu-pebble` path from the well-known SDK toolchain
 * locations (which are NOT on the system PATH), or null if none exist.
 *
 * pebble-tool ships qemu-pebble inside its SDK toolchain directory. The layout
 * differs by platform:
 *   - Linux/WSL (classic SDK): `~/.local/share/pebble-sdk/SDKs/current/toolchain/bin/`
 *   - macOS (modern uv-installed pebble-tool): `~/Library/Application Support/
 *     Pebble SDK/SDKs/current/toolchain/bin/`
 * We return the resolved path so the caller can both answer "is qemu available"
 * AND export it as PEBBLE_QEMU_PATH — pebble-tool otherwise defaults to a bare
 * `qemu-pebble` PATH lookup (sdk/emulator.py), which fails when the binary lives
 * only inside the SDK toolchain dir.
 */
export async function resolveSdkQemuPath(): Promise<string | null> {
  const home = process.env.HOME ?? "";
  const candidates: string[] = [
    `${home}/.local/share/pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble`,
  ];
  if (process.platform === "darwin") {
    candidates.push(
      `${home}/Library/Application Support/Pebble SDK/SDKs/current/toolchain/bin/qemu-pebble`,
    );
  }
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Like `onPath` but also accepts an absolute path that the user may have
 * configured via an environment variable, or checks known SDK install locations
 * as a fallback (see resolveSdkQemuPath).
 */
async function qemuAvailable(): Promise<boolean> {
  if (await onPath("qemu-pebble")) return true;
  if (process.env.PEBBLE_QEMU_PATH) return true;
  if (await resolveSdkQemuPath()) return true;

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
    // bundled qemu; we just hand qemu the control-file path. System time writes
    // "<now> 1" to it; an absent/empty file is treated as real time by qemu.
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
    const detachSpawn = async (cmd: string, args: string[], env?: Record<string, string>): Promise<void> => {
      const child = spawn(cmd, args, { windowsHide: true, stdio: "ignore", env: { ...process.env, ...env } });
      child.unref();
      child.on("error", () => { /* readiness is checked via ports/state file */ });
    };
    const winDeps = makeWinBootDeps({ run: spawnRunner, detachSpawn, pebble });
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
      inputChannel,
      timeShim: { ctlPath },
    });
  } else if (kind === "native") {
    // macOS runs the modern uv-installed pebble-tool. Two of its behaviors differ
    // from the classic Linux SDK the native path was written against, and both are
    // reconciled here by exporting env into THIS process so every child pebble/bash
    // inherits it (mirrors the win32 branch's env setup above):
    //   1. State file: pebble-tool writes pb-emulator.json to tempfile.gettempdir()
    //      (== $TMPDIR, e.g. /var/folders/…), but the app + its embedded python
    //      helpers read /tmp/pb-emulator.json. Forcing TMPDIR=/tmp makes emu-control
    //      and every discrete `pebble` command agree on /tmp. Harmless on Linux
    //      (gettempdir is already /tmp there).
    //   2. qemu discovery: pebble-tool defaults to a bare `qemu-pebble` PATH lookup,
    //      but on macOS the binary lives only inside the SDK toolchain dir. Point
    //      PEBBLE_QEMU_PATH at the resolved binary so boot finds it.
    let macShim: NativeDriverDeps["macShim"];
    if (process.platform === "darwin") {
      process.env.TMPDIR = "/tmp";
      // Resolve the REAL SDK qemu once: it is both the raw fallback (below) and the
      // wrapper's exec target. Honour an explicit user PEBBLE_QEMU_PATH if set.
      const realQemu = process.env.PEBBLE_QEMU_PATH ?? (await resolveSdkQemuPath()) ?? "";
      if (realQemu) {
        // Fallback until ensureTimeShim() flips this to the wrapper on shim-ready.
        process.env.PEBBLE_QEMU_PATH = realQemu;
        const { wrapper, ctl } = macDeployPaths(macStudioDir());
        macShim = { realQemu, wrapper, ctl };
        // Deploy sitecustomize.py + put its isolated dir on PYTHONPATH so pebble-tool
        // and its pypkjs child can serve fake time (defeats the SetUTC clobber).
        // PYTHONPATH is harmless with no active fake-time file; PEBBLE_FAKETIME_FILE
        // is set only when the dylib is ready (ensureTimeShim), so a shim-less mac
        // stays real-time. We deliberately do NOT set PEBBLE_SIM_ENV_FILE (keeps
        // sitecustomize's sim block dormant — no pebble_studio_sim in the dir).
        const sc = await ensureMacSitecustomize();
        if (sc) process.env.PYTHONPATH = sc.env.PYTHONPATH;
      }
    }
    driver = new NativeDriver({ run: spawnRunner, macShim }); // native default boot/stop
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
