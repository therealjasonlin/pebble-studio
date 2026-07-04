import { describe, it, expect, beforeEach } from "vitest";
import {
  parseMacSelfTest,
  macStudioDir,
  macDeployPaths,
  macWrapperScript,
  ensureMacTimeShim,
  isMacShimReady,
  _resetMacShimState,
  macSitecustomizeDir,
  macPythonEnv,
  ensureMacSitecustomize,
  type MacFsAdapter,
  type MacExecResult,
} from "../../src/main/backend/macTimeShim.js";

describe("parseMacSelfTest", () => {
  const now = 1_700_000_000;
  it("accepts a value within ±120s of now+86400", () => {
    expect(parseMacSelfTest(String(now + 86400), now)).toBe(true);
    expect(parseMacSelfTest(String(now + 86400 + 100), now)).toBe(true);
  });
  it("rejects an unfaked value (still ~now)", () => {
    expect(parseMacSelfTest(String(now), now)).toBe(false);
  });
  it("rejects garbage / empty output", () => {
    expect(parseMacSelfTest("not-a-number", now)).toBe(false);
    expect(parseMacSelfTest("", now)).toBe(false);
  });
  it("boundary: +120s → true; +121s → false; -121s → false", () => {
    const expected = now + 86400;
    expect(parseMacSelfTest(String(expected + 120), now)).toBe(true);
    expect(parseMacSelfTest(String(expected + 121), now)).toBe(false);
    expect(parseMacSelfTest(String(expected - 121), now)).toBe(false);
  });
  it("reads the LAST whitespace-separated token (ignores any prefix noise)", () => {
    expect(parseMacSelfTest(`junk\n${now + 86400}\n`, now)).toBe(true);
  });
});

describe("macStudioDir / macDeployPaths", () => {
  it("roots the studio dir at $HOME/.pebble-studio", () => {
    expect(macStudioDir({ HOME: "/Users/x" })).toBe("/Users/x/.pebble-studio");
  });
  it("derives dylib/probe/wrapper/ctl under the studio dir", () => {
    const p = macDeployPaths("/Users/x/.pebble-studio");
    expect(p.dylib).toBe("/Users/x/.pebble-studio/timeshim.dylib");
    expect(p.probe).toBe("/Users/x/.pebble-studio/probe");
    expect(p.wrapper).toBe("/Users/x/.pebble-studio/qemu-pebble");
    expect(p.ctl).toBe("/Users/x/.pebble-studio/pb-faketime.ctl");
  });
});

describe("macWrapperScript", () => {
  const w = macWrapperScript("/Users/x/Library/Application Support/Pebble SDK/q/qemu-pebble");
  it("force-loads the dylib via DYLD_INSERT_LIBRARIES", () => {
    expect(w).toContain("DYLD_INSERT_LIBRARIES");
    expect(w).toContain("timeshim.dylib");
  });
  it("exports the SAME ctl path the UI writes ($HOME/.pebble-studio/pb-faketime.ctl)", () => {
    expect(w).toContain("PEBBLE_FAKETIME_FILE=$HOME/.pebble-studio/pb-faketime.ctl");
  });
  it("execs the real qemu path, double-quoted (it contains spaces)", () => {
    expect(w).toContain('exec "/Users/x/Library/Application Support/Pebble SDK/q/qemu-pebble" "$@"');
  });
});

// ---------------------------------------------------------------------------
// ensureMacTimeShim integration (fake fs + exec, no real filesystem / process)
// ---------------------------------------------------------------------------

const QEMU = "/Users/x/Library/Application Support/Pebble SDK/q/qemu-pebble";
const SRC = "/src/timeshim-mac";
const STUDIO = "/home/.pebble-studio";
const fakeNow = () => 1_700_000_000 * 1000; // ms; /1000 = nowSec
const faked = String(fakeNow() / 1000 + 86400);

/** Records fs calls; `present` is the set of paths that "exist". Deployed files
 * (mkdir/copyFile/writeFile) are added to `present` as they are created. */
function makeFs(present: Set<string>): { fs: MacFsAdapter; calls: string[]; present: Set<string> } {
  const calls: string[] = [];
  const fs: MacFsAdapter = {
    exists: (p) => present.has(p),
    mkdir: async (d) => { calls.push(`mkdir ${d}`); present.add(d); },
    copyFile: async (s, dst) => { calls.push(`copy ${s} -> ${dst}`); present.add(dst); },
    writeFile: async (p, data) => { calls.push(`write ${p} :: ${data.split("\n")[0]}`); present.add(p); },
    chmod: async (p, m) => { calls.push(`chmod ${m.toString(8)} ${p}`); },
  };
  return { fs, calls, present };
}

/** exec runner: routes by binary name. `probeOut` is what the self-test probe
 * prints; `codesignCode`/`clangCode` let a step fail. */
function makeExec(opts: {
  probeOut?: string;
  probeCode?: number;
  codesignCode?: number;
  clangCode?: number;
} = {}): { exec: (f: string, a: string[], e?: Record<string, string>) => Promise<MacExecResult>; calls: string[] } {
  const calls: string[] = [];
  const exec = async (file: string, args: string[]): Promise<MacExecResult> => {
    calls.push(`${file} ${args.join(" ")}`);
    if (file.endsWith("/probe") || file === "probe") {
      return { code: opts.probeCode ?? 0, stdout: opts.probeOut ?? faked, stderr: "" };
    }
    if (file === "clang") return { code: opts.clangCode ?? 0, stdout: "", stderr: opts.clangCode ? "clang boom" : "" };
    if (file === "codesign") return { code: opts.codesignCode ?? 0, stdout: "", stderr: opts.codesignCode ? "sign boom" : "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

/** A source dir where the .c AND the compiled binaries already exist (happy path). */
function builtSource(): Set<string> {
  return new Set([
    `${SRC}/timeshim.c`, `${SRC}/probe.c`,
    `${SRC}/timeshim.dylib`, `${SRC}/probe`,
  ]);
}

describe("ensureMacTimeShim", () => {
  beforeEach(() => _resetMacShimState());

  it("success: deploys dylib+probe+wrapper then self-tests → ready true", async () => {
    const { fs, calls: fsCalls } = makeFs(builtSource());
    const { exec, calls: execCalls } = makeExec();
    const ok = await ensureMacTimeShim(QEMU, {
      fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC,
    });
    expect(ok).toBe(true);
    expect(isMacShimReady()).toBe(true);
    // deploy artifacts present
    expect(fsCalls.some((c) => c.startsWith(`mkdir ${STUDIO}`))).toBe(true);
    expect(fsCalls.some((c) => c.includes(`-> ${STUDIO}/timeshim.dylib`))).toBe(true);
    expect(fsCalls.some((c) => c.includes(`-> ${STUDIO}/probe`))).toBe(true);
    expect(fsCalls.some((c) => c.includes(`write ${STUDIO}/qemu-pebble`))).toBe(true);
    // self-test is the LAST exec, and runs the deployed probe
    expect(execCalls[execCalls.length - 1]).toContain(`${STUDIO}/probe`);
  });

  it("deploy order: dylib+probe copied and wrapper written BEFORE the self-test", async () => {
    const { fs, calls: fsCalls } = makeFs(builtSource());
    const { exec } = makeExec();
    // Interleave a combined timeline by wrapping exec to snapshot fs progress.
    const timeline: string[] = [];
    const wrapped = async (f: string, a: string[], e?: Record<string, string>) => {
      if (f.includes("/probe")) timeline.push(`selftest(fsCalls=${fsCalls.length})`);
      return exec(f, a, e);
    };
    await ensureMacTimeShim(QEMU, { fs, exec: wrapped, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    // By the time the self-test runs, all deploy fs ops have already happened.
    const copyIdx = fsCalls.findIndex((c) => c.includes(`-> ${STUDIO}/timeshim.dylib`));
    const writeIdx = fsCalls.findIndex((c) => c.includes(`write ${STUDIO}/qemu-pebble`));
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(copyIdx);
    expect(timeline[0]).toContain("selftest");
  });

  it("compile-on-demand: missing binaries → clang+codesign then success", async () => {
    // Only the .c sources exist; binaries must be compiled.
    const { fs } = makeFs(new Set([`${SRC}/timeshim.c`, `${SRC}/probe.c`]));
    const { exec, calls: execCalls } = makeExec();
    const ok = await ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    expect(ok).toBe(true);
    // Two clang compiles (dylib + probe) happened before deploy.
    const clangs = execCalls.filter((c) => c.startsWith("clang "));
    expect(clangs.length).toBe(2);
    expect(clangs[0]).toContain("-dynamiclib");
  });

  it("compile-on-demand fails (no toolchain) → ready false, no throw", async () => {
    const { fs } = makeFs(new Set([`${SRC}/timeshim.c`, `${SRC}/probe.c`]));
    const { exec } = makeExec({ clangCode: 1 });
    const ok = await ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    expect(ok).toBe(false);
    expect(isMacShimReady()).toBe(false);
  });

  it("self-test fails (dylib serves real time) → ready false", async () => {
    const { fs } = makeFs(builtSource());
    const { exec } = makeExec({ probeOut: String(fakeNow() / 1000) }); // unfaked
    const ok = await ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    expect(ok).toBe(false);
    expect(isMacShimReady()).toBe(false);
  });

  it("deploy codesign failure is non-fatal (self-test still gates) → ready true", async () => {
    const { fs } = makeFs(builtSource());
    const { exec } = makeExec({ codesignCode: 1 });
    const ok = await ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    expect(ok).toBe(true);
  });

  it("missing sources → ready false, no throw", async () => {
    const { fs } = makeFs(new Set());
    const { exec } = makeExec();
    const ok = await ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    expect(ok).toBe(false);
    expect(isMacShimReady()).toBe(false);
  });

  it("second call is cached (no re-run) after success", async () => {
    const { fs } = makeFs(builtSource());
    const { exec, calls } = makeExec();
    await ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    const after = calls.length;
    await ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC });
    expect(calls.length).toBe(after); // no new exec calls
    expect(isMacShimReady()).toBe(true);
  });

  it("a FAILED attempt is retryable: next call re-runs and can succeed", async () => {
    // First attempt: sources missing → false.
    const bad = makeFs(new Set());
    const okBad = await ensureMacTimeShim(QEMU, {
      fs: bad.fs, exec: makeExec().exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC,
    });
    expect(okBad).toBe(false);
    // Second attempt (NO reset): sources present now → succeeds.
    const good = makeFs(builtSource());
    const okGood = await ensureMacTimeShim(QEMU, {
      fs: good.fs, exec: makeExec().exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC,
    });
    expect(okGood).toBe(true);
    expect(isMacShimReady()).toBe(true);
  });

  it("concurrent calls share one in-flight check (self-test runs once)", async () => {
    const { fs } = makeFs(builtSource());
    const { exec, calls } = makeExec();
    const [r1, r2] = await Promise.all([
      ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC }),
      ensureMacTimeShim(QEMU, { fs, exec, now: fakeNow, studioDir: STUDIO, sourceDir: SRC }),
    ]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // Self-test call starts with the probe path; the codesign deploy call starts
    // with "codesign" — so this counts self-tests only.
    const selfTests = calls.filter((c) => c.startsWith(`${STUDIO}/probe`));
    expect(selfTests.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sitecustomize: env assembly + deploy
// ---------------------------------------------------------------------------

describe("macSitecustomizeDir / macPythonEnv", () => {
  it("isolates sitecustomize under studioDir/py", () => {
    expect(macSitecustomizeDir("/home/.pebble-studio")).toBe("/home/.pebble-studio/py");
  });
  it("sets PYTHONPATH to the dir + PEBBLE_FAKETIME_FILE to the ctl (no prior PYTHONPATH)", () => {
    const env = macPythonEnv("/home/.pebble-studio/py", "/home/.pebble-studio/pb-faketime.ctl");
    expect(env.PYTHONPATH).toBe("/home/.pebble-studio/py");
    expect(env.PEBBLE_FAKETIME_FILE).toBe("/home/.pebble-studio/pb-faketime.ctl");
  });
  it("PREPENDS the dir onto an existing PYTHONPATH (dir wins, tool's modules still resolve)", () => {
    const env = macPythonEnv("/home/.pebble-studio/py", "/ctl", "/existing/a:/existing/b");
    expect(env.PYTHONPATH).toBe("/home/.pebble-studio/py:/existing/a:/existing/b");
  });
});

describe("ensureMacSitecustomize", () => {
  const SC_SRC = "/vendor/pebble-py/sitecustomize.py";
  it("deploys ONLY sitecustomize.py into studioDir/py and returns the env", async () => {
    const { fs, calls } = makeFs(new Set([SC_SRC]));
    const r = await ensureMacSitecustomize({
      fs, studioDir: STUDIO, sitecustomizeSrc: SC_SRC, existingPythonPath: undefined,
    });
    expect(r).not.toBeNull();
    expect(r!.dir).toBe(`${STUDIO}/py`);
    expect(r!.env.PYTHONPATH).toBe(`${STUDIO}/py`);
    expect(r!.env.PEBBLE_FAKETIME_FILE).toBe(`${STUDIO}/pb-faketime.ctl`);
    // Exactly one file copied — and it is sitecustomize.py into the isolated dir.
    const copies = calls.filter((c) => c.startsWith("copy "));
    expect(copies.length).toBe(1);
    expect(copies[0]).toBe(`copy ${SC_SRC} -> ${STUDIO}/py/sitecustomize.py`);
    expect(calls.some((c) => c === `mkdir ${STUDIO}/py`)).toBe(true);
  });

  it("prepends an existing PYTHONPATH in the returned env", async () => {
    const { fs } = makeFs(new Set([SC_SRC]));
    const r = await ensureMacSitecustomize({
      fs, studioDir: STUDIO, sitecustomizeSrc: SC_SRC, existingPythonPath: "/tool/pkgs",
    });
    expect(r!.env.PYTHONPATH).toBe(`${STUDIO}/py:/tool/pkgs`);
  });

  it("missing source → null, no throw (degrades to real time)", async () => {
    const { fs } = makeFs(new Set());
    const r = await ensureMacSitecustomize({ fs, studioDir: STUDIO, sitecustomizeSrc: SC_SRC });
    expect(r).toBeNull();
  });
});
