/**
 * Bridge health detection core (Task H1 — pure, unit-testable).
 *
 * Detects whether the qemu-pebble + pypkjs processes are still alive and
 * reachable by reading the emulator state file and probing the real process
 * table. Pure (no Electron, no polling loop, no fs reads) — all three
 * exported functions are fully unit-testable under vitest's node environment.
 *
 * Three responsibilities:
 *   1. parseBridgePids  — extract qemu.pid, pypkjs.pid, pypkjs.port from the
 *      emulator state-file text.
 *   2. buildHealthCommand — assemble a quote-free bash one-liner that probes
 *      process states and the pypkjs TCP port, printing OK / DEAD pid /
 *      DEAD port to stdout.
 *   3. interpretHealth — parse that stdout into a structured verdict.
 *
 * CRITICAL: buildHealthCommand output MUST contain ZERO single-quote (') and
 * ZERO double-quote (") characters. The command is run via a Shell that on a
 * Windows host re-wraps it as `wsl.exe -- bash -lc "'bash' '-lc' '<cmd>'"`.
 * Any quote inside the command string is mangled across the two shell hops and
 * silently breaks only on the real .exe. (See pebbleCli.ts setTzOffsetCmd and
 * its no-quote test for the same constraint.)
 */

export interface BridgePids {
  qemuPid: number;
  pypkjsPid: number;
  pypkjsPort: number;
}

export function parseBridgePids(json: string, platform: string): BridgePids | null {
  try {
    const parsed = JSON.parse(json) as Record<
      string,
      Record<
        string,
        {
          qemu?: { pid?: number };
          pypkjs?: { pid?: number; port?: number };
        }
      >
    >;
    const versions = parsed?.[platform];
    if (!versions || typeof versions !== "object") return null;
    for (const v of Object.values(versions)) {
      const qemuPid = v?.qemu?.pid;
      const pypkjsPid = v?.pypkjs?.pid;
      const pypkjsPort = v?.pypkjs?.port;
      if (
        typeof qemuPid === "number" && Number.isFinite(qemuPid) &&
        typeof pypkjsPid === "number" && Number.isFinite(pypkjsPid) &&
        typeof pypkjsPort === "number" && Number.isFinite(pypkjsPort)
      ) {
        return { qemuPid, pypkjsPid, pypkjsPort };
      }
    }
  } catch {
    /* missing / partial / malformed json → no pids */
  }
  return null;
}

/**
 * Build a quote-free bash one-liner that probes qemu + pypkjs health and
 * prints exactly ONE verdict token to stdout:
 *   OK        — the pypkjs port accepts a TCP connection.
 *   DEAD port — both PIDs are alive but the pypkjs TCP port is not reachable.
 *   DEAD pid  — the port is not reachable and a PID is gone or zombie.
 *
 * The port check remains authoritative and runs first. For process state, Linux
 * and WSL use /proc when available; macOS falls back to `ps -o stat=`. Keeping
 * both probes in the generated command makes the same health logic work on all
 * supported POSIX hosts without weakening zombie detection.
 *
 * CRITICAL — the returned string MUST contain ZERO ' and ZERO " characters.
 */
export function buildHealthCommand(pids: BridgePids): string {
  const { qemuPid, pypkjsPid, pypkjsPort } = pids;

  return (
    `if (exec 3<>/dev/tcp/localhost/${pypkjsPort}) 2>/dev/null; then echo OK; exit 0; fi; ` +
    `QSTATE=$(grep -m1 ^State /proc/${qemuPid}/status 2>/dev/null | cut -f2 | cut -c1); ` +
    `[ -z $QSTATE ] && QSTATE=$(ps -o stat= -p ${qemuPid} 2>/dev/null | cut -c1); ` +
    `PSTATE=$(grep -m1 ^State /proc/${pypkjsPid}/status 2>/dev/null | cut -f2 | cut -c1); ` +
    `[ -z $PSTATE ] && PSTATE=$(ps -o stat= -p ${pypkjsPid} 2>/dev/null | cut -c1); ` +
    `if [ -z $QSTATE ] || [ -z $PSTATE ] || [ $QSTATE = Z ] || [ $PSTATE = Z ]; then echo DEAD pid; exit 1; fi; ` +
    `echo DEAD port`
  );
}

export function interpretHealth(
  stdout: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _code: number,
): { alive: boolean; kind: "ok" | "pid" | "port" } {
  const token = stdout.trim().toLowerCase();
  if (token === "ok") return { alive: true, kind: "ok" };
  if (token === "dead pid") return { alive: false, kind: "pid" };
  if (token === "dead port") return { alive: false, kind: "port" };
  return { alive: false, kind: "port" };
}
