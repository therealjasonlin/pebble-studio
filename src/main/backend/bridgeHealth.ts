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
 *      /tmp/pb-emulator.json text (same read pattern as parsePhonesimPort in
 *      clayWindow.ts and parseMonitorPort in backend/backlight.ts).
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

/**
 * The three identifiers needed to assess bridge health:
 *   - qemuPid     — PID of the qemu-pebble process
 *   - pypkjsPid   — PID of the pypkjs phone-bridge process
 *   - pypkjsPort  — WebSocket/TCP port pypkjs listens on
 */
export interface BridgePids {
  qemuPid: number;
  pypkjsPid: number;
  pypkjsPort: number;
}

/**
 * Extract the qemu PID, pypkjs PID, and pypkjs port for a given platform from
 * the emulator state file's JSON text (pebble-tool's /tmp/pb-emulator.json).
 *
 * Pure (no fs / no shell) so it is unit-testable. The file shape is:
 *   { "<platform>": { "<sdkVersion>": {
 *       "qemu":   { "pid": <n>, "port": <n>, "monitor": <n>, "vnc": true },
 *       "pypkjs": { "pid": <n>, "port": <n> },
 *       "websockify": { "pid": <n> }
 *     } } }
 * We return the first version entry under `platform` that carries all three
 * values (qemu.pid, pypkjs.pid, pypkjs.port) as finite numbers, or null when
 * the json is missing/malformed or no such entry exists. Tolerates non-object
 * shapes at any level without throwing.
 * (Same read pattern as parsePhonesimPort in clayWindow.ts and
 * parseMonitorPort in backend/backlight.ts.)
 */
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
 *   OK        — the pypkjs port accepts a TCP connection (the bridge is
 *               serving), OR both processes are alive (not zombies).
 *   DEAD port — both PIDs are alive but the pypkjs TCP port is not reachable
 *               (pypkjs hung — debounced by the monitor).
 *   DEAD pid  — the port is NOT reachable AND a PID is gone/zombie (a real,
 *               confirmed death).
 *
 * WHY PORT-FIRST (the relaunch-loop fix, v0.0.13.10):
 *   The /proc/<pid> read is fragile across the Windows→wsl.exe→bash boundary —
 *   the first poll after boot intermittently read an empty state for a pid that
 *   was demonstrably alive (the qemu/pypkjs processes survived long after the
 *   app gave up looping). The old command checked the pid FIRST and
 *   short-circuited to `DEAD pid` before ever probing the port, so one bad read
 *   tore down a healthy, port-reachable bridge and triggered an infinite
 *   relaunch loop. A reachable pypkjs port is authoritative proof the bridge is
 *   alive, so we probe it FIRST: if it answers, the verdict is OK no matter what
 *   the pid reads say. `DEAD pid` is now only reachable when the port is ALSO
 *   down, which makes it a genuine death (and safe to fire without debounce).
 *
 * CRITICAL — the returned string MUST contain ZERO ' and ZERO " characters.
 * See module-level comment for why. All tokens are unquoted; the only
 * shell-special characters used are redirection (>/dev/null, 2>/dev/null),
 * semicolon (;), and parentheses — none of which require quoting and all of
 * which survive the WSL double-shell-hop unmangled.
 *
 * Implementation strategy (quote-free):
 *   Step 1: TCP probe via bare `(exec 3<>/dev/tcp/localhost/PORT) 2>/dev/null`.
 *           A refused connect fails immediately — no timeout wrapper needed.
 *           On success → echo OK and exit (port-reachable ⇒ alive, authoritative).
 *   Step 2 (only when the port is down): read a single state char via
 *           `ps -o state= -p <pid> | cut -c1`, which yields one char (Z/S/R/…) or
 *           empty when the process is gone. If either QSTATE or PSTATE is empty or
 *           equals Z → DEAD pid; otherwise → DEAD port.
 *
 *   PORTABILITY: `ps -o state=` is the cross-platform state probe — it works on
 *   Linux, WSL (Linux), AND macOS (BSD ps), unlike the Linux-only /proc/<pid>/status
 *   this replaced. On macOS there is no /proc, so the old grep produced an empty
 *   state for EVERY pid and mis-reported a hung-but-alive bridge as `DEAD pid`.
 */
export function buildHealthCommand(pids: BridgePids): string {
  const { qemuPid, pypkjsPid, pypkjsPort } = pids;

  // Step 1: TCP probe — (exec 3<>/dev/tcp/localhost/PORT) 2>/dev/null
  // On connect refused this fails immediately; on success the subshell exits 0.
  // A reachable port is authoritative: the bridge is serving ⇒ OK, regardless
  // of any (fragile) /proc pid read.
  //
  // Step 2 (port down only): extract a single state char with `ps -o state=`.
  // The `=` suppresses the header; the value is the process state ("S", "R",
  // "Z", possibly with BSD flag suffixes like "Ss"/"R+"), so `cut -c1` reduces it
  // to one safe char. Empty when the pid is not in the process table (gone).
  // Single char, no spaces → unquoted [ ] tests are safe. `ps -o state=` is
  // portable across Linux / WSL / macOS (see the header comment on /proc).

  return (
    `if (exec 3<>/dev/tcp/localhost/${pypkjsPort}) 2>/dev/null; then echo OK; exit 0; fi; ` +
    `QSTATE=$(ps -o state= -p ${qemuPid} 2>/dev/null | cut -c1); ` +
    `PSTATE=$(ps -o state= -p ${pypkjsPid} 2>/dev/null | cut -c1); ` +
    `if [ -z $QSTATE ] || [ -z $PSTATE ] || [ $QSTATE = Z ] || [ $PSTATE = Z ]; then echo DEAD pid; exit 1; fi; ` +
    `echo DEAD port`
  );
}

/**
 * Interpret the stdout (and exit code) of the health command into a structured
 * verdict.
 *
 * Tokens (case-insensitive, leading/trailing whitespace ignored):
 *   "OK"        → { alive: true,  kind: "ok"   }
 *   "DEAD pid"  → { alive: false, kind: "pid"  }
 *   "DEAD port" → { alive: false, kind: "port" }
 *   anything else (empty, garbage, parse error) →
 *               → { alive: false, kind: "port" }
 *                 (conservative; the monitor debounces port failures so this
 *                  won't immediately trigger a false alarm for a one-off glitch)
 *
 * `code` is accepted for API completeness but is not needed — the command
 * always prints a token regardless of exit code; the token carries the verdict.
 */
export function interpretHealth(
  stdout: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _code: number,
): { alive: boolean; kind: "ok" | "pid" | "port" } {
  const token = stdout.trim().toLowerCase();
  if (token === "ok") return { alive: true, kind: "ok" };
  if (token === "dead pid") return { alive: false, kind: "pid" };
  if (token === "dead port") return { alive: false, kind: "port" };
  // Empty, unknown, or garbage output → conservative dead-port verdict.
  return { alive: false, kind: "port" };
}
