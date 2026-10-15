// Integration test for the bundled python's sitecustomize -> pebble_studio_sim
// hook (vendor/pebble-py). Runs the REAL bundled interpreter, so it is skipped
// when the (gitignored) vendor bundle isn't staged.
//
// Regression: sitecustomize used to `import requests` at interpreter startup
// (via pebble_studio_sim.install) whenever PEBBLE_SIM_ENV_FILE was set — which
// the app ALWAYS sets. That imported ssl before pypkjs's gevent
// monkey.patch_all(), so every real HTTPS XHR from PebbleKit JS died with
// RecursionError inside urllib3's create_urllib3_context (gevent#1016). Only the
// intercepted hosts (OpenWeatherMap/WeatherAPI/ipify) "worked"; Open-Meteo,
// MET Norway, etc. silently never answered — and with simulation disabled even
// geolocation hung.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PY = resolve(__dirname, "../../vendor/pebble-py/PebbleStudioEmu.exe");
const hasPy = process.platform === "win32" && existsSync(PY);

function runPy(code: string, simEnv: object | null): { out: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "pss-sim-"));
  const script = join(dir, "probe.py");
  writeFileSync(script, code, "utf-8");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PEBBLE_FAKETIME_FILE;
  if (simEnv) {
    const f = join(dir, "simenv.json");
    writeFileSync(f, JSON.stringify(simEnv), "utf-8");
    env.PEBBLE_SIM_ENV_FILE = f;
  } else {
    delete env.PEBBLE_SIM_ENV_FILE;
  }
  const r = spawnSync(PY, [script], { env, encoding: "utf-8", timeout: 60_000, cwd: dir });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
}

describe.skipIf(!hasPy)("bundled python: simulated weather hook", () => {
  const ENABLED = {
    enabled: true,
    location: { lat: 10, lon: 20, name: "X" },
    weather: { condition: "rain", tempC: 10, isDay: true },
    units: "F",
  };

  it("does not import requests/ssl at interpreter startup", () => {
    const r = runPy(
      "import sys\nprint('requests' in sys.modules, 'ssl' in sys.modules)\n",
      ENABLED,
    );
    expect(r.out).toContain("False False");
  });

  for (const [label, cfg] of [
    ["enabled", ENABLED],
    ["disabled", { enabled: false }],
  ] as const) {
    it(`real HTTPS still works after pypkjs's gevent patch (sim ${label})`, () => {
      // Exactly pypkjs's import order: pypkjs/__init__ monkey-patches first,
      // then the XHR module pulls in requests. Building the TLS context is what
      // recursed; it needs no network.
      const r = runPy(
        [
          "import pypkjs.javascript.xhr",
          "from urllib3.util.ssl_ import create_urllib3_context",
          "create_urllib3_context()",
          "print('CTX_OK')",
        ].join("\n"),
        cfg,
      );
      expect(r.out).not.toContain("RecursionError");
      expect(r.out).toContain("CTX_OK");
    });
  }

  it("still intercepts OpenWeatherMap + patches geolocation once requests loads", () => {
    const r = runPy(
      [
        "import pypkjs.javascript.xhr",
        "import requests, json, pygeoip",
        "print('PATCHED', getattr(requests.sessions.Session.send, '_pebble_sim', False))",
        "s = requests.Session()",
        "resp = s.send(s.prepare_request(requests.Request('GET', 'https://api.openweathermap.org/data/2.5/weather?lat=1&lon=2')))",
        "print('OWM_ID', resp.json()['weather'][0]['id'])",
        "rec = pygeoip.GeoIP.record_by_addr(None, '8.8.8.8')",
        "print('GEO', rec['latitude'], rec['longitude'])",
      ].join("\n"),
      ENABLED,
    );
    expect(r.out).toContain("PATCHED True");
    expect(r.out).toContain("OWM_ID 501");
    expect(r.out).toContain("GEO 10 20");
  });

  it("gives python-requests a non-generic User-Agent (MET Norway 403s the default)", () => {
    const r = runPy(
      [
        "import pypkjs.javascript.xhr",
        "import requests",
        "seen = {}",
        "import pebble_studio_sim as m",
        "orig = m._ORIG_SEND",
        "def fake(self, req, **kw):",
        "    seen['ua'] = req.headers.get('User-Agent')",
        "    raise requests.exceptions.ConnectionError('stop')",
        "m._ORIG_SEND = fake",
        "s = requests.Session()",
        "try:",
        "    s.send(s.prepare_request(requests.Request('GET', 'https://api.met.no/x')))",
        "except requests.exceptions.ConnectionError:",
        "    pass",
        "print('UA', seen.get('ua'))",
        "s2 = requests.Session()",
        "try:",
        "    s2.send(s2.prepare_request(requests.Request('GET', 'https://api.met.no/x', headers={'User-Agent': 'MyFace/1.0'})))",
        "except requests.exceptions.ConnectionError:",
        "    pass",
        "print('UA2', seen.get('ua'))",
      ].join("\n"),
      { enabled: false },
    );
    expect(r.out).toMatch(/UA PebbleStudio\//);
    expect(r.out).toContain("UA2 MyFace/1.0");
  });
});
