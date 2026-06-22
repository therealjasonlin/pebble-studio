import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { makeBundledBootDeps } from "../../src/main/backend/bundledBootDeps.js";

// makeBundledBootDeps branches on process.platform (Windows tasklist/taskkill vs
// POSIX pgrep/pkill). These cases assert the Windows branch, so pin the platform
// to win32 for this file regardless of the host running the suite.
const ORIGINAL_PLATFORM = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }));
afterAll(() => Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM }));

function deps(over = {}) {
  const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const readFile = vi.fn(async () => "");
  const detachSpawn = vi.fn(async () => {});
  return { run, readFile, detachSpawn, ...over };
}

describe("makeBundledBootDeps", () => {
  it("bootControl detach-spawns bare pebble (PATH default) with no extra env", async () => {
    const d = deps();
    const b = makeBundledBootDeps(d);
    await b.bootControl("basalt");
    expect(d.detachSpawn).toHaveBeenCalledWith("pebble", ["emu-control", "--emulator", "basalt", "--vnc"], undefined);
  });

  it("bootControl routes through the injected bundled-pebble builder, threading its env to the detached spawn", async () => {
    const pebble = (args: string[]) => ({
      cmd: "C:\\py\\python.exe",
      args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
      env: { PEBBLE_QEMU_PATH: "C:\\q\\qemu-pebble.exe", XDG_DATA_HOME: "C:\\data\\pebble-data" },
    });
    const d = deps({ pebble });
    const b = makeBundledBootDeps(d);
    await b.bootControl("emery");
    expect(d.detachSpawn).toHaveBeenCalledWith(
      "C:\\py\\python.exe",
      ["-c", "from pebble_tool import run_tool; run_tool()", "emu-control", "--emulator", "emery", "--vnc"],
      { PEBBLE_QEMU_PATH: "C:\\q\\qemu-pebble.exe", XDG_DATA_HOME: "C:\\data\\pebble-data" },
    );
  });

  it("wipe routes through the injected bundled-pebble builder with its env", async () => {
    const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const pebble = (args: string[]) => ({
      cmd: "C:\\py\\python.exe",
      args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
      env: { XDG_DATA_HOME: "C:\\data\\pebble-data" },
    });
    const d = deps({
      pebble,
      run: vi.fn(async (cmd: string, args: string[], env?: Record<string, string>) => { calls.push({ cmd, args, env }); return { code: 0, stdout: "", stderr: "" }; }),
    });
    const b = makeBundledBootDeps(d);
    await b.wipe!();
    const wipeCall = calls.find((c) => c.args.includes("wipe"));
    expect(wipeCall?.cmd).toBe("C:\\py\\python.exe");
    expect(wipeCall?.env).toEqual({ XDG_DATA_HOME: "C:\\data\\pebble-data" });
  });

  it("diagnose reports qemuAlive from a live tasklist row", async () => {
    const d = deps({
      run: vi.fn(async (_c: string, args: string[]) =>
        args.includes("IMAGENAME eq qemu-pebble.exe")
          ? { code: 0, stdout: `"qemu-pebble.exe","999","Console","1","10 K"\r\n`, stderr: "" }
          : { code: 0, stdout: "", stderr: "" }),
      readFile: vi.fn(async () => JSON.stringify({ basalt: { "4.9": { qemu: { pid: 999 } } } })),
    });
    const b = makeBundledBootDeps(d);
    const probe = await b.diagnose();
    expect(probe.qemuAlive).toBe(true);
    expect(probe.stateFile).toBe(true);
  });

  it("waitForEmuInfo resolves once the state file has a live pid for the platform", async () => {
    const d = deps({ readFile: vi.fn(async () => JSON.stringify({ basalt: { "4.9": { qemu: { pid: 42 } } } })) });
    const b = makeBundledBootDeps(d);
    await expect(b.waitForEmuInfo("basalt", 1000)).resolves.toBeUndefined();
  });

  it("killAll force-kills qemu by image and removes the state file", async () => {
    const calls: string[][] = [];
    const d = deps({
      run: vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    const b = makeBundledBootDeps(d);
    await b.killAll();
    expect(calls.some((a) => a.includes("qemu-pebble.exe") && a.includes("/F"))).toBe(true);
    expect(d.rm).toHaveBeenCalled();
  });

  it("waitForEmuInfo throws on timeout when the state file never has a live pid", async () => {
    const b = makeBundledBootDeps(deps({ readFile: vi.fn(async () => "") }));
    await expect(b.waitForEmuInfo("basalt", 1)).rejects.toThrow(/timeout/i);
  });

  it("waitForEmuInfo aborts promptly when the token is cancelled", async () => {
    const token = { cancelled: true };
    const b = makeBundledBootDeps(deps({ readFile: vi.fn(async () => "") }));
    await expect(b.waitForEmuInfo("basalt", 10_000, token)).rejects.toThrow(/abort/i);
  });

  it("waitForPort rejects on timeout when the port never opens", async () => {
    const b = makeBundledBootDeps(deps({ portOpen: vi.fn(async () => false) }));
    await expect(b.waitForPort("127.0.0.1", 5901, 1)).rejects.toThrow(/timeout/i);
  });

  it("diagnose reports qemuAlive=false for the 'No tasks' tasklist banner", async () => {
    const b = makeBundledBootDeps(deps({
      run: vi.fn(async () => ({ code: 0, stdout: "INFO: No tasks are running which match the specified criteria.\r\n", stderr: "" })),
      readFile: vi.fn(async () => ""),
      portOpen: vi.fn(async () => false),
    }));
    const probe = await b.diagnose();
    expect(probe.qemuAlive).toBe(false);
    expect(probe.stateFile).toBe(false);
  });
});

describe("makeBundledBootDeps killAll — process-leak fix", () => {
  // State file with qemu + pypkjs + websockify pids; the latter two run as
  // python.exe, so they MUST be killed by PID (an image kill would leak them).
  const stateJson = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 1001, port: 63000, vnc: true },
        pypkjs: { pid: 1002, port: 63001 },
        websockify: { pid: 1003 },
      },
    },
  });

  it("force-kills every state-file pid by PID and qemu by image, then removes the state file", async () => {
    const calls: string[][] = [];
    const d = deps({
      run: vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }),
      readFile: vi.fn(async () => stateJson),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    const b = makeBundledBootDeps(d);
    await b.killAll();

    // Each pid (qemu/pypkjs/websockify) force-killed by PID with the child tree.
    for (const pid of ["1001", "1002", "1003"]) {
      expect(calls.some((a) => a.includes("/PID") && a.includes(pid) && a.includes("/T") && a.includes("/F"))).toBe(true);
    }
    // Image backstop for qemu still runs; state file removed.
    expect(calls.some((a) => a.includes("qemu-pebble.exe") && a.includes("/F"))).toBe(true);
    expect(d.rm).toHaveBeenCalled();
  });

  it("does not blanket-kill python.exe by image (would hit unrelated user Python)", async () => {
    const calls: string[][] = [];
    const d = deps({
      run: vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }),
      readFile: vi.fn(async () => stateJson),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    await makeBundledBootDeps(d).killAll();
    expect(calls.some((a) => a.includes("python.exe"))).toBe(false);
  });

  it("calls pebble kill first (supervisor shutdown) through the bundled builder", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const pebble = (args: string[]) => ({ cmd: "C:\\py\\python.exe", args: ["-c", "run", ...args], env: { X: "1" } });
    const d = deps({
      pebble,
      run: vi.fn(async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; }),
      readFile: vi.fn(async () => ""),
      rm: vi.fn(async () => {}),
      portOpen: vi.fn(async () => false),
    });
    await makeBundledBootDeps(d).killAll();
    expect(calls.some((c) => c.cmd === "C:\\py\\python.exe" && c.args.includes("kill"))).toBe(true);
  });
});

describe("makeBundledBootDeps preflight — foreign port-collision guard", () => {
  it("resolves when both VNC and ws ports are free", async () => {
    const b = makeBundledBootDeps(deps({ portOpen: vi.fn(async () => false) }));
    await expect(b.preflight!()).resolves.toBeUndefined();
  });

  it("throws a clear, actionable error when a port is still held after teardown", async () => {
    const b = makeBundledBootDeps(deps({ portOpen: vi.fn(async () => true) }));
    await expect(b.preflight!()).rejects.toThrow(/already in use.*(WSL|Pebble Studio instance)/i);
  });

  it("names the specific port(s) in use", async () => {
    // Only the RFB port (5901) is held.
    const portOpen = vi.fn(async (_h: string, p: number) => p === 5901);
    const b = makeBundledBootDeps(deps({ portOpen }));
    await expect(b.preflight!()).rejects.toThrow(/5901/);
  });
});
