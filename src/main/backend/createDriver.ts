import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { spawnRunner } from "./spawnRunner.js";
import { selectDriverKind, type ProbeResult, type DriverKind } from "./driverFactory.js";
import { NativeDriver } from "./NativeDriver.js";
import { WslDriver } from "./WslDriver.js";
import { BundledNativeDriver } from "./BundledNativeDriver.js";
import { bootEmulator, stopEmulator, makeWslBootDeps } from "./bootEmulator.js";
import { makeBundledBootDeps } from "./bundledBootDeps.js";
import { defaultCtx, pebbleCmd, bundledToolsPresent, pebblePyExe } from "./bundledRuntime.js";
import { winFakeTimeCtlPath, winQemuFakeTimeLogPath } from "./bundledTimeShim.js";
import { simEnvPath } from "./simEnv.js";
import { winHostPaths, nativeHostEmuInfoPath } from "./hostPaths.js";
import { deployWinHelpers } from "./bundledHelpers.js";
import { BundledInputChannel, readPypkjsPort } from "./bundledInputChannel.js";
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
      : ["bash", ["-lc", `which ${cmd}`]];
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
  const sdkQemu = `${home}/.pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble`;
  try {
    await access(sdkQemu);
    return true;
  } catch {
    /* fall through */
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

type DriverClass = typeof NativeDriver | typeof WslDriver | typeof BundledNativeDriver;

/** Maps a driver kind to its class (used by createDriver + a construction test).
 * The `never` guard makes a new DriverKind member a compile error here. */
export function driverClassForKind(kind: DriverKind): DriverClass {
  if (kind === "native") return NativeDriver;
  if (kind === "wsl") return WslDriver;
  if (kind === "bundled-native") return BundledNativeDriver;
  const _never: never = kind;
  throw new Error(`Unknown driver kind: ${String(_never)}`);
}

export async function createDriver(override?: DriverKind): Promise<{ driver: BackendDriver; kind: DriverKind }> {
  // Resolve the self-contained native stack once. When the bundled
  // qemu + python are present, selection prefers bundled-native regardless of
  // the system PATH; the same ctx builds the path-independent pebble invocation.
  const ctx = await defaultCtx();
  const bundled = bundledToolsPresent(ctx);

  const probe: ProbeResult = {
    platform: process.platform,
    nativePebbleOnPath: bundled || (await onPath("pebble")),
    nativeQemuOnPath: bundled || (await qemuAvailable()),
    wslAvailable: process.platform === "win32" ? await onPath("wsl.exe") : false,
    override,
  };
  const kind = selectDriverKind(probe);

  let driver: BackendDriver;
  if (kind === "bundled-native") {
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
        PEBBLE_SIM_ENV_FILE: simEnvPath(ctx.userDataDir),
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
    const bundledDeps = makeBundledBootDeps({ run: spawnRunner, detachSpawn, pebble });
    // Deploy the persistent input helper and wire it to the bundled interpreter.
    // The input channel removes the per-press `pebble emu-button` spawn latency.
    const pyExe = pebblePyExe(ctx);
    const { inputHelperPath } = deployWinHelpers(pathJoin(ctx.userDataDir, "helpers"));
    const emuInfoPath = nativeHostEmuInfoPath();
    const inputChannel = new BundledInputChannel({
      helper: { pythonExe: pyExe, helperPath: inputHelperPath },
      readPort: () => readPypkjsPort(emuInfoPath),
    });
    driver = new BundledNativeDriver({
      run: spawnRunner,
      pebble,
      boot: (id, token, onStep) => bootEmulator(id, bundledDeps, token, onStep),
      stop: () => stopEmulator({ killAll: bundledDeps.killAll }),
      inputChannel,
      timeShim: { ctlPath },
    });
  } else if (kind === "native") {
    driver = new NativeDriver({ run: spawnRunner }); // native default boot/stop
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
