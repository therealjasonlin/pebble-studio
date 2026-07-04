// Build the macOS DYLD time-shim from source. Compile-from-source is the ONLY
// path — the .dylib/probe are never committed or packaged (.gitignored); they are
// regenerated here as part of `npm run build`. No-op off macOS, so Windows/Linux
// packaging (`npm run dist --win`, etc.) is unaffected.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TAG = "[build-timeshim-mac]";

if (process.platform !== "darwin") {
  console.log(`${TAG} skipped (not macOS)`);
  process.exit(0);
}

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const dir = path.join(root, "vendor/timeshim-mac");
const dylibSrc = path.join(dir, "timeshim.c");
const dylibOut = path.join(dir, "timeshim.dylib");
const probeSrc = path.join(dir, "probe.c");
const probeOut = path.join(dir, "probe");

for (const src of [dylibSrc, probeSrc]) {
  if (!existsSync(src)) {
    console.error(`${TAG} source not found: ${src}`);
    process.exit(1);
  }
}

// Fail early with an actionable message if the toolchain is missing. Both are part
// of the Xcode Command Line Tools; clang compiles, codesign ad-hoc signs (mandatory
// on Apple Silicon or the inserted dylib / probe won't load).
function toolExists(name) {
  try {
    execFileSync("/usr/bin/which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

for (const tool of ["clang", "codesign"]) {
  if (!toolExists(tool)) {
    console.error(
      `${TAG} required tool '${tool}' not found.\n` +
        `${TAG} Xcode Command Line Tools required: xcode-select --install`,
    );
    process.exit(1);
  }
}

// Universal (arm64 + x86_64) so the same artifact runs on Apple Silicon and Intel.
function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  } catch (err) {
    console.error(`${TAG} ${cmd} failed: ${err.message}`);
    process.exit(1);
  }
}

run("clang", [
  "-dynamiclib",
  "-arch", "arm64",
  "-arch", "x86_64",
  "-O2",
  "-o", dylibOut,
  dylibSrc,
]);

run("clang", [
  "-arch", "arm64",
  "-arch", "x86_64",
  "-O2",
  "-o", probeOut,
  probeSrc,
]);

// Ad-hoc sign both (-s - = adhoc, --force = replace any signature from compilation).
run("codesign", ["-s", "-", "--force", dylibOut]);
run("codesign", ["-s", "-", "--force", probeOut]);

console.log(`${TAG} built ${path.relative(root, dylibOut)} + ${path.relative(root, probeOut)} (arm64+x86_64, ad-hoc signed)`);
