#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "Pebble Studio simulated-geolocation patch";

function log(message) {
  console.log(`[macos-geolocation] ${message}`);
}

function warn(message) {
  console.warn(`[macos-geolocation] ${message}`);
}

if (process.platform !== "darwin") {
  log("skipped (macOS only)");
  process.exit(0);
}

try {
  const pebble = execFileSync("which", ["pebble"], { encoding: "utf8" }).trim();
  if (!pebble) {
    warn("pebble command was not found; install Pebble Tool and rerun npm install");
    process.exit(0);
  }

  const firstLine = readFileSync(pebble, "utf8").split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith("#!")) {
    warn(`cannot determine Pebble Tool Python interpreter from ${pebble}`);
    process.exit(0);
  }

  let shebang = firstLine.slice(2).trim();
  let pythonExe;
  if (shebang.startsWith("/usr/bin/env ")) {
    pythonExe = shebang.slice("/usr/bin/env ".length).trim().split(/\s+/)[0];
  } else {
    pythonExe = shebang.split(/\s+/)[0];
  }

  const purelib = execFileSync(
    pythonExe,
    ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
    { encoding: "utf8" },
  ).trim();

  const target = join(
    purelib,
    "pypkjs",
    "javascript",
    "navigator",
    "geolocation.py",
  );

  if (!existsSync(target)) {
    warn(`pypkjs geolocation module was not found at ${target}`);
    process.exit(0);
  }

  let source = readFileSync(target, "utf8");
  if (source.includes(MARKER)) {
    log("already applied");
    process.exit(0);
  }

  if (!/^import json$/m.test(source)) source = `import json\n${source}`;
  if (!/^import os$/m.test(source)) source = `import os\n${source}`;

  const replacement = `    def _get_position(self, success, failure):
        # ${MARKER}: prefer Pebble Studio's configured simulator location.
        try:
            sim_path = os.path.expanduser(
                "~/Library/Application Support/pebble-studio/pebble-data/sim-env.json"
            )

            if os.path.exists(sim_path):
                with open(sim_path, "r", encoding="utf-8") as sim_file:
                    sim_config = json.load(sim_file)

                if sim_config.get("enabled"):
                    location = sim_config.get("location", {})
                    latitude = float(location["lat"])
                    longitude = float(location["lon"])
                    self.runtime.enqueue(
                        success,
                        Position(
                            self.runtime,
                            Coordinates(self.runtime, longitude, latitude, 10),
                            round(time.time() * 1000),
                        ),
                    )
                    return

            # Simulation is disabled or unavailable: preserve the original
            # approximate IP-geolocation behavior.
            resp = requests.get("https://api.ipify.org", timeout=10)
            resp.raise_for_status()
            ip = resp.text.strip()
            gi = pygeoip.GeoIP("%s/GeoLiteCity.dat" % os.path.dirname(__file__))
            record = gi.record_by_addr(ip)

            if record is None:
                if callable(failure):
                    self.runtime.enqueue(failure)
                return

            self.runtime.enqueue(
                success,
                Position(
                    self.runtime,
                    Coordinates(
                        self.runtime,
                        record["longitude"],
                        record["latitude"],
                        1000,
                    ),
                    round(time.time() * 1000),
                ),
            )
        except (
            OSError,
            ValueError,
            KeyError,
            json.JSONDecodeError,
            requests.RequestException,
            pygeoip.GeoIPError,
        ):
            if callable(failure):
                self.runtime.enqueue(failure)

`;

  const methodPattern = /    def _get_position\(self, success, failure\):\n[\s\S]*?(?=    def _enabled\(self\):)/;
  if (!methodPattern.test(source)) {
    warn("could not find Geolocation._get_position; Pebble Tool may have changed");
    process.exit(0);
  }

  const backup = `${target}.pebble-studio-backup`;
  if (!existsSync(backup)) copyFileSync(target, backup);

  source = source.replace(methodPattern, replacement);
  writeFileSync(target, source, "utf8");

  execFileSync(pythonExe, ["-m", "py_compile", target], { stdio: "pipe" });
  log(`applied to ${target}`);
} catch (error) {
  // Do not make npm install unusable when Pebble Tool is absent or has an
  // unexpected layout. The warning tells the developer how to retry later.
  warn(error instanceof Error ? error.message : String(error));
  process.exit(0);
}
