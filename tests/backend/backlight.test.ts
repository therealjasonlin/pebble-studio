import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseMonitorPort,
  createBacklightController,
} from "../../src/main/backend/backlight.js";

/**
 * parseMonitorPort is the pure helper behind the backlight keepalive: it extracts
 * the qemu HMP `monitor` port from the /tmp/pb-emulator.json text so the keepalive
 * can open a TCP socket and send a Back press. It must be robust to a missing or
 * malformed file (return null, never throw).
 */
describe("parseMonitorPort", () => {
  // The real emulator state-file shape (from a live /tmp/pb-emulator.json).
  const realJson = JSON.stringify({
    emery: {
      "4.9.169": {
        qemu: { pid: 635689, port: 57419, serial: 55005, gdb: 43673, monitor: 54685, vnc: true },
        pypkjs: { pid: 635727, port: 54737 },
        version: "4.9.169",
        websockify: { pid: 635751 },
      },
    },
  });

  it("returns the monitor port from a valid state file", () => {
    expect(parseMonitorPort(realJson)).toBe(54685);
  });

  it("returns the first live monitor port across platforms/versions", () => {
    const json = JSON.stringify({
      basalt: { "4.9": { qemu: { pid: 1, monitor: 12000 } } },
    });
    expect(parseMonitorPort(json)).toBe(12000);
  });

  it("returns null when there is no qemu.monitor entry", () => {
    const json = JSON.stringify({ basalt: { "4.9": { qemu: { pid: 1 } } } });
    expect(parseMonitorPort(json)).toBeNull();
  });

  it("returns null for an empty / missing file", () => {
    expect(parseMonitorPort("")).toBeNull();
  });

  it("returns null for malformed (partial-write) json", () => {
    expect(parseMonitorPort('{ "emery": { "4.9.169": { "qemu": {')).toBeNull();
  });

  it("ignores a non-numeric monitor value", () => {
    const json = JSON.stringify({ basalt: { "4.9": { qemu: { monitor: "nope" } } } });
    expect(parseMonitorPort(json)).toBeNull();
  });

  it("with a platform arg, returns only that platform's monitor (ignores a stale other-platform entry)", () => {
    const json = JSON.stringify({
      basalt: { "4.9": { qemu: { monitor: 11111 } } }, // stale, dead qemu
      emery: { "4.9": { qemu: { monitor: 22222 } } },  // the live one
    });
    expect(parseMonitorPort(json, "emery")).toBe(22222);
    expect(parseMonitorPort(json, "basalt")).toBe(11111);
    expect(parseMonitorPort(json, "chalk")).toBeNull(); // no entry for this platform
  });
});

/**
 * The controller drives the keepalive. Its `method` selects WHAT a fire does:
 *   back   → read the qemu monitor port (injected reader) and send a Back key,
 *   motion → call the injected sendMotion() (accel tap), no monitor read,
 *   off    → do nothing (and the interval is never running).
 * We inject a `readMonitorPort` spy (so a monitor "read" is observable) and a
 * sendMotion spy. The reader returns null (no port), so the `back` path stops
 * after the read and never opens a real TCP socket — keeping these tests
 * hermetic. `pulseOnce()` fires exactly once for the current method regardless
 * of always/captureHold.
 */
describe("createBacklightController", () => {
  let readPort: ReturnType<typeof vi.fn>;
  let sendMotion: ReturnType<typeof vi.fn>;

  /** The injected reader answers "no monitor port" (null), so the "back" path
   * stops after the read and never opens a real TCP socket — keeping these tests
   * hermetic while still observing whether a read was attempted. */
  function makeController() {
    readPort = vi.fn(async () => null);
    sendMotion = vi.fn(async () => {});
    return createBacklightController(() => "native", sendMotion, readPort);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("method 'back' (default): a tick reads the monitor and tries to send a key", async () => {
    const ctrl = makeController();
    ctrl.setAlways(true); // sync() fires once immediately (back is the default)
    await vi.advanceTimersByTimeAsync(0);
    expect(readPort).toHaveBeenCalled();
    // The read returned no port, so motion was never used.
    expect(sendMotion).not.toHaveBeenCalled();
  });

  it("method 'off': with always=true, a fire does NO monitor read and NO motion", async () => {
    const ctrl = makeController();
    ctrl.setMethod("off");
    ctrl.setAlways(true);
    await vi.advanceTimersByTimeAsync(2000); // advance past several would-be ticks
    expect(readPort).not.toHaveBeenCalled();
    expect(sendMotion).not.toHaveBeenCalled();
    // pulseOnce is also a no-op when off.
    ctrl.pulseOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(readPort).not.toHaveBeenCalled();
    expect(sendMotion).not.toHaveBeenCalled();
  });

  it("method 'motion': a tick calls sendMotion and does NOT read the monitor", async () => {
    const ctrl = makeController();
    ctrl.setMethod("motion");
    ctrl.setAlways(true); // sync() fires once immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalledTimes(1);
    expect(readPort).not.toHaveBeenCalled();
  });

  it("pulseOnce() fires exactly one keepalive for the current method", async () => {
    const ctrl = makeController();
    ctrl.setMethod("motion");
    // No always/captureHold set → the interval is NOT running, so only the
    // explicit pulse should fire.
    ctrl.pulseOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalledTimes(1);
    // Advancing further must not produce additional fires (no interval active).
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMotion).toHaveBeenCalledTimes(1);
  });

  it("setMethod('off') stops a running interval even with always set", async () => {
    const ctrl = makeController();
    ctrl.setAlways(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(readPort).toHaveBeenCalled();
    readPort.mockClear();
    ctrl.setMethod("off"); // must stop the interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(readPort).not.toHaveBeenCalled();
  });

  // v0.0.13.5: capture-hold must light the screen during a screenshot/GIF even
  // when the always-on keepalive METHOD is "off" (the default). "off" only
  // disables the intrusive always-on keepalive (which navigates menus); an
  // explicit capture is a deliberate, temporary wake and should always work —
  // otherwise "backlight during capture" silently does nothing for the default
  // user, and GIFs record dim. Capture-hold wakes via motion (accel tap), never a
  // Back press, so a screenshot can't navigate inside the running app (PR #16).
  it("captureHold lights the screen even when method is 'off' (via motion, never Back)", async () => {
    const ctrl = makeController();
    ctrl.setMethod("off");
    ctrl.setCaptureHold(true); // an explicit capture - must wake despite "off"
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalledTimes(1);
    expect(readPort).not.toHaveBeenCalled(); // no Back press (would navigate the app)
  });

  it("captureHold never presses Back even when the always-on method is 'back'", async () => {
    const ctrl = makeController();
    ctrl.setMethod("back");
    ctrl.setCaptureHold(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalledTimes(1);
    expect(readPort).not.toHaveBeenCalled();
  });

  it("captureHold with method 'motion' uses motion (respects an explicit choice)", async () => {
    const ctrl = makeController();
    ctrl.setMethod("motion");
    ctrl.setCaptureHold(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalledTimes(1);
    expect(readPort).not.toHaveBeenCalled();
  });

  it("releasing captureHold stops the interval when method is 'off'", async () => {
    const ctrl = makeController();
    ctrl.setMethod("off");
    ctrl.setCaptureHold(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMotion).toHaveBeenCalled();
    sendMotion.mockClear();
    ctrl.setCaptureHold(false); // capture done — interval must stop
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMotion).not.toHaveBeenCalled();
  });

  it("=true with method 'off' stays inactive (only captureHold forces it)", async () => {
    const ctrl = makeController();
    ctrl.setMethod("off");
    ctrl.setAlways(true); // the always-on keepalive still respects "off"
    await vi.advanceTimersByTimeAsync(2000);
    expect(readPort).not.toHaveBeenCalled();
    expect(sendMotion).not.toHaveBeenCalled();
  });
});
