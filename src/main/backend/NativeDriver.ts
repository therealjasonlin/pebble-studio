import type { PlatformId, ButtonId, ButtonAction } from "../../shared/types.js";
import type { BackendDriver, HealthActivateResult, Runner, RunResult, VncEndpoint } from "./BackendDriver.js";
import type { PebbleCommand } from "./pebbleCli.js";
import * as cli from "./pebbleCli.js";
import { bootEmulator, stopEmulator, type BootToken, type OnStep } from "./bootEmulator.js";
import { setFakeTimeCmd, ensureTimeShim } from "./timeShim.js";

/** Default stop uses the native (current-host) teardown. */
const defaultStop: StopFn = () => stopEmulator();

export type BootFn = (id: PlatformId, token?: BootToken, onStep?: OnStep) => Promise<VncEndpoint>;
export type StopFn = () => Promise<void>;

export interface NativeDriverDeps {
  run: Runner;
  /** Real boot orchestration; injectable so unit tests never spawn processes. */
  boot?: BootFn;
  /** Real stop orchestration; injectable so the WSL host can tear down in-WSL. */
  stop?: StopFn;
}

export class NativeDriver implements BackendDriver {
  constructor(private readonly deps: NativeDriverDeps) {}

  setPlatform(id: PlatformId): void {
    cli.setActivePlatform(id);
  }

  async start(id: PlatformId, token?: BootToken, onStep?: OnStep): Promise<VncEndpoint> {
    this.setPlatform(id);
    // The default boot (no injected boot) uses the native deps; the BootFn shape
    // is (id, token, onStep) so the token + step callback thread through both the
    // injected and default paths without exposing SpawnDeps here.
    const boot: BootFn =
      this.deps.boot ?? ((bootId, bootToken, bootStep) => bootEmulator(bootId, {}, bootToken, bootStep));
    return boot(id, token, onStep);
  }

  async stop(): Promise<void> {
    await (this.deps.stop ?? defaultStop)();
  }

  async install(pbwPath: string): Promise<void> {
    await this.exec(cli.installCmd(pbwPath));
  }

  async button(id: ButtonId, action: ButtonAction): Promise<void> {
    await this.exec(cli.buttonCmd(id, action));
  }

  async accelTap(): Promise<void> {
    await this.exec(cli.accelTapCmd());
  }

  async setTime(value: string, opts?: { utc?: boolean }): Promise<void> {
    await this.exec(cli.setTimeCmd(value, opts?.utc ?? false));
  }

  async setTzOffset(offsetMin: number, tzName?: string): Promise<void> {
    // Runs the raw-SetUTC helper directly through the runner (NOT exec): it is a
    // `bash -lc` command, not a `pebble --emulator` one, so withVnc()/throw-on-
    // nonzero don't apply. We surface a nonzero exit for diagnosis but don't throw
    // (the time controller degrades silently if the emulator/tool is absent).
    const c = cli.setTzOffsetCmd(offsetMin, tzName);
    const r = await this.deps.run(c.cmd, c.args, c.env);
    if (r.code !== 0) {
      console.warn(`[time] setTzOffset(${offsetMin}) exit ${r.code}: ${r.stderr || r.stdout}`);
    }
  }

  async setFakeTime(targetUnix: number | null, rate: number): Promise<void> {
    const c = setFakeTimeCmd(targetUnix, rate);
    const r = await this.deps.run(c.cmd, c.args, c.env);
    if (r.code !== 0) console.warn(`[time] setFakeTime exit ${r.code}: ${r.stderr || r.stdout}`);
  }

  async ensureTimeShim(): Promise<boolean> {
    return ensureTimeShim((cmdline) => this.deps.run("bash", ["-lc", cmdline]));
  }

  async timeFormat(hour24: boolean): Promise<void> {
    await this.exec(cli.timeFormatCmd(hour24));
  }

  async bluetooth(connected: boolean): Promise<void> {
    await this.exec(cli.btCmd(connected));
  }

  async battery(percent: number, charging: boolean): Promise<void> {
    await this.exec(cli.batteryCmd(percent, charging));
  }

  async activateHealth(): Promise<HealthActivateResult> {
    try {
      const c = cli.activateHealthCmd();
      const r = await this.deps.run(c.cmd, c.args, c.env);
      const status = cli.parseHealthStatus(r.stdout);
      return { ok: status === 1, status, detail: (r.stdout || r.stderr || "").trim() };
    } catch (e) {
      return { ok: false, status: null, detail: String(e) };
    }
  }

  async screenshot(outPath: string): Promise<void> {
    await this.exec(cli.screenshotCmd(outPath));
  }

  // No persistent pypkjs helper on this driver, so the backlight-free framebuffer
  // grab isn't available — return false so callers fall back to the canvas grab.
  async screenshotFramebuffer(_outPath: string): Promise<boolean> {
    return false;
  }

  async wipe(): Promise<void> {
    // wipeCmd() has no --emulator flag, so withVnc() is a no-op here.
    // We run pebble wipe via the injected runner (not through exec's throw-on-nonzero
    // since wipe sometimes exits nonzero on stderr warnings but still succeeds).
    const c = cli.wipeCmd();
    await this.deps.run(c.cmd, c.args, c.env);
  }

  async timelineQuickView(on: boolean): Promise<void> {
    await this.exec(cli.timelineQuickViewCmd(on));
  }

  private async exec(c: PebbleCommand): Promise<RunResult> {
    const args = withVnc(c.args);
    const result = await this.deps.run(c.cmd, args, c.env);
    if (result.code !== 0) {
      throw new Error(
        `pebble ${args.join(" ")} failed (code ${result.code}): ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }
}

/**
 * Inject `--vnc` into any `--emulator`-targeted pebble command.
 *
 * EMPIRICAL FINDING (Task 1.5): the emulator was booted with VNC enabled
 * (`emu-control --vnc`). A discrete command like `pebble emu-button --emulator
 * basalt click up` issued WITHOUT `--vnc` returns exit 0 but the pebble tool
 * sees a VNC-state mismatch, SIGKILLs the running VNC qemu, and spawns a fresh
 * non-VNC emulator — tearing down ws://localhost:6080 and RFB :5901. Passing
 * `--vnc` makes the tool reuse the running VNC emulator (qemu pid unchanged,
 * VNC survives). The pure pebbleCli builders stay VNC-agnostic; the VNC concern
 * lives here in the driver that owns the booted VNC stack.
 */
function withVnc(args: string[]): string[] {
  if (!args.includes("--emulator") || args.includes("--vnc") || args[0] === "screenshot") return args;
  // Insert right after the `--emulator <platform>` pair so flag ordering is sane.
  const i = args.indexOf("--emulator");
  const out = args.slice();
  out.splice(i + 2, 0, "--vnc");
  return out;
}
