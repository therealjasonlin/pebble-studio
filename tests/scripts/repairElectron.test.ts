import { describe, it, expect } from "vitest";
import {
  electronBinaryRelPath,
  extractionPlan,
  isElectronHealthy,
} from "../../scripts/repair-electron.mjs";

// electronBinaryRelPath mirrors electron's own install.js getPlatformPath() — the
// per-platform location of the launcher inside dist/, which is also what path.txt
// must contain for `require('electron')` to resolve.
describe("electronBinaryRelPath", () => {
  it("points at the .app launcher on macOS", () => {
    expect(electronBinaryRelPath("darwin")).toBe("Electron.app/Contents/MacOS/Electron");
    expect(electronBinaryRelPath("mas")).toBe("Electron.app/Contents/MacOS/Electron");
  });
  it("is a bare binary on the unixes", () => {
    for (const p of ["linux", "freebsd", "openbsd"]) {
      expect(electronBinaryRelPath(p)).toBe("electron");
    }
  });
  it("is the .exe on Windows", () => {
    expect(electronBinaryRelPath("win32")).toBe("electron.exe");
  });
  it("throws on an unsupported platform", () => {
    expect(() => electronBinaryRelPath("sunos")).toThrow(/unsupported platform/);
  });
});

// extractionPlan picks a native, dependency-free unzip per platform — the whole
// point is to NOT use electron's bundled extract-zip, which truncates under
// current Node. Each plan must carry both the source zip and the destination.
describe("extractionPlan", () => {
  const ZIP = "/cache/electron-v33.4.11-darwin-arm64.zip";
  const DEST = "/proj/node_modules/electron/dist";

  it("uses ditto on macOS (preserves symlinks + signatures)", () => {
    const plan = extractionPlan("darwin", ZIP, DEST);
    expect(plan.cmd).toBe("ditto");
    expect(plan.args).toContain(ZIP);
    expect(plan.args).toContain(DEST);
  });
  it("uses unzip on Linux", () => {
    const plan = extractionPlan("linux", ZIP, DEST);
    expect(plan.cmd).toBe("unzip");
    expect(plan.args).toContain(ZIP);
    expect(plan.args).toContain(DEST);
  });
  it("uses PowerShell Expand-Archive on Windows", () => {
    const plan = extractionPlan("win32", ZIP, DEST);
    expect(plan.cmd).toBe("powershell");
    const script = plan.args.join(" ");
    expect(script).toMatch(/Expand-Archive/);
    expect(script).toContain(ZIP);
    expect(script).toContain(DEST);
  });
  it("throws on an unsupported platform", () => {
    expect(() => extractionPlan("sunos", ZIP, DEST)).toThrow(/unsupported platform/);
  });
});

// isElectronHealthy mirrors install.js isInstalled(): a repair is a NO-OP unless
// all three signals fail — dist/version matches, path.txt matches, binary exists.
// This is the guard that keeps the postinstall invisible on working installs.
describe("isElectronHealthy", () => {
  const base = {
    distDir: "/d",
    pathTxt: "/e/path.txt",
    versionFile: "/d/version",
    expectedVersion: "33.4.11",
    binaryRelPath: "Electron.app/Contents/MacOS/Electron",
  };
  const healthyDeps = {
    exists: (p: string) => p === "/d/Electron.app/Contents/MacOS/Electron",
    readText: (p: string) => (p === "/d/version" ? "v33.4.11" : "Electron.app/Contents/MacOS/Electron"),
  };

  it("is true when version, path.txt and binary all agree (leading v tolerated)", () => {
    expect(isElectronHealthy({ ...base, ...healthyDeps })).toBe(true);
  });
  it("is false when dist/version disagrees", () => {
    expect(
      isElectronHealthy({ ...base, ...healthyDeps, readText: (p: string) => (p === "/d/version" ? "v43.0.0" : "Electron.app/Contents/MacOS/Electron") }),
    ).toBe(false);
  });
  it("is false when path.txt disagrees", () => {
    expect(
      isElectronHealthy({ ...base, ...healthyDeps, readText: (p: string) => (p === "/d/version" ? "v33.4.11" : "stale") }),
    ).toBe(false);
  });
  it("is false when the binary is missing (the truncated-extraction case)", () => {
    expect(isElectronHealthy({ ...base, ...healthyDeps, exists: () => false })).toBe(false);
  });
  it("is false when a marker file cannot be read", () => {
    expect(
      isElectronHealthy({ ...base, ...healthyDeps, readText: () => { throw new Error("ENOENT"); } }),
    ).toBe(false);
  });
});
