/** Host-side paths for the emulator stack.
 *
 * Native macOS pebble-tool writes its state file under $TMPDIR, while Linux and
 * WSL normally use /tmp. These values are shell expressions rather than
 * host-resolved Node paths so the same command string resolves inside whichever
 * POSIX shell actually executes it.
 *
 * All three are embedded UNQUOTED in shell command lines (which may cross the
 * wsl.exe -- bash -lc boundary), so they must stay quote-free and space-free;
 * $HOME/$TMPDIR are expanded by that shell. tests/backend/hostPaths.test.ts
 * enforces that shape. */

// When TMPDIR is set (macOS), use it. Otherwise fall back to /tmp (Linux/WSL).
// The two adjacent parameter expansions produce exactly one path.
export const EMU_INFO_PATH = "${TMPDIR:+$TMPDIR/pb-emulator.json}${TMPDIR:-/tmp/pb-emulator.json}";
export const EMU_LOG_PATH = "${TMPDIR:+$TMPDIR/pebble-emu.log}${TMPDIR:-/tmp/pebble-emu.log}";
export const SDK_ROOT = "$HOME/.local/share/pebble-sdk/SDKs/current";

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
