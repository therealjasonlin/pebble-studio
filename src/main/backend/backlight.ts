import { connect as netConnect } from "node:net";
import { makeNativeShell, makeWslShell, type Shell } from "./bootEmulator.js";
import type { DriverKind } from "./driverFactory.js";
import { EMU_INFO_PATH } from "./hostPaths.js";
import { getActivePlatform } from "./pebbleCli.js";

/**
 * Backlight keepalive (Task K).
 *
 * The qemu-pebble screen backlight dims after a few seconds. pebble-tool's GIF
 * capture keeps it bright by tapping a button every second; we mirror that. While
 * `always` OR `captureHold` is set, a ~1000ms interval:
 *   1. reads the qemu HMP **monitor** port from /tmp/pb-emulator.json
 *      (`<platform>.<version>.qemu.monitor`) — THROUGH the same Shell abstraction
 *      bootEmulator uses, so it works on a Windows+WSL host where the file lives
 *      in the WSL filesystem and Node (on Windows) can't read that POSIX path.
 *   2. opens a TCP socket to 127.0.0.1:<monitor>, writes `sendkey left\n`
 *      (a Back press = backlight wake), and closes.
 *
 * A Back press is harmless on a watchface but can navigate inside an app — that
 * caveat is surfaced in the Settings UI, not here.
 */

const TICK_MS = 1000;

/**
 * Extract the qemu HMP monitor port from the emulator state file's JSON text.
 *
 * Pure (no fs / no shell) so it is unit-testable. The file shape is
 *   { "<platform>": { "<version>": { "qemu": { "monitor": <port>, ... } } } }
 * (e.g. `{ "basalt": { "4.9": { "qemu": { "monitor": 63215 } } } }`).
 *
 * With `platform` given, only that platform's versions are searched — like
 * parseBridgePids — so a stale entry for a DIFFERENT, dead platform can't hand back
 * a monitor port for a qemu that is gone (a Back-press to a dead port). Without it
 * (legacy callers) we return the first live `monitor` port across all platforms.
 * Returns null if the json is missing/malformed or has no matching monitor entry.
 */
export function parseMonitorPort(jsonText: string, platform?: string): number | null {
  try {
    const json = JSON.parse(jsonText) as Record<
      string,
      Record<string, { qemu?: { monitor?: number } }>
    >;
    const entries = platform
      ? (json?.[platform] ? [json[platform]] : [])
      : Object.values(json);
    for (const versions of entries) {
      if (!versions || typeof versions !== "object") continue;
      for (const v of Object.values(versions)) {
        const port = v?.qemu?.monitor;
        if (typeof port === "number" && Number.isFinite(port)) return port;
      }
    }
  } catch {
    /* missing / partial / malformed json → no port */
  }
  return null;
}

/** Read the emulator state file through the shell and parse the monitor port.
 * Correct for wsl / native-Linux. NOT for a Windows host: there `bash` is the WSL
 * launcher, so this reads WSL's /tmp and never finds the native state file — the
 * windows-native wiring injects a Node-fs reader instead (see createBacklightController
 * caller in ipc.ts; same fix class as the Clay gear + bridge-health monitor). */
async function readPortViaShell(shell: Shell): Promise<number | null> {
  const { code, stdout } = await shell.run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
  if (code !== 0 || !stdout.trim()) return null;
  // Scope to the active platform so a stale entry for a different, dead platform
  // can't return a monitor port for a qemu that's already gone.
  return parseMonitorPort(stdout, getActivePlatform());
}

/** Open a TCP socket to the HMP monitor, send a Back press, then close. */
function sendBackKey(port: number): Promise<void> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    sock.setTimeout(1000);
    const done = () => {
      sock.destroy();
      resolve();
    };
    sock.once("connect", () => {
      // HMP command: `sendkey left` taps the Back button (backlight wake).
      sock.write("sendkey left\n", () => {
        // Give the monitor a beat to receive before we tear down the socket.
        setTimeout(done, 50);
      });
    });
    sock.once("error", done);
    sock.once("timeout", done);
  });
}

/**
 * How a keepalive fire wakes the backlight:
 *   - `back`   → tap the Back button (qemu monitor `sendkey left`). Default.
 *                Harmless on a watchface but can navigate inside an app.
 *   - `motion` → inject an accel tap (a shake). Doesn't navigate menus, but
 *                fires the app's shake/tap handlers.
 *   - `off`    → no keepalive at all (the interval is never run).
 */
export type BacklightMethod = "back" | "motion" | "off";

export interface BacklightController {
  /** "Keep backlight on" — independent of captures. */
  setAlways(on: boolean): void;
  /** "Backlight during capture" — held only for the duration of a capture. */
  setCaptureHold(on: boolean): void;
  /** Choose how a fire wakes the backlight; re-syncs the interval. */
  setMethod(m: BacklightMethod): void;
  /** Fire a single keepalive now (current method; no-op when method is "off"). */
  pulseOnce(): void;
  /** Stop the keepalive entirely (e.g. on emulator stop). Clears both flags. */
  stop(): void;
}

/**
 * Construct a BacklightController. The shell is chosen to mirror createDriver's
 * native/wsl decision (passed in by the caller, which knows the active driver
 * kind) so the monitor-port read works on the same host the emulator runs on.
 *
 * `sendMotion` is the accel-tap injector (the real wiring passes
 * `() => driver!.accelTap()`); it's used by the "motion" method.
 *
 * `readMonitorPort` returns the qemu HMP monitor port for the "back" method (null
 * when unavailable). The caller injects a driver-aware reader (Node fs on %TEMP%
 * for windows-native; the shell `cat` for wsl / native-Linux). It defaults to the
 * shell reader — correct off-Windows, but the windows-native caller MUST override
 * it (a Windows-host `bash` is the WSL launcher and would read the wrong /tmp).
 */
export function createBacklightController(
  getKind: () => DriverKind | null,
  sendMotion: () => Promise<void>,
  readMonitorPort: () => Promise<number | null> =
    () => readPortViaShell(defaultShellFor(getKind() ?? "native")),
): BacklightController {
  let always = false;
  let captureHold = false;
  let method: BacklightMethod = "back";
  let timer: ReturnType<typeof setInterval> | null = null;
  // Guard so a slow fire (shell read + TCP) doesn't overlap the next interval.
  let ticking = false;

  /**
   * The wake method to actually use for a fire. The always-on keepalive honors
   * the user's `method` (incl. "off" = no keepalive, "back" = Back press). But
   * `captureHold` is a deliberate, temporary wake tied to an explicit screenshot
   * or GIF: it must light the screen even when the always-on keepalive is "off"
   * (the default), and it must NOT press Back - a Back press navigates inside the
   * running app and a screenshot must never change emulator state (community PR
   * #16). So a capture always wakes via an accel tap (motion), whatever the
   * always-on method is.
   */
  function effectiveMethod(): BacklightMethod {
    if (captureHold) return "motion";
    return method;
  }

  /** Perform a single keepalive action for the effective method. */
  async function fire(): Promise<void> {
    const m = effectiveMethod();
    if (m === "off") return; // disabled — nothing to do
    if (m === "motion") {
      try {
        await sendMotion();
      } catch {
        /* never let a fire crash the app */
      }
      return;
    }
    // "back": read the qemu HMP monitor port (driver-aware), send a Back key.
    const port = await readMonitorPort();
    if (port == null) return; // backend not up / json/monitor missing — skip silently
    await sendBackKey(port);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await fire();
    } catch {
      /* never let a tick crash the app — skip and try again next interval */
    } finally {
      ticking = false;
    }
  }

  function sync(): void {
    // The always-on keepalive runs only when `always` is set AND the method is
    // not "off". `captureHold` runs whenever set — even under method "off" —
    // because a capture is an explicit, temporary wake (see effectiveMethod).
    const wantActive = (always && method !== "off") || captureHold;
    if (wantActive && timer == null) {
      timer = setInterval(() => void tick(), TICK_MS);
      // Fire once immediately so the backlight rises without a full tick's wait.
      void tick();
    } else if (!wantActive && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    setAlways(on: boolean): void {
      always = on;
      sync();
    },
    setCaptureHold(on: boolean): void {
      captureHold = on;
      sync();
    },
    setMethod(m: BacklightMethod): void {
      method = m;
      sync();
    },
    pulseOnce(): void {
      // A single immediate fire regardless of always/captureHold (respects "off").
      void fire();
    },
    stop(): void {
      always = false;
      captureHold = false;
      sync();
    },
  };
}

/** Pick the native or wsl shell, mirroring how createDriver decides. */
function defaultShellFor(kind: DriverKind): Shell {
  return kind === "wsl" ? makeWslShell() : makeNativeShell();
}
