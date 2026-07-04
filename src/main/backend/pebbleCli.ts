import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";

export interface PebbleCommand {
  // Usually "pebble"; setTzOffsetCmd uses "bash -lc …" to run the raw-SetUTC helper.
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Quote-free shell snippet applying `timeout -k 2 6` (SIGTERM at 6 s, SIGKILL at
 * 8 s) ONLY when a `timeout`/`gtimeout` binary was resolved into `$T`; otherwise
 * it expands to nothing and the helper runs unbounded. Callers must set
 * `T=$(command -v timeout || command -v gtimeout)` earlier in the SAME one-liner.
 * Stays quote-free so it survives the Windows→wsl.exe→bash double-hop.
 */
const TIMEOUT_PREFIX = "${T:+$T -k 2 6}";

let activePlatform: PlatformId = "basalt";
export function setActivePlatform(id: PlatformId): void { activePlatform = id; }
export function getActivePlatform(): PlatformId { return activePlatform; }

function base(sub: string, ...rest: string[]): PebbleCommand {
  return { cmd: "pebble", args: [sub, "--emulator", activePlatform, ...rest] };
}

export function installCmd(pbwPath: string): PebbleCommand {
  return { ...base("install", pbwPath), env: { PEBBLE_EMULATOR: activePlatform } };
}

/**
 * Maps ButtonAction to the CLI's action vocabulary.
 * Real CLI: pebble emu-button {click,push,release} [BUTTON ...]
 *   - "press"   -> "click"  (press + release)
 *   - "hold"    -> "push"   (hold down)
 *   - "release" -> "release"
 */
const ACTION_MAP: Record<ButtonAction, string> = {
  press: "click",
  hold: "push",
  release: "release",
};

export function buttonCmd(button: ButtonId, action: ButtonAction): PebbleCommand {
  // Real CLI order: action first, then button(s)
  return base("emu-button", ACTION_MAP[action], button);
}

/**
 * Sends an accelerometer tap event.
 * Real CLI: pebble emu-tap (separate subcommand, not emu-accel tap)
 */
export function accelTapCmd(): PebbleCommand { return base("emu-tap"); }

/**
 * Sets emulator time. With utc=true appends --utc so the firmware applies the
 * value as UTC (utc_offset=0) — making the *displayed* time exactly the epoch
 * interpreted as UTC, independent of the host timezone. We always pass epoch
 * seconds + utc=true so timezone display is deterministic (see timeController).
 * Real CLI: pebble emu-set-time <time> [--utc]
 *   where <time> is HH:MM:SS (today, local) or Unix UTC seconds.
 *   ISO 8601 strings are NOT accepted.
 */
export function setTimeCmd(time: string, utc = false): PebbleCommand {
  return base("emu-set-time", ...(utc ? [time, "--utc"] : [time]));
}

/**
 * Sets the 12h/24h clock style (what clock_is_24h_style() reads).
 * Real CLI: pebble emu-time-format --format {12h|24h}
 */
export function timeFormatCmd(hour24: boolean): PebbleCommand {
  return base("emu-time-format", "--format", hour24 ? "24h" : "12h");
}

/**
 * Push the watch's UTC offset (minutes) via a RAW SetUTC packet, bypassing
 * `pebble emu-set-time`.
 *
 * WHY NOT `emu-set-time`: the qemu RTC is slaved to host UTC, so SetUTC's
 * `unix_time` is ignored — only `utc_offset` moves the displayed time. But the
 * stock CLI can only send offset 0 (`--utc`) or the host offset (no `--utc`),
 * never an arbitrary zone. AND every `pebble` command re-syncs host time on
 * connect (commands/base.py post_connect). A raw libpebble2 connection sends ONLY
 * our offset and skips post_connect entirely. (See timeController's contract.)
 *
 * Self-contained: deploys a tiny helper (base64 below) under ~/.pebble-studio on
 * first/every call, then runs it with pebble-tool's bundled python (whose libpebble2
 * has the protocol). Returned as a `bash -lc` command so the same (cmd,args) routes
 * through the native runner OR the WSL runner (`wsl.exe -- bash -lc …`) unchanged.
 */
// Helper source (pb-set-tz.py): connects to the running emulator's pypkjs websocket
// (port from /tmp/pb-emulator.json) and sends SetUTC(now, utc_offset=argv[1],
// tz_name=argv[2]). Base64 of the script (the base64 alphabet is shell-safe — no
// quotes/spaces/metacharacters — so it can be echo'd UNQUOTED, see below).
const SET_TZ_HELPER_B64 =
  "aW1wb3J0IHN5cywganNvbiwgdGltZQpmcm9tIGxpYnBlYmJsZTIuY29tbXVuaWNhdGlvbiBpbXBvcnQgUGViYmxlQ29ubmVjdGlvbgpmcm9tIGxpYnBlYmJsZTIuY29tbXVuaWNhdGlvbi50cmFuc3BvcnRzLndlYnNvY2tldCBpbXBvcnQgV2Vic29ja2V0VHJhbnNwb3J0CmZyb20gbGlicGViYmxlMi5wcm90b2NvbC5zeXN0ZW0gaW1wb3J0IFRpbWVNZXNzYWdlLCBTZXRVVEMKb2Zmc2V0ID0gaW50KHN5cy5hcmd2WzFdKQpuYW1lID0gc3lzLmFyZ3ZbMl0gaWYgbGVuKHN5cy5hcmd2KSA+IDIgZWxzZSAoJ1VUQyUrZCcgJSAob2Zmc2V0IC8vIDYwKSkKaW5mbyA9IGpzb24ubG9hZChvcGVuKCcvdG1wL3BiLWVtdWxhdG9yLmpzb24nKSkKcG9ydCA9IE5vbmUKZm9yIHBsYXQsIHZlcnMgaW4gaW5mby5pdGVtcygpOgogICAgZm9yIHYsIGQgaW4gdmVycy5pdGVtcygpOgogICAgICAgIHAgPSAoZC5nZXQoJ3B5cGtqcycpIG9yIHt9KS5nZXQoJ3BvcnQnKQogICAgICAgIGlmIHA6IHBvcnQgPSBwCmlmIHBvcnQgaXMgTm9uZToKICAgIHN5cy5leGl0KCdubyBweXBranMgcG9ydCBpbiAvdG1wL3BiLWVtdWxhdG9yLmpzb24nKQpjID0gUGViYmxlQ29ubmVjdGlvbihXZWJzb2NrZXRUcmFuc3BvcnQoJ3dzOi8vbG9jYWxob3N0OiVkLycgJSBwb3J0KSkKYy5jb25uZWN0KCk7IGMucnVuX2FzeW5jKCkKdHMgPSBpbnQodGltZS50aW1lKCkpCmMuc2VuZF9wYWNrZXQoVGltZU1lc3NhZ2UobWVzc2FnZT1TZXRVVEModW5peF90aW1lPXRzLCB1dGNfb2Zmc2V0PW9mZnNldCwgdHpfbmFtZT1uYW1lKSkpCnRpbWUuc2xlZXAoMC40KQpwcmludCgnc2VudCBvZmZzZXQ9JWQgKCVzKSB2aWEgd3MgcG9ydCAlZCcgJSAob2Zmc2V0LCBuYW1lLCBwb3J0KSkK";

/** A name is safe to pass UNQUOTED through the shell (IANA zones: letters, digits,
 * `/`, `_`, `-`, `+`). Anything else falls back to the synthesized UTC±h name. */
function shellSafeZoneName(name: string | undefined, offsetMin: number): string {
  if (name && /^[A-Za-z0-9_+/-]+$/.test(name)) return name;
  const h = Math.trunc(offsetMin / 60);
  return `UTC${h >= 0 ? "+" : ""}${h}`;
}

export function setTzOffsetCmd(offsetMin: number, tzName?: string): PebbleCommand {
  const off = Math.trunc(offsetMin);
  const name = shellSafeZoneName(tzName, off);
  // CRITICAL: this one-liner must contain NO single OR double quotes. It is run as
  // `bash -lc <oneLiner>`, and on a Windows host the WSL driver re-wraps the whole
  // thing (`wsl.exe -- bash -lc "'bash' '-lc' '<oneLiner>'"`). Quotes inside the
  // one-liner would have to survive Node's Windows arg-quoting AND two shell-parse
  // hops — which mangled the previous quoted version, so timezone/custom time
  // silently never reached the watch. Everything here is quote-free:
  //   - the base64 blob is echo'd unquoted (base64 alphabet is shell-safe);
  //   - $HOME/pebble paths have no spaces, so $VAR is left unquoted;
  //   - the shebang is stripped with `head -1 | cut -c3-` (no sed quotes);
  //   - the zone name is validated shell-safe above.
  // `timeout -k 2 6` HARD-BOUNDS the push: the helper opens a connection to the
  // single-client pypkjs bridge, which when contended/dead would otherwise hang
  // FOREVER (the helper has no internal timeout). Fire-and-forget callers (reassert)
  // then pile up dozens of stuck connections, starving/destabilising pypkjs — a
  // confirmed live failure (15+ hung `pb-set-tz.py` chains). SIGTERM at 6 s,
  // SIGKILL at 8 s, so a wedged push always unwinds.
  //
  // `timeout` is GNU coreutils — always present on Linux/WSL, but NOT on a stock
  // macOS (it ships as `gtimeout` via Homebrew, if at all). Resolve either name and
  // apply it only when found; otherwise run the helper unbounded. `${T:+…}` keeps
  // this quote-free (WSL double-hop safe — see the not-toContain(') test).
  const oneLiner =
    `mkdir -p $HOME/.pebble-studio; ` +
    `H=$HOME/.pebble-studio/pb-set-tz.py; ` +
    `echo ${SET_TZ_HELPER_B64} | base64 -d > $H; ` +
    `PYBIN=$(head -1 $(command -v pebble) | cut -c3-); ` +
    `T=$(command -v timeout || command -v gtimeout); ` +
    `${TIMEOUT_PREFIX} $PYBIN $H ${off} ${name}`;
  return { cmd: "bash", args: ["-lc", oneLiner] };
}

export interface WinSetTzOffsetOpts {
  /** Absolute path to the Python interpreter that has pebble-tool's libpebble2. */
  pythonExe: string;
  /** Absolute path to the deployed pb-set-tz.py helper. */
  helperPath: string;
  offsetMin: number;
  tzName?: string;
}

/**
 * Windows-native form of setTzOffset: a direct argv (cmd=python, no shell) that
 * runs the same pb-set-tz.py helper used by the POSIX path. No bash, no base64,
 * no quoting hops — so the v0.0.12 "quote-free" rule is N/A here (nothing crosses
 * a shell). The zone name is still validated shell-safe for defense in depth and
 * to keep behavior identical to the POSIX path's synthesized UTC±h fallback.
 */
export function winSetTzOffsetArgv(o: WinSetTzOffsetOpts): PebbleCommand {
  const off = Math.trunc(o.offsetMin);
  const name = shellSafeZoneName(o.tzName, off);
  return { cmd: o.pythonExe, args: [o.helperPath, String(off), name] };
}

// Helper source (pb-activate-health.py): connects to the running emulator's pypkjs
// websocket and sends ONE BlobDB Prefs INSERT (key "activityPreferences\0", value =
// 9-byte ActivitySettings with tracking_enabled=1), then reads the BlobResponse and
// prints "health-activate: status=<n>" (1 == success). The emulator state-file path
// is argv[1] (default /tmp/pb-emulator.json for POSIX/WSL); the windows-native driver
// passes %TEMP%\pb-emulator.json — WITHOUT this, native Windows hit FileNotFoundError
// on /tmp (→ C:\tmp) before sending, so health never activated.
// Base64 of the script (base64 alphabet is shell-safe — echo'd UNQUOTED, like pb-set-tz.py).
const ACTIVATE_HEALTH_HELPER_B64 =
  "aW1wb3J0IHN5cywganNvbiwgb3MsIHN0cnVjdApmcm9tIGxpYnBlYmJsZTIuY29tbXVuaWNhdGlvbiBpbXBvcnQgUGViYmxlQ29ubmVjdGlvbgpmcm9tIGxpYnBlYmJsZTIuY29tbXVuaWNhdGlvbi50cmFuc3BvcnRzLndlYnNvY2tldCBpbXBvcnQgV2Vic29ja2V0VHJhbnNwb3J0CmZyb20gbGlicGViYmxlMi5wcm90b2NvbC5ibG9iZGIgaW1wb3J0IEJsb2JDb21tYW5kLCBJbnNlcnRDb21tYW5kLCBCbG9iUmVzcG9uc2UKc3RhdGVwYXRoID0gc3lzLmFyZ3ZbMV0gaWYgbGVuKHN5cy5hcmd2KSA+IDEgZWxzZSAnL3RtcC9wYi1lbXVsYXRvci5qc29uJwppbmZvID0ganNvbi5sb2FkKG9wZW4oc3RhdGVwYXRoKSkKcG9ydCA9IE5vbmUKZm9yIHBsYXQsIHZlcnMgaW4gaW5mby5pdGVtcygpOgogICAgZm9yIHYsIGQgaW4gdmVycy5pdGVtcygpOgogICAgICAgIHAgPSAoZC5nZXQoJ3B5cGtqcycpIG9yIHt9KS5nZXQoJ3BvcnQnKQogICAgICAgIGlmIHA6IHBvcnQgPSBwCmlmIHBvcnQgaXMgTm9uZToKICAgIHN5cy5leGl0KCdubyBweXBranMgcG9ydCBpbiAlcycgJSBzdGF0ZXBhdGgpCmtleSA9IGInYWN0aXZpdHlQcmVmZXJlbmNlcycgKyBiJ1x4MDAnCnZhbHVlID0gc3RydWN0LnBhY2soJzxoaEJCQmJiJywgMTc1MCwgNzUwMCwgMSwgMSwgMSwgMzAsIDEpCnRva2VuID0gaW50LmZyb21fYnl0ZXMob3MudXJhbmRvbSgyKSwgJ2JpZycpCnBrdCA9IEJsb2JDb21tYW5kKGNvbW1hbmQ9MHgwMSwgdG9rZW49dG9rZW4sIGRhdGFiYXNlPTcsIGNvbnRlbnQ9SW5zZXJ0Q29tbWFuZChrZXk9a2V5LCB2YWx1ZT12YWx1ZSkpCnRyeToKICAgIGMgPSBQZWJibGVDb25uZWN0aW9uKFdlYnNvY2tldFRyYW5zcG9ydCgnd3M6Ly9sb2NhbGhvc3Q6JWQvJyAlIHBvcnQpKQogICAgYy5jb25uZWN0KCk7IGMucnVuX2FzeW5jKCkKICAgIHJlc3AgPSBjLnNlbmRfYW5kX3JlYWQocGt0LCBCbG9iUmVzcG9uc2UsIHRpbWVvdXQ9MykKICAgIHByaW50KCdoZWFsdGgtYWN0aXZhdGU6IHN0YXR1cz0lZCcgJSBpbnQocmVzcC5yZXNwb25zZSkpCmV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgIGNuID0gdHlwZShlKS5fX25hbWVfXwogICAgaWYgY24gPT0gJ1RpbWVvdXRFcnJvcicgb3IgY24gPT0gJ1RpbWVvdXRFbmRwb2ludCc6CiAgICAgICAgcHJpbnQoJ2hlYWx0aC1hY3RpdmF0ZTogbm8tcmVzcG9uc2UnKTsgc3lzLmV4aXQoMSkKICAgIHByaW50KCdoZWFsdGgtYWN0aXZhdGU6IGVycm9yICVzJyAlIGUpOyBzeXMuZXhpdCgxKQo=";

/** POSIX form: deploy + run pb-activate-health.py via `bash -lc` (echoed UNQUOTED,
 * same quote-free rule as setTzOffsetCmd — the WSL driver re-wraps it). `timeout`
 * hard-bounds the pypkjs connection. The helper prints `health-activate: status=<n>`. */
export function activateHealthCmd(): PebbleCommand {
  const oneLiner =
    `mkdir -p $HOME/.pebble-studio; ` +
    `H=$HOME/.pebble-studio/pb-activate-health.py; ` +
    `echo ${ACTIVATE_HEALTH_HELPER_B64} | base64 -d > $H; ` +
    `PYBIN=$(head -1 $(command -v pebble) | cut -c3-); ` +
    `T=$(command -v timeout || command -v gtimeout); ` +
    `${TIMEOUT_PREFIX} $PYBIN $H`;
  return { cmd: "bash", args: ["-lc", oneLiner] };
}

/** Windows-native form: write the decoded helper to `helperPath` then run it via the
 * provisioned python (no shell). Returns the argv; the driver writes the file first.
 * `statePath` is the native emulator state file (`%TEMP%\pb-emulator.json`) — passed
 * as argv[1] because the helper's /tmp default does not exist on native Windows. */
export function winActivateHealthArgv(pythonExe: string, helperPath: string, statePath: string): PebbleCommand {
  return { cmd: pythonExe, args: [helperPath, statePath] };
}

/** The base64-decoded pb-activate-health.py source, for the windows driver to write. */
export function activateHealthHelperSource(): Buffer {
  return Buffer.from(ACTIVATE_HEALTH_HELPER_B64, "base64");
}

/** Parse the helper's stdout into a status. status===1 ⇒ activated; null ⇒ unknown/fail. */
export function parseHealthStatus(stdout: string): number | null {
  const m = /health-activate:\s*status=(\d+)/.exec(stdout);
  return m ? Number(m[1]) : null;
}

/** Toggle the timeline quick-view (peek) on the watchface. Real CLI:
 * pebble emu-set-timeline-quick-view {on|off} */
export function timelineQuickViewCmd(on: boolean): PebbleCommand {
  return base("emu-set-timeline-quick-view", on ? "on" : "off");
}

/**
 * Toggles Bluetooth connection state.
 * Real CLI: pebble emu-bt-connection --connected {yes,no}
 */
export function btCmd(connected: boolean): PebbleCommand {
  return base("emu-bt-connection", "--connected", connected ? "yes" : "no");
}

export function batteryCmd(percent: number, charging: boolean): PebbleCommand {
  const cmd = base("emu-battery", "--percent", String(percent));
  if (charging) cmd.args.push("--charging");
  return cmd;
}

export function screenshotCmd(outPath: string): PebbleCommand { return base("screenshot", outPath); }

export function bootCmd(platform: PlatformId): PebbleCommand {
  return { cmd: "pebble", args: ["emu-control", "--emulator", platform, "--vnc"] };
}

/**
 * Wipes all emulator data for the current SDK version.
 * NOTE: `pebble wipe` has NO --emulator flag — it wipes ALL platform dirs
 * (basalt, chalk, etc.) under the active SDK version's persist directory.
 * The emulator CANNOT survive a wipe; a full reboot is required afterward.
 * (Empirically confirmed: deletes ~/.local/share/pebble-sdk/<ver>/{basalt,...})
 */
export function wipeCmd(): PebbleCommand {
  return { cmd: "pebble", args: ["wipe"] };
}
