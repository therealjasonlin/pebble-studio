import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  parseBridgePids,
  buildHealthCommand,
  interpretHealth,
} from "../../src/main/backend/bridgeHealth.js";

// ---------------------------------------------------------------------------
// parseBridgePids
// ---------------------------------------------------------------------------

describe("parseBridgePids", () => {
  // Real shape from /tmp/pb-emulator.json sample.
  const sample = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 1854238, port: 51113, monitor: 42553, vnc: true },
        pypkjs: { pid: 1854276, port: 57749 },
        websockify: { pid: 1854300 },
      },
    },
  });

  it("returns all three numbers from a valid sample", () => {
    expect(parseBridgePids(sample, "emery")).toEqual({
      qemuPid: 1854238,
      pypkjsPid: 1854276,
      pypkjsPort: 57749,
    });
  });

  it("returns null when the platform is missing", () => {
    expect(parseBridgePids(sample, "basalt")).toBeNull();
  });

  it("returns null when qemu.pid is missing", () => {
    const noQemuPid = JSON.stringify({
      emery: {
        "4.9.169": {
          qemu: { port: 51113, monitor: 42553 },
          pypkjs: { pid: 1854276, port: 57749 },
        },
      },
    });
    expect(parseBridgePids(noQemuPid, "emery")).toBeNull();
  });

  it("returns null when pypkjs.pid is missing", () => {
    const noPypkjsPid = JSON.stringify({
      emery: {
        "4.9.169": {
          qemu: { pid: 1854238, port: 51113, monitor: 42553 },
          pypkjs: { port: 57749 },
        },
      },
    });
    expect(parseBridgePids(noPypkjsPid, "emery")).toBeNull();
  });

  it("returns null when pypkjs.port is missing", () => {
    const noPypkjsPort = JSON.stringify({
      emery: {
        "4.9.169": {
          qemu: { pid: 1854238, port: 51113, monitor: 42553 },
          pypkjs: { pid: 1854276 },
        },
      },
    });
    expect(parseBridgePids(noPypkjsPort, "emery")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseBridgePids("{not json", "emery")).toBeNull();
    expect(parseBridgePids("", "emery")).toBeNull();
  });

  it("tolerates non-object shapes without throwing", () => {
    expect(parseBridgePids("null", "emery")).toBeNull();
    expect(parseBridgePids('{"emery": 7}', "emery")).toBeNull();
    expect(parseBridgePids('{"emery": {"4.9": null}}', "emery")).toBeNull();
    expect(parseBridgePids('{"emery": {"4.9": {"qemu": null, "pypkjs": null}}}', "emery")).toBeNull();
  });

  it("picks the version entry that has all three values when multiple versions exist", () => {
    const multi = JSON.stringify({
      emery: {
        // This version is missing pypkjs.port — should be skipped.
        "4.8.0": {
          qemu: { pid: 111 },
          pypkjs: { pid: 222 },
        },
        // This version has all three — should be returned.
        "4.9.169": {
          qemu: { pid: 1854238 },
          pypkjs: { pid: 1854276, port: 57749 },
        },
      },
    });
    expect(parseBridgePids(multi, "emery")).toEqual({
      qemuPid: 1854238,
      pypkjsPid: 1854276,
      pypkjsPort: 57749,
    });
  });
});

// ---------------------------------------------------------------------------
// buildHealthCommand
// ---------------------------------------------------------------------------

describe("buildHealthCommand", () => {
  const pids = { qemuPid: 1854238, pypkjsPid: 1854276, pypkjsPort: 57749 };

  it("contains the qemu PID", () => {
    expect(buildHealthCommand(pids)).toContain("1854238");
  });

  it("contains the pypkjs PID", () => {
    expect(buildHealthCommand(pids)).toContain("1854276");
  });

  it("contains the pypkjs port", () => {
    expect(buildHealthCommand(pids)).toContain("57749");
  });

  // CRITICAL: the command is run via a Shell that on Windows re-wraps it as
  // `wsl.exe -- bash -lc "'bash' '-lc' '<cmd>'"`. Any quote inside the command
  // string is mangled across the two shell hops and silently breaks only on the
  // real .exe. (Same constraint as setTzOffsetCmd in pebbleCli.ts.)
  it("contains NO single-quote characters (survives the Windows→wsl.exe→bash hops)", () => {
    expect(buildHealthCommand(pids)).not.toContain("'");
  });

  it("contains NO double-quote characters (survives the Windows→wsl.exe→bash hops)", () => {
    expect(buildHealthCommand(pids)).not.toContain('"');
  });

  // Structural assertions: a gutted command body must not pass these.
  it("reads qemu process state via portable `ps -o state=` (not Linux-only /proc)", () => {
    expect(buildHealthCommand(pids)).toContain("ps -o state= -p 1854238");
    expect(buildHealthCommand(pids)).not.toContain("/proc/");
  });

  it("reads pypkjs process state via portable `ps -o state=`", () => {
    expect(buildHealthCommand(pids)).toContain("ps -o state= -p 1854276");
  });

  it("probes TCP via /dev/tcp/localhost/<pypkjsPort>", () => {
    expect(buildHealthCommand(pids)).toContain("/dev/tcp/localhost/57749");
  });

  it("emits echo OK on success", () => {
    expect(buildHealthCommand(pids)).toContain("echo OK");
  });

  it("emits echo DEAD on failure paths", () => {
    expect(buildHealthCommand(pids)).toContain("echo DEAD");
  });
});

// ---------------------------------------------------------------------------
// buildHealthCommand — EXECUTED behaviour (the real bug)
//
// The relaunch-loop bug (v0.0.13.10): on the Windows→wsl.exe path the first
// health poll reported `DEAD pid` while the emulator was demonstrably alive
// (the qemu/pypkjs processes survived long after the app gave up). The
// /proc/<pid> liveness read is fragile across the shell boundary, so a single
// unreadable read tore down a healthy, port-reachable bridge.
//
// CONTRACT: a reachable pypkjs port is authoritative proof the bridge is alive.
// If the port answers, the verdict MUST be OK regardless of what the /proc
// pid reads say. `DEAD pid` is only legitimate when the port is ALSO down.
// These tests execute the generated command against controlled pids/ports.
// ---------------------------------------------------------------------------

/** Open a TCP server on 127.0.0.1 and resolve its port. */
function openPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, server });
    });
  });
}

/** Reserve a port number then immediately free it — guaranteed-closed for the test window. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Spawn a short-lived process, kill it, and return its now-dead pid. */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("sleep", ["30"]);
    const pid = child.pid!;
    child.on("exit", () => resolve(pid));
    // Give it a tick to actually be running, then kill so /proc/<pid> disappears.
    setTimeout(() => child.kill("SIGKILL"), 50);
  });
}

/** Run the health one-liner through bash and return its trimmed stdout token. */
function runHealthCmd(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim()));
  });
}

// These execute the generated bash one-liner against a real Linux /proc + /dev/tcp,
// so they require a POSIX host (bash, sleep, /proc). They run on the Linux/WSL dev
// host but are skipped on the Windows host. The command-string structure itself is
// covered by the platform-agnostic "buildHealthCommand" describe above.
describe.skipIf(process.platform === "win32")("buildHealthCommand executed against real pids/ports", () => {
  const ALIVE = process.pid; // the test process is, by definition, alive.

  it("returns OK when both pids are alive and the port is reachable", async () => {
    const { port, server } = await openPort();
    try {
      const out = await runHealthCmd(buildHealthCommand({ qemuPid: ALIVE, pypkjsPid: ALIVE, pypkjsPort: port }));
      expect(out).toBe("OK");
    } finally {
      server.close();
    }
  });

  // THE REGRESSION TEST for the relaunch loop: a dead/unreadable pid must NOT
  // produce `DEAD pid` while the port still answers.
  it("returns OK (NOT DEAD pid) when the qemu pid is unreadable but the port is reachable", async () => {
    const { port, server } = await openPort();
    const gonePid = await deadPid();
    try {
      const out = await runHealthCmd(buildHealthCommand({ qemuPid: gonePid, pypkjsPid: ALIVE, pypkjsPort: port }));
      expect(out).toBe("OK");
    } finally {
      server.close();
    }
  });

  it("returns OK when the pypkjs pid is unreadable but the port is reachable", async () => {
    const { port, server } = await openPort();
    const gonePid = await deadPid();
    try {
      const out = await runHealthCmd(buildHealthCommand({ qemuPid: ALIVE, pypkjsPid: gonePid, pypkjsPort: port }));
      expect(out).toBe("OK");
    } finally {
      server.close();
    }
  });

  it("returns DEAD pid when a pid is gone AND the port is unreachable (a real death)", async () => {
    const port = await closedPort();
    const gonePid = await deadPid();
    const out = await runHealthCmd(buildHealthCommand({ qemuPid: gonePid, pypkjsPid: ALIVE, pypkjsPort: port }));
    expect(out).toBe("DEAD pid");
  });

  it("returns DEAD port when both pids are alive but the port is unreachable (pypkjs hung)", async () => {
    const port = await closedPort();
    const out = await runHealthCmd(buildHealthCommand({ qemuPid: ALIVE, pypkjsPid: ALIVE, pypkjsPort: port }));
    expect(out).toBe("DEAD port");
  });
});

// ---------------------------------------------------------------------------
// interpretHealth
// ---------------------------------------------------------------------------

describe("interpretHealth", () => {
  it("maps OK to alive=true, kind=ok", () => {
    expect(interpretHealth("OK", 0)).toEqual({ alive: true, kind: "ok" });
  });

  it("maps DEAD pid to alive=false, kind=pid", () => {
    expect(interpretHealth("DEAD pid", 1)).toEqual({ alive: false, kind: "pid" });
  });

  it("maps DEAD port to alive=false, kind=port", () => {
    expect(interpretHealth("DEAD port", 1)).toEqual({ alive: false, kind: "port" });
  });

  it("maps empty stdout to alive=false, kind=port (conservative fallback)", () => {
    expect(interpretHealth("", 0)).toEqual({ alive: false, kind: "port" });
  });

  it("maps garbage stdout to alive=false, kind=port (conservative fallback)", () => {
    expect(interpretHealth("unexpected error 42", 1)).toEqual({ alive: false, kind: "port" });
    expect(interpretHealth("bash: /proc/1/status: No such file", 1)).toEqual({ alive: false, kind: "port" });
  });

  it("tolerates surrounding whitespace and newlines", () => {
    expect(interpretHealth("  OK\n", 0)).toEqual({ alive: true, kind: "ok" });
    expect(interpretHealth("\nDEAD pid\n", 1)).toEqual({ alive: false, kind: "pid" });
    expect(interpretHealth("  DEAD port  ", 1)).toEqual({ alive: false, kind: "port" });
  });

  it("is case-insensitive", () => {
    expect(interpretHealth("ok", 0)).toEqual({ alive: true, kind: "ok" });
    expect(interpretHealth("dead pid", 1)).toEqual({ alive: false, kind: "pid" });
    expect(interpretHealth("DEAD PORT", 1)).toEqual({ alive: false, kind: "port" });
  });
});
