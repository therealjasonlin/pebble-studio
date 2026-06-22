/** Host-side paths for the emulator stack. Today: POSIX (native Linux or WSL).
 * A future WindowsNativeDriver swaps these for %TEMP%-based equivalents —
 * pebble-tool itself writes the state file to tempfile.gettempdir().
 *
 * All three are embedded UNQUOTED in shell command lines (which may cross the
 * wsl.exe -- bash -lc boundary), so they must stay quote-free and space-free;
 * $HOME is expanded in-distro by bash. tests/backend/hostPaths.test.ts enforces
 * that shape. */
export const EMU_INFO_PATH = "/tmp/pb-emulator.json";
export const EMU_LOG_PATH = "/tmp/pebble-emu.log";
export const SDK_ROOT = "$HOME/.pebble-sdk/SDKs/current";

export interface WinHostPaths {
  /** %TEMP%\pb-emulator.json — pebble-tool writes the state file to tempfile.gettempdir(). */
  emuInfo: string;
  /** %TEMP%\pebble-emu.log */
  emuLog: string;
  /** %LOCALAPPDATA%\pebble-sdk\SDKs\current */
  sdkRoot: string;
}

/**
 * Windows-native host paths (real Win32 paths read via Node `fs`, NEVER embedded
 * in a shell command line — so unlike the POSIX consts above they may contain
 * spaces/backslashes). `env` is injectable for tests; defaults to process.env.
 */
export function winHostPaths(env: Record<string, string | undefined> = process.env): WinHostPaths {
  const temp = env.TEMP || env.TMP || "C:\\Windows\\Temp";
  const local = env.LOCALAPPDATA || "C:\\Users\\Default\\AppData\\Local";
  return {
    emuInfo: `${temp}\\pb-emulator.json`,
    emuLog: `${temp}\\pebble-emu.log`,
    sdkRoot: `${local}\\pebble-sdk\\SDKs\\current`,
  };
}

export function nativeHostEmuInfoPath(): string {
  return process.platform === "win32" ? winHostPaths().emuInfo : EMU_INFO_PATH;
}
