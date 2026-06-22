import { describe, it, expect } from "vitest";
import { selectDriverKind, type ProbeResult } from "../../src/main/backend/driverFactory.js";

describe("selectDriverKind", () => {
  const base: ProbeResult = { platform: "linux", nativePebbleOnPath: false, nativeQemuOnPath: false, wslAvailable: false };

  it("prefers bundled-native when both pebble and qemu resolve", () => {
    expect(selectDriverKind({ ...base, nativePebbleOnPath: true, nativeQemuOnPath: true })).toBe("bundled-native");
  });

  it("falls back to plain native on POSIX when only one of pebble/qemu resolves", () => {
    expect(selectDriverKind({ ...base, nativePebbleOnPath: true, nativeQemuOnPath: false })).toBe("native");
    expect(selectDriverKind({ ...base, nativePebbleOnPath: false, nativeQemuOnPath: true })).toBe("native");
  });

  it("falls back to wsl on win32 when native tools are missing but wsl exists", () => {
    expect(selectDriverKind({ ...base, platform: "win32", wslAvailable: true })).toBe("wsl");
  });

  it("throws when nothing is available", () => {
    expect(() => selectDriverKind(base)).toThrow(/no usable emulator backend/i);
  });

  it("honors an explicit override", () => {
    expect(selectDriverKind({ ...base, override: "wsl", wslAvailable: true })).toBe("wsl");
  });

  it("prefers bundled-native on win32 when pebble.exe AND qemu(.exe)/PEBBLE_QEMU_PATH resolve", () => {
    expect(
      selectDriverKind({ ...base, platform: "win32", nativePebbleOnPath: true, nativeQemuOnPath: true }),
    ).toBe("bundled-native");
  });

  it("on win32 falls back to wsl when native qemu is absent but wsl exists", () => {
    expect(
      selectDriverKind({ ...base, platform: "win32", nativePebbleOnPath: true, nativeQemuOnPath: false, wslAvailable: true }),
    ).toBe("wsl");
  });

  it("honors an explicit bundled-native override when native tools are present", () => {
    expect(
      selectDriverKind({ ...base, platform: "win32", override: "bundled-native", nativePebbleOnPath: true, nativeQemuOnPath: true }),
    ).toBe("bundled-native");
  });

  it("throws if bundled-native is overridden but native tools are missing", () => {
    expect(() =>
      selectDriverKind({ ...base, platform: "win32", override: "bundled-native", nativePebbleOnPath: false, nativeQemuOnPath: false }),
    ).toThrow(/bundled-native.*not found/i);
  });
});
