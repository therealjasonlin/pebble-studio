/**
 * winTimeShim.ts — native-Windows analog of timeShim.ts (the LD_PRELOAD shim).
 *
 * On Linux true custom time comes from an LD_PRELOAD .so faking
 * clock_gettime(CLOCK_REALTIME) for the qemu process. Windows has no LD_PRELOAD,
 * so we ship the same lever as an INJECTED DLL (vendor/timeshim-win/):
 *   - timeshim-win.dll  inline-hooks KERNEL32 GetSystemTimeAsFileTime +
 *     GetSystemTimePreciseAsFileTime (which MinGW's clock_gettime/gettimeofday —
 *     the calls qemu-pebble actually makes — bottom out on) and serves a fake
 *     clock driven by the SAME control-file contract (`<target_unix|-> <rate>`).
 *   - launcher.exe  is pointed at by PEBBLE_QEMU_PATH; pebble-tool spawns it as
 *     "qemu", and it CreateProcess(real qemu, SUSPENDED) → injects the DLL →
 *     resumes. A no-op passthrough when the control file holds system time.
 *   - probe.exe  is the self-test target (prints clock_gettime once).
 *
 * Unlike timeShim.ts this is SHELL-FREE (Node fs + child_process), matching the
 * rest of the windows-native driver. Pure/injectable so it unit-tests on Linux.
 */
import { spawn } from "node:child_process";
import { writeFile as fsWriteFile, appendFile as fsAppendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { win32 as winPath } from "node:path";

/** Resolved paths to the three bundled shim artifacts (under timeShimWinDir). */
export interface WinShimPaths {
  dll: string;
  launcher: string;
  probe: string;
}

/** Build the three artifact paths from the bundle directory. Pure. */
export function winShimPaths(dir: string): WinShimPaths {
  return {
    dll: winPath.join(dir, "timeshim-win.dll"),
    launcher: winPath.join(dir, "launcher.exe"),
    probe: winPath.join(dir, "probe.exe"),
  };
}

/** Control file path: `%TEMP%\pb-faketime.ctl` (re-read by the DLL on mtime
 * change). `%TEMP%` matches where pebble-tool writes its own state file, so the
 * file is writable and co-located. Pure (env injectable). */
export function winFakeTimeCtlPath(env: Record<string, string | undefined> = process.env): string {
  const temp = env.TEMP || env.TMP || "C:\\Windows\\Temp";
  return winPath.join(temp, "pb-faketime.ctl");
}

/** Where the patched qemu writes its fake-time diagnostic log (`%TEMP%\pb-qemu-ft.log`),
 * passed to qemu as PEBBLE_FAKETIME_LOG. Confirms the control file is reaching qemu
 * and what time it serves. Pure (env injectable). */
export function winQemuFakeTimeLogPath(env: Record<string, string | undefined> = process.env): string {
  const temp = env.TEMP || env.TMP || "C:\\Windows\\Temp";
  return winPath.join(temp, "pb-qemu-ft.log");
}

// ---------------------------------------------------------------------------
// DIAGNOSTIC INSTRUMENTATION (session 7 — "custom time reverts" investigation)
// ---------------------------------------------------------------------------

/** Where the injected DLL appends its load-marker / ctl-reread / heartbeat lines
 * (`%TEMP%\pb-faketime-dll.log`). Passed to the launcher env so the path is
 * explicit + matches the user-collection instructions. Pure (env injectable). */
export function winFakeTimeDllLogPath(env: Record<string, string | undefined> = process.env): string {
  const temp = env.TEMP || env.TMP || "C:\\Windows\\Temp";
  return winPath.join(temp, "pb-faketime-dll.log");
}

/** Where the main process logs every ctl write (`%TEMP%\pb-faketime-ts.log`).
 * Correlate its timestamps with the DLL log to bisect TS-clobber vs unhooked
 * clock source. Pure (env injectable). */
export function winFakeTimeTsLogPath(env: Record<string, string | undefined> = process.env): string {
  const temp = env.TEMP || env.TMP || "C:\\Windows\\Temp";
  return winPath.join(temp, "pb-faketime-ts.log");
}

/** Append one line recording a ctl write: timestamp, target, rate, and the
 * caller chain (so a stray System `<now> 1` write after a custom set is visible
 * WITH who triggered it). Best-effort — never throws. */
export async function logWinFakeTimeWrite(
  targetUnix: number | null,
  rate: number,
  stack: string | undefined,
  nowIso: string,
  logPath: string = winFakeTimeTsLogPath(),
  append: (p: string, data: string) => Promise<void> = (p, d) => fsAppendFile(p, d, "utf8"),
): Promise<void> {
  // Drop the Error() + this-frame lines; keep the meaningful caller chain.
  const frames = (stack ?? "").split("\n").slice(2, 7).map((s) => s.trim()).join(" <- ");
  try {
    await append(logPath, `[${nowIso}] setFakeTime tgt=${targetUnix} rate=${rate} :: ${frames}\n`);
  } catch {
    /* logging must never break time control */
  }
}

/**
 * Write the faketime control file: `<target_unix|-> <rate>` (same format as the
 * Linux setFakeTimeCmd). `targetUnix` null → `-` (keep current fake, rate-only);
 * rate 0 → freeze, 1 → real-time, N → N×. Integer target (quote-free, numeric).
 */
export async function writeWinFakeTime(
  ctlPath: string,
  targetUnix: number | null,
  rate: number,
  write: (p: string, data: string) => Promise<void> = (p, data) => fsWriteFile(p, data, "utf8"),
): Promise<void> {
  const t = targetUnix === null ? "-" : String(Math.trunc(targetUnix));
  await write(ctlPath, `${t} ${rate}`);
}

// ---------------------------------------------------------------------------
// Self-test (proves the DLL actually injects + fakes, not just that it exists)
// ---------------------------------------------------------------------------

/**
 * True if `stdout` (the probe's printed clock_gettime seconds, run through the
 * launcher with PEBBLE_FAKETIME_OFFSET=86400) lands within ±120s of nowSec+86400.
 * Mirrors parseSelfTest in timeShim.ts; the ±120s window absorbs process startup.
 */
export function parseWinSelfTest(stdout: string, nowSec: number): boolean {
  const last = stdout.trim().split(/\s+/).pop() ?? "";
  const v = Number(last);
  return Number.isFinite(v) && Math.abs(v - (nowSec + 86400)) <= 120;
}

/** Shell-free runner: spawn an exe with extra env merged over process.env, collect
 * stdout. Injectable so the self-test is unit-testable without a real process. */
export type ShimExecRunner = (
  exe: string,
  env: Record<string, string>,
) => Promise<{ code: number; stdout: string }>;

function defaultExec(exe: string, env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, [], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => resolve({ code: -1, stdout: out }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: out }));
  });
}

export interface WinShimEnsureDeps {
  exec?: ShimExecRunner;
  now?: () => number;
  exists?: (p: string) => boolean;
}

/** Tri-state readiness cache (module-global, like timeShim.ts): null = never
 * checked, true/false = cached. The boot routing reads isWinShimReady(). */
let shimReady: boolean | null = null;
let shimReadyPromise: Promise<boolean> | null = null;

export function isWinShimReady(): boolean { return shimReady === true; }
export function _resetWinShimState(): void { shimReady = null; shimReadyPromise = null; }

async function runWinEnsure(paths: WinShimPaths, deps: WinShimEnsureDeps): Promise<boolean> {
  const exists = deps.exists ?? existsSync;
  // Missing bundle (e.g. an old build, or a dev tree before the binaries are
  // built) → not ready, fall back to no custom time. Never throws.
  if (!exists(paths.dll) || !exists(paths.launcher) || !exists(paths.probe)) {
    shimReady = false;
    shimReadyPromise = null;
    return false;
  }
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? (() => Date.now());
  try {
    // Run the probe THROUGH the launcher (real injection) with a +1 day offset and
    // NO control file, so a pass proves the inject+hook path end-to-end.
    const r = await exec(paths.launcher, {
      PEBBLE_FAKETIME_REAL_QEMU: paths.probe,
      PEBBLE_FAKETIME_DLL: paths.dll,
      PEBBLE_FAKETIME_OFFSET: "86400",
      PEBBLE_FAKETIME_FILE: "", // override any stale inherited control file
    });
    shimReady = r.code === 0 && parseWinSelfTest(r.stdout, now() / 1000);
  } catch {
    shimReady = false;
  }
  // A FAILED check stays retryable (next boot tries again); SUCCESS is cached.
  if (shimReady !== true) shimReadyPromise = null;
  return shimReady === true;
}

/** Idempotent: deploy is a no-op (the binaries are bundled read-only resources),
 * so this only self-tests + caches. Concurrent callers join one in-flight check. */
export function ensureWinTimeShim(paths: WinShimPaths, deps: WinShimEnsureDeps = {}): Promise<boolean> {
  if (shimReadyPromise !== null) return shimReadyPromise;
  shimReadyPromise = runWinEnsure(paths, deps);
  return shimReadyPromise;
}
