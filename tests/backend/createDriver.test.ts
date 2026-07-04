import { describe, it, expect } from "vitest";
import { createDriver, resolveSdkQemuPath } from "../../src/main/backend/createDriver.js";

describe("createDriver", () => {
  // POSIX-dev-machine assertion (Linux or macOS): the pebble tool + SDK qemu are
  // installed, so selection resolves to the native driver. createDriver()'s win32
  // path builds a prod ctx via defaultCtx(), which requires the electron runtime
  // (absent under vitest), so this can only run on a POSIX dev host. The win32
  // selection logic is covered by winRuntime.test.ts.
  it.skipIf(process.platform === "win32")(
    "returns kind 'native' on this POSIX dev machine (pebble + sdk qemu present)",
    async () => {
      const { kind } = await createDriver();
      expect(kind).toBe("native");
    },
  );
});

describe("resolveSdkQemuPath", () => {
  it("resolves the SDK toolchain qemu-pebble on this POSIX dev machine", async () => {
    // On Linux the classic SDK path is probed; on macOS the Application Support
    // path. Either way a working dev machine has the binary, so we get a path.
    const p = await resolveSdkQemuPath();
    if (process.platform !== "win32") {
      expect(p).toMatch(/qemu-pebble$/);
    }
  });
});

describe("createDriver windows-native construction", () => {
  it("maps the windows-native kind to the WindowsNativeDriver class", async () => {
    const { driverClassForKind } = await import("../../src/main/backend/createDriver.js");
    const { WindowsNativeDriver } = await import("../../src/main/backend/WindowsNativeDriver.js");
    expect(driverClassForKind("windows-native")).toBe(WindowsNativeDriver);
  });

  it("maps native and wsl kinds to their classes", async () => {
    const { driverClassForKind } = await import("../../src/main/backend/createDriver.js");
    const { NativeDriver } = await import("../../src/main/backend/NativeDriver.js");
    const { WslDriver } = await import("../../src/main/backend/WslDriver.js");
    expect(driverClassForKind("native")).toBe(NativeDriver);
    expect(driverClassForKind("wsl")).toBe(WslDriver);
  });
});
