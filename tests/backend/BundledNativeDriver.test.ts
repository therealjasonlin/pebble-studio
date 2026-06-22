import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BundledNativeDriver,
  healthRetryDecision,
  HEALTH_ACTIVATE_MAX_ATTEMPTS,
  HEALTH_ACTIVATE_READY_MS,
} from "../../src/main/backend/BundledNativeDriver.js";

// install()/screenshotFramebuffer() apply winPath() normalization only on win32
// (a no-op pass-through on POSIX). These cases assert the normalized Windows
// paths, so pin the platform to win32 for this file regardless of the host.
const ORIGINAL_PLATFORM = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }));
afterAll(() => Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM }));

const ep = { host: "localhost", port: 6080, wsPath: "/" };

const healthHelper = { pythonExe: "C:\\py\\python.exe", helperPath: join(tmpdir(), "pb-set-tz.py") };

describe("BundledNativeDriver", () => {
  it("runs discrete pebble commands via a plain runner (no bash wrapping)", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    d.setPlatform("basalt");
    await d.button("up", "press");
    expect(calls[0].cmd).toBe("pebble");                 // resolves to pebble.exe at spawn time
    expect(calls[0].args).toContain("emu-button");
    expect(calls[0].args).toContain("up");
    expect(calls[0].args).toContain("--vnc");            // inner NativeDriver still injects --vnc
    expect(calls[0].args).not.toContain("-lc");          // NOT wrapped in bash -lc
  });

  it("routes discrete pebble commands through the injected bundled invocation (python + run_tool + env)", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const run = vi.fn(async (cmd: string, args: string[], env?: Record<string, string>) => { calls.push({ cmd, args, env }); return { code: 0, stdout: "", stderr: "" }; });
    const pebble = (args: string[]) => ({
      cmd: "C:\\py\\python.exe",
      args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
      env: { PEBBLE_QEMU_PATH: "C:\\q\\qemu-pebble.exe", XDG_DATA_HOME: "C:\\data\\pebble-data" },
    });
    const d = new BundledNativeDriver({ run, pebble, boot: async () => ep, stop: async () => {} });
    d.setPlatform("basalt");
    await d.button("up", "press");
    expect(calls[0].cmd).toBe("C:\\py\\python.exe");
    expect(calls[0].args.slice(0, 2)).toEqual(["-c", "from pebble_tool import run_tool; run_tool()"]);
    expect(calls[0].args).toContain("emu-button");
    expect(calls[0].args).toContain("--vnc");           // inner NativeDriver still injects --vnc
    expect(calls[0].env?.PEBBLE_QEMU_PATH).toBe("C:\\q\\qemu-pebble.exe");
  });

  it("normalizes a Windows .pbw path with winPath on install (no /mnt translation)", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    d.setPlatform("basalt");
    await d.install("C:/Users/Jane Doe/My Watch.pbw");
    expect(calls[0]).toContain("C:\\Users\\Jane Doe\\My Watch.pbw");
  });

  it("reports the time shim as unavailable when no timeShim dep is wired", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    expect(await d.ensureTimeShim()).toBe(false);
  });

  it("setFakeTime is a no-op that resolves when no timeShim dep is wired", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.setFakeTime(123, 0)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  describe("with the custom-time control file wired", () => {
    // Custom time is built into the bundled qemu-pebble.exe (the Pebble RTC reads
    // the control file directly), so it's ALWAYS available when a ctlPath is wired
    // — no DLL files to probe, no self-test, no AV-blockable injection.
    it("ensureTimeShim is true whenever a control file is wired", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const d = new BundledNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeShim: { ctlPath: join(tmpdir(), "pb-faketime-test.ctl") },
      });
      expect(await d.ensureTimeShim()).toBe(true);
    });

    it("setFakeTime writes the control file qemu reads ('<target> <rate>')", async () => {
      const ctlPath = join(tmpdir(), `pb-faketime-${process.pid}.ctl`);
      await rm(ctlPath, { force: true });
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const d = new BundledNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeShim: { ctlPath },
      });
      await d.setFakeTime(1577836800, 0); // freeze at 2020-01-01
      expect(await readFile(ctlPath, "utf8")).toBe("1577836800 0");
      await d.setFakeTime(null, 10); // rate-only
      expect(await readFile(ctlPath, "utf8")).toBe("- 10");
      await rm(ctlPath, { force: true });
    });
  });

  it("setTzOffset runs the python helper argv when paths are configured", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new BundledNativeDriver({
      run, boot: async () => ep, stop: async () => {},
      timeHelper: { pythonExe: "C:\\py\\python.exe", helperPath: "C:\\h\\pb-set-tz.py" },
    });
    await d.setTzOffset(-240, "America/New_York");
    expect(calls[0].cmd).toBe("C:\\py\\python.exe");
    expect(calls[0].args).toEqual(["C:\\h\\pb-set-tz.py", "-240", "America/New_York"]);
  });

  it("setTzOffset is a no-op (no throw) when the helper paths are not configured", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.setTzOffset(540, "Asia/Tokyo")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  describe("activateHealth (readiness-race retry)", () => {
    it("retries a fast not-ready miss, then reports the eventual success", async () => {
      let n = 0;
      const run = vi.fn(async () => {
        n++;
        // First two attempts: state file / pypkjs not ready yet (connection refused),
        // which the helper reports WITHOUT a numeric status. Then it succeeds.
        return n < 3
          ? { code: 1, stdout: "health-activate: error [WinError 10061] refused", stderr: "" }
          : { code: 0, stdout: "health-activate: status=1", stderr: "" };
      });
      const d = new BundledNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeHelper: healthHelper, sleep: async () => {},
      });
      const r = await d.activateHealth();
      expect(r).toEqual({ ok: true, status: 1, detail: "health-activate: status=1" });
      expect(run).toHaveBeenCalledTimes(3);
    });

    it("returns immediately on a definitive (even non-success) status — no retry", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "health-activate: status=8", stderr: "" }));
      const d = new BundledNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeHelper: healthHelper, sleep: async () => {},
      });
      const r = await d.activateHealth();
      expect(r.status).toBe(8);
      expect(r.ok).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("gives up after the attempt cap when the emulator never becomes ready", async () => {
      const run = vi.fn(async () => ({ code: 1, stdout: "health-activate: error refused", stderr: "" }));
      const d = new BundledNativeDriver({
        run, boot: async () => ep, stop: async () => {},
        timeHelper: healthHelper, sleep: async () => {},
      });
      const r = await d.activateHealth();
      expect(r.ok).toBe(false);
      expect(r.status).toBeNull();
      expect(run).toHaveBeenCalledTimes(HEALTH_ACTIVATE_MAX_ATTEMPTS);
    });

    it("is a no-op result when no python helper is provisioned", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
      const r = await d.activateHealth();
      expect(r.ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe("healthRetryDecision", () => {
    it("is done on any numeric status (success or a real code)", () => {
      expect(healthRetryDecision(1, 5)).toBe("done");
      expect(healthRetryDecision(8, 5)).toBe("done");
    });
    it("retries a fast null (the not-ready race)", () => {
      expect(healthRetryDecision(null, 10)).toBe("retry");
    });
    it("is done on a slow null (connected but unanswered — don't hammer the boot)", () => {
      expect(healthRetryDecision(null, HEALTH_ACTIVATE_READY_MS)).toBe("done");
    });
  });

  it("threads the cancellation token + onStep into the injected boot fn", async () => {
    const boot = vi.fn(async (_id: string) => ep);
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot, stop: async () => {} });
    const token = { cancelled: false };
    const step = () => {};
    await d.start("basalt", token, step);
    expect(boot).toHaveBeenCalledWith("basalt", token, step);
  });

  it("forces the VNC endpoint host to localhost regardless of the boot fn", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const boot = vi.fn(async () => ({ host: "192.168.1.50", port: 6080, wsPath: "/" }));
    const d = new BundledNativeDriver({ run, boot, stop: async () => {} });
    const result = await d.start("basalt", { cancelled: false });
    expect(result.host).toBe("localhost");
    expect(result.port).toBe(6080);
  });

  it("delegates screenshotFramebuffer to the input channel (winPath-normalized)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const screenshot = vi.fn(async () => true);
    const inputChannel = { screenshot } as unknown as import("../../src/main/backend/bundledInputChannel.js").BundledInputChannel;
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel });
    expect(await d.screenshotFramebuffer("C:/caps/My Shot.png")).toBe(true);
    expect(screenshot).toHaveBeenCalledWith("C:\\caps\\My Shot.png");
  });

  it("screenshotFramebuffer returns false when no input channel is wired (canvas fallback)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    expect(await d.screenshotFramebuffer("C:/caps/shot.png")).toBe(false);
  });

  it("screenshotFramebuffer swallows an input-channel rejection and returns false", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const screenshot = vi.fn(async () => { throw new Error("boom"); });
    const inputChannel = { screenshot } as unknown as import("../../src/main/backend/bundledInputChannel.js").BundledInputChannel;
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel });
    expect(await d.screenshotFramebuffer("C:/caps/shot.png")).toBe(false);
  });

  it("insertSamplePin sends the pin via the input channel", async () => {
    const insertPin = vi.fn(async () => true);
    const channel = { insertPin, deletePin: vi.fn(async () => true) } as unknown as import("../../src/main/backend/bundledInputChannel.js").BundledInputChannel;
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel: channel });
    await d.insertSamplePin(1781452800, "Sample Pin");
    expect(insertPin).toHaveBeenCalledWith("studio-sample-pin", 1781452800, "Sample Pin");
  });

  it("insertSamplePin throws when the channel reports failure (so IPC can revert)", async () => {
    const channel = { insertPin: vi.fn(async () => false), deletePin: vi.fn(async () => true) } as unknown as import("../../src/main/backend/bundledInputChannel.js").BundledInputChannel;
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel: channel });
    await expect(d.insertSamplePin(1781452800, "Sample Pin")).rejects.toThrow(/sample pin/i);
  });

  it("insertSamplePin throws when no input channel is wired", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {} });
    await expect(d.insertSamplePin(1, "x")).rejects.toThrow();
  });

  it("deleteSamplePin removes the fixed pin via the channel", async () => {
    const deletePin = vi.fn(async () => true);
    const channel = { insertPin: vi.fn(async () => true), deletePin } as unknown as import("../../src/main/backend/bundledInputChannel.js").BundledInputChannel;
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const d = new BundledNativeDriver({ run, boot: async () => ep, stop: async () => {}, inputChannel: channel });
    await d.deleteSamplePin();
    expect(deletePin).toHaveBeenCalledWith("studio-sample-pin");
  });
});
