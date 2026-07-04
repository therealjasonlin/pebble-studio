/**
 * macTimeShim.ts — darwin analog of timeShim.ts (LD_PRELOAD) / winTimeShim.ts
 * (injected DLL). On macOS the lever is a Mach-O dylib force-loaded into
 * qemu-pebble via DYLD_INSERT_LIBRARIES that fakes CLOCK_REALTIME from the SAME
 * control-file contract (`<target_unix|-> <rate>`).
 *
 * POLICY: compile-from-source is the ONLY path. The timeshim.dylib + probe are
 * built from vendor/timeshim-mac/*.c (scripts/build-timeshim-mac.mjs at build
 * time; compile-on-demand here as a safety net). Nothing prebuilt is committed or
 * packaged.
 *
 * SHELL-FREE (Node fs + child_process), like winTimeShim.ts — macOS is always the
 * native driver, so no command ever crosses a shell. Everything is injectable so
 * the controller unit-tests without a real filesystem or spawned process.
 *
 * Boot flow (wired by createDriver): ensureMacTimeShim() deploys the dylib+probe to
 * ~/.pebble-studio, generates a qemu wrapper there, self-tests the inject path,
 * and — on success — createDriver points PEBBLE_QEMU_PATH at the wrapper.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, copyFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

// esbuild bundles this to CommonJS (dist/main/index.cjs) where __dirname is a
// native global; the ambient declare keeps tsc happy under the ESM tsconfig.
declare const __dirname: string;

// ---------------------------------------------------------------------------
// Well-known paths (all under $HOME/.pebble-studio — space-free by convention,
// and the SAME root the Linux/Windows tracks + setFakeTimeCmd use, so the ctl
// file the wrapper reads is exactly the one the UI writes).
// ---------------------------------------------------------------------------

/** Root deployment directory. HOME is injectable for tests. */
export function macStudioDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.HOME ?? "", ".pebble-studio");
}

/** Deployed artifact + wrapper + control paths under a studio dir. Pure. */
export interface MacDeployPaths {
  dylib: string;
  probe: string;
  wrapper: string;
  ctl: string;
}
export function macDeployPaths(studioDir: string): MacDeployPaths {
  return {
    dylib: path.join(studioDir, "timeshim.dylib"),
    probe: path.join(studioDir, "probe"),
    wrapper: path.join(studioDir, "qemu-pebble"),
    ctl: path.join(studioDir, "pb-faketime.ctl"),
  };
}

// ---------------------------------------------------------------------------
// Wrapper script content
// ---------------------------------------------------------------------------

/**
 * Content for the ~/.pebble-studio/qemu-pebble wrapper. Written directly to disk
 * (shell-free), so quotes inside are fine — the only parser is the wrapper's own
 * /bin/sh at runtime. The real qemu path has SPACES on macOS ("Library/
 * Application Support/Pebble SDK/…") so it is double-quoted.
 *
 * Uses literal $HOME (expanded by the wrapper's shell) for the dylib + ctl so the
 * ctl file matches setFakeTimeCmd's `$HOME/.pebble-studio/pb-faketime.ctl`. A
 * missing dylib → an unshimmed (real-time) boot rather than a hard failure.
 */
export function macWrapperScript(realQemuPath: string): string {
  return [
    "#!/bin/sh",
    "DYLIB=$HOME/.pebble-studio/timeshim.dylib",
    'if [ -f "$DYLIB" ]; then',
    '  export DYLD_INSERT_LIBRARIES="$DYLIB"',
    "  export PEBBLE_FAKETIME_FILE=$HOME/.pebble-studio/pb-faketime.ctl",
    "fi",
    `exec "${realQemuPath}" "$@"`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Self-test (proves the dylib actually injects + fakes, not just that it exists)
// ---------------------------------------------------------------------------

/**
 * True if `stdout` (the probe's printed time() seconds, run through the shim with
 * PEBBLE_FAKETIME_OFFSET=86400) lands within ±120s of nowSec+86400. Mirrors
 * parseWinSelfTest/parseSelfTest; the ±120s window absorbs process startup and any
 * host clock drift. Reads the LAST whitespace-separated token so any incidental
 * prefix output is ignored (the probe itself prints only the number).
 */
export function parseMacSelfTest(stdout: string, nowSec: number): boolean {
  const last = stdout.trim().split(/\s+/).pop() ?? "";
  const v = Number(last);
  return Number.isFinite(v) && Math.abs(v - (nowSec + 86400)) <= 120;
}

// ---------------------------------------------------------------------------
// Injectable adapters (so ensure* unit-tests with no real fs / process)
// ---------------------------------------------------------------------------

export interface MacExecResult { code: number; stdout: string; stderr: string; }

/** Run a binary with args and extra env merged over process.env, collecting
 * stdout+stderr. Resolves code -1 on spawn error (e.g. tool not found). */
export type MacExecRunner = (
  file: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<MacExecResult>;

function defaultExec(file: string, args: string[], env?: Record<string, string>): Promise<MacExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", () => resolve({ code: -1, stdout: out, stderr: err }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

/** Minimal filesystem surface used for deploy — injectable for tests. */
export interface MacFsAdapter {
  exists(p: string): boolean;
  mkdir(dir: string): Promise<void>;
  copyFile(src: string, dst: string): Promise<void>;
  writeFile(p: string, data: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}

const defaultFs: MacFsAdapter = {
  exists: (p) => existsSync(p),
  mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
  copyFile: (src, dst) => copyFile(src, dst),
  writeFile: (p, data) => writeFile(p, data, "utf8"),
  chmod: (p, mode) => chmod(p, mode),
};

export interface MacShimDeps {
  exec?: MacExecRunner;
  fs?: MacFsAdapter;
  now?: () => number;
  /** Override the deploy root (default `$HOME/.pebble-studio`). */
  studioDir?: string;
  /** Override the compiled-artifact/source search (default: vendor/resources). */
  sourceDir?: string;
  /** Override the sitecustomize.py source path (default: vendor/resources search). */
  sitecustomizeSrc?: string;
  /** Existing PYTHONPATH to prepend onto (default: process.env.PYTHONPATH). */
  existingPythonPath?: string;
  /** Electron packaged resources root (defaults to process.resourcesPath). */
  resourcesPath?: string;
}

const XCODE_HINT = "Xcode Command Line Tools required: xcode-select --install";

// ---------------------------------------------------------------------------
// Locate compiled artifacts (compile-on-demand from .c if missing/stale)
// ---------------------------------------------------------------------------

/** Candidate directories holding vendor/timeshim-mac (packaged, dev, cwd). */
function candidateSourceDirs(resourcesPath: string | undefined): string[] {
  const dirBase = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  return [
    resourcesPath ? path.join(resourcesPath, "timeshim-mac") : null,
    path.join(dirBase, "..", "..", "..", "vendor", "timeshim-mac"),
    path.join(process.cwd(), "vendor", "timeshim-mac"),
  ].filter((b): b is string => !!b);
}

export interface MacShimSource { dir: string; dylib: string; probe: string; }

/**
 * Resolve the compiled dylib + probe. Picks the first candidate dir that has the
 * .c sources, then ensures the two binaries exist there — compiling from source
 * (clang universal + ad-hoc codesign) if either is missing. Throws if no source
 * dir is found or the toolchain is unavailable/compile fails.
 */
async function locateMacShimArtifacts(deps: MacShimDeps): Promise<MacShimSource> {
  const fs = deps.fs ?? defaultFs;
  const exec = deps.exec ?? defaultExec;
  const bases = deps.sourceDir ? [deps.sourceDir] : candidateSourceDirs(deps.resourcesPath);
  const dir = bases.find((b) => fs.exists(path.join(b, "timeshim.c")) && fs.exists(path.join(b, "probe.c")));
  if (!dir) throw new Error("mac timeshim sources not found in: " + bases.join(", "));

  const dylibSrc = path.join(dir, "timeshim.c");
  const probeSrc = path.join(dir, "probe.c");
  const dylib = path.join(dir, "timeshim.dylib");
  const probe = path.join(dir, "probe");

  if (!fs.exists(dylib) || !fs.exists(probe)) {
    // Compile-on-demand — universal (arm64+x86_64), then ad-hoc sign both.
    const steps: Array<[string, string[]]> = [
      ["clang", ["-dynamiclib", "-arch", "arm64", "-arch", "x86_64", "-O2", "-o", dylib, dylibSrc]],
      ["clang", ["-arch", "arm64", "-arch", "x86_64", "-O2", "-o", probe, probeSrc]],
      ["codesign", ["-s", "-", "--force", dylib]],
      ["codesign", ["-s", "-", "--force", probe]],
    ];
    for (const [cmd, args] of steps) {
      const r = await exec(cmd, args);
      if (r.code !== 0) {
        console.error(`[macTimeShim] ${cmd} failed (compile-on-demand): ${r.stderr.trim()}`);
        console.error(`[macTimeShim] ${XCODE_HINT}`);
        throw new Error(`mac timeshim compile failed at ${cmd}`);
      }
    }
  }
  return { dir, dylib, probe };
}

// ---------------------------------------------------------------------------
// Deploy + self-test
// ---------------------------------------------------------------------------

async function deployMacShim(
  deps: MacShimDeps,
  source: MacShimSource,
  paths: MacDeployPaths,
  studioDir: string,
  realQemuPath: string,
): Promise<void> {
  const fs = deps.fs ?? defaultFs;
  const exec = deps.exec ?? defaultExec;

  await fs.mkdir(studioDir);
  await fs.copyFile(source.dylib, paths.dylib);
  await fs.copyFile(source.probe, paths.probe);
  await fs.chmod(paths.probe, 0o755);

  // Best-effort re-sign after the copy. fs.copyFile preserves the embedded
  // signature, so the copied binaries are normally already valid — this only
  // repairs a stripped signature. A missing/failing codesign is NOT fatal: the
  // self-test is the real arbiter of whether the dylib loads.
  for (const p of [paths.dylib, paths.probe]) {
    const r = await exec("codesign", ["-s", "-", "--force", p]);
    if (r.code !== 0) {
      console.warn(`[macTimeShim] codesign --force ${p} failed (continuing): ${r.stderr.trim()}`);
    }
  }

  await fs.writeFile(paths.wrapper, macWrapperScript(realQemuPath));
  await fs.chmod(paths.wrapper, 0o755);
}

/** Run the deployed probe THROUGH the deployed dylib (+1 day, no ctl) so a pass
 * proves the inject+interpose path end-to-end. */
async function selfTestMacShim(deps: MacShimDeps, paths: MacDeployPaths): Promise<boolean> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? (() => Date.now());
  const r = await exec(paths.probe, [], {
    DYLD_INSERT_LIBRARIES: paths.dylib,
    PEBBLE_FAKETIME_OFFSET: "86400",
    PEBBLE_FAKETIME_FILE: "", // override any stale inherited control file
  });
  return r.code === 0 && parseMacSelfTest(r.stdout, now() / 1000);
}

// ---------------------------------------------------------------------------
// Readiness cache (tri-state + single-flight, like timeShim/winTimeShim)
// ---------------------------------------------------------------------------

let shimReady: boolean | null = null;
let shimReadyPromise: Promise<boolean> | null = null;

export function isMacShimReady(): boolean { return shimReady === true; }
export function _resetMacShimState(): void { shimReady = null; shimReadyPromise = null; }

async function runMacEnsure(realQemuPath: string, deps: MacShimDeps): Promise<boolean> {
  try {
    const studioDir = deps.studioDir ?? macStudioDir();
    const paths = macDeployPaths(studioDir);
    const source = await locateMacShimArtifacts(deps);
    await deployMacShim(deps, source, paths, studioDir, realQemuPath);
    shimReady = await selfTestMacShim(deps, paths);
  } catch {
    shimReady = false;
  }
  // A FAILED attempt stays retryable (next boot / time-apply tries again); a
  // SUCCESS is cached for the session.
  if (shimReady !== true) shimReadyPromise = null;
  return shimReady === true;
}

/**
 * Idempotent: compile-on-demand → deploy (dylib, probe, wrapper) → self-test →
 * cache. Concurrent callers join one in-flight check. Never throws — any failure
 * (no toolchain, bad sign, dylib won't load) degrades the feature to disabled.
 *
 * @param realQemuPath absolute path to the REAL SDK qemu-pebble the wrapper execs.
 */
export function ensureMacTimeShim(realQemuPath: string, deps: MacShimDeps = {}): Promise<boolean> {
  if (shimReadyPromise !== null) return shimReadyPromise;
  shimReadyPromise = runMacEnsure(realQemuPath, deps);
  return shimReadyPromise;
}

// ---------------------------------------------------------------------------
// sitecustomize on the pebble-tool python (defeat the SetUTC clobber)
// ---------------------------------------------------------------------------
//
// The dylib fakes qemu's RTC, but pebble-tool + pypkjs run as SEPARATE python
// processes on the REAL clock and push SetUTC(int(time.time())) on connect,
// jamming the watch back to real time. The repo's sitecustomize.py monkeypatches
// time.time()/localtime()/gmtime() against the SAME PEBBLE_FAKETIME_FILE contract;
// dropping it on PYTHONPATH makes pebble-tool AND its pypkjs child serve fake time.
//
// It is deployed ALONE into an isolated dir — NOT the whole vendor site-packages,
// which ships a pypkjs/ that would shadow the tool's own. Its sim block stays
// dormant unless PEBBLE_SIM_ENV_FILE is set (we don't set it on darwin).

/** Isolated dir holding ONLY sitecustomize.py (kept off the tool's own packages). */
export function macSitecustomizeDir(studioDir: string): string {
  return path.join(studioDir, "py");
}

/**
 * Env fragment that makes the pebble-tool python serve FAKE time. Pure. Prepends
 * the isolated sitecustomize dir to any existing PYTHONPATH so the tool's own
 * modules still resolve, and points PEBBLE_FAKETIME_FILE at the SAME ctl the
 * dylib + setFakeTimeCmd use (lock-step).
 */
export function macPythonEnv(
  sitecustomizeDir: string,
  ctlPath: string,
  existingPythonPath?: string,
): { PYTHONPATH: string; PEBBLE_FAKETIME_FILE: string } {
  const PYTHONPATH = existingPythonPath
    ? `${sitecustomizeDir}${path.delimiter}${existingPythonPath}`
    : sitecustomizeDir;
  return { PYTHONPATH, PEBBLE_FAKETIME_FILE: ctlPath };
}

/** Candidate sitecustomize.py locations (packaged, dev, cwd). */
function candidateSitecustomizeSrcs(resourcesPath: string | undefined): string[] {
  const dirBase = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  const vendorRel = ["vendor", "pebble-py", "Lib", "site-packages", "sitecustomize.py"];
  return [
    resourcesPath ? path.join(resourcesPath, "pebble-py", "sitecustomize.py") : null,
    resourcesPath ? path.join(resourcesPath, "sitecustomize.py") : null,
    path.join(dirBase, "..", "..", "..", ...vendorRel),
    path.join(process.cwd(), ...vendorRel),
  ].filter((b): b is string => !!b);
}

export interface MacSitecustomizeResult {
  dir: string;
  env: { PYTHONPATH: string; PEBBLE_FAKETIME_FILE: string };
}

/**
 * Deploy sitecustomize.py (that file ONLY) into ~/.pebble-studio/py and return the
 * env fragment to merge into the emu-control launch env. Never throws — a missing
 * source degrades to null (pebble-tool then serves real time, i.e. today's
 * behavior). Idempotent: copyFile overwrites.
 *
 * @returns the isolated dir + env, or null if the source could not be found.
 */
export async function ensureMacSitecustomize(deps: MacShimDeps = {}): Promise<MacSitecustomizeResult | null> {
  const fs = deps.fs ?? defaultFs;
  try {
    const studioDir = deps.studioDir ?? macStudioDir();
    const dir = macSitecustomizeDir(studioDir);
    const srcs = deps.sitecustomizeSrc ? [deps.sitecustomizeSrc] : candidateSitecustomizeSrcs(deps.resourcesPath);
    const src = srcs.find((s) => fs.exists(s));
    if (!src) {
      console.warn(`[macTimeShim] sitecustomize.py not found in: ${srcs.join(", ")}`);
      return null;
    }
    await fs.mkdir(dir);
    await fs.copyFile(src, path.join(dir, "sitecustomize.py"));
    const ctl = macDeployPaths(studioDir).ctl;
    const existing = deps.existingPythonPath ?? process.env.PYTHONPATH;
    return { dir, env: macPythonEnv(dir, ctl, existing) };
  } catch {
    return null;
  }
}
