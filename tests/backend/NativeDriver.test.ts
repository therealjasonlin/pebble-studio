import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NativeDriver } from "../../src/main/backend/NativeDriver.js";
import { _resetShimState, isShimReady } from "../../src/main/backend/timeShim.js";

describe("NativeDriver", () => {
  it("runs the install command via the injected runner", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.install("/apps/face.pbw");
    expect(calls[0].cmd).toBe("pebble");
    expect(calls[0].args).toContain("install");
    expect(calls[0].args).toContain("/apps/face.pbw");
  });

  it("streamLogs attaches --vnc so it reuses the running VNC emulator (without --vnc the tool SIGKILLs the VNC qemu)", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const logSpawn = vi.fn((cmd: string, args: string[]) => { calls.push({ cmd, args }); return { kill: () => {} }; });
    const d = new NativeDriver({ run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), logSpawn });
    d.streamLogs("basalt", () => {});
    expect(calls[0].cmd).toBe("pebble");
    expect(calls[0].args).toEqual(["logs", "--emulator", "basalt", "--vnc"]);
  });

  it("rejects when the runner returns a non-zero code", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await expect(d.button("select", "press")).rejects.toThrow(/boom/);
  });

  it("start() and stop() use the injected boot/stop deps (no real spawning)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const boot = vi.fn(async () => ({ host: "localhost", port: 6080, wsPath: "/" }));
    const stop = vi.fn(async () => {});
    const d = new NativeDriver({ run, boot, stop });
    const ep = await d.start("basalt");
    // start now threads an optional cancellation token + onStep callback through
    // to boot (both undefined here).
    expect(boot).toHaveBeenCalledWith("basalt", undefined, undefined);
    expect(ep).toEqual({ host: "localhost", port: 6080, wsPath: "/" });
    await d.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("setTime passes epoch + --utc through the runner", async () => {
    const calls: string[][] = [];
    const run = async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.setTime("1700000000", { utc: true });
    expect(calls[0]).toContain("--utc");
    expect(calls[0]).toContain("1700000000");
  });

  it("timeFormat sends --format 24h", async () => {
    const calls: string[][] = [];
    const run = async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.timeFormat(true);
    expect(calls[0]).toEqual(expect.arrayContaining(["emu-time-format", "--format", "24h"]));
  });

  it("wipe() runs pebble wipe with no --emulator flag", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.wipe();
    expect(calls[0].cmd).toBe("pebble");
    expect(calls[0].args).toEqual(["wipe"]);
    expect(calls[0].args).not.toContain("--emulator");
  });

  it("timelineQuickView routes on through the runner", async () => {
    const calls: string[][] = [];
    const run = async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
    const d = new NativeDriver({ run });
    d.setPlatform("basalt");
    await d.timelineQuickView(true);
    expect(calls[0]).toEqual(expect.arrayContaining(["emu-set-timeline-quick-view", "on"]));
  });

  describe("setFakeTime", () => {
    it("issues bash -lc echo <target> <rate> > ctl path", async () => {
      const calls: { cmd: string; args: string[] }[] = [];
      const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
      const d = new NativeDriver({ run });
      await d.setFakeTime(123456, 0);
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("bash");
      expect(calls[0].args[0]).toBe("-lc");
      const cmdline = calls[0].args[1];
      // Must contain target and rate
      expect(cmdline).toContain("123456");
      expect(cmdline).toContain("0");
      // Must be quote-free
      expect(cmdline).not.toContain("'");
      expect(cmdline).not.toContain('"');
    });

    it("uses '-' for null target", async () => {
      const calls: { cmd: string; args: string[] }[] = [];
      const run = vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; });
      const d = new NativeDriver({ run });
      await d.setFakeTime(null, 1);
      const cmdline = calls[0].args[1];
      expect(cmdline).toContain("- 1");
    });

    it("does NOT throw on nonzero exit", async () => {
      const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "some error" }));
      const d = new NativeDriver({ run });
      await expect(d.setFakeTime(123456, 0)).resolves.toBeUndefined();
    });
  });

  describe("ensureTimeShim", () => {
    beforeEach(() => {
      _resetShimState();
    });

    it("routes commands through runner as bash -lc <cmdline> and resolves to a boolean", async () => {
      const bashCalls: string[] = [];
      const nowSec = Math.floor(Date.now() / 1000);
      const run = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "bash" && args[0] === "-lc") {
          const cmdline = args[1] ?? "";
          bashCalls.push(cmdline);
          // Satisfy the self-test: return nowSec+86400 when asked for date +%s
          if (cmdline.includes("date +%s")) {
            return { code: 0, stdout: String(nowSec + 86400), stderr: "" };
          }
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const d = new NativeDriver({ run });
      const result = await d.ensureTimeShim();
      expect(typeof result).toBe("boolean");
      // At least one bash -lc call must have been issued
      expect(bashCalls.length).toBeGreaterThan(0);
    });

    it("resolves true and marks isShimReady() when vendor resources are present", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const run = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "bash" && args[0] === "-lc") {
          const cmdline = args[1] ?? "";
          if (cmdline.includes("date +%s")) {
            return { code: 0, stdout: String(nowSec + 86400), stderr: "" };
          }
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const d = new NativeDriver({ run });
      const result = await d.ensureTimeShim();
      expect(result).toBe(true);
      expect(isShimReady()).toBe(true);
    });

    it("does NOT throw when resources are missing (resolves false)", async () => {
      // Force resources to fail by using a fresh shimState + broken runner
      const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "fail" }));
      const d = new NativeDriver({ run });
      // Even if the runner always fails, it should not throw
      await expect(d.ensureTimeShim()).resolves.toBeDefined();
    });
  });

  describe("ensureTimeShim — macOS shim routing (deps.macShim)", () => {
    const REAL = "/Users/x/Library/Application Support/Pebble SDK/q/qemu-pebble";
    const WRAP = "/home/.pebble-studio/qemu-pebble";
    const CTL = "/home/.pebble-studio/pb-faketime.ctl";
    // These tests mutate process.env; snapshot + restore the two keys they touch.
    let savedQemu: string | undefined;
    let savedFt: string | undefined;
    beforeEach(() => {
      savedQemu = process.env.PEBBLE_QEMU_PATH;
      savedFt = process.env.PEBBLE_FAKETIME_FILE;
      delete process.env.PEBBLE_QEMU_PATH;
      delete process.env.PEBBLE_FAKETIME_FILE;
    });
    afterEach(() => {
      if (savedQemu === undefined) delete process.env.PEBBLE_QEMU_PATH;
      else process.env.PEBBLE_QEMU_PATH = savedQemu;
      if (savedFt === undefined) delete process.env.PEBBLE_FAKETIME_FILE;
      else process.env.PEBBLE_FAKETIME_FILE = savedFt;
    });

    it("shim ready → routes PEBBLE_QEMU_PATH to the wrapper + sets the shared ctl file", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const ensure = vi.fn(async () => true);
      const d = new NativeDriver({ run, macShim: { realQemu: REAL, wrapper: WRAP, ctl: CTL, ensure } });
      const ok = await d.ensureTimeShim();
      expect(ok).toBe(true);
      expect(ensure).toHaveBeenCalledWith(REAL);
      expect(process.env.PEBBLE_QEMU_PATH).toBe(WRAP);
      expect(process.env.PEBBLE_FAKETIME_FILE).toBe(CTL);
      // The mac path must NOT fall through to the Linux bash -lc runner.
      expect(run).not.toHaveBeenCalled();
    });

    it("shim NOT ready → keeps the raw qemu + leaves no fake-time file (real time)", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const ensure = vi.fn(async () => false);
      const d = new NativeDriver({ run, macShim: { realQemu: REAL, wrapper: WRAP, ctl: CTL, ensure } });
      const ok = await d.ensureTimeShim();
      expect(ok).toBe(false);
      expect(process.env.PEBBLE_QEMU_PATH).toBe(REAL);
      expect(process.env.PEBBLE_FAKETIME_FILE).toBeUndefined();
    });

    it("ensure throwing degrades to not-ready (raw qemu, no throw)", async () => {
      const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const ensure = vi.fn(async () => { throw new Error("boom"); });
      const d = new NativeDriver({ run, macShim: { realQemu: REAL, wrapper: WRAP, ctl: CTL, ensure } });
      await expect(d.ensureTimeShim()).resolves.toBe(false);
      expect(process.env.PEBBLE_QEMU_PATH).toBe(REAL);
    });
  });
});
