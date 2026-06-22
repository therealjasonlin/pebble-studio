import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  qemuExe,
  pebblePyExe,
  sdkBundleRoot,
  pebbleDataDir,
  pebbleCmd,
  bundledToolsPresent,
  getQemuBundleName,
  getPyBundleName,
  type BundledRuntimeCtx,
} from "../../src/main/backend/bundledRuntime.js";

/** A packaged context for a given platform: bundles live under resourcesPath.
 * Paths are built with node:path `join` (same as the source), so expectations
 * stay separator-correct on whatever host runs the suite. */
function packagedCtx(platform: NodeJS.Platform): BundledRuntimeCtx {
  return {
    packaged: true,
    resourcesPath: join("/opt", "Pebble Studio", "resources"),
    repoRoot: join("/repo"),
    userDataDir: join("/home", "tester", ".config", "Pebble Studio"),
    platform,
    exists: () => true,
  };
}

describe("bundledRuntime platform-aware bundle names", () => {
  it("selects the per-platform qemu bundle dir", () => {
    expect(getQemuBundleName("win32")).toBe("qemu-pebble-win");
    expect(getQemuBundleName("darwin")).toBe("qemu-pebble-mac");
    expect(getQemuBundleName("linux")).toBe("qemu-pebble-linux");
  });

  it("selects the per-platform python bundle dir", () => {
    expect(getPyBundleName("win32")).toBe("pebble-py");
    expect(getPyBundleName("darwin")).toBe("pebble-py-mac");
    expect(getPyBundleName("linux")).toBe("pebble-py-linux");
  });
});

describe("bundledRuntime path resolution (packaged)", () => {
  it("resolves the linux qemu + python (bin/python) under resourcesPath", () => {
    const ctx = packagedCtx("linux");
    expect(qemuExe(ctx)).toBe(join(ctx.resourcesPath, "qemu-pebble-linux", "qemu-pebble"));
    expect(pebblePyExe(ctx)).toBe(join(ctx.resourcesPath, "pebble-py-linux", "bin", "python"));
    expect(sdkBundleRoot(ctx)).toBe(join(ctx.resourcesPath, "pebble-sdk"));
  });

  it("uses the .exe / python.exe names on win32", () => {
    const ctx = packagedCtx("win32");
    expect(qemuExe(ctx)).toBe(join(ctx.resourcesPath, "qemu-pebble-win", "qemu-pebble.exe"));
    expect(pebblePyExe(ctx)).toBe(join(ctx.resourcesPath, "pebble-py", "python.exe"));
  });

  it("uses the mac bundle names on darwin (bin/python like linux)", () => {
    const ctx = packagedCtx("darwin");
    expect(qemuExe(ctx)).toBe(join(ctx.resourcesPath, "qemu-pebble-mac", "qemu-pebble"));
    expect(pebblePyExe(ctx)).toBe(join(ctx.resourcesPath, "pebble-py-mac", "bin", "python"));
  });

  it("pebbleDataDir is the writable persist root under userData", () => {
    const ctx = packagedCtx("linux");
    expect(pebbleDataDir(ctx)).toBe(join(ctx.userDataDir, "pebble-data"));
  });
});

describe("bundledRuntime path resolution (dev / vendor)", () => {
  const dev = (over: Partial<BundledRuntimeCtx> = {}): BundledRuntimeCtx => ({
    packaged: false,
    resourcesPath: join("/ignored"),
    repoRoot: join("/repo"),
    userDataDir: join("/data"),
    platform: "linux",
    exists: () => true,
    ...over,
  });

  it("resolves bundles under repo vendor/ when they are staged", () => {
    const ctx = dev();
    expect(qemuExe(ctx)).toBe(join("/repo", "vendor", "qemu-pebble-linux", "qemu-pebble"));
    expect(pebblePyExe(ctx)).toBe(join("/repo", "vendor", "pebble-py-linux", "bin", "python"));
    expect(sdkBundleRoot(ctx)).toBe(join("/repo", "vendor", "pebble-sdk"));
  });

  it("falls back to the C:\\tmp build location for the win32 python bundle when unstaged", () => {
    const ctx = dev({ platform: "win32", exists: () => false });
    expect(pebblePyExe(ctx)).toBe(join("C:\\tmp\\pebble-py-build\\python", "python.exe"));
  });
});

describe("bundledToolsPresent", () => {
  it("is true when both the bundled qemu and python exist", () => {
    expect(bundledToolsPresent({ ...packagedCtx("linux"), exists: () => true })).toBe(true);
  });

  it("is false when the bundles are absent", () => {
    expect(bundledToolsPresent({ ...packagedCtx("linux"), exists: () => false })).toBe(false);
  });

  it("is false when only one of qemu/python is present", () => {
    const onlyQemu = (p: string) => p.endsWith("qemu-pebble") || p.endsWith("qemu-pebble.exe");
    expect(bundledToolsPresent({ ...packagedCtx("linux"), exists: onlyQemu })).toBe(false);
  });
});

describe("pebbleCmd invocation contract", () => {
  it("invokes the bundled python path-independently via run_tool() and passes pebble args", () => {
    const ctx = packagedCtx("linux");
    const c = pebbleCmd(["emu-control", "--emulator", "emery", "--vnc"], ctx);
    expect(c.cmd).toBe(join(ctx.resourcesPath, "pebble-py-linux", "bin", "python"));
    expect(c.args).toEqual([
      "-c",
      "from pebble_tool import run_tool; run_tool()",
      "emu-control",
      "--emulator",
      "emery",
      "--vnc",
    ]);
  });

  it("sets PEBBLE_QEMU_PATH to the bundled qemu and XDG_DATA_HOME to the writable data dir", () => {
    const ctx = packagedCtx("linux");
    const c = pebbleCmd(["wipe"], ctx);
    expect(c.env?.PEBBLE_QEMU_PATH).toBe(join(ctx.resourcesPath, "qemu-pebble-linux", "qemu-pebble"));
    expect(c.env?.XDG_DATA_HOME).toBe(join(ctx.userDataDir, "pebble-data"));
  });
});
