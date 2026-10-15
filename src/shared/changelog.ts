/** A single user-facing changelog entry. Newest entries come first in CHANGELOG. */
export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  changes: string[];
}

/**
 * User-facing changelog (concise, newest-first). Patch iterations within the
 * 0.0.13.x line are folded into their 0.0.13 entry to stay readable. Source of
 * truth for the Help → "What's New" modal.
 */
export const CHANGELOG: ChangelogEntry[] = [
  // The 2.x line is the native-Windows track (no WSL); the 1.x line is the
  // WSL-connected track. 2.0.1 is the first native release. 3.0.0 is the first
  // public open-source release. (3.0.6 was never released.)
  { version: "3.0.15", date: "2026-10-15", changes: [
    "Fixed weather not loading in watchfaces. Pebble Studio's simulated-weather helper started up too early and broke every real internet request a watchface's phone-side JavaScript made, so sources like Open-Meteo and MET Norway silently never answered. Real weather requests work again whether or not simulated weather is on.",
    "MET Norway weather now works: requests are sent with a proper app identifier instead of the default one that MET Norway blocks.",
    "Simulated OpenWeather data now looks like the real API: it includes the status code, condition name and icon, honours metric/imperial units, and also answers One Call and 5-day forecast requests. Other OpenWeather requests (like city lookup) go to the real service.",
    "Taking a screenshot or recording a GIF no longer changes what's on the watch. The capture backlight used to be woken with a Back button press, which could navigate out of the app you were capturing; it now uses a wrist-flick instead. (Thanks @jasonmarquette, PR #16.)",
    "If installing an app fails because the emulator's phone bridge dropped or timed out, Pebble Studio now restarts the emulator once and retries the install automatically. (Thanks @jasonmarquette, PR #14.)",
    "Groundwork for macOS: the emulator's temporary files are found in the right place on macOS. (Thanks @jasonmarquette, PR #12.)",
  ] },
  { version: "3.0.14", date: "2026-07-12", changes: [
    "Fixed watchfaces looking off-center on Pebble Time 2. The v3.0.13 touch-alignment change had widened the watch's on-screen area to include a hidden padding strip, which pushed the watchface off to one side of the bezel; the screen is back to its correct size, so watchfaces are centered again.",
    "Reworked the touch-alignment fix so it no longer moves the picture. Taps on Pebble Time 2 and Pebble Round 2 are now corrected purely in how the click is translated to the watch — the watchface stays centered — so vertical taps land where you tap without the side effect that shifted the display in v3.0.13.",
  ] },
  { version: "3.0.13", date: "2026-07-12", changes: [
    "Fixed touch alignment on Pebble Time 2. Taps now register where you tap — previously touches landed low and slightly left of where you clicked (for example, tapping the top row of an on-screen keypad registered as the row below), because the emulator's screen and its touch panel disagreed about the screen's exact pixel width.",
    "Fixed touch/tap input dying while Sunlight correction is on in the live view. With the overlay active, taps stopped registering on the watch; now they pass through to the emulator as normal. (The correction overlay was hiding the interactive layer beneath it in a way that also blocked clicks.)",
  ] },
  { version: "3.0.12", date: "2026-07-12", changes: [
    "Pebble Studio now runs on Windows-on-ARM PCs. The same download works on both regular (Intel/AMD) and ARM machines: on an ARM PC it automatically uses a native-ARM emulator engine, so the watch emulator boots instead of failing with \"failed to load.\" Nothing changes on Intel/AMD PCs.",
  ] },
  { version: "3.0.11", date: "2026-07-11", changes: [
    "\"Make full-featured\" now gives the modern watches (Pebble Time 2 / Pebble 2 Duo / the new Pebble) the full launcher AND runs apps built with newer SDKs. Previously the bundled launcher firmware was one app-version behind the current SDK, so those apps were rejected with \"requires a newer version of the Pebble firmware\"; the launcher firmware for those models has been rebuilt to accept them.",
    "Whether the launcher can be added is now decided by real app compatibility (the SDK version your apps actually require vs the launcher firmware) instead of the SDK's release number, so the warning only appears when apps would genuinely be rejected.",
  ] },
  { version: "3.0.10", date: "2026-07-11", changes: [
    "\"Make full-featured\" no longer risks silently breaking your apps. When your SDK is newer than Studio's bundled launcher, it now keeps your firmware by default and explains, in a themed in-app dialog (not a plain Windows pop-up), that overlaying Studio's older launcher would downgrade the firmware and cause apps to be rejected with \"requires a newer version of the Pebble firmware.\" Downgrading is still possible, but only as a clearly-labelled, deliberate choice — and \"Revert to stock firmware\" always undoes it.",
    "Removing that Windows pop-up also fixes the emulator zooming in by itself after \"Make full-featured.\"",
    "Settings → Pebble SDK: the \"Upload archive\" and \"Upload folder\" buttons lost their \"…\" and now show a hover tooltip listing exactly which files they accept.",
    "Sharper, more responsive emulator display: the watch's screen stream is now tuned for the local connection (crisper image, less CPU), and the diagnostic FPS read-out is more accurate.",
  ] },
  { version: "3.0.9", date: "2026-07-11", changes: [
    "\"Make full-featured\" can now add the launcher to an SDK that is newer than Studio's bundled launcher firmware: it asks first (\"Apply anyway?\") and then overlays Studio's launcher on those models. The launcher works, but apps built with the newer SDK may be rejected — use \"Revert to stock firmware\" to undo it. SDKs at or below our firmware are unaffected.",
    "Applying the launcher no longer reboots the emulator when nothing actually changes (for example when you decline the downgrade), and the emulator no longer over-zooms after a relaunch.",
    "SDK status messages now clear themselves: \"Relaunching…\" is replaced once the relaunch finishes, and messages auto-dismiss after a few seconds.",
  ] },
  { version: "3.0.8", date: "2026-07-11", changes: [
    "The full PebbleOS launcher is now opt-in for uploaded SDKs. A freshly uploaded SDK runs its own firmware as-is; a new \"Make full-featured\" button in Settings → Pebble SDK overlays Studio's full launcher (Settings, Health, full menu) on demand and reports, per watch model, whether it could — a model whose firmware is newer than our launcher is left alone instead of being silently downgraded.",
    "The launcher overlay is now reversible: applying it stashes each model's original firmware, so \"Revert to stock firmware\" restores the SDK's own firmware in one click without re-uploading.",
  ] },
  { version: "3.0.7", date: "2026-07-10", changes: [
    "Fixed (#8, #11): uploading a newer Pebble SDK now actually updates the emulator's firmware. Previously Studio silently stamped its own bundled (older) firmware over every uploaded SDK to preserve the full PebbleOS launcher, so apps built with a newer SDK were rejected with \"This app requires a newer version of the Pebble firmware\". The launcher firmware is now only applied to a watch model when it wouldn't be a downgrade — an upload newer than the bundled firmware keeps its own firmware (that model then uses the SDK's stock launcher).",
    "Also fixed as part of that: uploading or resetting an SDK now discards the instant-launch snapshots for the affected version, so the next launch can't restore a pre-swap firmware image; and \"Reset to bundled\" now stops an in-flight or background pre-booted emulator before switching, like Upload already did.",
    "Emulator app logs (#6): the \"Emulator logs\" panel is now on by default — watchface APP_LOG output and PebbleKit JS console messages stream live in a collapsible panel under the emulator. The stream now rides Studio's existing emulator connection instead of a separate one, so it no longer competes with app installs for the emulator bridge's limited client slots — logs keep flowing during installs (previously the stream was paused exactly then, and the panel was hidden behind Settings → Advanced).",
    "npm install now automatically repairs an Electron install that newer Node versions can silently truncate during extraction.",
    "Fixed: the background reader that keeps Studio's emulator connection drained (the protection against config pages dying with \"No config page\" after repeated opens) crashed silently the first time the connection went idle, so it effectively never ran — broken since v3.0.3. The \"Emulator logs\" panel also now prints a confirmation line when the app-log stream connects.",
    "Where's v3.0.6? It was an internal build we used for performance experiments. It didn't meet our quality bar in testing, so it was never released — we've skipped the number and rolled the best of that work into future updates.",
  ]},
  { version: "3.0.5", date: "2026-07-10", changes: [
    "The emulator now launches almost instantly on every watch model: Pebble Studio keeps a ready-to-run snapshot of a booted watch and restores it instead of booting from scratch. The boot pipeline is faster overall on every board too. (The first launch of each watch after this update boots normally once while its snapshot is created.)",
    "New option (Settings → \"Pre-boot emulator on app start\"): have Pebble Studio start your startup watch booting in the background the moment you open it, so your first Launch is near-instant. Off by default — turn it on if you'd like it.",
    "Language packs: install a different watch language from an official catalog on the supported boards, or sideload your own .pbl language pack (Settings → Language). Your chosen language sticks across launches. (Not available on Pebble Time 2, Pebble Round 2, or Pebble 2 Duo — no packs are published for those boards.)",
    "Re-selecting the watch model that's already running no longer reboots the emulator — it's now a no-op instead of a pointless restart.",
    "More reliable shutdown: quitting Pebble Studio now force-stops the emulator immediately — previously, on a heavily loaded machine, the cleanup could run out of time and leave emulator processes running in the background. Several rare ways a just-starting emulator could slip past a quit or Force close were also fixed, and language packs can now only be downloaded from the official catalog over a secure connection.",
  ]},
  { version: "3.0.4", date: "2026-07-09", changes: [
    "Fixed: Pebble Studio could get permanently stuck on \"Killing stale emulator…\" / \"Stopping…\" (seen on Pebble Round 2), and even fully restarting Studio wouldn't clear it. An emulator left over from a previous session could survive every shutdown attempt: Studio's force-kill used a Windows command whose process-tree scan times out when the machine is busy (for example a watchface pegging the CPU), so it silently failed and the old emulator kept holding the ports a new one needs. Studio now terminates emulator processes directly — which can't time out that way — and keeps retrying until the ports are actually free.",
    "Pebble Studio now clears any leftover emulator processes from a previous session at startup, so relaunching reliably gives you a clean slate even if the last session crashed or was force-closed.",
    "Important fix: that startup cleanup could terminate unrelated programs. It trusted a list of process IDs left in a temporary file that survives crashes and reboots — and Windows reuses process IDs, so an ID recorded days ago could belong to something else entirely by the time Studio read it. Studio now confirms each process really is one of its own emulator processes before stopping it.",
    "Security: watchface configuration pages (the gear button) are third-party web pages, and Studio was running them with the operating-system sandbox switched off, allowing them to navigate anywhere and to ask for permissions such as camera and microphone. Config pages are now properly sandboxed, denied all such permissions, and confined to the page they were opened for.",
    "Fixed: switching custom time back to \"System\" didn't return the watch to the real time — it stayed at whatever custom time you had set, until you rebooted the emulator. Most visible on Pebble Time 2, Pebble Round 2 and Pebble 2 Duo, whose clocks read the time continuously.",
    "Fixed: clicking \"Force close\" while the emulator was relaunching didn't actually stop it — the relaunch carried on and booted the watch straight back up. This also made an auto-recovery loop after a crash impossible to interrupt.",
    "Fixed: switching watch model while an emulator was running (with Launch set to Manual) left that emulator running invisibly in the background — holding its ports and burning CPU — with no way to stop it from the UI.",
    "Fixed: recording a GIF when the emulator stopped mid-recording would spin forever with the status stuck on \"Recording…\". Recording now stops on its own, and the Upscale and Duration controls are locked while a recording is in progress (changing Upscale mid-recording used to corrupt the GIF).",
    "Fixed: with \"Sunlight correction\" enabled, the Upscale setting was silently ignored for screenshots — 2×/4×/8× all saved at normal size.",
    "Fixed: clicking \"Rebind\" for a keyboard shortcut and then clicking elsewhere left an invisible trap armed — the next key you pressed anywhere in Studio was silently swallowed and became the new shortcut. Rebinding is now cancelled when you click away, and modifier keys on their own are rejected.",
    "Fixed: \"Reset to bundled\" in Settings → Pebble SDK could report success while the emulator kept using your uploaded SDK, if that SDK declared the same version number as the bundled one.",
    "You can now upload an extracted SDK folder (Settings → Pebble SDK → \"Upload folder…\"), not just an archive — the folder option was described but couldn't actually be selected.",
    "Screenshot and Record GIF can now be given keyboard shortcuts (Settings → Keyboard), so you can capture without opening the Capture panel. Screenshot, Record and the battery \"Set\" button now tell you the watch isn't running instead of failing with a raw error.",
    "Fixed: a diagnostic log the emulator writes to your temporary folder grew without limit (nearly 12 MB was observed). It's now cleared each time the emulator starts.",
    "Various smaller fixes: the emulator-log line count now updates while the panel is collapsed; the \"loaded\" badges no longer flicker back after clearing; picking a capture folder at the root of a drive works; a watchface config page with a malformed address no longer leaves a blank window behind; and quitting Studio twice in quick succession no longer skips emulator cleanup.",
  ]},
  { version: "3.0.3", date: "2026-06-24", changes: [
    "Fixed: with custom time set to \"Frozen\", animated watchfaces (ones with a minute-change animation) would replay that animation many times a second instead of holding still. Frozen now nudges the clock forward imperceptibly slowly so the watch stays visually frozen without the firmware re-firing the minute tick in a loop.",
    "Installing a watchface (by dropping it in) right after a reboot — especially with the \"Show emulator logs\" panel open — no longer occasionally fails with an \"install failed\" error. Pebble Studio now lets the phone bridge free up its connection slot and retries the install if it's momentarily busy.",
    "Your watchface now appears much faster after the emulator boots. Health activation used to run first and could hold the watchface back by up to ~10 seconds (sometimes leaving you on the launcher to open it by hand); it now runs in the background after your watchface loads.",
    "New Settings → Pebble SDK section: see which SDK version is in use and upload your own (a Pebble sdk-core .tar.bz2 / .zip archive or its folder) to replace the bundled one. Your SDK persists across updates until you upload another or reset to the bundled one. The full PebbleOS launcher (Settings, Health, full menu) is kept automatically on an uploaded SDK, and if the emulator is running it relaunches itself to apply the change. The active SDK version is also shown in Help → What's New.",
    "The App Library's \"loaded\" badges now clear when the emulator stops, is force-closed, or relaunches — they no longer linger as if apps were still running on a watch that isn't.",
    "Settings is less cluttered: longer explanations are now tucked behind a small \"?\" icon you can hover (or focus) for the full description, instead of always-on paragraphs of text.",
    "Setting the battery level right after the watch boots no longer fails with an error — Pebble Studio now waits for the watch to finish starting up and retries, instead of giving up while the phone bridge is still connecting.",
    "Opening a watchface's config (the gear button) right after boot no longer shows a misleading \"No config page\" message — it now retries while the watchface and phone bridge finish starting up before reporting that an app has no config page.",
    "Fixed: opening a watchface's config (the gear) several times in a row would fail with \"No config page\" from the second or third open onward and stay broken until you relaunched. The phone bridge could get stuck sending the (large) config page to a client that wasn't reading it, which froze the watch's JavaScript; the bridge now stays drained and can't be blocked, so the gear keeps working no matter how many times you open it.",
  ]},
  { version: "3.0.2", date: "2026-06-22", changes: [
    "Closing Pebble Studio now shuts the emulator down with it — QEMU and the watch's Python helpers no longer keep running (and hogging CPU) in the background, and a fresh launch always starts cleanly.",
    "The emulator's background processes now show up as \"PebbleStudioEmu\" in Task Manager instead of a generic \"python\".",
    "New option (Settings → Captures → \"Sunlight correction on live view\") applies Pebble's sunlight colour correction to the live emulator screen, matching what you already get in screenshots and GIFs. Off by default.",
    "New option (Settings → Advanced → \"Show emulator logs\") streams the watch app logs (pebble install --logs) in a collapsible panel under the emulator, with a Copy button. Off by default.",
    "Watch buttons now respond from the very first press after boot — earlier builds could drop the first couple of presses while the input helper was still starting up.",
    "Pebble Health now activates reliably on the newer boards (Pebble Time 2, Pebble Round 2, Pebble 2 Duo): boot activation retries until it lands instead of giving up when the phone bridge is still connecting, so the Health app no longer occasionally shows \"Enable Pebble Health\" after a normal boot.",
  ]},
  { version: "3.0.1", date: "2026-06-17", changes: [
    "Battery simulation: set a custom battery percentage and charging state on the running watch from Settings → Battery. Works on every board. The \"Set battery\" button glows when you have changes you haven't applied yet. Your chosen level now sticks across a reboot — changing the weather, clearing the emulator, or switching watches no longer reverts it to the board default.",
    "Simulated location & weather: watchfaces that use geolocation now work in the emulator with no phone connected. Settings → \"Simulated location & weather\" offers location presets or custom lat/lon, condition, temperature (°F/°C), and day/night. Changing the weather and clicking Apply updates weather watchfaces immediately — it clears their refresh throttle and reloads the watch — while preserving their saved settings.",
    "Pebble Health now activates reliably on boot across all boards, before user apps load, so health watchfaces no longer show \"This app requires Pebble Health\" or crash. On the legacy boards (Pebble Time, Pebble Time Round, Pebble 2) Health is pre-enabled in the bundled image so it works from the very first boot; the newer boards (Pebble Time 2, Pebble Round 2, Pebble 2 Duo) always have it on.",
    "Watchfaces that use geolocation no longer crash the emulator (a 32-bit timestamp overflow in the bundled phone-side JS engine on Windows).",
    "Captures: screenshots and GIFs can apply Pebble's official sunlight colour correction to match the real display. Off by default — toggle in Settings → Captures.",
    "Startup watch is now a fixed preference (Settings → Startup watch): the watch Pebble Studio opens on launch no longer changes when you switch the active watch from the top bar.",
    "Watch buttons support long-press (hold the mouse to hold the button) and light up on every keyboard press, confirming each keystroke registered.",
    "Clear emulator is now available whenever the emulator is running, so stale leftover apps can always be wiped.",
    "Boot-log panel no longer shrinks the emulator: collapsing the expanded log restores the fit zoom.",
  ]},
  { version: "3.0.0", date: "2026-06-15", changes: [
    "First public open-source release. Pebble Studio is now available on GitHub under the MIT license.",
  ]},
  { version: "2.1.12", date: "2026-06-15", changes: [
    "The newer watches — Pebble Time 2 (emery), Pebble Round 2 (gabbro), and Pebble 2 Duo (flint) — now open the full watch menu (Settings, Music, Notifications, Alarms, Watchfaces) when you press Select, instead of just a watchface picker. This is now built in, so it survives updates and works on a fresh install.",
  ]},
  { version: "2.1.11", date: "2026-06-15", changes: [
    "Fixed a stray outline that stuck to the last on-screen watch button you clicked with the mouse and then showed when you pressed an arrow key.",
  ]},
  { version: "2.1.10", date: "2026-06-15", changes: [
    "Custom time is now set with simple dropdowns (hour / minute, plus AM·PM in 12-hour mode) instead of typing the digits and \"AM\"/\"PM\" — the 24-hour toggle still switches the hour range and AM·PM on or off.",
    "Screenshots try a new backlight-free capture (no display flash); if it isn't available they fall back automatically to the previous method, so saving a shot always works.",
  ]},
  { version: "2.1.9", date: "2026-06-15", changes: [
    "The \"Run custom time\" button now clearly highlights (accent fill) while you have unsaved date/time/rate edits — so it's obvious that changing a control doesn't take effect until you press it.",
    "On-screen watch buttons now light up on every keyboard press (Back/Up/Select/Down), confirming each keystroke registered — not just on mouse clicks.",
  ]},
  { version: "2.1.8", date: "2026-06-15", changes: [
    "Custom time rate (2×/4×/10×) and Frozen now work on the newer watches — Pebble Time 2 (emery), Pebble Round 2 (gabbro), and Pebble 2 Duo (flint). Their emulator was following the real PC clock and ignoring your custom time, freeze, and rate; it now honors them like the other watches do.",
  ]},
  { version: "2.1.7", date: "2026-06-15", changes: [
    "Custom time now holds reliably on native Windows: 1× and 10× hold the time you set and tick forward, and Frozen holds your chosen time instead of snapping back to the real clock. (Root cause: the bundled pebble-tool was pushing the PC's real time to the watch on every connection; it now honors the emulator's fake clock, mirroring the Linux build.)",
    "Known issue: in Frozen mode the watchface still replays its time-change animation. A deeper emulator/firmware fix for that is in progress; 1×/10× are unaffected.",
  ]},
  { version: "2.1.6", date: "2026-06-14", changes: [
    "Custom time now actually applies and HOLDS on native Windows — set any date (1970–2099), Freeze, or run 2×/4×/10× and the watch goes there and stays. (v2.1.5 built the fix into the emulator but a Windows file-timestamp quirk meant the emulator never noticed when you changed the time after boot; it now re-reads your setting reliably.)",
  ]},
  { version: "2.1.4", date: "2026-06-14", changes: [
    "Fixed the backlight keepalive, the capture backlight (auto-on while taking a screenshot/GIF), and the Backlight pulse button on native Windows — they read the emulator's monitor port the wrong way and silently did nothing. (The custom-time revert is still under investigation; the diagnostics now point to needing a rebuilt emulator binary.)",
  ]},
  { version: "2.1.3", date: "2026-06-14", changes: [
    "Custom time fix attempt: the diagnostics pinned the revert to the emulator reading the clock through a lower-level Windows path than before, so this build also intercepts that path (ntdll). If custom/frozen time now holds, we found it; if not, the logs will confirm we need a rebuilt emulator.",
  ]},
  { version: "2.1.2", date: "2026-06-14", changes: [
    "Diagnostic build: custom time still reverts to system time on some setups, so this build adds internal logging (written to your TEMP folder) to pin down exactly where it slips. No behavior change — the fix comes next, once the logs confirm the cause.",
  ]},
  { version: "2.1.1", date: "2026-06-14", changes: [
    "Fixed custom time snapping back to system time a few seconds after being set — the emulator was re-reading the real clock through a code path the time shim wasn't covering yet.",
  ]},
  { version: "2.1.0", date: "2026-06-14", changes: [
    "Custom time, freeze, and time-rate (2×/4×/10×) now work on native Windows — set any date 1970–2099 in Settings → Time and it applies live on the watch.",
    "App settings (the ⚙ Clay gear) now open on native Windows — fixed the emulator-port lookup that made the gear do nothing.",
  ]},
  { version: "2.0.5", date: "2026-06-14", changes: [
    "Much faster button response — presses go through a persistent connection instead of launching a process each time.",
    "No more Windows Defender Firewall prompt for python — the emulator's sensor page now binds to localhost too.",
  ]},
  { version: "2.0.4", date: "2026-06-14", changes: [
    "Fixed the emulator failing to boot ('timeout waiting for emulator info') — qemu now binds VNC and its serial console via localhost, the form this qemu build accepts.",
    "Removed the last stray console window that opened on each launch.",
  ]},
  { version: "2.0.3", date: "2026-06-14", changes: [
    "No more Windows Defender Firewall prompts — the emulator now binds only to localhost.",
    "Cleaner launch: no extra console windows pop up while the emulator boots.",
    "Fixed the emulator falsely reporting 'stopped responding' moments after boot and looping.",
  ]},
  { version: "2.0.1", date: "2026-06-14", changes: [
    "Native Windows emulator — runs the Pebble emulator with no WSL required.",
    "Self-contained: bundles qemu, pebble-tool, and the SDK; first launch provisions the SDK automatically.",
    "Faster, more reliable boot, with a clear error when another emulator already holds the ports.",
  ]},
  { version: "1.0.0", date: "2026-06-13", changes: [
    "First stable release — the WSL-connected Pebble emulator GUI.",
    "New app & Windows .exe icon (Pebble Time 2 watch design).",
    "Application menu: File (Install PBW…, Clear Emulator), Edit, Window, Help.",
    "Help → What's New shows the version and this changelog.",
  ]},
  { version: "0.0.13", date: "2026-06-13", changes: [
    "Backlight button on the toolbar (activation: Back button or Shake, set in Settings).",
    "Toolbar button groups wrap together and stay centered on small windows.",
    "Fixed a false 'Emulator stopped responding' relaunch loop on a healthy emulator.",
    "Persistent, copyable diagnostics session log; loud Clay failures + auto-recovery.",
    "Time & Clay configuration port; per-app Clay config window.",
  ]},
  { version: "0.0.12", date: "2026-06-12", changes: [
    "Timezone and custom time reliably reach the watch; 12-hour default.",
  ]},
  { version: "0.0.11", date: "2026-06-12", changes: [
    "24-hour default, backlight-off default, time and app-list fixes, status row.",
  ]},
  { version: "0.0.10", date: "2026-06-11", changes: [
    "Working Timezone / Custom time, plus Freeze and time-rate controls.",
  ]},
  { version: "0.0.9", date: "2026-06-11", changes: [
    "Time offset and a three-mode Time source; live status; dropdown fixes.",
  ]},
  { version: "0.0.8", date: "2026-06-10", changes: [
    "Timeline button; Settings Time section (System vs Custom).",
  ]},
  { version: "0.0.7", date: "2026-06-10", changes: [
    "Opaque model dropdown, neutral Tap button, backlight-keepalive option.",
  ]},
  { version: "0.0.6", date: "2026-06-09", changes: [
    "Launch-failure highlight on the Relaunch button.",
  ]},
  { version: "0.0.5", date: "2026-06-09", changes: [
    "Boot cancellation + abort, splash screen.",
  ]},
  { version: "0.0.4", date: "2026-06-08", changes: [
    "Fit scaling, round-watch layout, thin screen bezel.",
  ]},
  { version: "0.0.3", date: "2026-06-08", changes: [
    "Screenshot/GIF capture; app library improvements.",
  ]},
  { version: "0.0.2", date: "2026-06-07", changes: [
    "Multi-platform model switching; noVNC live screen.",
  ]},
  { version: "0.0.1", date: "2026-06-07", changes: [
    "Initial build — boot the qemu-pebble emulator and view the live watch.",
  ]},
];
