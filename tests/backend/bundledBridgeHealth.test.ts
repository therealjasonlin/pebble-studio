import { describe, it, expect } from "vitest";
import {
  nativeHealthVerdict,
  makeNativeHealthCheck,
} from "../../src/main/backend/bundledBridgeHealth.js";
import type { BridgePids } from "../../src/main/backend/bridgeHealth.js";

const PIDS: BridgePids = { qemuPid: 1001, pypkjsPid: 1002, pypkjsPort: 57749 };

describe("nativeHealthVerdict (pure, port-first)", () => {
  it("reachable port → OK regardless of pid state", () => {
    expect(nativeHealthVerdict(true, false, false)).toEqual({ alive: true, kind: "ok" });
  });

  it("port down + a dead pid → DEAD pid (real death)", () => {
    expect(nativeHealthVerdict(false, false, true)).toEqual({ alive: false, kind: "pid" });
    expect(nativeHealthVerdict(false, true, false)).toEqual({ alive: false, kind: "pid" });
  });

  it("port down but both pids alive → DEAD port (hung, debounced)", () => {
    expect(nativeHealthVerdict(false, true, true)).toEqual({ alive: false, kind: "port" });
  });
});

describe("makeNativeHealthCheck", () => {
  it("returns OK when the pypkjs port is reachable (no pid read needed)", async () => {
    let pidReads = 0;
    const check = makeNativeHealthCheck({
      portOpen: async () => true,
      pidAlive: () => { pidReads++; return true; },
    });
    expect(await check(PIDS)).toEqual({ alive: true, kind: "ok" });
    expect(pidReads).toBe(0); // port-first short-circuits before reading pids
  });

  it("probes localhost on the pypkjs port from the state file", async () => {
    const seen: Array<[string, number]> = [];
    const check = makeNativeHealthCheck({
      portOpen: async (h, p) => { seen.push([h, p]); return true; },
    });
    await check(PIDS);
    expect(seen).toEqual([["127.0.0.1", 57749]]);
  });

  it("port down + a dead pid → DEAD pid", async () => {
    const check = makeNativeHealthCheck({
      portOpen: async () => false,
      pidAlive: (pid) => pid !== 1002, // pypkjs gone
    });
    expect(await check(PIDS)).toEqual({ alive: false, kind: "pid" });
  });

  it("port down but both pids alive → DEAD port", async () => {
    const check = makeNativeHealthCheck({
      portOpen: async () => false,
      pidAlive: () => true,
    });
    expect(await check(PIDS)).toEqual({ alive: false, kind: "port" });
  });
});
