import { describe, it, expect, beforeEach } from "vitest";
import { join, sep } from "node:path";
import {
  pickSdkVersion,
  isSdkCoreManifestValid,
  planSdkProvision,
  provisionSdk,
  refreshSdkFirmware,
  ensureSdkProvisioned,
  _resetProvisionState,
  FW_REFRESH_BOARDS,
  FW_REFRESH_BLOBS,
  type ProvisionFs,
} from "../../src/main/backend/sdkProvision.js";
import type { BundledRuntimeCtx } from "../../src/main/backend/bundledRuntime.js";

// A packaged POSIX context. sdkProvision joins paths with node:path, so building
// expectations with the same `join` keeps this test separator-correct on any host.
const packaged: BundledRuntimeCtx = {
  packaged: true,
  resourcesPath: join("/opt", "Pebble Studio", "resources"),
  repoRoot: join("/repo"),
  userDataDir: join("/home", "tester", ".config", "Pebble Studio"),
  platform: "linux",
  exists: () => true,
};

const VERSION = "4.9.169";

// ---------------------------------------------------------------------------
// pickSdkVersion
// ---------------------------------------------------------------------------

describe("pickSdkVersion", () => {
  it("returns the single version dir, ignoring the current link", () => {
    expect(pickSdkVersion(["4.9.169", "current"])).toBe("4.9.169");
  });

  it("returns the highest version when several are present", () => {
    expect(pickSdkVersion(["4.9.169", "4.10.2", "4.9.200", "current"])).toBe("4.10.2");
  });

  it("compares numerically, not lexically (10 > 9)", () => {
    expect(pickSdkVersion(["4.9.169", "4.9.9"])).toBe("4.9.169");
  });

  it("accepts two-segment versions", () => {
    expect(pickSdkVersion(["4.9"])).toBe("4.9");
  });

  it("ignores non-version entries", () => {
    expect(pickSdkVersion(["current", "README.md", ".gitkeep"])).toBeNull();
  });

  it("returns null on an empty bundle", () => {
    expect(pickSdkVersion([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSdkCoreManifestValid
// ---------------------------------------------------------------------------

describe("isSdkCoreManifestValid", () => {
  const good = JSON.stringify({ type: "sdk-core", version: "4.9.169", channel: "" });

  it("accepts a well-formed sdk-core manifest of the expected version", () => {
    expect(isSdkCoreManifestValid(good, "4.9.169")).toBe(true);
  });

  it("rejects a manifest of a different version", () => {
    expect(isSdkCoreManifestValid(good, "4.10.0")).toBe(false);
  });

  it("rejects a non-sdk-core type", () => {
    expect(isSdkCoreManifestValid(JSON.stringify({ type: "toolchain", version: "4.9.169" }), "4.9.169")).toBe(false);
  });

  it("rejects empty / missing content", () => {
    expect(isSdkCoreManifestValid("", "4.9.169")).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(isSdkCoreManifestValid("{ not json", "4.9.169")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planSdkProvision (pure path resolution)
// ---------------------------------------------------------------------------

describe("planSdkProvision", () => {
  const p = planSdkProvision(packaged, VERSION);
  const persistBase = join(packaged.userDataDir, "pebble-data", "pebble-sdk", "SDKs");

  it("copies sdk-core FROM the read-only bundle under resourcesPath", () => {
    expect(p.bundleSdkCore).toBe(join(packaged.resourcesPath, "pebble-sdk", "SDKs", VERSION, "sdk-core"));
  });

  it("sources keymaps from the qemu bundle's pc-bios/keymaps", () => {
    expect(p.keymapsSrc).toBe(join(packaged.resourcesPath, "qemu-pebble-linux", "pc-bios", "keymaps"));
  });

  it("targets the WRITABLE persist dir (XDG_DATA_HOME = userData/pebble-data)", () => {
    expect(p.persistSdks).toBe(persistBase);
    expect(p.targetVersionDir).toBe(join(persistBase, VERSION));
    expect(p.targetSdkCore).toBe(join(persistBase, VERSION, "sdk-core"));
    expect(p.targetManifest).toBe(join(persistBase, VERSION, "sdk-core", "manifest.json"));
    expect(p.targetKeymaps).toBe(join(persistBase, VERSION, "toolchain", "lib", "pc-bios", "keymaps"));
    expect(p.currentLink).toBe(join(persistBase, "current"));
  });
});

// ---------------------------------------------------------------------------
// provisionSdk (effectful runner, fake fs)
// ---------------------------------------------------------------------------

/** A fake fs that records every effect and serves a configurable file/dir model. */
function makeFakeFs(model: {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
}): ProvisionFs & { calls: string[] } {
  const files: Record<string, string> = { ...(model.files ?? {}) };
  const dirs: Record<string, string[]> = { ...(model.dirs ?? {}) };
  const calls: string[] = [];
  const present = new Set<string>([...Object.keys(files)]);
  return {
    calls,
    async exists(p) {
      return present.has(p) || p in dirs;
    },
    async readText(p) {
      return files[p] ?? "";
    },
    async writeText(p, content) {
      calls.push(`writeText ${p}`);
      files[p] = content;
      present.add(p);
    },
    async remove(p) {
      calls.push(`remove ${p}`);
      delete files[p];
      present.delete(p);
      delete dirs[p];
    },
    async list(p) {
      return dirs[p] ?? [];
    },
    async mkdirp(p) {
      calls.push(`mkdirp ${p}`);
      dirs[p] = dirs[p] ?? [];
    },
    async copyTree(src, dest) {
      calls.push(`copyTree ${src} -> ${dest}`);
      // Simulate a successful sdk-core copy by materialising a valid manifest.
      const manifest = join(dest, "manifest.json");
      files[manifest] = JSON.stringify({ type: "sdk-core", version: VERSION });
      present.add(manifest);
    },
    async copyFile(src, dest) {
      calls.push(`copyFile ${src} -> ${dest}`);
      files[dest] = "x";
      present.add(dest);
    },
    async ensureJunction(target, link) {
      calls.push(`junction ${link} -> ${target}`);
    },
  };
}

const BUNDLE_SDKS = join(packaged.resourcesPath, "pebble-sdk", "SDKs");
const KEYMAPS_SRC = join(packaged.resourcesPath, "qemu-pebble-linux", "pc-bios", "keymaps");

describe("provisionSdk — clean first run", () => {
  beforeEach(() => _resetProvisionState());

  it("copies sdk-core, seeds keymaps, and creates the current junction", async () => {
    const fs = makeFakeFs({
      dirs: {
        [BUNDLE_SDKS]: ["4.9.169", "current"],
        [KEYMAPS_SRC]: ["en-us", "en-gb", "de"],
      },
    });
    const res = await provisionSdk(packaged, { fs });

    expect(res.version).toBe(VERSION);
    expect(res.actions).toEqual({
      copiedSdkCore: true,
      seededKeymaps: true,
      refreshedJunction: true,
      // A fresh full copy already carries the new blobs + marker → no extra refresh.
      refreshedFirmware: false,
    });

    const p = planSdkProvision(packaged, VERSION);
    expect(fs.calls).toContain(`copyTree ${p.bundleSdkCore} -> ${p.targetSdkCore}`);
    expect(fs.calls).toContain(`copyFile ${join(KEYMAPS_SRC, "en-us")} -> ${join(p.targetKeymaps, "en-us")}`);
    expect(fs.calls).toContain(`junction ${p.currentLink} -> ${p.targetVersionDir}`);
  });
});

describe("provisionSdk — idempotent re-run", () => {
  beforeEach(() => _resetProvisionState());

  it("skips the sdk-core copy and keymap seeding when both already exist", async () => {
    const p = planSdkProvision(packaged, VERSION);
    const fs = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169", "current"], [KEYMAPS_SRC]: ["en-us"] },
      files: {
        [p.targetManifest]: JSON.stringify({ type: "sdk-core", version: VERSION }),
        [join(p.targetKeymaps, "en-us")]: "x",
      },
    });
    const res = await provisionSdk(packaged, { fs });

    expect(res.actions.copiedSdkCore).toBe(false);
    expect(res.actions.seededKeymaps).toBe(false);
    // The junction is always refreshed (cheap + self-healing).
    expect(res.actions.refreshedJunction).toBe(true);
    expect(fs.calls.some((c) => c.startsWith("copyTree"))).toBe(false);
    expect(fs.calls.some((c) => c.startsWith("copyFile"))).toBe(false);
  });

  it("re-copies sdk-core when the existing manifest is the wrong version", async () => {
    const p = planSdkProvision(packaged, VERSION);
    const fs = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169", "current"], [KEYMAPS_SRC]: ["en-us"] },
      files: {
        [p.targetManifest]: JSON.stringify({ type: "sdk-core", version: "4.0.0" }),
        [join(p.targetKeymaps, "en-us")]: "x",
      },
    });
    const res = await provisionSdk(packaged, { fs });
    expect(res.actions.copiedSdkCore).toBe(true);
  });
});

describe("provisionSdk — failure modes", () => {
  beforeEach(() => _resetProvisionState());

  it("throws when the bundle has no SDK version", async () => {
    const fs = makeFakeFs({ dirs: { [BUNDLE_SDKS]: ["current", "README.md"] } });
    await expect(provisionSdk(packaged, { fs })).rejects.toThrow(/no SDK version/i);
  });

  it("throws when the bundle has no keymaps to seed", async () => {
    const fs = makeFakeFs({ dirs: { [BUNDLE_SDKS]: ["4.9.169"], [KEYMAPS_SRC]: [] } });
    await expect(provisionSdk(packaged, { fs })).rejects.toThrow(/no keymaps/i);
  });
});

describe("ensureSdkProvisioned — process cache", () => {
  beforeEach(() => _resetProvisionState());

  it("provisions once and reuses the cached result for concurrent callers", async () => {
    const fs = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169"], [KEYMAPS_SRC]: ["en-us"] },
    });
    const [a, b] = await Promise.all([
      ensureSdkProvisioned(packaged, { fs }),
      ensureSdkProvisioned(packaged, { fs }),
    ]);
    expect(a).toBe(b); // same cached promise result
    // Only ONE copyTree across both calls.
    expect(fs.calls.filter((c) => c.startsWith("copyTree")).length).toBe(1);
  });

  it("clears the cache on failure so a later call retries", async () => {
    const failing = makeFakeFs({ dirs: { [BUNDLE_SDKS]: [] } });
    await expect(ensureSdkProvisioned(packaged, { fs: failing })).rejects.toThrow();

    // A subsequent call with a healthy fs must run again (not return the failure).
    const healthy = makeFakeFs({
      dirs: { [BUNDLE_SDKS]: ["4.9.169"], [KEYMAPS_SRC]: ["en-us"] },
    });
    const res = await ensureSdkProvisioned(packaged, { fs: healthy });
    expect(res.version).toBe(VERSION);
  });
});

// ---------------------------------------------------------------------------
// refreshSdkFirmware (fw-rev–gated firmware refresh)
// ---------------------------------------------------------------------------

describe("refreshSdkFirmware", () => {
  const p = planSdkProvision(packaged, VERSION);

  /** Bundle qemu dir for a board. */
  const bundleQemu = (board: string) => join(p.bundleSdkCore, "pebble", board, "qemu");
  /** Target qemu dir for a board. */
  const targetQemu = (board: string) => join(p.targetSdkCore, "pebble", board, "qemu");
  /** Decompressed spi for a board under the persist root. */
  const decompressedSpi = (board: string) =>
    join(p.persistSdkRoot, p.version, board, "qemu_spi_flash.bin");

  /** A fake fs whose bundle carries `.fw-rev` + every board's blobs. */
  function bundleWithFw(rev: string, boards: readonly string[] = FW_REFRESH_BOARDS) {
    const files: Record<string, string> = { [p.bundleFwRev]: rev };
    for (const board of boards) {
      for (const blob of FW_REFRESH_BLOBS) files[join(bundleQemu(board), blob)] = "fw";
    }
    return makeFakeFs({ files });
  }

  it("(a) marker equal → no refresh, no fs writes", async () => {
    const fs = bundleWithFw("freeze-fix-1");
    // Target already stamped with the same rev.
    await fs.writeText(p.targetFwRev, "freeze-fix-1");
    fs.calls.length = 0;

    const refreshed = await refreshSdkFirmware(fs, p, false);
    expect(refreshed).toBe(false);
    expect(fs.calls).toEqual([]);
  });

  it("(b) marker differs → copies the boards' blobs, deletes decompressed spi, writes new marker", async () => {
    const fs = bundleWithFw("freeze-fix-1");
    await fs.writeText(p.targetFwRev, "freeze-fix-0"); // stale rev present
    fs.calls.length = 0;

    const refreshed = await refreshSdkFirmware(fs, p, false);
    expect(refreshed).toBe(true);

    for (const board of FW_REFRESH_BOARDS) {
      for (const blob of FW_REFRESH_BLOBS) {
        expect(fs.calls).toContain(`copyFile ${join(bundleQemu(board), blob)} -> ${join(targetQemu(board), blob)}`);
      }
      expect(fs.calls).toContain(`remove ${decompressedSpi(board)}`);
    }
    // Exactly 2 blobs × N boards copied.
    expect(fs.calls.filter((c) => c.startsWith("copyFile")).length).toBe(FW_REFRESH_BOARDS.length * FW_REFRESH_BLOBS.length);
    // New marker stamped last.
    expect(fs.calls).toContain(`writeText ${p.targetFwRev}`);
    expect(await fs.readText(p.targetFwRev)).toBe("freeze-fix-1");
  });

  it("(c) target marker missing → treated as differ → refresh runs", async () => {
    const fs = bundleWithFw("freeze-fix-1"); // no target .fw-rev written
    fs.calls.length = 0;

    const refreshed = await refreshSdkFirmware(fs, p, false);
    expect(refreshed).toBe(true);
    expect(fs.calls.filter((c) => c.startsWith("copyFile")).length).toBe(FW_REFRESH_BOARDS.length * FW_REFRESH_BLOBS.length);
    expect(await fs.readText(p.targetFwRev)).toBe("freeze-fix-1");
  });

  it("(d) bundle marker missing → skip entirely (no-op)", async () => {
    // Bundle has board blobs but no .fw-rev marker.
    const files: Record<string, string> = {};
    for (const board of FW_REFRESH_BOARDS) {
      for (const blob of FW_REFRESH_BLOBS) files[join(bundleQemu(board), blob)] = "fw";
    }
    const fs = makeFakeFs({ files });
    fs.calls.length = 0;

    const refreshed = await refreshSdkFirmware(fs, p, false);
    expect(refreshed).toBe(false);
    expect(fs.calls).toEqual([]);
  });

  it("(e) fresh full copy this run → don't double-refresh", async () => {
    const fs = bundleWithFw("freeze-fix-1"); // would otherwise differ (no target rev)
    fs.calls.length = 0;

    const refreshed = await refreshSdkFirmware(fs, p, /* alreadyCopiedFresh */ true);
    expect(refreshed).toBe(false);
    expect(fs.calls).toEqual([]);
  });

  it("(f) a board's blob missing in bundle → skip that board without throwing", async () => {
    // chalk has no blobs in the bundle; basalt + diorite do.
    const fs = bundleWithFw("freeze-fix-1", ["basalt", "diorite"]);
    await fs.writeText(p.targetFwRev, "freeze-fix-0");
    fs.calls.length = 0;

    const refreshed = await refreshSdkFirmware(fs, p, false);
    expect(refreshed).toBe(true);

    // chalk skipped — no copies for it.
    expect(fs.calls.some((c) => c.includes(`${sep}chalk${sep}`))).toBe(false);
    // basalt + diorite refreshed: 2 boards × 2 blobs.
    expect(fs.calls.filter((c) => c.startsWith("copyFile")).length).toBe(2 * FW_REFRESH_BLOBS.length);
    // Marker still advanced.
    expect(await fs.readText(p.targetFwRev)).toBe("freeze-fix-1");
  });

  it("is wired into provisionSdk: an existing install with a stale fw-rev gets refreshed", async () => {
    _resetProvisionState();
    const files: Record<string, string> = {
      // already-provisioned (valid manifest + keymaps) so no full copy happens
      [p.targetManifest]: JSON.stringify({ type: "sdk-core", version: VERSION }),
      [join(p.targetKeymaps, "en-us")]: "x",
      // bundle ships a newer fw-rev than the target
      [p.bundleFwRev]: "freeze-fix-1",
      [p.targetFwRev]: "freeze-fix-0",
    };
    for (const board of FW_REFRESH_BOARDS) {
      for (const blob of FW_REFRESH_BLOBS) files[join(bundleQemu(board), blob)] = "fw";
    }
    const fs = makeFakeFs({
      files,
      dirs: { [BUNDLE_SDKS]: ["4.9.169", "current"], [KEYMAPS_SRC]: ["en-us"] },
    });

    const res = await provisionSdk(packaged, { fs });
    expect(res.actions.copiedSdkCore).toBe(false);
    expect(res.actions.refreshedFirmware).toBe(true);
    expect(await fs.readText(p.targetFwRev)).toBe("freeze-fix-1");
  });

  it("FW_REFRESH_BOARDS covers the stm32f4 trio AND the M33 full-launcher trio", () => {
    for (const board of ["basalt", "chalk", "diorite", "emery", "gabbro", "flint"]) {
      expect(FW_REFRESH_BOARDS).toContain(board);
    }
  });
});
