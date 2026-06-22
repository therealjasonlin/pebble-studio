import { describe, it, expect } from "vitest";
import { EMU_INFO_PATH, EMU_LOG_PATH, SDK_ROOT } from "../../src/main/backend/hostPaths.js";
import { winHostPaths } from "../../src/main/backend/hostPaths.js";

describe("hostPaths", () => {
  it("exports POSIX-shaped, quote-free, space-free path strings", () => {
    for (const p of [EMU_INFO_PATH, EMU_LOG_PATH, SDK_ROOT]) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
      // These literals are embedded UNQUOTED in shell command lines that may
      // cross the wsl.exe -- bash -lc boundary: no quotes, spaces, backslashes.
      expect(p).not.toMatch(/['"\s\\]/);
      // POSIX-shaped: absolute or $HOME-anchored (expanded in-distro by bash).
      expect(p.startsWith("/") || p.startsWith("$HOME/")).toBe(true);
    }
  });

  it("matches the paths the emulator stack actually uses today", () => {
    expect(EMU_INFO_PATH).toBe("/tmp/pb-emulator.json");
    expect(EMU_LOG_PATH).toBe("/tmp/pebble-emu.log");
    expect(SDK_ROOT).toBe("$HOME/.pebble-sdk/SDKs/current");
  });
});

describe("winHostPaths", () => {
  const env = { TEMP: "C:\\Temp", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" };

  it("places the state + log files under %TEMP% (matches pebble-tool's tempfile.gettempdir)", () => {
    const p = winHostPaths(env);
    expect(p.emuInfo).toBe("C:\\Temp\\pb-emulator.json");
    expect(p.emuLog).toBe("C:\\Temp\\pebble-emu.log");
  });

  it("places the SDK root under %LOCALAPPDATA%", () => {
    expect(winHostPaths(env).sdkRoot).toBe("C:\\Users\\x\\AppData\\Local\\pebble-sdk\\SDKs\\current");
  });

  it("falls back to a sane default when env vars are missing", () => {
    const p = winHostPaths({});
    expect(p.emuInfo.endsWith("pb-emulator.json")).toBe(true);
    expect(p.sdkRoot.endsWith("SDKs\\current")).toBe(true);
  });
});
