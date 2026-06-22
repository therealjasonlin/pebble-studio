/**
 * winSdkProvision.ts — first-run SDK provisioning for the native-Windows track.
 *
 * pebble-tool needs a **writable** persist dir: it decompresses the SPI flash,
 * writes the emulator state file, and resolves the SDK via a `current` link. The
 * SDK we ship (`vendor/pebble-sdk`, → `resources/pebble-sdk` when packaged) is
 * READ-ONLY, so on first launch we materialise a writable copy under the app-data
 * persist dir that the invocation contract points at via XDG_DATA_HOME.
 *
 * Persist dir = winRuntime.pebbleDataDir(ctx) = `<userData>\pebble-data`.
 * pebble-tool's get_persist_dir() joins XDG_DATA_HOME + "pebble-sdk", so the SDK
 * lands at `<pebbleDataDir>\pebble-sdk\SDKs\<ver>\sdk-core`.
 *
 * Idempotent: every step is a no-op when its output already exists + validates,
 * so it is safe to run on every launch (it runs once at backend:init).
 *
 * Layout produced (mirrors the proven dev provisioning):
 *   <persist>\pebble-sdk\SDKs\<ver>\sdk-core\            (copied from the bundle)
 *   <persist>\pebble-sdk\SDKs\<ver>\toolchain\lib\pc-bios\keymaps\  (seeded from qemu bundle)
 *   <persist>\pebble-sdk\SDKs\current  →  <persist>\pebble-sdk\SDKs\<ver>   (junction)
 *
 * The PURE helpers (pickSdkVersion / isSdkCoreManifestValid / planSdkProvision)
 * are unit-tested on any host; the effectful runner takes an injectable `ProvisionFs`
 * so the orchestration logic is tested without touching disk.
 */

import { join, dirname, resolve } from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  cp,
  copyFile,
  symlink,
  rm,
  stat,
  readlink,
} from "node:fs/promises";
import type { BundledRuntimeCtx } from "./bundledRuntime.js";
import { sdkBundleRoot, qemuExe, pebbleDataDir } from "./bundledRuntime.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Matches a bare SDK version dir name like `4.9.169` or `4.9`. */
const VERSION_RE = /^\d+(\.\d+)+$/;

/**
 * Boards whose emulator firmware blobs are versioned by the sdk-core `.fw-rev`
 * marker — the Cortex-M4 (stm32f4) watches whose qemu flash images we patched,
 * plus the Cortex-M33 watches (emery/gabbro/flint) whose firmware we swapped to
 * the full PebbleOS launcher. Listed as a constant so adding a board to the
 * fw-refresh is a one-line change.
 */
export const FW_REFRESH_BOARDS = ["basalt", "chalk", "diorite", "emery", "gabbro", "flint"] as const;

/** The two per-board qemu firmware blobs the `.fw-rev` marker versions. */
export const FW_REFRESH_BLOBS = ["qemu_micro_flash.bin", "qemu_spi_flash.bin.bz2"] as const;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pick the SDK version to provision from the entries of the bundle's `SDKs\` dir.
 * Excludes the `current` link and any non-version entries; returns the highest
 * version, or null when none is present.
 */
export function pickSdkVersion(entries: string[]): string | null {
  const versions = entries.filter((e) => e !== "current" && VERSION_RE.test(e));
  if (versions.length === 0) return null;
  versions.sort(compareVersions);
  return versions[versions.length - 1];
}

/**
 * Validate a copied `sdk-core/manifest.json`: it must parse and declare the
 * expected sdk-core version. A missing/garbled/wrong-version manifest means the
 * copy is absent or incomplete and must be (re-)done.
 */
export function isSdkCoreManifestValid(raw: string, expectVersion: string): boolean {
  try {
    const o = JSON.parse(raw) as { type?: unknown; version?: unknown };
    return o?.type === "sdk-core" && o?.version === expectVersion;
  } catch {
    return false;
  }
}

/** All resolved paths involved in provisioning a given version. PURE. */
export interface SdkPaths {
  version: string;
  /** Bundle (read-only) sdk-core to copy FROM. */
  bundleSdkCore: string;
  /** Bundle keymaps source (the qemu bundle's pc-bios\keymaps). */
  keymapsSrc: string;
  /** `<persist>\pebble-sdk\SDKs` */
  persistSdks: string;
  /** `<persist>\pebble-sdk\SDKs\<ver>` (the junction target). */
  targetVersionDir: string;
  /** `<persist>\pebble-sdk\SDKs\<ver>\sdk-core` */
  targetSdkCore: string;
  /** `<targetSdkCore>\manifest.json` */
  targetManifest: string;
  /** `<persist>\pebble-sdk\SDKs\<ver>\toolchain\lib\pc-bios\keymaps` */
  targetKeymaps: string;
  /** `<persist>\pebble-sdk\SDKs\current` (junction → targetVersionDir). */
  currentLink: string;
  /** Bundle (read-only) firmware-revision marker `<bundleSdkCore>\.fw-rev`. */
  bundleFwRev: string;
  /** Target (writable) firmware-revision marker `<targetSdkCore>\.fw-rev`. */
  targetFwRev: string;
  /**
   * pebble-tool's get_persist_dir() = `<persist>\pebble-sdk` — the root under
   * which it decompresses each board's spi flash to `<ver>\<board>\qemu_spi_flash.bin`.
   */
  persistSdkRoot: string;
}

/**
 * Resolve every path provisioning touches for `version`. PURE — joins with
 * path.win32 so it is deterministic regardless of the host running it.
 */
export function planSdkProvision(ctx: BundledRuntimeCtx, version: string): SdkPaths {
  const bundleRoot = sdkBundleRoot(ctx);
  const qemuBundleDir = dirname(qemuExe(ctx));
  const persist = pebbleDataDir(ctx);
  const persistSdkRoot = join(persist, "pebble-sdk");
  const persistSdks = join(persistSdkRoot, "SDKs");
  const targetVersionDir = join(persistSdks, version);
  const targetSdkCore = join(targetVersionDir, "sdk-core");
  const bundleSdkCore = join(bundleRoot, "SDKs", version, "sdk-core");
  return {
    version,
    bundleSdkCore,
    keymapsSrc: join(qemuBundleDir, "pc-bios", "keymaps"),
    persistSdks,
    targetVersionDir,
    targetSdkCore,
    targetManifest: join(targetSdkCore, "manifest.json"),
    targetKeymaps: join(targetVersionDir, "toolchain", "lib", "pc-bios", "keymaps"),
    currentLink: join(persistSdks, "current"),
    bundleFwRev: join(bundleSdkCore, ".fw-rev"),
    targetFwRev: join(targetSdkCore, ".fw-rev"),
    persistSdkRoot,
  };
}

// ---------------------------------------------------------------------------
// Effectful runner (injectable fs for tests)
// ---------------------------------------------------------------------------

/** Minimal fs surface the runner needs; injected so the logic is unit-testable. */
export interface ProvisionFs {
  /** True if the path exists (file, dir, or link). */
  exists(p: string): Promise<boolean>;
  /** Read a text file; resolve "" if missing. */
  readText(p: string): Promise<string>;
  /** Write a text file (creating/overwriting); parent dir must already exist. */
  writeText(p: string, content: string): Promise<void>;
  /** Delete a file (or tree); a no-op when the path is absent. */
  remove(p: string): Promise<void>;
  /** List a directory's entries; resolve [] if missing. */
  list(p: string): Promise<string[]>;
  /** mkdir -p. */
  mkdirp(p: string): Promise<void>;
  /** Recursive copy of a directory tree (src → dest). */
  copyTree(src: string, dest: string): Promise<void>;
  /** Copy a single file (src → dest). */
  copyFile(src: string, dest: string): Promise<void>;
  /**
   * Create/refresh a directory junction `link` → `target`. Junctions need no
   * symlink privilege on Windows. Must replace a stale/wrong link idempotently.
   */
  ensureJunction(target: string, link: string): Promise<void>;
}

export interface ProvisionDeps {
  fs?: ProvisionFs;
  onProgress?: (msg: string) => void;
}

export interface ProvisionResult {
  version: string;
  /** Persist root handed to pebble-tool as XDG_DATA_HOME → `<this>\pebble-sdk`. */
  persistDir: string;
  sdkCoreDir: string;
  /** What actually ran this launch (for logging/tests). */
  actions: {
    copiedSdkCore: boolean;
    seededKeymaps: boolean;
    refreshedJunction: boolean;
    /** True when the fw-rev marker differed and per-board firmware was re-copied. */
    refreshedFirmware: boolean;
  };
}

/** Real fs implementation of ProvisionFs (used in production). */
export function realProvisionFs(): ProvisionFs {
  const exists = async (p: string): Promise<boolean> => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };
  return {
    exists,
    readText: async (p) => readFile(p, "utf8").catch(() => ""),
    writeText: async (p, content) => {
      await writeFile(p, content);
    },
    remove: async (p) => {
      await rm(p, { recursive: true, force: true }).catch(() => {});
    },
    list: async (p) => readdir(p).catch(() => [] as string[]),
    mkdirp: async (p) => {
      await mkdir(p, { recursive: true });
    },
    copyTree: async (src, dest) => {
      await cp(src, dest, { recursive: true });
    },
    copyFile: async (src, dest) => {
      await copyFile(src, dest);
    },
    ensureJunction: async (target, link) => {
      // Idempotent: if a correct junction already points at target, keep it;
      // otherwise remove whatever is there and create a fresh junction.
      try {
        const cur = await readlink(link);
        if (resolve(cur) === resolve(target)) return;
      } catch {
        /* not a link / missing — fall through to (re)create */
      }
      await rm(link, { recursive: true, force: true }).catch(() => {});
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    },
  };
}

/**
 * Refresh the per-board emulator firmware in an ALREADY-provisioned target when
 * the bundled firmware changes, keyed on the `sdk-core\.fw-rev` marker.
 *
 * Provisioning only re-copies the whole sdk-core tree when the manifest is
 * missing/invalid, so an existing install keeps stale qemu flash images even
 * after we ship patched firmware. This compares the bundle's `.fw-rev` content
 * to the target's; when they DIFFER (target missing counts as different) it
 * re-copies each affected board's `qemu_micro_flash.bin` + `qemu_spi_flash.bin.bz2`
 * and deletes the stale DECOMPRESSED spi (`get_persist_dir()\<ver>\<board>\
 * qemu_spi_flash.bin`) so pebble-tool regenerates it from the new template on the
 * next emulator launch. Finally it stamps the bundle's marker onto the target.
 *
 * Gated + resilient:
 *  - skips entirely when the bundle has no `.fw-rev` (nothing versions the fw);
 *  - no-op when bundle marker == target marker (the common steady-state case);
 *  - skips `alreadyCopiedFresh` runs (the full sdk-core copy already brought the
 *    new blobs + the new marker, so there is nothing to refresh);
 *  - skips a board whose bundle blob is missing rather than throwing.
 *
 * Returns true iff firmware was actually re-copied. Never throws for an expected
 * cause; the caller additionally wraps this so a refresh failure can't break boot.
 */
export async function refreshSdkFirmware(
  fs: ProvisionFs,
  p: SdkPaths,
  alreadyCopiedFresh: boolean,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  // A fresh full copy this run already carried the new blobs + marker.
  if (alreadyCopiedFresh) return false;

  const bundleRev = await fs.readText(p.bundleFwRev);
  // No marker in the bundle → nothing versions the firmware → skip entirely.
  if (bundleRev === "") return false;

  const targetRev = await fs.readText(p.targetFwRev);
  // Common case: already on the bundled revision → no-op (normal launches).
  if (targetRev === bundleRev) return false;

  log(`Refreshing emulator firmware (${targetRev || "none"} → ${bundleRev})…`);

  for (const board of FW_REFRESH_BOARDS) {
    const bundleQemu = join(p.bundleSdkCore, "pebble", board, "qemu");
    // If the bundle lacks this board's blobs, skip it (don't throw).
    const missing = !(await fs.exists(join(bundleQemu, FW_REFRESH_BLOBS[0])));
    if (missing) {
      log(`  firmware for ${board} missing in bundle — skipping`);
      continue;
    }

    const targetQemu = join(p.targetSdkCore, "pebble", board, "qemu");
    await fs.mkdirp(targetQemu);
    for (const blob of FW_REFRESH_BLOBS) {
      await fs.copyFile(join(bundleQemu, blob), join(targetQemu, blob));
    }
    // Drop the stale decompressed spi so it regenerates from the new template.
    await fs.remove(join(p.persistSdkRoot, p.version, board, "qemu_spi_flash.bin"));
  }

  // Stamp the bundle's revision onto the target so this is a no-op next launch.
  await fs.writeText(p.targetFwRev, bundleRev);
  return true;
}

/**
 * Idempotently provision the writable SDK for the native-Windows emulator.
 *
 * 1. discover the bundle version, 2. copy sdk-core if the target manifest is
 * missing/invalid, 3. seed keymaps if absent (qemu VNC needs keymaps\en-us),
 * 4. create/refresh the `current` junction. Throws if the bundle is absent or a
 * step fails — provisioning is a hard prerequisite for boot, so the caller
 * surfaces the failure rather than booting into a broken SDK.
 *
 * Cached per process: a successful run is remembered so repeat calls are free;
 * a failure stays retryable.
 */
export async function provisionSdk(
  ctx: BundledRuntimeCtx,
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const fs = deps.fs ?? realProvisionFs();
  const log = deps.onProgress ?? (() => {});

  const bundleRoot = sdkBundleRoot(ctx);
  const bundleSdksDir = join(bundleRoot, "SDKs");
  const version = pickSdkVersion(await fs.list(bundleSdksDir));
  if (!version) {
    throw new Error(`no SDK version found in bundle at ${bundleSdksDir}`);
  }

  const p = planSdkProvision(ctx, version);
  const actions = {
    copiedSdkCore: false,
    seededKeymaps: false,
    refreshedJunction: false,
    refreshedFirmware: false,
  };

  // 1. sdk-core — copy when the target manifest is missing or invalid.
  if (!isSdkCoreManifestValid(await fs.readText(p.targetManifest), version)) {
    log(`Provisioning Pebble SDK ${version}…`);
    await fs.mkdirp(p.targetVersionDir);
    // Remove a partial/corrupt prior copy before re-copying so cp can't merge.
    await fs.copyTree(p.bundleSdkCore, p.targetSdkCore);
    if (!isSdkCoreManifestValid(await fs.readText(p.targetManifest), version)) {
      throw new Error(`sdk-core copy failed validation at ${p.targetSdkCore}`);
    }
    actions.copiedSdkCore = true;
  }

  // 2. keymaps — qemu's `-L <ver>\toolchain\lib\pc-bios` needs keymaps\en-us.
  const haveEnUs = await fs.exists(join(p.targetKeymaps, "en-us"));
  if (!haveEnUs) {
    log("Seeding emulator keymaps…");
    await fs.mkdirp(p.targetKeymaps);
    const names = await fs.list(p.keymapsSrc);
    if (names.length === 0) {
      throw new Error(`no keymaps found in bundle at ${p.keymapsSrc}`);
    }
    for (const name of names) {
      await fs.copyFile(join(p.keymapsSrc, name), join(p.targetKeymaps, name)).catch(() => {});
    }
    if (!(await fs.exists(join(p.targetKeymaps, "en-us")))) {
      throw new Error(`keymap en-us missing after seeding at ${p.targetKeymaps}`);
    }
    actions.seededKeymaps = true;
  }

  // 3. `current` junction → the version dir (pebble-tool resolves SDKs\current).
  await fs.ensureJunction(p.targetVersionDir, p.currentLink);
  actions.refreshedJunction = true;

  // 4. firmware refresh — pick up updated emulator firmware for an already-
  // provisioned install when the bundled `.fw-rev` changed. Gated to a no-op in
  // the common case; wrapped so a refresh failure can never break provisioning.
  try {
    actions.refreshedFirmware = await refreshSdkFirmware(fs, p, actions.copiedSdkCore, log);
  } catch (e) {
    log(`Firmware refresh skipped (non-fatal): ${(e as Error)?.message ?? e}`);
  }

  log(`Pebble SDK ${version} ready.`);
  return {
    version,
    persistDir: pebbleDataDir(ctx),
    sdkCoreDir: p.targetSdkCore,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Process-level cache (idempotent across calls in one app session)
// ---------------------------------------------------------------------------

let provisioned: Promise<ProvisionResult> | null = null;

/**
 * Provision once per process. Concurrent callers share the in-flight Promise; a
 * success is cached for the session; a failure clears the cache so the next call
 * retries.
 */
export function ensureSdkProvisioned(
  ctx: BundledRuntimeCtx,
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  if (provisioned) return provisioned;
  provisioned = provisionSdk(ctx, deps).catch((e) => {
    provisioned = null;
    throw e;
  });
  return provisioned;
}

/** Reset the cache — tests only. */
export function _resetProvisionState(): void {
  provisioned = null;
}
