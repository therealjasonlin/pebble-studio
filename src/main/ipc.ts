import { ipcMain, app, dialog, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createDriver } from "./backend/createDriver.js";
import type { BackendDriver } from "./backend/BackendDriver.js";
import { makeNativeShell, makeWslShell, type BootToken } from "./backend/bootEmulator.js";
import type { DriverKind } from "./backend/driverFactory.js";
import { EMU_INFO_PATH } from "./backend/hostPaths.js";
import { openClayWindow, parsePhonesimPort } from "./clayWindow.js";
import { createBacklightController, parseMonitorPort } from "./backend/backlight.js";
import { makeTimeController, isNonSystemTime, detectHostTimezone, type TimeConfig } from "./backend/timeController.js";
import { makeBatteryController } from "./backend/batteryController.js";
import { makeBridgeMonitor } from "./backend/bridgeMonitor.js";
import { buildHealthCommand, interpretHealth } from "./backend/bridgeHealth.js";
import { makeNativeHealthCheck } from "./backend/bundledBridgeHealth.js";
import { winHostPaths, nativeHostEmuInfoPath } from "./backend/hostPaths.js";
import { readPypkjsPort } from "./backend/bundledInputChannel.js";
import { defaultCtx } from "./backend/bundledRuntime.js";
import { ensureSdkProvisioned } from "./backend/sdkProvision.js";
import { readSimEnv, writeSimEnv } from "./backend/simEnv.js";
import { clearWeatherCacheArgv, refreshWeatherAfterSimChange } from "./backend/weatherCacheRefresh.js";
import { spawnRunner } from "./backend/spawnRunner.js";
import type { PlatformId, ButtonId, ButtonAction } from "../shared/types.js";
import type { SimEnvConfig } from "../shared/simEnv.js";
import { LibraryStore } from "./library.js";

let driver: BackendDriver | null = null;

/**
 * The active driver kind (native | wsl), recorded at `backend:init`. The backlight
 * controller uses it to pick the matching Shell (native vs wsl) for reading the
 * emulator state file, mirroring how createDriver decides.
 */
let driverKind: DriverKind | null = null;

/**
 * The platform booted by the most recent `emu:start`. clay:phonesimPort uses it
 * to pick the right entry in the emulator state file (which is keyed by
 * platform, then SDK version).
 */
let currentPlatform: PlatformId | null = null;

/**
 * The cancellation token for the current/most-recent boot. `emu:start` creates a
 * fresh one; `emu:abort` and `emu:stop` flip `cancelled` so an in-flight boot's
 * wait loops bail promptly instead of blocking up to the full readiness timeout.
 */
let currentBootToken: BootToken | null = null;

/**
 * The directory captures are written to. Defaults to the user's Downloads; the
 * renderer can repoint it via `settings:setCaptureDir`.
 */
let captureDir: string | null = null;

/**
 * The set of .pbw paths currently installed on the emulator's on-disk data dir.
 * Populated when install succeeds; cleared ONLY on a real wipe (loaded:clear).
 * A plain stop/kill preserves installed apps on disk, so it must NOT clear this.
 * Known limitation: a fresh app process starts with an empty set even if apps
 * persist on disk from a previous run (no cross-process persistence by design).
 */
const loaded = new Set<string>();

/**
 * Resolve + validate a capture filename against a configured directory.
 *
 * Pure (no fs) so it is unit-testable. Strips any directory component, enforces
 * a png/gif filename whitelist, and confirms the resolved path stays INSIDE the
 * configured dir (defense-in-depth against traversal). Throws on any violation.
 */
export function resolveCapturePath(dir: string, name: string): string {
  const safeName = path.basename(name);
  if (!/^[\w.\- ]+\.(png|gif)$/i.test(safeName)) {
    throw new Error(`invalid capture filename: ${name}`);
  }
  const base = path.resolve(dir);
  const out = path.resolve(base, safeName);
  if (out !== path.join(base, safeName) || !out.startsWith(base + path.sep)) {
    throw new Error("capture path escapes capture directory");
  }
  return out;
}

/**
 * Find the highest existing capture index for a base (Task G).
 *
 * Pure (no fs) so it is unit-testable. Scans `existingNames` for files matching
 * `^<base>-(\d+)\.<ext>$` (ext + base matched case-insensitively, base regex-
 * escaped) and returns the highest index found, or -1 when none match. The next
 * filename is then `<base>-<nextIndexedName(...) + 1>.<ext>` (so it starts at 1).
 */
export function nextIndexedName(existingNames: string[], base: string, ext: string): number {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}-(\\d+)\\.${ext}$`, "i");
  let max = -1;
  for (const name of existingNames) {
    const m = re.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

export function registerIpc(getMainWindow: () => BrowserWindow | null = () => null): void {
  const library = new LibraryStore(path.join(app.getPath("userData"), "library.json"));
  // Default capture target is the user's Downloads; settings:setCaptureDir can
  // repoint it. Resolved here (not at module load) so app paths are ready.
  captureDir = path.resolve(app.getPath("downloads"));

  // Backlight keepalive (Task K). The "back" wake reads the qemu HMP monitor port
  // from the emulator state file. bundled-native MUST read %TEMP% via Node fs: a
  // Windows-host `bash` is the WSL launcher, so a shell `cat /tmp/...` reads WSL's
  // /tmp and never finds the native state file → no port → the keepalive, capture
  // backlight, and Backlight-pulse button all silently no-op. (Same native-Windows
  // shell-reads-WSL bug fixed for the Clay gear + bridge-health monitor.) wsl /
  // native-Linux keep using the matching shell.
  const backlight = createBacklightController(
    () => driverKind,
    () => driver!.accelTap(),
    async () => {
      if (driverKind === "bundled-native") {
        const raw = await fs.readFile(nativeHostEmuInfoPath(), "utf8").catch(() => "");
        return raw.trim() ? parseMonitorPort(raw) : null;
      }
      const shell = driverKind === "wsl" ? makeWslShell() : makeNativeShell();
      const { code, stdout } = await shell.run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
      return code === 0 && stdout.trim() ? parseMonitorPort(stdout) : null;
    },
  );

  // Time controller (Task 5). Uses a getter so it always references the current driver.
  const time = makeTimeController(() => driver);

  // Battery controller (feat/battery-and-health). Remembers the user's chosen
  // simulated level and re-asserts it after every reboot — a fresh boot reverts
  // to the firmware default (emery 100%, basalt 80%), so the sim-weather refresh,
  // "Clear emulator", or a model relaunch would otherwise silently drop it.
  const battery = makeBatteryController(() => driver);

  // Every `pebble` command re-syncs HOST time to the watch on connect (pebble-tool
  // commands/base.py post_connect). Since v0.0.13 that clobber only matters for
  // Timezone mode and the legacy offset fallback — shim-backed custom keeps
  // utc_offset at the host offset, so the re-push is already a no-op. The
  // controller decides internally what (if anything) to re-push; fire-and-forget,
  // skipped when showing plain host/system time so we don't spawn needlessly.
  const reassertTime = (): void => {
    if (isNonSystemTime(time.getConfig(), detectHostTimezone())) void time.reassert();
  };

  /** Seconds ahead of the watch clock to place the demo pin (inside the peek window). */
  const SAMPLE_PIN_LEAD_SEC = 90;
  /** Title shown on the demo pin's peek bar. */
  const SAMPLE_PIN_TITLE = "Sample Pin";

  // Bridge-health monitor (Task H4). Polls qemu + pypkjs health after every
  // successful boot; fires "emu:bridge-dead" to the renderer when the bridge dies.
  // The POSIX (WSL / native-Linux) path runs the bash `/proc` + `/dev/tcp` probe
  // through the matching shell. The bundled-native path must NOT use a shell at
  // all: on a Windows host `bash` resolves to the WSL launcher, so a bash probe
  // would inspect WSL's stale state file + `/proc` (which never holds the native
  // qemu/pypkjs pids) and falsely report DEAD pid — the v2.0.1 false-death loop.
  const bridgeShell = (): ReturnType<typeof makeNativeShell> =>
    driverKind === "wsl" ? makeWslShell() : makeNativeShell();
  const nativeHealthCheck = makeNativeHealthCheck();
  const bridgeMonitor = makeBridgeMonitor({
    readEmuInfo: async () => {
      if (driverKind === "bundled-native") {
        // Read the state file directly via Node fs (no bash/WSL).
        const raw = await fs.readFile(nativeHostEmuInfoPath(), "utf8").catch(() => "");
        return raw.trim() ? raw : null;
      }
      const { code, stdout } = await bridgeShell().run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
      return code === 0 && stdout.trim() ? stdout : null;
    },
    checkHealth: async (pids) => {
      if (driverKind === "bundled-native") return nativeHealthCheck(pids);
      const { code, stdout } = await bridgeShell().run(buildHealthCommand(pids));
      return interpretHealth(stdout, code);
    },
    onDead: (reason) => {
      // Target the main window explicitly (not getAllWindows()[0], which could
      // be a Clay config child window or the splash and would silently drop the event).
      const win = getMainWindow();
      win?.webContents.send("emu:bridge-dead", reason);
    },
  });

  ipcMain.handle("lib:add", async (_e, pbwPath: string) => { library.add(pbwPath); return library.list(); });
  ipcMain.handle("lib:list", async () => library.list());
  ipcMain.handle("lib:remove", async (_e, p: string) => {
    library.remove(p);
    // Also drop it from the loaded set. There is no per-app uninstall command
    // (only `pebble wipe`), so the app stays on disk until a wipe — but from the
    // user's point of view a removed app is no longer one of "their" loaded apps.
    // Pruning here keeps the "N loaded" count from drifting ABOVE the visible
    // library list (the "removed 2, added 1 → 3 loaded" bug).
    loaded.delete(p);
    return library.list();
  });
  ipcMain.handle("lib:installAll", async () => {
    for (const p of library.list()) {
      await driver!.install(p);
      loaded.add(p);
    }
    // Each `pebble install` re-syncs host time on connect (post_connect),
    // clobbering any custom/timezone offset. installAll runs AFTER emu:start's
    // applyAll() (the renderer reinstalls once VNC is up), so without this the
    // watch reverts to host time on every boot with a non-system time set.
    reassertTime();
  });

  ipcMain.handle("loaded:list", async () => Array.from(loaded));
  ipcMain.handle("loaded:clear", async (_e, platformId: PlatformId) => {
    // Stop the bridge-health monitor before teardown so it doesn't poll a dead
    // emulator during the wipe window (mirrors emu:stop). It is re-started after
    // the clean reboot below via bridgeMonitor.start(platformId).
    bridgeMonitor.stop();
    // 1. Stop the running emulator so wipe can safely delete its files.
    try { await driver!.stop(); } catch { /* ignore — may already be stopped */ }
    loaded.clear();
    // 2. Wipe all emulator data (all platforms for the current SDK version).
    await driver!.wipe();
    // 3. Reboot the current platform clean — WITHOUT reinstalling library apps
    //    (that's what "clear" means: the watch starts fresh with no user apps).
    await driver!.start(platformId);
    await battery.reassert(); // re-assert the chosen battery level on the clear-rebooted emulator (before the time push: emu-battery's connect re-syncs host time)
    void time.applyAll(); // re-assert time settings on the clear-rebooted emulator (fire-and-forget)
    bridgeMonitor.start(platformId);
    // loaded remains empty after the clear reboot.
  });

  ipcMain.handle("dialog:pickPbw", async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: "Select .pbw file(s)",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Pebble apps", extensions: ["pbw"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("backend:init", async () => {
    const { driver: d, kind } = await createDriver();
    driver = d;
    driverKind = kind;
    console.log(`[backend] initialized kind=${kind}`);
    // First-run SDK provisioning for the native-Windows stack: the bundled SDK is
    // read-only, so we materialise a writable copy under the app-data persist dir
    // (the XDG_DATA_HOME the invocation contract points at) BEFORE any boot. Runs
    // here at init — which the renderer awaits before enabling Launch — so the
    // first emu:start always finds a ready SDK. Idempotent (cached), so this is a
    // near-instant no-op on every launch after the first.
    if (process.platform === "win32" && kind === "bundled-native") {
      try {
        const ctx = await defaultCtx();
        const res = await ensureSdkProvisioned(ctx, {
          onProgress: (msg) => {
            console.log(`[provision] ${msg}`);
            getMainWindow()?.webContents.send("emu:boot-progress", msg);
          },
        });
        console.log(`[provision] SDK ${res.version} ready at ${res.sdkCoreDir}`);
      } catch (e) {
        console.error(`[provision] FAILED: ${String(e)}`);
        // Surface to the renderer so the failure isn't silent; boot would fail
        // anyway without a provisioned SDK.
        getMainWindow()?.webContents.send(
          "emu:boot-progress",
          `SDK provisioning failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return { kind };
  });
  // App version (v1.0.0) — surfaced in the Help → What's New modal.
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("emu:start", async (e, id: PlatformId) => {
    currentPlatform = id; // remembered for clay:phonesimPort's state-file lookup
    // Fresh token per boot, stored as current so abort/stop can cancel it.
    const token: BootToken = { cancelled: false };
    currentBootToken = token;
    // Forward each boot step to the renderer (diagnostic boot notes, Task J).
    const onStep = (msg: string): void => { e.sender.send("emu:boot-progress", msg); };
    // Deploy the LD_PRELOAD time shim BEFORE the emulator boots: bootEmulator's
    // bootControl consults the shim-ready cache when spawning emu-control, so the
    // wrapper must already exist on disk. Failure is fine — the time controller
    // falls back to the legacy offset path. (Optional chaining: a null driver is
    // handled by the start() call below, same as before.)
    await driver?.ensureTimeShim().catch(() => false);
    const ep = await driver!.start(id, token, onStep);
    await battery.reassert(); // re-assert the chosen battery level on the fresh emulator (before the time push, since emu-battery's connect re-syncs host time)
    void time.applyAll(); // re-assert time settings on the fresh emulator (fire-and-forget)
    // Arm the health monitor only if this boot wasn't superseded by a force-close
    // mid-flight: emu:abort/emu:stop flip token.cancelled and call bridgeMonitor.stop(),
    // and a boot that resolves in that same window would otherwise re-start a monitor
    // polling an already-killed emulator (symmetric to the renderer's bootGen guard).
    if (!token.cancelled) bridgeMonitor.start(id);
    return ep;
  });
  ipcMain.handle("emu:abort", async () => {
    // Cancel any in-flight boot so its wait loops bail promptly. No-op (no throw)
    // if nothing is booting.
    if (currentBootToken) currentBootToken.cancelled = true;
  });
  ipcMain.handle("emu:stop", async () => {
    // Stop the backlight keepalive, time controller, and bridge-health monitor
    // first so we don't operate on a dead emulator.
    backlight.stop();
    time.stop();
    bridgeMonitor.stop();
    // Cancel the in-flight boot BEFORE teardown so a mid-boot wait aborts and the
    // killAll sweep reliably reaps qemu/websockify/emu-control/pypkjs.
    if (currentBootToken) currentBootToken.cancelled = true;
    await driver!.stop();
    // Deliberately NOT resetting the time-shim control file here: the next
    // emu:start's applyAll() rewrites it, and the controller starts every app run
    // at the System default anyway.
    // NOTE: do NOT clear `loaded` here. A stop/kill (killAll) only reaps the
    // qemu/websockify/pypkjs/emu-control processes + the state file — it does NOT
    // delete installed apps, which persist on disk and are removed ONLY by
    // `pebble wipe` (driver.wipe(), called from loaded:clear). Clearing the set on
    // stop desynced it from disk: after a relaunch/force-close/model-switch the
    // apps were still installed but `loaded` was empty, so loaded:list returned []
    // and the renderer's "Clear emulator" button stayed disabled. The set now
    // mirrors on-disk install state and is cleared only on a real wipe.
  });

  // Backlight keepalive toggles (Task K). "Always on" is independent of captures;
  // "capture hold" is held only for a capture's duration. The interval runs while
  // either is set and stops when both clear (or on emu:stop above).
  ipcMain.handle("emu:backlightAlways", async (_e, on: boolean) => { backlight.setAlways(on); });
  ipcMain.handle("emu:backlightCaptureHold", async (_e, on: boolean) => { backlight.setCaptureHold(on); });
  // Selectable keepalive method (back | motion | off) + a manual one-shot pulse.
  ipcMain.handle("emu:backlightMethod", async (_e, m: "back" | "motion" | "off") => { backlight.setMethod(m); });
  ipcMain.handle("emu:backlightPulse", async () => { backlight.pulseOnce(); });

  // Time control (Task 5): get/set persisted time config and re-apply on boot.
  ipcMain.handle("time:get", async () => time.getConfig());
  ipcMain.handle("time:set", async (_e, cfg: TimeConfig) => { await time.setConfig(cfg); });
  // Time-shim readiness ({shim:boolean}) — the Settings note shows the legacy
  // offset-fallback limits when false.
  ipcMain.handle("time:status", async () => time.getStatus());
  // Simulated location & weather control file (read by the bundled python's
  // sitecustomize). sim:get hydrates the Settings UI; sim:set persists changes,
  // which the emulator picks up live (sitecustomize re-reads on mtime change).
  ipcMain.handle("sim:get", async (): Promise<SimEnvConfig> =>
    readSimEnv(app.getPath("userData")));
  ipcMain.handle("sim:set", async (_e, cfg: SimEnvConfig): Promise<{ rebooted: boolean }> => {
    await writeSimEnv(app.getPath("userData"), cfg);
    // Make weather watchfaces reflect the new values NOW rather than waiting out
    // their internal fetch throttle (faces commonly cache their last fetch for
    // some minutes, keyed on a localStorage epoch-ms timestamp). We clear those
    // throttle stamps from on-disk localStorage; if an emulator is live, we reboot
    // and relaunch the face so it refetches the new weather on its launch handshake.
    // Windows-native only (the bundled python hosts the helper). Never fatal —
    // sim-env.json is already written, so a refresh failure just defers the change
    // to the next natural launch.
    try {
      // Windows-native only (the bundled python hosts the helper); skip the
      // win32-only defaultCtx() entirely on other stacks where it would throw.
      const isNative = driverKind === "bundled-native";
      const ctx = isNative ? await defaultCtx() : null;
      const { rebooted } = await refreshWeatherAfterSimChange({
        enabled: isNative,
        isLive: async () =>
          currentPlatform != null && readPypkjsPort(nativeHostEmuInfoPath()) != null,
        clearCache: async () => {
          const { cmd, args, env } = clearWeatherCacheArgv(ctx!);
          const r = await spawnRunner(cmd, args, env);
          if (r.code !== 0) console.error(`[sim] clearcache exited ${r.code}: ${r.stderr.trim()}`);
          else if (r.stdout.trim()) console.log(`[sim] ${r.stdout.trim()}`);
        },
        stop: async () => {
          // Mirror emu:stop: quiesce the keepalive/time/bridge timers so they
          // don't poll the dead emulator during the reboot window.
          backlight.stop();
          time.stop();
          bridgeMonitor.stop();
          try { await driver!.stop(); } catch { /* may already be stopped */ }
        },
        start: async () => {
          // Fresh token stored as current so a force-close during the refresh
          // reboot cancels the boot's wait loops promptly (mirrors emu:start).
          const token: BootToken = { cancelled: false };
          currentBootToken = token;
          await driver!.start(currentPlatform!, token);
          void time.applyAll();
          if (!token.cancelled) bridgeMonitor.start(currentPlatform!);
        },
        reinstall: async () => {
          for (const p of library.list()) { await driver!.install(p); loaded.add(p); }
          // Re-assert the chosen battery level so a weather change doesn't revert it
          // to the firmware default. Before reassertTime() because emu-battery's
          // pebble connect re-syncs host time, so the time push must run last.
          await battery.reassert();
          reassertTime();
        },
      });
      if (rebooted) console.log("[sim] rebooted emulator to refresh weather");
      return { rebooted };
    } catch (e) {
      console.error(`[sim] weather refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      return { rebooted: false };
    }
  });
  ipcMain.handle("emu:install", async (_e, pbwPath: string) => {
    await driver!.install(pbwPath);
    loaded.add(pbwPath);
    reassertTime();
  });
  ipcMain.handle("emu:button", async (_e, id: ButtonId, action?: ButtonAction) => {
    await driver!.button(id, action ?? "press");
    reassertTime();
  });
  ipcMain.handle("emu:accelTap", async () => {
    await driver!.accelTap();
    reassertTime();
  });
  ipcMain.handle("emu:battery", async (_e, percent: number, charging: boolean) => {
    // Remember the level (battery.set) so reboots can re-assert it; emu-battery's
    // pebble connect re-syncs host time on post_connect, hence the reassertTime().
    await battery.set(percent, charging);
    reassertTime();
  });
  ipcMain.handle("emu:activateHealth", async () => {
    if (!driver) return { ok: false, status: null, detail: "no emulator" };
    const r = await driver.activateHealth();
    console.log(`[health] activate: ok=${r.ok} status=${r.status} ${r.detail}`);
    return r;
  });
  ipcMain.handle("emu:screenshot", async (_e, out: string) => driver!.screenshot(out));
  // Backlight-free framebuffer screenshot (over the watch protocol). The renderer
  // passes a capture filename; main resolves it under the configured capture dir
  // (same whitelist/traversal guard as capture:save), asks the driver to write the
  // PNG there, and returns the saved absolute path — or null on ANY failure, which
  // tells the renderer to fall back to the VNC-canvas + backlight grab. Never
  // throws (a thrown handler would surface as a renderer rejection, defeating the
  // graceful fallback). The framebuffer path is unverified-live; see bundledHelpers.ts.
  ipcMain.handle("emu:screenshotFramebuffer", async (_e, name: string): Promise<string | null> => {
    if (!driver) return null;
    try {
      const dir = captureDir ?? path.resolve(app.getPath("downloads"));
      const out = resolveCapturePath(dir, name);
      const ok = await driver.screenshotFramebuffer(out);
      if (!ok) return null;
      // Confirm the file actually landed before claiming success.
      const stat = await fs.stat(out).catch(() => null);
      if (!stat || !stat.isFile() || stat.size === 0) return null;
      console.log(`[capture] saved (framebuffer) ${out}`);
      return out;
    } catch (e) {
      console.warn(`[capture] framebuffer screenshot failed (falling back): ${String(e)}`);
      return null;
    }
  });
  ipcMain.handle("emu:timelineQuickView", async (_e, on: boolean) => {
    // Insert a demo pin BEFORE enabling the peek so the bar has something to show;
    // on disable, drop the peek first then remove the pin. The pin methods are
    // optional (bundled-native only) — without them this is just the peek toggle.
    if (on) {
      if (driver!.insertSamplePin) {
        await driver!.insertSamplePin(time.currentWatchUnix() + SAMPLE_PIN_LEAD_SEC, SAMPLE_PIN_TITLE);
      }
      await driver!.timelineQuickView(true);
    } else {
      await driver!.timelineQuickView(false);
      if (driver!.deleteSamplePin) await driver!.deleteSamplePin();
    }
    reassertTime();
  });

  // Clay / AppConfig (Task B2). The renderer drives the pypkjs websocket
  // round-trip (src/shared/clayProtocol.ts); main supplies the port and hosts
  // the config page in a locked-down child window.
  ipcMain.handle("clay:phonesimPort", async (): Promise<number | null> => {
    if (currentPlatform == null) return null; // nothing booted yet
    // bundled-native must NOT use a shell: on a Windows host `bash` resolves to
    // the WSL launcher, so `cat /tmp/pb-emulator.json` would read WSL's stale
    // state file (never the native emulator's %TEMP%\pb-emulator.json) and return
    // null → the Clay gear reported "emulator not running" and never opened.
    // Read the Windows state file directly via Node fs, mirroring the bridge
    // monitor (readEmuInfo above) and the input channel (createDriver readPort).
    if (driverKind === "bundled-native") {
      return readPypkjsPort(nativeHostEmuInfoPath());
    }
    // POSIX (WSL / native-Linux): read the state file through the matching Shell
    // (Node can't read the in-distro POSIX path directly on a Windows+WSL host).
    const shell = driverKind === "wsl" ? makeWslShell() : makeNativeShell();
    const { code, stdout } = await shell.run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
    if (code !== 0 || !stdout.trim()) return null;
    return parsePhonesimPort(stdout, currentPlatform);
  });
  ipcMain.handle("clay:openWindow", async (e, url: string): Promise<string> => {
    // Defense against arbitrary URL loads: only config-page-shaped URLs.
    if (
      typeof url !== "string" ||
      !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:"))
    ) {
      throw new Error(`clay:openWindow: refusing to load non-http(s)/data URL`);
    }
    // Resolves with the RAW STILL-PERCENT-ENCODED close fragment ("" = cancel).
    // It must stay encoded: the renderer forwards it verbatim to pypkjs, and the
    // watchapp's JS decodeURIComponent()s it itself (see clayWindow.ts).
    const rawFragment = await new Promise<string>((resolve) => {
      openClayWindow(url, resolve, BrowserWindow.fromWebContents(e.sender) ?? undefined);
    });
    // The config round-trip's websocket connects can clobber a timezone/custom
    // offset (post_connect re-syncs host time); re-assert it after a real save.
    if (rawFragment !== "") reassertTime();
    return rawFragment;
  });

  ipcMain.handle("dialog:pickDirectory", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "Select capture folder",
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("settings:setCaptureDir", async (_e, dir: string) => {
    // Validate: must be an absolute path that exists and is a directory.
    if (typeof dir !== "string" || !path.isAbsolute(dir)) {
      throw new Error(`capture dir must be an absolute path: ${dir}`);
    }
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`capture dir does not exist or is not a directory: ${dir}`);
    }
    captureDir = path.resolve(dir);
  });

  ipcMain.handle("capture:nextName", async (_e, base: string, ext: "png" | "gif") => {
    // Sanitize the base (allow [\w.\-] only) so the filename + scan regex are safe.
    const safeBase = String(base).replace(/[^\w.\-]/g, "");
    const safeExt = ext === "gif" ? "gif" : "png";
    const dir = captureDir ?? path.resolve(app.getPath("downloads"));
    // Scan the configured capture dir; an unreadable dir just means "start at 1".
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const max = nextIndexedName(names, safeBase, safeExt);
    return `${safeBase}-${max + 1}.${safeExt}`;
  });

  ipcMain.handle("capture:save", async (_e, name: string, bytes: Uint8Array) => {
    // Resolve + sanitize against the configured capture dir (filename whitelist +
    // path stays inside the dir). Falls back to Downloads if unset.
    const dir = captureDir ?? path.resolve(app.getPath("downloads"));
    const out = resolveCapturePath(dir, name);
    await fs.writeFile(out, Buffer.from(bytes));
    console.log(`[capture] saved ${out}`);
    return out;
  });
}
