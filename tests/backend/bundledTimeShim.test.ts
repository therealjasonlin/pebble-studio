import { describe, it, expect, beforeEach } from "vitest";
import {
  winShimPaths,
  winFakeTimeCtlPath,
  writeWinFakeTime,
  parseWinSelfTest,
  ensureWinTimeShim,
  isWinShimReady,
  _resetWinShimState,
  type WinShimPaths,
} from "../../src/main/backend/bundledTimeShim.js";

const PATHS: WinShimPaths = {
  dll: "C:\\res\\timeshim-win\\timeshim-win.dll",
  launcher: "C:\\res\\timeshim-win\\launcher.exe",
  probe: "C:\\res\\timeshim-win\\probe.exe",
};

describe("winShimPaths", () => {
  it("joins the three artifact names under the bundle dir (Windows separators)", () => {
    const p = winShimPaths("C:\\res\\timeshim-win");
    expect(p.dll).toBe("C:\\res\\timeshim-win\\timeshim-win.dll");
    expect(p.launcher).toBe("C:\\res\\timeshim-win\\launcher.exe");
    expect(p.probe).toBe("C:\\res\\timeshim-win\\probe.exe");
  });
});

describe("winFakeTimeCtlPath", () => {
  it("uses %TEMP%, falling back to %TMP% then a Windows default", () => {
    expect(winFakeTimeCtlPath({ TEMP: "C:\\Temp" })).toBe("C:\\Temp\\pb-faketime.ctl");
    expect(winFakeTimeCtlPath({ TMP: "D:\\t" })).toBe("D:\\t\\pb-faketime.ctl");
    expect(winFakeTimeCtlPath({})).toBe("C:\\Windows\\Temp\\pb-faketime.ctl");
  });
});

describe("writeWinFakeTime", () => {
  it("writes '<target> <rate>' for an absolute jump", async () => {
    let written = "";
    await writeWinFakeTime("X", 1577836800, 1, async (_p, d) => { written = d; });
    expect(written).toBe("1577836800 1");
  });
  it("writes '- <rate>' when target is null (rate-only)", async () => {
    let written = "";
    await writeWinFakeTime("X", null, 0, async (_p, d) => { written = d; });
    expect(written).toBe("- 0");
  });
  it("truncates a fractional target to an integer (numeric/quote-free)", async () => {
    let written = "";
    await writeWinFakeTime("X", 1000.9, 10, async (_p, d) => { written = d; });
    expect(written).toBe("1000 10");
  });
  it("passes the control path through to the writer", async () => {
    let path = "";
    await writeWinFakeTime("C:\\Temp\\pb-faketime.ctl", 1, 1, async (p) => { path = p; });
    expect(path).toBe("C:\\Temp\\pb-faketime.ctl");
  });
});

describe("parseWinSelfTest", () => {
  const now = 1_700_000_000;
  it("accepts a value within ±120s of now+86400", () => {
    expect(parseWinSelfTest(String(now + 86400), now)).toBe(true);
    expect(parseWinSelfTest(String(now + 86400 + 100), now)).toBe(true);
  });
  it("rejects an unfaked value (still ~now)", () => {
    expect(parseWinSelfTest(String(now), now)).toBe(false);
  });
  it("rejects garbage / empty output", () => {
    expect(parseWinSelfTest("not-a-number", now)).toBe(false);
    expect(parseWinSelfTest("", now)).toBe(false);
  });
  it("reads the LAST whitespace-separated token (ignores any prefix noise)", () => {
    expect(parseWinSelfTest(`junk\n${now + 86400}\n`, now)).toBe(true);
  });
});

describe("ensureWinTimeShim", () => {
  beforeEach(() => _resetWinShimState());

  it("is false (and never spawns) when a bundle artifact is missing", async () => {
    let spawned = false;
    const ok = await ensureWinTimeShim(PATHS, {
      exists: (p) => p !== PATHS.probe, // probe missing
      exec: async () => { spawned = true; return { code: 0, stdout: "", stderr: "" } as { code: number; stdout: string }; },
    });
    expect(ok).toBe(false);
    expect(spawned).toBe(false);
    expect(isWinShimReady()).toBe(false);
  });

  it("is true when the probe (via launcher) reports the faked +1 day, and passes the right env", async () => {
    const now = 1_700_000_000_000; // ms
    let seenEnv: Record<string, string> = {};
    const ok = await ensureWinTimeShim(PATHS, {
      exists: () => true,
      now: () => now,
      exec: async (exe, env) => {
        seenEnv = env;
        expect(exe).toBe(PATHS.launcher);
        return { code: 0, stdout: String(now / 1000 + 86400) };
      },
    });
    expect(ok).toBe(true);
    expect(isWinShimReady()).toBe(true);
    expect(seenEnv.PEBBLE_FAKETIME_REAL_QEMU).toBe(PATHS.probe);
    expect(seenEnv.PEBBLE_FAKETIME_DLL).toBe(PATHS.dll);
    expect(seenEnv.PEBBLE_FAKETIME_OFFSET).toBe("86400");
  });

  it("is false when the probe shows real (unfaked) time — injection blocked", async () => {
    const now = 1_700_000_000_000;
    const ok = await ensureWinTimeShim(PATHS, {
      exists: () => true,
      now: () => now,
      exec: async () => ({ code: 0, stdout: String(now / 1000) }),
    });
    expect(ok).toBe(false);
  });

  it("caches a success (second call does not re-spawn)", async () => {
    const now = 1_700_000_000_000;
    let runs = 0;
    const deps = {
      exists: () => true,
      now: () => now,
      exec: async () => { runs++; return { code: 0, stdout: String(now / 1000 + 86400) }; },
    };
    await ensureWinTimeShim(PATHS, deps);
    await ensureWinTimeShim(PATHS, deps);
    expect(runs).toBe(1);
  });

  it("retries after a failure (failed check is not cached)", async () => {
    const now = 1_700_000_000_000;
    let runs = 0;
    await ensureWinTimeShim(PATHS, { exists: () => true, now: () => now, exec: async () => { runs++; return { code: 1, stdout: "" }; } });
    await ensureWinTimeShim(PATHS, { exists: () => true, now: () => now, exec: async () => { runs++; return { code: 0, stdout: String(now / 1000 + 86400) }; } });
    expect(runs).toBe(2);
    expect(isWinShimReady()).toBe(true);
  });
});
