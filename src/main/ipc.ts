import { ipcMain, app, dialog, BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { AppLogStream } from "./backend/appLogStream.js";
import { createDriver } from "./backend/createDriver.js";
import type { AppLogHandle, BackendDriver } from "./backend/BackendDriver.js";
import { makeNativeShell, makeWslShell, type BootToken } from "./backend/bootEmulator.js";
import { WarmStandby } from "./backend/warmStandby.js";
import type { VncEndpoint } from "./backend/BackendDriver.js";
import type { DriverKind } from "./backend/driverFactory.js";
import { EMU_INFO_PATH } from "./backend/hostPaths.js";
import { openClayWindow, parsePhonesimPort } from "./clayWindow.js";
import { createBacklightController, parseMonitorPort } from "./backend/backlight.js";
import { makeTimeController, isNonSystemTime, detectHostTimezone, type TimeConfig } from "./backend/timeController.js";
import { installWithBridgeRetry } from "./backend/installRetry.js";
import { makeBatteryController } from "./backend/batteryController.js";
import { makeBridgeMonitor } from "./backend/bridgeMonitor.js";
import { buildHealthCommand, interpretHealth } from "./backend/bridgeHealth.js";
import { makeNativeHealthCheck } from "./backend/winBridgeHealth.js";
import { winHostPaths } from "./backend/hostPaths.js";
import { readPypkjsPort } from "./backend/winInputChannel.js";
import { defaultCtx, pebblePyExe } from "./backend/winRuntime.js";
import { deployWinHelpers } from "./backend/winHelpers.js";
import { makeLanguageController, type LanguageController, type PackRef, type Selection } from "./backend/languageController.js";
import { makeLangHandlers, kickLangReassert } from "./langIpc.js";
import { ensureWinSdkProvisioned } from "./backend/winSdkProvision.js";
import { currentSdkInfo, installCustomSdk, resetToBundledSdk, applyFullLauncherToActiveSdk, revertFullLauncherOnActiveSdk } from "./backend/sdkController.js";
import { readSimEnv, writeSimEnv, simEnvPath } from "./backend/simEnv.js";
import { clearWeatherCacheArgv, refreshWeatherAfterSimChange } from "./backend/weatherCacheRefresh.js";
import { spawnRunner } from "./backend/spawnRunner.js";
import { getPlatform } from "./backend/emulatorRegistry.js";
import { applyCircularMaskToPngFile } from "./backend/circularMaskPng.js";
import type { PlatformId, ButtonId, ButtonAction } from "../shared/types.js";
import type { SimEnvConfig } from "../shared/simEnv.js";
import { isButtonId, isButtonAction, normalizeSimEnv } from "../shared/validate.js";
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
 * The in-flight boot's promise (cold `emu:start` or warm-standby pre-boot).
 * teardownEmulator awaits it (post-kill, token already cancelled → it unwinds
 * promptly via BootAborted) so a boot past its last token checkpoint can't spawn
 * a fresh stack AFTER the teardown sweep and leak it. Cleared when it settles.
 */
let currentBootPromise: Promise<unknown> | null = null;

/**
 * Latched by the app-quit teardown. `emu:start` refuses to boot once set: a quit
 * that lands while a warm pre-boot is being claimed used to reject the claim and
 * FALL THROUGH to a fresh cold boot with a brand-new (uncancelled) token —
 * spawning a whole emulator stack after the quit sweep, orphaned when the app
 * exited moments later.
 */
let quitting = false;

/**
 * Pending fire-and-forget QEMU snapshot-creation timer (Tasks 6+7). Armed ~8s
 * after a cold boot reaches Live so post-live injections settle first; cleared on
 * teardown so a stop cancels a not-yet-fired creation. Only ever holds ONE timer.
 */
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
/** Delay after Live before creating a snapshot, so pypkjs/time/lang injections settle. */
const SNAPSHOT_CREATE_DELAY_MS = 8000;

/**
 * The directory captures are written to. Defaults to the user's Downloads; the
 * renderer can repoint it via `settings:setCaptureDir`.
 */
let captureDir: string | null = null;

/**
 * The set of .pbw paths currently LOADED on the running emulator. Populated as
 * installs succeed; reset to empty whenever the emulator stops, is force-closed,
 * relaunches, or is wiped (teardownEmulator + loaded:clear) — a watch that isn't
 * running has nothing loaded, so the App Library's "● loaded" pills clear with
 * it. Repopulated by the renderer's libInstallAll on the next boot. (The .pbw
 * files themselves stay on disk across a stop; this tracks live-load status only.)
 */
const loaded = new Set<string>();

/** Hard cap on the windows-native startup reap so backend:init can never hang on
 * it (the renderer awaits backend:init before enabling Launch). */
const STARTUP_REAP_TIMEOUT_MS = 8000;

/** Ceiling on a `capture:save` payload (64 MiB). A screenshot/GIF is far smaller;
 * this just stops a hostile/buggy renderer from asking main to buffer an
 * unbounded blob to disk. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

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
  // Reject Windows reserved device names (CON, NUL, COM1…, LPT1…) and any base
  // ending in a space or dot: Windows can't create such files (they map to a
  // device or get silently trimmed), so a write there would fail or misfire.
  const stem = safeName.slice(0, safeName.lastIndexOf("."));
  if (/[ .]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
    throw new Error(`invalid capture filename: ${name}`);
  }
  const base = path.resolve(dir);
  const out = path.resolve(base, safeName);
  // Confirm the result stays inside the configured dir. path.resolve strips a
  // trailing separator EXCEPT at a filesystem/drive root ("D:\\", "/"), so
  // derive the prefix separator-normalized rather than always appending sep —
  // otherwise a drive-root capture dir yields "D:\\\\" and every save fails.
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (out !== path.join(base, safeName) || !out.startsWith(prefix)) {
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

export function registerIpc(getMainWindow: () => BrowserWindow | null = () => null): { shutdown: () => Promise<void> } {
  const library = new LibraryStore(path.join(app.getPath("userData"), "library.json"));
  // Default capture target is the user's Downloads; settings:setCaptureDir can
  // repoint it. Resolved here (not at module load) so app paths are ready.
  captureDir = path.resolve(app.getPath("downloads"));

  /**
   * Reject an IPC invoke from any frame that isn't the MAIN window's top frame
   * (defense-in-depth). Applied to the write/spawn-capable handlers. The Clay
   * config child window carries NO preload (see clayWindow.ts), so it never
   * invokes IPC at all; the clay:* channels are driven by the MAIN window and
   * are deliberately left un-gated here. Before the main window exists (or if the
   * frame was disposed) the strict !== check rejects, which is correct: no
   * legitimate handler here runs before the window is up.
   */
  const assertMainSender = (e: IpcMainInvokeEvent): void => {
    const main = getMainWindow();
    if (!main || e.senderFrame !== main.webContents.mainFrame) {
      throw new Error("ipc: rejected sender (not the main window)");
    }
  };

  /** Return the active driver or throw a clean, typed error — instead of the raw
   * TypeError a `driver!` deref produces — when a write/spawn handler is invoked
   * before `backend:init`. Mirrors emu:activateHealth's null-guard. */
  const requireDriver = (): BackendDriver => {
    if (!driver) throw new Error("emulator backend not initialized");
    return driver;
  };

  // Backlight keepalive (Task K). The "back" wake reads the qemu HMP monitor port
  // from the emulator state file. windows-native MUST read %TEMP% via Node fs: a
  // Windows-host `bash` is the WSL launcher, so a shell `cat /tmp/...` reads WSL's
  // /tmp and never finds the native state file → no port → the keepalive, capture
  // backlight, and Backlight-pulse button all silently no-op. (Same native-Windows
  // shell-reads-WSL bug fixed for the Clay gear + bridge-health monitor.) wsl /
  // native-Linux keep using the matching shell.
  const backlight = createBacklightController(
    () => driverKind,
    () => driver!.accelTap(),
    async () => {
      if (driverKind === "windows-native") {
        const raw = await fs.readFile(winHostPaths().emuInfo, "utf8").catch(() => "");
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

  // Emulator app-log stream (Issue 3). Capture runs while the emulator is live
  // (the renderer toggle only controls visibility); the buffer back-fills the
  // panel when first opened. Each line is also forwarded live to the renderer.
  const appLog = new AppLogStream({
    onLine: (line) => getMainWindow()?.webContents.send("emu:app-log", line),
  });
  let logHandle: AppLogHandle | null = null;
  // The log stream runs ONLY while the renderer's "Show emulator logs" toggle is on
  // (set via emu:logCapture; the renderer pushes the persisted value at startup —
  // default ON since v3.0.7, #6: the windows-native stream rides the input
  // helper's shared pypkjs connection, so it no longer loads the bridge).
  // `emuLive` gates a mid-session toggle-on so we never spawn a CLI `pebble logs`
  // against a dead emulator (which would LAUNCH a rogue one).
  let logCaptureEnabled = false;
  let emuLive = false;
  const startAppLog = (id: PlatformId, opts: { clear?: boolean } = {}): void => {
    if (!logCaptureEnabled) return;
    stopAppLog();
    if (opts.clear !== false) appLog.clear();
    logHandle = driver?.streamLogs?.(id, (line) => appLog.push(line)) ?? null;
  };
  const stopAppLog = (): void => {
    if (logHandle) { try { logHandle.kill(); } catch { /* already gone */ } logHandle = null; }
  };
  /**
   * Run a pypkjs-bridge operation (install, health) with the log stream PAUSED.
   * The bundled pypkjs accepts only a couple of concurrent clients; the always-on
   * input helper plus a persistent `pebble logs` stream already fill them, so an
   * install becomes a third client and pypkjs rejects it ("unable to add pbw when
   * emulator already running"). We drop the log stream for the duration, then
   * resume it WITHOUT clearing the buffer so captured lines survive the op.
   */
  // After killing the log stream, pypkjs needs a beat to release that client's
  // bridge slot before the paused op (install/health) connects — otherwise the op
  // can hit the "emulator already running" cap-reject. This short settle only runs
  // when a stream was actually active; the install retry (installWithBridgeRetry)
  // remains the real safety net if the slot is still busy after it.
  const BRIDGE_SLOT_SETTLE_MS = 250;
  const withAppLogPaused = async <T>(fn: () => Promise<T>): Promise<T> => {
    // A channel-based stream (viaChannel) shares the input helper's existing
    // pypkjs client, so it occupies no bridge slot — never pause it (pausing
    // would drop exactly the install-time logs the user wants to see).
    const wasRunning = logHandle != null && !logHandle.viaChannel;
    if (wasRunning) {
      stopAppLog();
      await new Promise<void>((resolve) => setTimeout(resolve, BRIDGE_SLOT_SETTLE_MS));
    }
    try {
      return await fn();
    } finally {
      if (wasRunning && currentPlatform) startAppLog(currentPlatform, { clear: false });
    }
  };

  /**
   * Tear down everything the emulator owns: quiesce the keepalive/time/bridge
   * timers, cancel any in-flight boot, then stop the driver (which reaps
   * qemu/pypkjs/websockify/emu-control via killAll and kills the input helper).
   * Shared by `emu:stop` and the app-quit handler (index.ts before-quit). Safe to
   * call when nothing is running: the timers no-op and `driver?.stop()` skips.
   * Never throws — a teardown error must not block app exit.
   *
   * `quit`: the app is exiting under before-quit's bounded deadline, so latch the
   * boot refusal and use the driver's stopFast (direct kill sweep, no liveness
   * probe / graceful `pebble kill` first — under load those steps could eat the
   * whole deadline and the force-kill would never dispatch, orphaning the stack).
   */
  const teardownEmulator = async (opts?: { quit?: boolean }): Promise<void> => {
    if (opts?.quit) quitting = true;
    emuLive = false;
    stopAppLog();
    backlight.stop();
    time.stop();
    bridgeMonitor.stop();
    // Cancel a pending snapshot creation: the emulator is going away, so a delayed
    // stop→migrate→cont must not fire against a dead/next monitor port.
    if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    if (currentBootToken) currentBootToken.cancelled = true;
    // Clear any warm-standby state: teardown stops the driver itself, so a later
    // claim must not attach to a pre-boot that this teardown just killed. reset()
    // flips the warm token and drops to idle WITHOUT a second stack kill.
    warmStandby.reset();
    // Reset the "loaded" status: a stopped/force-closed emulator is running
    // nothing, so the App Library's "● loaded" pills must clear. The set is
    // repopulated by the renderer's libInstallAll on the next boot. (Apps stay
    // on disk; this tracks what's loaded on a LIVE watch, which is now none.)
    loaded.clear();
    try {
      if (opts?.quit && driver?.stopFast) await driver.stopFast();
      else await driver?.stop();
    } catch { /* may already be stopped */ }
    // Wait for an in-flight boot to fully unwind (mirrors warmStandby.cancel()):
    // the token is cancelled and the stack just got swept, so this resolves
    // promptly via BootAborted — but a boot past its last token checkpoint could
    // otherwise spawn AFTER the sweep and leak. Its compensating killAll runs
    // inside this await. (On the quit path the before-quit timer still bounds us.)
    if (currentBootPromise) await currentBootPromise.catch(() => { /* BootAborted et al. */ });
  };

  /** Seconds ahead of the watch clock to place the demo pin (inside the peek window). */
  const SAMPLE_PIN_LEAD_SEC = 90;
  /** Title shown on the demo pin's peek bar. */
  const SAMPLE_PIN_TITLE = "Sample Pin";

  // Bridge-health monitor (Task H4). Polls qemu + pypkjs health after every
  // successful boot; fires "emu:bridge-dead" to the renderer when the bridge dies.
  // The POSIX (WSL / native-Linux) path runs the bash `/proc` + `/dev/tcp` probe
  // through the matching shell. The windows-native path must NOT use a shell at
  // all: on a Windows host `bash` resolves to the WSL launcher, so a bash probe
  // would inspect WSL's stale state file + `/proc` (which never holds the native
  // qemu/pypkjs pids) and falsely report DEAD pid — the v2.0.1 false-death loop.
  const bridgeShell = (): ReturnType<typeof makeNativeShell> =>
    driverKind === "wsl" ? makeWslShell() : makeNativeShell();
  const nativeHealthCheck = makeNativeHealthCheck();
  const bridgeMonitor = makeBridgeMonitor({
    readEmuInfo: async () => {
      if (driverKind === "windows-native") {
        // Read the WINDOWS state file directly via Node fs (no bash/WSL).
        const raw = await fs.readFile(winHostPaths().emuInfo, "utf8").catch(() => "");
        return raw.trim() ? raw : null;
      }
      const { code, stdout } = await bridgeShell().run(`cat ${EMU_INFO_PATH} 2>/dev/null`);
      return code === 0 && stdout.trim() ? stdout : null;
    },
    checkHealth: async (pids) => {
      if (driverKind === "windows-native") return nativeHealthCheck(pids);
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

  // Warm-standby pre-boot (Task 5). Right after `backend:init` finishes
  // provisioning we kick a background boot of the last-used board so the first
  // Launch attaches near-instantly. `emu:start` claims it (single boot, no
  // double-start) when the launched board matches; otherwise it cancels the warm
  // boot (freeing the single-instance VNC ports) before its own cold boot. Owns
  // ONLY the boot-to-Live step — post-live work (battery/time/bridge/appLog) still
  // runs once in `emu:start` after the claim. `enabled: () => true`: the renderer
  // gates on the Settings checkbox by only passing a `prebootBoard` when it's on.
  const warmStandby = new WarmStandby<VncEndpoint>({
    // Always-true by design: the production gate lives upstream — the renderer
    // only passes `prebootBoard` to backend:init when the Settings checkbox is on
    // (the setting is renderer-side localStorage), and backend:init only kicks on
    // the windows-native driver. Kept a dep so tests exercise the disabled path.
    enabled: () => true,
    boot: async (id, token) => {
      // Same pre-boot prep as emu:start's cold path: deploy the time shim before
      // the emulator comes up (bootControl consults the shim-ready cache).
      await driver?.ensureTimeShim().catch(() => false);
      // Tracked like emu:start's cold boot so teardownEmulator can await a warm
      // pre-boot's unwind too (same late-spawn leak guard). An emu:start that
      // claims this boot overwrites the tracker with its own promise, which
      // awaits this one — the unwind is still covered transitively.
      const p = requireDriver().start(id, token, (msg) => {
        getMainWindow()?.webContents.send("emu:boot-progress", msg);
      });
      currentBootPromise = p;
      void p.catch(() => {}).finally(() => { if (currentBootPromise === p) currentBootPromise = null; });
      return p;
    },
    kill: async () => { try { await driver?.stop(); } catch { /* may already be stopped */ } },
    onError: (err) => console.error(`[warm] pre-boot failed: ${String(err)}`),
  });

  // ── Language packs (Task 10, native-Windows only) ────────────────────────
  // The controller is built ONCE, lazily, on first use — and only on the
  // windows-native backend (the self-contained stack that bundles the pypkjs
  // language helper + interpreter). On WSL / native-Linux getLang resolves null
  // so the handlers surface a clear "not supported" payload instead of crashing.
  let langController: LanguageController | null = null;
  const getLang = async (): Promise<LanguageController | null> => {
    if (driverKind !== "windows-native") return null;
    if (!langController) {
      const ctx = await defaultCtx();
      const { langHelperPath } = deployWinHelpers(path.join(app.getPath("userData"), "helpers"));
      langController = makeLanguageController({
        userDataDir: app.getPath("userData"),
        langHelperPath,
        pythonExe: pebblePyExe(ctx),
        // The active pypkjs websocket port, or null when the emulator isn't up.
        readPort: () => readPypkjsPort(winHostPaths().emuInfo),
      });
    }
    return langController;
  };
  // Catalog is keyed on the active SDK/firmware version pebble-tool resolves.
  const getLangFwVersion = async (): Promise<string> => {
    try {
      return (await currentSdkInfo(await defaultCtx())).version;
    } catch {
      return "unknown";
    }
  };
  // `.pbl` file picker for sideloading a pack (mirrors dialog:pickPbw / sdk:install).
  const pickPblFile = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "Select a Pebble language pack",
      properties: ["openFile"],
      filters: [
        { name: "Pebble language pack", extensions: ["pbl"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  };
  const langHandlers = makeLangHandlers({
    getController: getLang,
    getFwVersion: getLangFwVersion,
    pickPblFile,
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
    await withAppLogPaused(async () => {
      for (const p of library.list()) {
        await installWithBridgeRetry(() => driver!.install(p));
        loaded.add(p);
      }
    });
    // Each `pebble install` re-syncs host time on connect (post_connect),
    // clobbering any custom/timezone offset. installAll runs AFTER emu:start's
    // applyAll() (the renderer reinstalls once VNC is up), so without this the
    // watch reverts to host time on every boot with a non-system time set.
    reassertTime();
  });

  ipcMain.handle("loaded:list", async () => Array.from(loaded));
  ipcMain.handle("loaded:clear", async (_e, platformId: PlatformId) => {
    getPlatform(platformId); // reject an unknown/injected platform id before it reaches a bash -lc line
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
    emuLive = true;
    startAppLog(platformId);
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

  ipcMain.handle("backend:init", async (_e, opts?: { prebootBoard?: PlatformId }) => {
    process.env.PEBBLE_SIM_ENV_FILE = simEnvPath(app.getPath("userData"));

    if (process.platform !== "win32") {
      const simModulePath = app.isPackaged
        ? path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "vendor",
            "pebble-sim-site",
          )
        : path.join(
            app.getAppPath(),
            "vendor",
            "pebble-sim-site",
          );
      process.env.PYTHONPATH = process.env.PYTHONPATH
        ? `${simModulePath}:${process.env.PYTHONPATH}`
        : simModulePath;
    }

    const { driver: d, kind } = await createDriver();
    driver = d;
    driverKind = kind;
    console.log(`[backend] initialized kind=${kind}`);
    // STARTUP REAP (windows-native): clear orphaned emulator processes left by a
    // prior session — a crash, Task Manager "End process" (TerminateProcess can't
    // run before-quit), or a teardown that failed (e.g. the historic `taskkill /T`
    // tree-walk timeout). driver.reap() force-kills our stack DIRECTLY (no graceful
    // `pebble kill` interpreter spawn, so no startup slowdown). AWAITED here — and
    // the renderer awaits backend:init before enabling Launch — so it finishes
    // before any boot, which means it can NEVER race a fresh emulator (the old race
    // concern that argued against reaping here). before-quit still covers graceful
    // closes; boot-time killAll remains a backstop.
    if (kind === "windows-native" && driver.reap) {
      // Bounded: reap force-kills directly and enumerates via a bounded tasklist,
      // but we still race it against a hard cap so a startup reap can NEVER wedge
      // backend:init (which the renderer awaits before enabling Launch). On
      // timeout we proceed — boot-time killAll is the backstop.
      const reapDone = driver.reap().catch((e) => console.error(`[backend] startup reap failed: ${String(e)}`));
      await Promise.race([reapDone, new Promise<void>((r) => setTimeout(r, STARTUP_REAP_TIMEOUT_MS))]);
    }
    // First-run SDK provisioning for the native-Windows stack: the bundled SDK is
    // read-only, so we materialise a writable copy under the app-data persist dir
    // (the XDG_DATA_HOME the invocation contract points at) BEFORE any boot. Runs
    // here at init — which the renderer awaits before enabling Launch — so the
    // first emu:start always finds a ready SDK. Idempotent (cached), so this is a
    // near-instant no-op on every launch after the first.
    if (process.platform === "win32" && kind === "windows-native") {
      try {
        const ctx = await defaultCtx();
        const res = await ensureWinSdkProvisioned(ctx, {
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
    // Warm-standby pre-boot (Task 5): now that provisioning is done, fire a
    // background boot of the last-used board so the first Launch attaches near-
    // instantly. Fire-and-forget — NOT awaited, so it can never gate this init
    // response (the renderer awaits backend:init before enabling Launch); errors
    // are swallowed inside kick() to a log line. windows-native only: it's the
    // shipping self-contained stack with the fast killAll/reap paths this relies
    // on. The renderer passes `prebootBoard` only when the Settings checkbox is on.
    const prebootBoard = opts?.prebootBoard;
    if (kind === "windows-native" && prebootBoard) {
      try {
        getPlatform(prebootBoard); // reject an unknown/injected id before it reaches a boot
        warmStandby.kick(prebootBoard);
        // Adopt the warm boot's token as the current one so an abort/stop during
        // the pre-boot window cancels the right boot's wait loops.
        const t = warmStandby.currentToken();
        if (t) currentBootToken = t;
        console.log(`[warm] pre-booting ${prebootBoard}`);
      } catch (err) {
        console.error(`[warm] kick skipped: ${String(err)}`);
      }
    }
    return { kind };
  });
  // App version (v1.0.0) — surfaced in the Help → What's New modal.
  ipcMain.handle("app:version", () => app.getVersion());
  // Post-live work shared by the cold boot and the warm-standby fast path: runs
  // exactly once per user-visible launch (the warm boot owns only boot-to-Live).
  // battery.reassert / time.applyAll are idempotent re-asserts, so running them
  // here after a claim — even if the emulator has been warm for a while — just
  // re-applies the chosen state (same as after a Clear/weather reboot).
  // Arm a fire-and-forget QEMU snapshot creation for this boot, so the NEXT launch
  // of this board restores instantly. Delayed so post-live injections settle, and
  // guarded so it only fires while THIS exact boot is still the live one (a stop or
  // a newer boot cancels it; the driver hook is a no-op off windows-native and
  // ineligible boards, and skips when a current bundle already exists). Never on
  // the boot critical path; never throws.
  const scheduleSnapshotCreate = (id: PlatformId, token: BootToken): void => {
    if (!driver?.createSnapshotAfterLive) return; // snapshots unsupported on this driver
    if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    const stillLive = (): boolean => !token.cancelled && currentBootToken === token && emuLive;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      if (!stillLive()) return;
      void driver?.createSnapshotAfterLive?.(id, () => !stillLive());
    }, SNAPSHOT_CREATE_DELAY_MS);
  };
  const runPostLive = async (id: PlatformId, token: BootToken): Promise<void> => {
    await battery.reassert(); // re-assert the chosen battery level (before the time push, since emu-battery's connect re-syncs host time)
    void time.applyAll(); // re-assert time settings (fire-and-forget)
    // Re-install the per-board language pack (Task 10): packs live in RAM and are
    // wiped on reboot, so re-assert the persisted selection after every boot.
    // Fire-and-forget like health — NEVER on the boot critical path, never awaited
    // (the controller caps its own retries and never throws). No-op on non-native
    // backends and when no language is selected. runPostLive runs exactly once per
    // launch (cold boot + warm-standby claim), so this reassert does too.
    kickLangReassert(getLang, id, (m) => console.error(m));
    // Arm the health monitor only if this boot wasn't superseded by a force-close
    // mid-flight: emu:abort/emu:stop flip token.cancelled and call bridgeMonitor.stop(),
    // and a boot that resolves in that same window would otherwise re-start a monitor
    // polling an already-killed emulator (symmetric to the renderer's bootGen guard).
    if (!token.cancelled) bridgeMonitor.start(id);
    if (!token.cancelled) { emuLive = true; startAppLog(id); }
    // Kick the delayed snapshot creation for this launch (cold boot / warm claim).
    // The driver hook self-skips when a current bundle already exists, so this is a
    // one-time-per-identity capture and never re-snapshots after a restore boot.
    if (!token.cancelled) scheduleSnapshotCreate(id, token);
  };
  const startEmu = async (e: IpcMainInvokeEvent, id: PlatformId): Promise<VncEndpoint> => {
    assertMainSender(e);
    if (quitting) throw new Error("Pebble Studio is shutting down.");
    getPlatform(id); // reject an unknown/injected platform id before it reaches a bash -lc line
    currentPlatform = id; // remembered for clay:phonesimPort's state-file lookup

    // Warm-standby fast path: if a pre-boot for THIS board is in flight or ready,
    // claim it (single boot, no double-start) and jump straight to post-live work.
    const warm = warmStandby.claim(id);
    if (warm) {
      // Adopt the warm boot's token so a force-close mid-attach cancels the right
      // boot and the post-live guards see it.
      const adopted = warmStandby.currentToken() ?? { cancelled: false };
      currentBootToken = adopted;
      try {
        const ep = await warm;
        await runPostLive(id, adopted);
        return ep;
      } catch (err) {
        // A CANCELLED claim (quit/force-close raced the attach) must NOT fall
        // through: the fallback cold boot would spawn a fresh stack with a brand-
        // new token right after teardown's sweep — orphaned on quit, or booting
        // the watch straight back up after a Force close.
        if (quitting || adopted.cancelled) throw err;
        // The pre-boot genuinely failed — fall through to a normal cold boot.
        console.error(`[warm] claimed pre-boot failed, falling back to a cold boot: ${String(err)}`);
      }
    } else {
      // Not our board (or already claimed): cancel any UNCLAIMED warm boot for a
      // different board and fully kill its stack (single-instance VNC ports) before
      // we boot. No-op when the warm standby is idle/claimed.
      await warmStandby.cancel();
    }

    // Cold boot. Fresh token per boot, stored as current so abort/stop can cancel it.
    if (quitting) throw new Error("Pebble Studio is shutting down.");
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
    const ep = await requireDriver().start(id, token, onStep);
    await runPostLive(id, token);
    return ep;
  };
  ipcMain.handle("emu:start", (e, id: PlatformId) => {
    // Track the boot so teardownEmulator can await its full unwind (leak guard).
    const p = startEmu(e, id);
    currentBootPromise = p;
    // Swallow here only for the tracker's sake; the returned `p` still carries
    // the rejection to the renderer unchanged.
    void p.catch(() => {}).finally(() => { if (currentBootPromise === p) currentBootPromise = null; });
    return p;
  });
  ipcMain.handle("emu:abort", async () => {
    // Cancel any in-flight boot so its wait loops bail promptly. No-op (no throw)
    // if nothing is booting.
    if (currentBootToken) currentBootToken.cancelled = true;
  });
  ipcMain.handle("emu:appLogHistory", async () => appLog.history());
  // Renderer drives this from the "Show emulator logs" toggle (and once on startup
  // with the persisted value). On → start streaming if an emulator is live (else it
  // starts at the next boot); off → stop the stream so it stops contending for the
  // pypkjs bridge.
  ipcMain.handle("emu:logCapture", async (_e, on: boolean) => {
    logCaptureEnabled = on;
    if (on) {
      if (emuLive && currentPlatform) startAppLog(currentPlatform);
    } else {
      stopAppLog();
    }
  });
  ipcMain.handle("emu:stop", async (e) => {
    assertMainSender(e);
    // Shared teardown (also used by the app-quit handler). Deliberately does NOT
    // clear `loaded`: a stop/kill reaps processes + the state file but leaves
    // installed apps on disk (removed only by `pebble wipe`).
    await teardownEmulator();
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
  ipcMain.handle("sim:set", async (e, rawCfg: SimEnvConfig): Promise<{ rebooted: boolean }> => {
    assertMainSender(e);
    // Normalize the untrusted renderer object (finite lat/lon in range, allowed
    // condition/units, clamped tempC) before persisting — the bundled python
    // reads sim-env.json and trusts it. Never throws: bad fields fall back/clamp.
    const cfg = normalizeSimEnv(rawCfg);
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
      const isWindowsNative = driverKind === "windows-native";
      const supportsRefresh = driverKind === "native" || isWindowsNative;
      const ctx = isWindowsNative ? await defaultCtx() : null;
      const { rebooted } = await refreshWeatherAfterSimChange({
        enabled: supportsRefresh,
        isLive: async () =>
          currentPlatform != null && readPypkjsPort(winHostPaths().emuInfo) != null,
        clearCache: isWindowsNative ? async () => {
          const { cmd, args, env } = clearWeatherCacheArgv(ctx!);
          const r = await spawnRunner(cmd, args, env);
          if (r.code !== 0) console.error(`[sim] clearcache exited ${r.code}: ${r.stderr.trim()}`);
          else if (r.stdout.trim()) console.log(`[sim] ${r.stdout.trim()}`);
        } : undefined,
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
          if (!token.cancelled) { emuLive = true; startAppLog(currentPlatform!); }
        },
        reinstall: async () => {
          await withAppLogPaused(async () => {
            for (const p of library.list()) { await installWithBridgeRetry(() => driver!.install(p)); loaded.add(p); }
          });
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
  ipcMain.handle("emu:install", async (e, pbwPath: string) => {
    assertMainSender(e);

    const platform = currentPlatform;
    if (!platform) throw new Error("No emulator platform is currently selected.");

    const recoverBridge = async (): Promise<void> => {
      console.warn("[install] bridge stopped responding — restarting emulator");
      emuLive = false;
      backlight.stop();
      time.stop();
      bridgeMonitor.stop();

      try {
        await requireDriver().stop();
      } catch {
        // The bridge may already be partially stopped.
      }

      const token: BootToken = { cancelled: false };
      currentBootToken = token;
      await requireDriver().start(platform, token);

      if (token.cancelled) throw new Error("Bridge recovery boot was cancelled.");

      void time.applyAll();
      bridgeMonitor.start(platform);
      emuLive = true;
    };

    await withAppLogPaused(() =>
      installWithBridgeRetry(() => requireDriver().install(pbwPath), { recoverBridge }),
    );

    loaded.add(pbwPath);
    reassertTime();
  });
  ipcMain.handle("emu:button", async (_e, id: ButtonId, action?: ButtonAction) => {
    // ButtonId/ButtonAction are erased at runtime; validate against the real
    // allowed sets so a crafted id can't inject into the input-helper stdin
    // protocol (`click <id>` / `hold <id>`; see winInputChannel.writeCommand).
    if (!isButtonId(id)) throw new Error(`invalid button id: ${String(id)}`);
    const act = action ?? "press";
    if (!isButtonAction(act)) throw new Error(`invalid button action: ${String(action)}`);
    await requireDriver().button(id, act);
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
    // Pause the log stream: health activation is another pypkjs-bridge client, and
    // the persistent log stream can crowd out the limited connection slots.
    const r = await withAppLogPaused(() => driver!.activateHealth());
    console.log(`[health] activate: ok=${r.ok} status=${r.status} ${r.detail}`);
    return r;
  });
  // Backlight-free framebuffer screenshot (over the watch protocol). The renderer
  // passes a capture filename; main resolves it under the configured capture dir
  // (same whitelist/traversal guard as capture:save), asks the driver to write the
  // PNG there, and returns the saved absolute path — or null on ANY failure, which
  // tells the renderer to fall back to the VNC-canvas + backlight grab. Never
  // throws (a thrown handler would surface as a renderer rejection, defeating the
  // graceful fallback). The framebuffer path is unverified-live; see winHelpers.ts.
  ipcMain.handle("emu:screenshotFramebuffer", async (e, name: string): Promise<string | null> => {
    assertMainSender(e);
    if (!driver) return null;
    try {
      const dir = captureDir ?? path.resolve(app.getPath("downloads"));
      const out = resolveCapturePath(dir, name);
      const ok = await driver.screenshotFramebuffer(out);
      if (!ok) return null;
      // Confirm the file actually landed before claiming success.
      const stat = await fs.stat(out).catch(() => null);
      if (!stat || !stat.isFile() || stat.size === 0) return null;
      // Round boards (chalk, gabbro): the framebuffer PNG is a plain rectangle
      // with black corners. Mask them to transparent so the saved shot is a
      // circle, matching the renderer's canvas path. Best-effort: a mask failure
      // must not lose the (otherwise valid) screenshot.
      if (currentPlatform && getPlatform(currentPlatform).round) {
        try {
          await applyCircularMaskToPngFile(out);
        } catch (e) {
          console.warn(`[capture] circular mask failed (keeping square PNG): ${String(e)}`);
        }
      }
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
    // optional (windows-native only) — without them this is just the peek toggle.
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
    // windows-native must NOT use a shell: on a Windows host `bash` resolves to
    // the WSL launcher, so `cat /tmp/pb-emulator.json` would read WSL's stale
    // state file (never the native emulator's %TEMP%\pb-emulator.json) and return
    // null → the Clay gear reported "emulator not running" and never opened.
    // Read the Windows state file directly via Node fs, mirroring the bridge
    // monitor (readEmuInfo above) and the input channel (createDriver readPort).
    if (driverKind === "windows-native") {
      return readPypkjsPort(winHostPaths().emuInfo);
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

  ipcMain.handle("settings:setCaptureDir", async (e, dir: string) => {
    assertMainSender(e);
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

  // ── Pebble SDK management (native-Windows) ───────────────────────────────
  // Report / replace / reset the SDK pebble-tool resolves via SDKs\current. An
  // uploaded SDK is "Replace & persist": it survives relaunches via the
  // .active-sdk override marker until the user uploads another or resets.
  const sdkProgress = (msg: string): void => {
    console.log(`[sdk] ${msg}`);
    getMainWindow()?.webContents.send("emu:boot-progress", msg);
  };
  ipcMain.handle("sdk:info", async () => {
    return currentSdkInfo(await defaultCtx());
  });
  ipcMain.handle("sdk:install", async (e, mode?: "file" | "folder") => {
    assertMainSender(e);
    // Windows' openFile dialog can't select a directory, so a folder SDK needs a
    // separate openDirectory picker. installCustomSdk handles either path shape;
    // the renderer chooses via `mode` (default "file", the archive picker).
    const result = await dialog.showOpenDialog(
      mode === "folder"
        ? { title: "Select a Pebble SDK folder", properties: ["openDirectory"] }
        : {
            title: "Select a Pebble SDK archive",
            properties: ["openFile"],
            filters: [
              { name: "Pebble SDK archive", extensions: ["bz2", "tbz2", "gz", "tgz", "tar", "zip"] },
              { name: "All files", extensions: ["*"] },
            ],
          },
    );
    if (result.canceled || result.filePaths.length === 0) return null;
    // Installing a new SDK changes what the NEXT boot resolves. Cancel any
    // in-flight boot first — the `emuLive` gate alone misses a boot still in
    // progress (emuLive flips true only once it completes), which the swap would
    // otherwise race — then tear down so nothing is left straddling the old SDK.
    if (currentBootToken) currentBootToken.cancelled = true;
    await teardownEmulator();
    return installCustomSdk(await defaultCtx(), result.filePaths[0], { run: spawnRunner, onProgress: sdkProgress });
  });
  ipcMain.handle("sdk:reset", async (e) => {
    assertMainSender(e);
    // Mirror sdk:install: an in-flight boot or warm-standby pre-boot may still
    // be running against the SDK we're about to drop — `emuLive` alone missed both.
    if (currentBootToken) currentBootToken.cancelled = true;
    await teardownEmulator();
    return resetToBundledSdk(await defaultCtx(), { onProgress: sdkProgress });
  });
  // Dry-run preview: what a normal apply WOULD do (which boards are newer than
  // our launcher, etc.), with no teardown and no mutation. The renderer uses this
  // to show its own themed dialog and decide whether to downgrade — replacing the
  // old OS message box that lived here (and whose focus-steal over-zoomed the
  // emulator on relaunch).
  ipcMain.handle("sdk:previewFullLauncher", async (e) => {
    assertMainSender(e);
    const preview = await applyFullLauncherToActiveSdk(await defaultCtx(), { dryRun: true });
    return { report: preview.report, info: preview.info };
  });
  ipcMain.handle("sdk:applyFullLauncher", async (e, opts?: { force?: boolean }) => {
    assertMainSender(e);
    const ctx = await defaultCtx();
    const force = opts?.force === true;
    // Re-derive what will change from a fresh dry run (the renderer already asked
    // the user; this is the authoritative check the mutation gates on).
    const preview = await applyFullLauncherToActiveSdk(ctx, { dryRun: true });
    const willChange =
      preview.report.applied.length > 0 || (force && preview.report.skippedNewer.length > 0);
    // Nothing to do (no eligible boards, downgrade not granted)? Don't tear down.
    if (!willChange) {
      return { report: preview.report, info: preview.info, changed: false };
    }
    // Real apply — firmware changes, so tear down first like sdk:install.
    if (currentBootToken) currentBootToken.cancelled = true;
    await teardownEmulator();
    const applied = await applyFullLauncherToActiveSdk(ctx, { force, onProgress: sdkProgress });
    return { report: applied.report, info: applied.info, changed: true };
  });
  ipcMain.handle("sdk:revertFullLauncher", async (e) => {
    assertMainSender(e);
    if (currentBootToken) currentBootToken.cancelled = true;
    await teardownEmulator();
    const { reverted, info } = await revertFullLauncherOnActiveSdk(await defaultCtx(), { onProgress: sdkProgress });
    return { reverted, info, changed: reverted.length > 0 };
  });

  // ── Language packs (native-Windows) ──────────────────────────────────────
  // The handlers delegate to the language controller (Task 9); the langIpc layer
  // owns native-only gating + error→string mapping + the file picker. install /
  // sideload return a `{ language }` / `{ pack }` on success or a surfaced
  // `{ error }` string; on a non-native backend every handler resolves the clear
  // "not supported" payload rather than crashing.
  ipcMain.handle("lang:catalog", async (e, board: string) => {
    assertMainSender(e);
    return langHandlers.catalog(board);
  });
  ipcMain.handle("lang:install", async (e, board: string, ref: PackRef) => {
    assertMainSender(e);
    return langHandlers.install(board, ref);
  });
  ipcMain.handle("lang:sideload", async (e) => {
    assertMainSender(e);
    return langHandlers.sideload();
  });
  ipcMain.handle("lang:active", async (e, board: string) => {
    assertMainSender(e);
    return langHandlers.active(board);
  });
  ipcMain.handle("lang:selection", async (e, board: string) => {
    assertMainSender(e);
    return langHandlers.getSelection(board);
  });
  ipcMain.handle("lang:setSelection", async (e, board: string, sel: Selection | null) => {
    assertMainSender(e);
    return langHandlers.setSelection(board, sel);
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

  ipcMain.handle("capture:save", async (e, name: string, bytes: Uint8Array) => {
    assertMainSender(e);
    // Cap the payload so a hostile/buggy renderer can't make main buffer an
    // unbounded blob to disk (a real screenshot/GIF is far under this).
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength > MAX_CAPTURE_BYTES) {
      throw new Error("capture payload too large or not binary");
    }
    // Resolve + sanitize against the configured capture dir (filename whitelist +
    // path stays inside the dir). Falls back to Downloads if unset.
    const dir = captureDir ?? path.resolve(app.getPath("downloads"));
    const out = resolveCapturePath(dir, name);
    await fs.writeFile(out, Buffer.from(bytes));
    console.log(`[capture] saved ${out}`);
    return out;
  });

  // The app-quit path latches the boot refusal and takes the driver's fast stop
  // (direct kill sweep, no graceful nicety) — see teardownEmulator.
  return { shutdown: () => teardownEmulator({ quit: true }) };
}
