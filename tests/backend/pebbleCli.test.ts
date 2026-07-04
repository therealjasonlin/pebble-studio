import { describe, it, expect } from "vitest";
import {
  installCmd, buttonCmd, accelTapCmd, setTimeCmd, timeFormatCmd, btCmd, batteryCmd, screenshotCmd, bootCmd, wipeCmd, timelineQuickViewCmd, setTzOffsetCmd, winSetTzOffsetArgv,
  activateHealthCmd, winActivateHealthArgv, parseHealthStatus, activateHealthHelperSource,
} from "../../src/main/backend/pebbleCli.js";

describe("pebbleCli argv builders", () => {
  it("builds an install command for a pbw path", () => {
    expect(installCmd("/apps/face.pbw")).toEqual({
      cmd: "pebble",
      args: ["install", "--emulator", "basalt", "/apps/face.pbw"],
      env: { PEBBLE_EMULATOR: "basalt" },
    });
  });
  it("builds a button press command", () => {
    // Real CLI: pebble emu-button {click,push,release} [BUTTON ...]
    // action first, then button; "press" ButtonAction maps to "click"
    expect(buttonCmd("select", "press").args).toEqual(["emu-button", "--emulator", "basalt", "click", "select"]);
  });
  it("builds an accelerometer tap command", () => {
    // Real CLI: pebble emu-tap (separate subcommand, not emu-accel tap)
    expect(accelTapCmd().args).toEqual(["emu-tap", "--emulator", "basalt"]);
  });
  it("sets a specific time (HH:MM:SS)", () => {
    // Real CLI: pebble emu-set-time accepts HH:MM:SS or Unix seconds, NOT ISO
    expect(setTimeCmd("09:30:00").args).toEqual(["emu-set-time", "--emulator", "basalt", "09:30:00"]);
  });
  it("toggles bluetooth", () => {
    // Real CLI: --connected {no,yes} (not connected/disconnected)
    expect(btCmd(false).args).toEqual(["emu-bt-connection", "--emulator", "basalt", "--connected", "no"]);
  });
  it("sets battery level + charging", () => {
    expect(batteryCmd(42, true).args).toEqual(["emu-battery", "--emulator", "basalt", "--percent", "42", "--charging"]);
  });
  it("builds a screenshot command with output path", () => {
    expect(screenshotCmd("/tmp/shot.png").args).toEqual(["screenshot", "--emulator", "basalt", "/tmp/shot.png"]);
  });
  it("builds an emulator boot command with vnc enabled", () => {
    expect(bootCmd("chalk").args).toEqual(["emu-control", "--emulator", "chalk", "--vnc"]);
  });
  it("builds a wipe command with no --emulator flag (wipes all platforms)", () => {
    // pebble wipe has no --emulator option; it always wipes all platform dirs
    // for the current SDK version. The emulator cannot survive a wipe.
    const c = wipeCmd();
    expect(c.cmd).toBe("pebble");
    expect(c.args).toEqual(["wipe"]);
    // Confirm no --emulator flag is present (would be a CLI error)
    expect(c.args).not.toContain("--emulator");
  });
});

describe("setTimeCmd --utc", () => {
  it("omits --utc by default", () => {
    expect(setTimeCmd("1700000000").args).toEqual(["emu-set-time", "--emulator", expect.any(String), "1700000000"]);
  });
  it("appends --utc when requested", () => {
    expect(setTimeCmd("1700000000", true).args).toContain("--utc");
  });
});

describe("timeFormatCmd", () => {
  it("builds 24h", () => {
    expect(timeFormatCmd(true).args).toEqual(["emu-time-format", "--emulator", expect.any(String), "--format", "24h"]);
  });
  it("builds 12h", () => {
    expect(timeFormatCmd(false).args).toContain("12h");
  });
});

describe("timelineQuickViewCmd", () => {
  it("on", () => expect(timelineQuickViewCmd(true).args).toEqual(["emu-set-timeline-quick-view", "--emulator", expect.any(String), "on"]));
  it("off", () => expect(timelineQuickViewCmd(false).args).toContain("off"));
});

describe("setTzOffsetCmd", () => {
  // ROOT CAUSE of the v0.0.11 "timezone/custom time do nothing on the .exe" bug:
  // the one-liner is run as `bash -lc <oneLiner>` and the WSL driver re-wraps it
  // as `wsl.exe -- bash -lc "'bash' '-lc' '<oneLiner>'"`. ANY single/double quote
  // inside the one-liner has to survive Node's Windows arg-quoting + two shell
  // hops, which mangled it. So the one-liner MUST stay quote-free.
  it("produces a quote-free one-liner (survives the Windows→wsl.exe→bash hops)", () => {
    const c = setTzOffsetCmd(-240, "America/New_York");
    expect(c.cmd).toBe("bash");
    const oneLiner = c.args[1];
    expect(oneLiner).not.toContain("'");
    expect(oneLiner).not.toContain('"');
    expect(oneLiner).toContain("-240");
    expect(oneLiner).toContain("America/New_York");
  });
  it("hard-bounds the helper with `timeout`/`gtimeout` when present (SIGTERM 6s, SIGKILL 8s)", () => {
    const oneLiner = setTzOffsetCmd(-240, "America/New_York").args[1];
    // Resolve either coreutils name (gtimeout on macOS/Homebrew) and apply it only
    // when found — `${T:+$T -k 2 6}` expands to nothing on a stock macOS, so the
    // helper still runs (unbounded) rather than dying on a missing `timeout`.
    expect(oneLiner).toContain("command -v timeout || command -v gtimeout");
    expect(oneLiner).toContain("${T:+$T -k 2 6} $PYBIN");
    expect(oneLiner).not.toContain("'"); // quote-free rule (v0.0.12)
    expect(oneLiner).not.toContain('"');
  });
  it("falls back to a synthesized UTC±h name for non-shell-safe/absent zones", () => {
    expect(setTzOffsetCmd(540).args[1]).toContain("UTC+9");
    expect(setTzOffsetCmd(-240).args[1]).toContain("UTC-4");
    // A zone with shell-unsafe characters is rejected → synthesized name used.
    const c = setTzOffsetCmd(540, "Asia/Tokyo; rm -rf /");
    expect(c.args[1]).not.toContain("rm -rf");
    expect(c.args[1]).toContain("UTC+9");
  });
});

describe("winSetTzOffsetArgv", () => {
  const py = "C:\\py\\python.exe";
  const helper = "C:\\Users\\x\\.pebble-studio\\pb-set-tz.py";

  it("builds an argv (no shell) invoking python on the helper with offset + zone", () => {
    const c = winSetTzOffsetArgv({ pythonExe: py, helperPath: helper, offsetMin: -240, tzName: "America/New_York" });
    expect(c.cmd).toBe(py);
    expect(c.args).toEqual([helper, "-240", "America/New_York"]);
  });

  it("synthesizes a UTC±h name when no zone is given", () => {
    expect(winSetTzOffsetArgv({ pythonExe: py, helperPath: helper, offsetMin: 540 }).args[2]).toBe("UTC+9");
    expect(winSetTzOffsetArgv({ pythonExe: py, helperPath: helper, offsetMin: -240 }).args[2]).toBe("UTC-4");
  });

  it("rejects an unsafe zone name and falls back to the synthesized UTC±h", () => {
    const c = winSetTzOffsetArgv({ pythonExe: py, helperPath: helper, offsetMin: 540, tzName: "Asia/Tokyo; rm -rf /" });
    expect(c.args[2]).toBe("UTC+9");
  });

  it("truncates a fractional offset to an integer string", () => {
    expect(winSetTzOffsetArgv({ pythonExe: py, helperPath: helper, offsetMin: 90.7 }).args[1]).toBe("90");
  });
});

describe("activateHealth", () => {
  it("POSIX command is a quote-free bash -lc one-liner that decodes + runs the helper", () => {
    const c = activateHealthCmd();
    expect(c.cmd).toBe("bash");
    expect(c.args[0]).toBe("-lc");
    expect(c.args[1]).toContain("pb-activate-health.py");
    expect(c.args[1]).toContain("base64 -d");
    expect(c.args[1]).not.toMatch(/['"]/); // quote-free rule (v0.0.12)
  });
  it("win argv runs the python on the helper path + passes the state-file path", () => {
    const c = winActivateHealthArgv("C:/py/python.exe", "C:/h/pb-activate-health.py", "C:/Temp/pb-emulator.json");
    expect(c).toEqual({ cmd: "C:/py/python.exe", args: ["C:/h/pb-activate-health.py", "C:/Temp/pb-emulator.json"] });
  });
  it("decoded helper sends a BlobDB Prefs INSERT (activityPreferences, tracking on) + reads state path from argv", () => {
    const src = activateHealthHelperSource().toString("utf8");
    expect(src).toContain("activityPreferences");
    expect(src).toContain("database=7");
    expect(src).toContain("struct.pack('<hhBBBbb', 1750, 7500, 1, 1, 1, 30, 1)");
    // The fix: state-file path is argv[1] (default /tmp), so native Windows can pass %TEMP%.
    expect(src).toContain("statepath = sys.argv[1]");
    expect(src).toContain("open(statepath)");
  });
  it("parses the status line", () => {
    expect(parseHealthStatus("health-activate: status=1")).toBe(1);
    expect(parseHealthStatus("health-activate: status=0")).toBe(0);
    expect(parseHealthStatus("health-activate: no-response")).toBeNull();
  });
});
