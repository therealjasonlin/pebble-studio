/**
 * winBridgeHealth.ts — NATIVE (no-bash) bridge-health check for the
 * windows-native driver.
 *
 * WHY THIS EXISTS (root cause of the v2.0.1 "stopped responding" loop):
 * the POSIX bridge health probe (bridgeHealth.buildHealthCommand) is a bash
 * one-liner that reads `/proc/<pid>/status` and `/dev/tcp`. On a native-Windows
 * host the bridge monitor ran it through `makeNativeShell()` = `bash -lc …`, and
 * on this class of machine `bash` resolves to the **WSL** launcher
 * (`…\WindowsApps\bash.exe`). So the probe ran INSIDE WSL: it read WSL's stale
 * `/tmp/pb-emulator.json` and inspected WSL's `/proc` — which never contains the
 * native-Windows qemu/pypkjs pids — so it returned `DEAD pid` for a perfectly
 * healthy native emulator every poll, triggering the auto-relaunch loop.
 *
 * The native check inspects the REAL Windows process table + the pypkjs TCP port
 * directly (no bash, no WSL, no /proc), mirroring buildHealthCommand's port-first
 * verdict semantics so the monitor's debounce logic is unchanged.
 */

import { connect as netConnect } from "node:net";
import type { BridgePids } from "./bridgeHealth.js";

/** Same verdict shape interpretHealth produces, so the monitor is agnostic. */
export interface HealthVerdict {
  alive: boolean;
  kind: "ok" | "pid" | "port";
}

/**
 * PURE port-first verdict, mirroring buildHealthCommand:
 *   - the pypkjs TCP port is reachable        → OK (authoritative: bridge serving)
 *   - port down AND a pid is gone             → DEAD pid (a real death)
 *   - port down but both pids still alive     → DEAD port (pypkjs hung; debounced)
 */
export function nativeHealthVerdict(
  portReachable: boolean,
  qemuAlive: boolean,
  pypkjsAlive: boolean,
): HealthVerdict {
  if (portReachable) return { alive: true, kind: "ok" };
  if (!qemuAlive || !pypkjsAlive) return { alive: false, kind: "pid" };
  return { alive: false, kind: "port" };
}

/**
 * Native pid-liveness via `process.kill(pid, 0)` — sends no signal, just probes
 * existence. On Windows: returns normally if the process exists and is
 * signalable; throws EPERM if it exists but we lack rights (still alive); throws
 * ESRCH if it is gone. So alive ⇔ (no throw) OR (throw with code EPERM).
 */
export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Native TCP reachability probe (1s timeout), same shape as winBootDeps.portOpen. */
export function defaultPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    s.setTimeout(1000);
    const no = (): void => { s.destroy(); resolve(false); };
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", no);
    s.once("timeout", no);
  });
}

export interface NativeHealthDeps {
  /** Probe a TCP port; resolve true if reachable. Defaults to defaultPortOpen. */
  portOpen?: (host: string, port: number) => Promise<boolean>;
  /** Test whether a pid is alive. Defaults to defaultPidAlive. */
  pidAlive?: (pid: number) => boolean;
}

/**
 * Build a `checkHealth(pids)` for the bridge monitor that assesses a NATIVE
 * Windows emulator with no shell at all. Port-first: a reachable pypkjs port is
 * authoritative proof the bridge is serving, so we don't even read the pids in
 * the common healthy case.
 */
export function makeNativeHealthCheck(
  deps: NativeHealthDeps = {},
): (pids: BridgePids) => Promise<HealthVerdict> {
  const portOpen = deps.portOpen ?? defaultPortOpen;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  return async (pids: BridgePids): Promise<HealthVerdict> => {
    if (await portOpen("127.0.0.1", pids.pypkjsPort)) return { alive: true, kind: "ok" };
    return nativeHealthVerdict(false, pidAlive(pids.qemuPid), pidAlive(pids.pypkjsPid));
  };
}
