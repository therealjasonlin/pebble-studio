import { describe, it, expect, vi } from "vitest";
import {
  localStorageRoot,
  clearWeatherCacheArgv,
  refreshWeatherAfterSimChange,
  type WeatherRefreshDeps,
} from "../../src/main/backend/weatherCacheRefresh.js";
import type { BundledRuntimeCtx } from "../../src/main/backend/bundledRuntime.js";

const ctx: BundledRuntimeCtx = {
  packaged: false,
  resourcesPath: "C:\\res",
  repoRoot: "C:\\repo",
  userDataDir: "C:\\Users\\me\\AppData\\Roaming\\pebble-studio",
  platform: "win32",
  exists: () => true, // vendor/pebble-py resolves
};

describe("paths + argv", () => {
  it("localStorageRoot is <userData>/pebble-data/pebble-sdk", () => {
    expect(localStorageRoot(ctx)).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\pebble-studio\\pebble-data\\pebble-sdk",
    );
  });
  it("clearWeatherCacheArgv invokes the bundled module on that root", () => {
    const c = clearWeatherCacheArgv(ctx);
    expect(c.cmd).toMatch(/python\.exe$/);
    expect(c.args).toEqual(["-m", "pebble_studio_clearcache", localStorageRoot(ctx)]);
    expect(c.env).toBeUndefined(); // file-only helper needs no emulator env
  });
});

/** Build deps with spies and a controllable liveness. */
function makeDeps(over: Partial<WeatherRefreshDeps> = {}): {
  deps: WeatherRefreshDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const rec = (name: string) => async () => { calls.push(name); };
  const deps: WeatherRefreshDeps = {
    enabled: true,
    isLive: async () => false,
    clearCache: rec("clearCache"),
    stop: rec("stop"),
    start: rec("start"),
    reinstall: rec("reinstall"),
    ...over,
  };
  return { deps, calls };
}

describe("refreshWeatherAfterSimChange", () => {
  it("disabled stack: does nothing", async () => {
    const { deps, calls } = makeDeps({ enabled: false, isLive: async () => true });
    const r = await refreshWeatherAfterSimChange(deps);
    expect(r).toEqual({ rebooted: false });
    expect(calls).toEqual([]);
  });

  it("offline: clears the cache only, never boots", async () => {
    const { deps, calls } = makeDeps({ isLive: async () => false });
    const r = await refreshWeatherAfterSimChange(deps);
    expect(r).toEqual({ rebooted: false });
    expect(calls).toEqual(["clearCache"]);
  });

  it("live: stop → clear → start → reinstall, in order", async () => {
    const { deps, calls } = makeDeps({ isLive: async () => true });
    const r = await refreshWeatherAfterSimChange(deps);
    expect(r).toEqual({ rebooted: true });
    // clearCache must run AFTER stop (pypkjs releases the store) and BEFORE start.
    expect(calls).toEqual(["stop", "clearCache", "start", "reinstall"]);
  });

  it("checks liveness exactly once", async () => {
    const isLive = vi.fn(async () => true);
    const { deps } = makeDeps({ isLive });
    await refreshWeatherAfterSimChange(deps);
    expect(isLive).toHaveBeenCalledTimes(1);
  });
});
