/**
 * timeShim.ts — deploy + self-test command builders for the LD_PRELOAD time shim.
 *
 * WHY A SHIM: qemu-pebble's RTC is slaved to host UTC; `emu-set-time` and the
 * SetUTC `unix_time` field are both ignored. The only real knob is `utc_offset`,
 * which shifts the displayed time but NOT the wall-clock rate. To get true
 * custom date, freeze, and time-rate, we LD_PRELOAD a shim that intercepts
 * clock_gettime(CLOCK_REALTIME) and reads a control file at runtime.
 *
 * IRON RULE (cost two releases to pin down):
 * Every command string that goes through the app's Shell/Runner crosses
 *   wsl.exe -- bash -lc "..."
 * on Windows. That means ZERO single or double quotes may appear in any
 * command string. File CONTENT is exempt because it travels base64-encoded
 * (the base64 alphabet: A-Z a-z 0-9 + / = is entirely shell-safe and can be
 * echo'd UNQUOTED). Commands must also stay ≤ ~4KB each (chunked base64).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PebbleCommand } from "./pebbleCli.js";

// esbuild bundles this file to CommonJS (dist/main/index.cjs) where __dirname
// is a native global. The ambient declare keeps tsc happy under the ESM
// (nodenext) tsconfig used for `npm run typecheck`.
declare const __dirname: string;

// ---------------------------------------------------------------------------
// Well-known paths — all under $HOME/.pebble-studio, which is space-free and
// quote-free by definition (POSIX home dirs almost never have spaces; we
// enforce this via the constant rather than quoting).
// ---------------------------------------------------------------------------

/** Root deployment directory on the target (WSL or native Linux). */
export const STUDIO_DIR = "$HOME/.pebble-studio";
/** Deployed shim shared object. */
export const SHIM_SO = `${STUDIO_DIR}/timeshim.so`;
/** Deployed shim C source (kept for the glibc-mismatch compile fallback). */
export const SHIM_SRC = `${STUDIO_DIR}/timeshim.c`;
/** Wrapper script that activates LD_PRELOAD and delegates to the real qemu. */
export const WRAPPER = `${STUDIO_DIR}/qemu-pebble`;
/** Control file: one line `<target_unix|-> <rate>`, re-read by the shim on mtime change. */
export const CTL_PATH = `${STUDIO_DIR}/pb-faketime.ctl`;

// ---------------------------------------------------------------------------
// Base64 chunking
// ---------------------------------------------------------------------------

/**
 * Split a base64 string into chunks of at most `max` characters.
 * Each chunk is safe to `echo` UNQUOTED through the shell — the base64
 * alphabet contains no shell metacharacters. Chunks are 4000 chars by
 * default to stay well under the ~32 KB wsl.exe argv limit even with shell
 * overhead.
 */
export function chunkB64(b64: string, max = 4000): string[] {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += max) out.push(b64.slice(i, i + max));
  return out;
}

// ---------------------------------------------------------------------------
// File deployment
// ---------------------------------------------------------------------------

/**
 * Build a quote-free command sequence that materialises `bytes` at
 * `STUDIO_DIR/<name>` on the target.
 *
 * Strategy:
 *   1. mkdir + clear any leftover .b64 accumulator file
 *   2. `echo <chunk> >> file.b64`  for each base64 chunk (no quotes needed —
 *      the base64 alphabet is shell-safe)
 *   3. `base64 -d file.b64 > file && rm file.b64`
 *      (+ `&& chmod +x file` only when executable=true)
 *
 * One code path works for both native Linux and WSL because we never reference
 * /mnt/c or Windows paths.
 *
 * @param name        Filename relative to STUDIO_DIR.
 * @param bytes       File content to deploy.
 * @param executable  Whether to `chmod +x` the deployed file (default true).
 *                    Pass false for plain data files such as the .c source.
 */
export function deployFileCmds(name: string, bytes: Buffer, executable = true): string[] {
  const target = `${STUDIO_DIR}/${name}`;
  const b64 = bytes.toString("base64");
  const cmds: string[] = [`mkdir -p ${STUDIO_DIR} && rm -f ${target}.b64`];
  for (const c of chunkB64(b64)) cmds.push(`echo ${c} >> ${target}.b64`);
  const finalCmd = executable
    ? `base64 -d ${target}.b64 > ${target} && rm -f ${target}.b64 && chmod +x ${target}`
    : `base64 -d ${target}.b64 > ${target} && rm -f ${target}.b64`;
  cmds.push(finalCmd);
  return cmds;
}

// ---------------------------------------------------------------------------
// Wrapper script content
// ---------------------------------------------------------------------------

/**
 * Content for the qemu-pebble wrapper script deployed at STUDIO_DIR.
 * Quotes inside are fine here — this content travels base64-encoded and is
 * never seen by the shell command parser.
 *
 * The wrapper:
 *   - Activates LD_PRELOAD + PEBBLE_FAKETIME_FILE if the .so exists (so
 *     a missing shim causes an unshimmed boot rather than a hard failure)
 *   - Delegates via `exec` to the real qemu-pebble under the current SDK
 *     symlink so pebble-tool's auto-install keeps working.
 */
export function wrapperScript(): string {
  return [
    "#!/bin/sh",
    `SO=$HOME/.pebble-studio/timeshim.so`,
    `if [ -f $SO ]; then export LD_PRELOAD=$SO; export PEBBLE_FAKETIME_FILE=$HOME/.pebble-studio/pb-faketime.ctl; fi`,
    `exec $HOME/.pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble "$@"`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * A quote-free shell command that fakes CLOCK_REALTIME forward by 86400s
 * (exactly one day) and prints `date +%s`. If the shim is loaded correctly the
 * output should be ≈ now+86400; parseSelfTest validates that.
 *
 * PEBBLE_FAKETIME_OFFSET is a convenience env var read by the shim for quick
 * self-tests without writing a control file.
 */
export function selfTestCmd(): string {
  return `PEBBLE_FAKETIME_OFFSET=86400 LD_PRELOAD=${SHIM_SO} date +%s`;
}

/**
 * Returns true if `stdout` parses as a Unix timestamp within ±120s of the
 * expected faked time (`nowSec + 86400`). The 120s tolerance absorbs process
 * start-up time and any host clock drift during the test.
 */
export function parseSelfTest(stdout: string, nowSec: number): boolean {
  const v = Number(stdout.trim());
  return Number.isFinite(v) && Math.abs(v - (nowSec + 86400)) <= 120;
}

// ---------------------------------------------------------------------------
// Compile fallback
// ---------------------------------------------------------------------------

/**
 * Rebuild the .so from the deployed source when the pre-built binary was
 * linked against a different glibc than the target system has. Quote-free:
 * paths use $-vars, no spaces, no quotes. Tries `cc` first, falls back to
 * `gcc` explicitly (some minimal distros alias cc differently).
 */
export function compileShimCmd(): string {
  return `cc -O2 -fPIC -shared -o ${SHIM_SO} ${SHIM_SRC} -ldl 2>&1 || gcc -O2 -fPIC -shared -o ${SHIM_SO} ${SHIM_SRC} -ldl`;
}

// ---------------------------------------------------------------------------
// Control-file writer
// ---------------------------------------------------------------------------

/**
 * Build a PebbleCommand that writes the faketime control file.
 * Format: `<target_unix|-> <rate>`
 *   - `targetUnix` null  → `-`  (rate-only mode; shim uses current real time
 *     as base and applies only the rate multiplier)
 *   - `rate` 0            → freeze (shim ignores elapsed real time)
 *   - `rate` 1            → real-time passthrough
 *   - `rate` N>1          → fast-forward at N×
 *
 * Uses integer arithmetic (Math.trunc) so the value is numeric-only → quote-free.
 * Both interpolated tokens are coerced to plain integers: TS types are erased at
 * runtime, so this guarantees the string crossing `wsl.exe -- bash -lc` can never
 * carry shell metacharacters even if a caller passes a non-numeric value.
 */
export function setFakeTimeCmd(targetUnix: number | null, rate: number): PebbleCommand {
  const t = targetUnix === null ? "-" : String(Math.trunc(targetUnix));
  const r = String(Number.isFinite(rate) ? Math.trunc(rate) : 0);
  // echo <t> <r> — all numerics / "-", zero quotes. > not < so no escaping.
  return { cmd: "bash", args: ["-lc", `echo ${t} ${r} > ${CTL_PATH}`] };
}

// ---------------------------------------------------------------------------
// Resource loader
// ---------------------------------------------------------------------------

/**
 * Read the shim binary and source from the best available location:
 *   1. `<resourcesPath>/timeshim/`  — packaged Electron app (electron-builder
 *      copies vendor/timeshim here via the extraResources entry in
 *      electron-builder.yml)
 *   2. `<__dirname>/../../../vendor/timeshim/`  — development tree (esbuild
 *      outputs to dist/main/index.cjs, so three levels up = repo root)
 *   3. `<cwd>/vendor/timeshim/`  — vitest / direct-node fallback
 */
export async function readShimResources(
  // process.resourcesPath is an Electron main-process addition; access it
  // structurally so this file also typechecks in programs WITHOUT the electron
  // ambient augmentation (the renderer tsconfig reaches this file through the
  // type-only chain vncClient → BackendDriver → bootEmulator → timeShim).
  resourcesPath: string | undefined = typeof process !== "undefined"
    ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    : undefined,
): Promise<{ so: Buffer; src: Buffer }> {
  // __dirname is defined at runtime in the esbuild CJS bundle; in vitest it
  // resolves through the declare above. Fall back to cwd if truly absent.
  const dirBase = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  const bases = [
    resourcesPath ? path.join(resourcesPath, "timeshim") : null,
    path.join(dirBase, "..", "..", "..", "vendor", "timeshim"),
    path.join(process.cwd(), "vendor", "timeshim"),
  ].filter((b): b is string => !!b);

  let lastErr: unknown = null;
  for (const b of bases) {
    try {
      const so = await readFile(path.join(b, "timeshim-x86_64.so"));
      const src = await readFile(path.join(b, "timeshim.c"));
      return { so, src };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`timeshim resources not found: ${String(lastErr)}`);
}

// ---------------------------------------------------------------------------
// Runner type + readiness cache
// ---------------------------------------------------------------------------

/** A minimal shell runner interface (provided by NativeDriver/WslDriver adapters). */
export type ShimRunner = (cmdline: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Tri-state: null = never checked, true/false = cached result. */
let shimReady: boolean | null = null;

/**
 * In-flight Promise cache: if a call to ensureTimeShim is already running,
 * subsequent concurrent callers join it rather than starting a duplicate
 * deploy sequence. Cleared only by _resetShimState().
 */
let shimReadyPromise: Promise<boolean> | null = null;

/** Returns the cached shim readiness (false if never checked). */
export function isShimReady(): boolean { return shimReady === true; }

/** Reset cached state — used in tests and for future "force-redeploy" UX. */
export function _resetShimState(): void { shimReady = null; shimReadyPromise = null; }

// ---------------------------------------------------------------------------
// ensureTimeShim — idempotent deploy + self-test
// ---------------------------------------------------------------------------

/**
 * Deploy the shim (so, source, wrapper) then self-test. If the pre-built .so
 * fails the self-test (glibc mismatch), recompile from source and re-test.
 * Result is cached; subsequent calls return immediately without re-running.
 *
 * Never throws — failures are caught and recorded as `shimReady = false`.
 *
 * @param run   Shell runner (one bash command string → {code, stdout, stderr})
 * @param deps  Injectable overrides for testing: `resources` loader, `now`
 *              clock (returns ms like Date.now())
 */
/**
 * Inner implementation — called at most once per shimReadyPromise lifetime.
 * Separating it out keeps the public API clean and allows shimReady to be set
 * for isShimReady() even when callers share a single Promise.
 */
async function runEnsure(
  run: ShimRunner,
  deps: {
    resources?: () => Promise<{ so: Buffer; src: Buffer }>;
    now?: () => number;
  },
): Promise<boolean> {
  try {
    const { so, src } = await (deps.resources ?? readShimResources)();

    // Deploy binary (executable), source (NOT executable), and wrapper script (executable).
    for (const c of deployFileCmds("timeshim.so", so)) await run(c);
    for (const c of deployFileCmds("timeshim.c", src, false)) await run(c);
    for (const c of deployFileCmds("qemu-pebble", Buffer.from(wrapperScript()))) await run(c);

    const nowMs = (deps.now ?? (() => Date.now()));

    // First self-test attempt with the pre-built binary. The clock is re-read
    // immediately before each parse so a slow compile between attempts can't
    // drift the ±120s acceptance window.
    let r = await run(selfTestCmd());
    if (!(r.code === 0 && parseSelfTest(r.stdout, nowMs() / 1000))) {
      // Pre-built .so failed (likely glibc mismatch): rebuild from deployed source.
      await run(compileShimCmd());
      r = await run(selfTestCmd());
    }

    shimReady = r.code === 0 && parseSelfTest(r.stdout, nowMs() / 1000);
  } catch {
    shimReady = false;
  }

  // A FAILED deploy stays retryable: clear the promise cache so the next
  // explicit ensureTimeShim() call (boot / time-apply — low frequency) tries
  // again after e.g. a transient fs/WSL hiccup. isShimReady() stays false in
  // the meantime. A SUCCESS remains permanently cached for the session.
  if (shimReady !== true) shimReadyPromise = null;

  return shimReady!;
}

export function ensureTimeShim(
  run: ShimRunner,
  deps: {
    resources?: () => Promise<{ so: Buffer; src: Buffer }>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  if (shimReadyPromise !== null) return shimReadyPromise;
  shimReadyPromise = runEnsure(run, deps);
  return shimReadyPromise;
}
