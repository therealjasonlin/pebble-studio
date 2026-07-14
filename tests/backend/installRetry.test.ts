import { describe, it, expect } from "vitest";
import {
  installWithBridgeRetry,
  isBridgeBusyError,
  isBridgeDeadError,
} from "../../src/main/backend/installRetry.js";

const BUSY = "pebble install --emulator basalt --vnc x.pbw failed (code 1): unable to add pbw when emulator already running";
const noSleep = async (): Promise<void> => {};

describe("isBridgeBusyError", () => {
  it("matches the pypkjs cap-reject text (in any wrapping)", () => {
    expect(isBridgeBusyError(new Error(BUSY))).toBe(true);
    expect(isBridgeBusyError(new Error("Error: emulator already running"))).toBe(true);
  });
  it("does not match unrelated failures", () => {
    expect(isBridgeBusyError(new Error("pebble install failed (code 1): bad pbw"))).toBe(false);
    expect(isBridgeBusyError(new Error("ENOENT"))).toBe(false);
  });
});

describe("isBridgeDeadError", () => {
  it("matches bridge disconnect and timeout failures", () => {
    expect(isBridgeDeadError(new Error("Timed out waiting for install confirmation."))).toBe(true);
    expect(isBridgeDeadError(new Error("WebSocketConnectionClosedException"))).toBe(true);
    expect(isBridgeDeadError(new Error("Connection to remote host was lost."))).toBe(true);
    expect(isBridgeDeadError(new Error("libpebble2.exceptions.TimeoutError"))).toBe(true);
    expect(isBridgeDeadError(new Error("Couldn't launch emulator"))).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isBridgeDeadError(new Error("pebble install failed: corrupt pbw"))).toBe(false);
    expect(isBridgeDeadError(new Error("ENOENT"))).toBe(false);
  });
});

describe("installWithBridgeRetry", () => {
  it("calls install once and returns when it succeeds first try", async () => {
    let n = 0;
    await installWithBridgeRetry(async () => { n++; }, { sleep: noSleep });
    expect(n).toBe(1);
  });
    it("recovers once from a dead bridge and retries the install", async () => {
    let installs = 0;
    let recoveries = 0;

    await installWithBridgeRetry(async () => {
      installs++;

      if (installs === 1) {
        throw new Error("Timed out waiting for install confirmation.");
      }
    }, {
      attempts: 3,
      sleep: noSleep,
      recoverBridge: async () => {
        recoveries++;
      },
    });

    expect(installs).toBe(2);
    expect(recoveries).toBe(1);
  });

  it("retries on the cap-reject and succeeds once the slot frees", async () => {
    let n = 0;
    await installWithBridgeRetry(async () => {
      n++;
      if (n < 3) throw new Error(BUSY);
    }, { attempts: 4, sleep: noSleep });
    expect(n).toBe(3);
  });

  it("gives up after `attempts` cap-rejects and rethrows the last error", async () => {
    let n = 0;
    await expect(installWithBridgeRetry(async () => {
      n++;
      throw new Error(BUSY);
    }, { attempts: 3, sleep: noSleep })).rejects.toThrow(/already running/);
    expect(n).toBe(3);
  });

  it("does NOT retry a non-cap-reject error — rethrows immediately", async () => {
    let n = 0;
    await expect(installWithBridgeRetry(async () => {
      n++;
      throw new Error("pebble install failed (code 1): corrupt pbw");
    }, { attempts: 4, sleep: noSleep })).rejects.toThrow(/corrupt pbw/);
    expect(n).toBe(1);
  });

  it("waits retryMs between attempts (sleep is called once per retry)", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await installWithBridgeRetry(async () => {
      n++;
      if (n < 3) throw new Error(BUSY);
    }, { attempts: 4, retryMs: 250, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([250, 250]); // two retries before the 3rd attempt succeeds
  });
});
