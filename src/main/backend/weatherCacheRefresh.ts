// weatherCacheRefresh.ts — make weather watchfaces pick up new simulated weather
// immediately instead of waiting out their internal cache window.
//
// Weather faces commonly throttle their fetches — storing Date.now() in
// localStorage and refusing to refetch for some minutes. So after the user changes
// Pebble Studio's simulated weather, the watch keeps showing the stale values. The
// bundled `pebble_studio_clearcache` python module deletes those epoch-ms throttle
// stamps from pypkjs's on-disk localStorage (preserving the face's saved settings);
// relaunching the face then refetches on its handshake.
import { win32 as winPath } from "node:path";
import type { PebbleCommand } from "./pebbleCli.js";
import { pebblePyExe, pebbleDataDir, type BundledRuntimeCtx } from "./bundledRuntime.js";

/**
 * The localStorage persist root pypkjs writes under. pebble-tool provisions the
 * SDK + per-app state at `<userData>/pebble-data/pebble-sdk`, and pypkjs keeps each
 * app's localStorage at `<root>/<ver>/<board>/localstorage/<uuid>.dat`.
 */
export function localStorageRoot(ctx: BundledRuntimeCtx): string {
  return winPath.join(pebbleDataDir(ctx), "pebble-sdk");
}

/**
 * Argv that clears weather-throttle timestamps from every localStorage store under
 * the persist root, via the bundled python module (importable from the pebble-py
 * site-packages, exactly like pypkjs is run with `-m`). Touches only files, so no
 * emulator env (PEBBLE_QEMU_PATH/XDG_DATA_HOME) is needed.
 */
export function clearWeatherCacheArgv(ctx: BundledRuntimeCtx): PebbleCommand {
  return {
    cmd: pebblePyExe(ctx),
    args: ["-m", "pebble_studio_clearcache", localStorageRoot(ctx)],
  };
}

export interface WeatherRefreshDeps {
  /** Whether the running stack supports the helper (bundled python present —
   * i.e. the windows-native driver). False ⇒ no-op (keeps legacy behaviour). */
  enabled: boolean;
  /** True when an emulator is currently live (state file lists a pypkjs port). */
  isLive: () => Promise<boolean>;
  /** Delete throttle stamps from on-disk localStorage. Safe ONLY when the
   * emulator is stopped — a live pypkjs holds the store open and caches its
   * index in memory, so external edits wouldn't take effect anyway. */
  clearCache: () => Promise<void>;
  /** Stop the running emulator (+ pause any health monitor). */
  stop: () => Promise<void>;
  /** Boot the emulator again on the same platform (+ resume monitor/time). */
  start: () => Promise<void>;
  /** Reinstall the loaded app(s) so the active watchface relaunches and refetches
   * weather on its launch handshake. */
  reinstall: () => Promise<void>;
}

/**
 * Refresh weather after a simulated-environment change.
 *  - offline: just delete the on-disk throttle stamps; the next manual launch
 *    refetches with the new values (no boot — applying weather must not start a
 *    stopped emulator).
 *  - live: stop → clear → reboot → relaunch the face. The cleared cache makes the
 *    face's throttle pass, so it refetches the new weather on launch.
 *
 * Returns whether a live reboot was performed (for caller logging/UX).
 */
export async function refreshWeatherAfterSimChange(
  d: WeatherRefreshDeps,
): Promise<{ rebooted: boolean }> {
  if (!d.enabled) return { rebooted: false };
  if (!(await d.isLive())) {
    await d.clearCache();
    return { rebooted: false };
  }
  await d.stop();
  await d.clearCache();
  await d.start();
  await d.reinstall();
  return { rebooted: true };
}
