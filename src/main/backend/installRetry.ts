/**
 * installRetry.ts — bounded retry for `pebble install` against the contended,
 * small-capacity pypkjs bridge.
 *
 * pypkjs accepts only a couple of simultaneous libpebble2 clients. The persistent
 * input helper holds one, and the optional emu-logs stream (`pebble logs`) holds
 * another. A drag-drop install opens yet another client; even though emu:install
 * pauses the log stream first (withAppLogPaused → stopAppLog), pypkjs may not have
 * released that just-killed client's slot before the install connects, so it
 * rejects the install with "unable to add pbw when emulator already running" and
 * surfaces a raw "failed (code 1)" to the user — yet the watchface still loads via
 * the boot-path reinstall. This is transient (the slot frees within a beat), so we
 * retry the install a few times. Any OTHER failure (corrupt pbw, ENOENT, …) is a
 * hard fault and is rethrown immediately — retrying it would only delay the error.
 */

/** The pypkjs cap-reject signature, as it appears inside the wrapped install error. */
const BRIDGE_BUSY_RE = /unable to add pbw|emulator already running/i;
/** Signatures that indicate the pypkjs/WebSocket bridge stopped responding. */
const BRIDGE_DEAD_RE =
  /Timed out waiting for install confirmation|WebSocketConnectionClosedException|Connection to remote host was lost|libpebble2\.exceptions\.TimeoutError|Couldn't launch emulator/i;


/** True if `err` is the transient pypkjs "another client holds the slot" rejection. */
export function isBridgeBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return BRIDGE_BUSY_RE.test(msg);
}

/** True if the emulator bridge disconnected or stopped responding. */
export function isBridgeDeadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return BRIDGE_DEAD_RE.test(msg);
}

export interface InstallRetryOpts {
  /** Total attempts including the first (default 4). */
  attempts?: number;
  /** Delay between attempts in ms (default 400). */
  retryMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Restart the emulator bridge after a disconnect or protocol timeout. */
  recoverBridge?: () => Promise<void>;
}

/**
 * Run `install`, retrying ONLY on the transient bridge-busy rejection up to
 * `attempts` times. Resolves on the first success; rethrows the last error once
 * attempts are exhausted, and rethrows any non-bridge-busy error immediately.
 */
export async function installWithBridgeRetry(
  install: () => Promise<void>,
  opts: InstallRetryOpts = {},
): Promise<void> {
  const attempts = opts.attempts ?? 4;
  const retryMs = opts.retryMs ?? 400;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const recoverBridge = opts.recoverBridge;
  let recoveredBridge = false;

  for (let i = 0; i < attempts; i++) {
    try {
      await install();
      return;
    } catch (e) {
      if (
        isBridgeDeadError(e) &&
        recoverBridge &&
        !recoveredBridge &&
        i < attempts - 1
      ) {
        recoveredBridge = true;
        await recoverBridge();
        continue;
      }

      if (i === attempts - 1 || !isBridgeBusyError(e)) throw e;
      await sleep(retryMs);
    }
  }
}

