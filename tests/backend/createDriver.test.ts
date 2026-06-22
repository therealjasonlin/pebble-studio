import { describe, it, expect, vi } from "vitest";

// createDriver() now resolves a runtime ctx via defaultCtx(), which imports the
// electron `app` (absent under vitest). Stub a minimal app so the POSIX selection
// path can run headless.
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp/pebble-studio-test-userdata" },
}));

import { createDriver } from "../../src/main/backend/createDriver.js";

describe("createDriver", () => {
  // Linux-dev-machine assertion: createDriver()'s path builds a prod ctx via
  // defaultCtx(), which requires the electron runtime (absent under vitest), so it can
  // only run on the POSIX dev host. The selection logic is covered by
  // bundledRuntime.test.ts. With pebble + qemu both resolvable, selection prefers
  // the self-contained bundled-native stack on every platform.
  it.skipIf(process.platform === "win32")(
    "returns kind 'bundled-native' on this dev machine (pebble + qemu both resolve)",
    async () => {
      const { kind } = await createDriver();
      expect(kind).toBe("bundled-native");
    },
  );
});

describe("createDriver bundled-native construction", () => {
  it("maps the bundled-native kind to the BundledNativeDriver class", async () => {
    const { driverClassForKind } = await import("../../src/main/backend/createDriver.js");
    const { BundledNativeDriver } = await import("../../src/main/backend/BundledNativeDriver.js");
    expect(driverClassForKind("bundled-native")).toBe(BundledNativeDriver);
  });

  it("maps native and wsl kinds to their classes", async () => {
    const { driverClassForKind } = await import("../../src/main/backend/createDriver.js");
    const { NativeDriver } = await import("../../src/main/backend/NativeDriver.js");
    const { WslDriver } = await import("../../src/main/backend/WslDriver.js");
    expect(driverClassForKind("native")).toBe(NativeDriver);
    expect(driverClassForKind("wsl")).toBe(WslDriver);
  });
});
