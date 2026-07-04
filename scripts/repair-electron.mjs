// Repair an incomplete Electron install (postinstall). Electron 33 bundles
// @electron/get@2.0.3 → extract-zip@2.0.1, which silently truncates the darwin
// zip under current Node (the extraction promise resolves after the first
// sizeable file, so dist/ ends up with ~3 of ~255 files and no path.txt — yet
// `npm install` still exits 0). The runtime itself is fine; only the JS unzip is.
//
// This script re-extracts the SAME (already-downloaded, checksum-verified) zip
// with the platform's native tool — ditto (macOS), unzip (Linux), PowerShell
// Expand-Archive (Windows, matching scripts/build-pebble-py.ps1's toolchain) —
// then writes the path.txt marker electron/index.js reads. It mirrors electron's
// own install.js conventions (getPlatformPath / isInstalled / d.ts hoist).
//
// GUARD: symptom-gated, NOT platform-gated. It runs on every `npm install` but
// its first act is a health check identical to install.js's isInstalled(); on a
// working install (e.g. the upstream Windows .exe build) it reads two files, sees
// everything in place, and exits doing NOTHING. It only extracts when Electron is
// provably broken — which is the current Node case regardless of OS.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const TAG = "[repair-electron]";

/**
 * Relative path to the Electron launcher inside dist/, per platform. This is
 * also the exact string path.txt must contain. Mirrors electron install.js
 * getPlatformPath(). Pure.
 */
export function electronBinaryRelPath(platform = process.platform) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`${TAG} unsupported platform: ${platform}`);
  }
}

/** Single-quote a string for a PowerShell -Command literal (doubles embedded '). */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Native, dependency-free extraction command for the platform — the whole point
 * is to bypass extract-zip. Returns { cmd, args } for execFileSync. Pure.
 *
 * - macOS: `ditto -x -k` preserves the framework symlinks + code signatures.
 * - Linux/BSD: `unzip -o -q` (overwrite into a freshly-cleared dir).
 * - Windows: PowerShell `Expand-Archive -Force` (built in on all supported Windows).
 */
export function extractionPlan(platform, zipPath, destDir) {
  switch (platform) {
    case "mas":
    case "darwin":
      return { cmd: "ditto", args: ["-x", "-k", zipPath, destDir] };
    case "linux":
    case "freebsd":
    case "openbsd":
      return { cmd: "unzip", args: ["-o", "-q", zipPath, "-d", destDir] };
    case "win32":
      return {
        cmd: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`,
        ],
      };
    default:
      throw new Error(`${TAG} unsupported platform: ${platform}`);
  }
}

/**
 * Mirror of electron install.js isInstalled(): true only when dist/version
 * matches, path.txt matches the expected launcher path, and the launcher exists.
 * Leading `v` on either version string is tolerated. Injectable fs for tests;
 * any read failure (missing marker) reads as "not healthy". Pure given deps.
 */
export function isElectronHealthy({
  distDir,
  pathTxt,
  versionFile,
  expectedVersion,
  binaryRelPath,
  exists = existsSync,
  readText = (p) => readFileSync(p, "utf-8"),
}) {
  const strip = (v) => String(v).trim().replace(/^v/, "");
  try {
    if (strip(readText(versionFile)) !== strip(expectedVersion)) return false;
    if (readText(pathTxt) !== binaryRelPath) return false;
  } catch {
    return false;
  }
  return exists(path.join(distDir, binaryRelPath));
}

async function main() {
  // install.js honours this to skip the binary entirely; so must we, or we'd
  // "repair" an install the user deliberately opted out of.
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log(`${TAG} skipped (ELECTRON_SKIP_BINARY_DOWNLOAD set)`);
    return;
  }

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const electronDir = path.join(root, "node_modules", "electron");
  if (!existsSync(electronDir)) {
    console.log(`${TAG} skipped (electron not installed)`);
    return;
  }

  const version = JSON.parse(readFileSync(path.join(electronDir, "package.json"), "utf-8")).version;
  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const binaryRelPath = electronBinaryRelPath(platform);
  const distDir = path.join(electronDir, "dist");
  const pathTxt = path.join(electronDir, "path.txt");
  const versionFile = path.join(distDir, "version");

  if (isElectronHealthy({ distDir, pathTxt, versionFile, expectedVersion: version, binaryRelPath })) {
    console.log(`${TAG} ok — Electron ${version} already installed correctly (no action)`);
    return;
  }

  console.log(`${TAG} Electron ${version} install is incomplete — re-extracting with native tooling…`);

  // 1) Obtain the zip via electron's OWN downloader (returns the cached copy if
  //    present, downloads + checksum-verifies otherwise). No re-`npm install`
  //    needed — that would just re-trigger the broken extract-zip path.
  const { downloadArtifact } = await import("@electron/get");
  let checksums;
  try {
    checksums = JSON.parse(readFileSync(path.join(electronDir, "checksums.json"), "utf-8"));
  } catch {
    checksums = undefined; // fall back to remote checksums
  }
  const zipPath = await downloadArtifact({ version, artifactName: "electron", platform, arch, checksums });

  // 2) Clear the truncated dist/ and re-extract natively.
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  const { cmd, args } = extractionPlan(platform, zipPath, distDir);
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  } catch (err) {
    console.error(`${TAG} extraction via '${cmd}' failed: ${err.message}`);
    process.exit(1);
  }

  // 3) Mirror install.js: hoist the type defs if present, then write path.txt.
  const srcDts = path.join(distDir, "electron.d.ts");
  if (existsSync(srcDts)) renameSync(srcDts, path.join(electronDir, "electron.d.ts"));
  writeFileSync(pathTxt, binaryRelPath);

  // 4) Verify the repair actually produced a launcher.
  if (!existsSync(path.join(distDir, binaryRelPath))) {
    console.error(`${TAG} repair failed: ${binaryRelPath} still missing after extraction`);
    process.exit(1);
  }
  console.log(`${TAG} repaired — Electron ${version} extracted with native tooling`);
}

// Run only when invoked directly (postinstall), so tests can import the pure
// helpers without triggering the download/extract side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`${TAG} ${err?.stack || err}`);
    process.exit(1);
  });
}
