import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { PebbleCommand } from "./pebbleCli.js";

declare const __dirname: string;

export interface BundledRuntimeCtx {
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  userDataDir: string;
  platform: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

const SDK_BUNDLE = "pebble-sdk";

function exists(ctx: BundledRuntimeCtx, p: string): boolean {
  return (ctx.exists ?? existsSync)(p);
}

function bundleDir(ctx: BundledRuntimeCtx, name: string, fallback?: string): string {
  if (ctx.packaged) return join(ctx.resourcesPath, name);
  const vendor = join(ctx.repoRoot, "vendor", name);
  if (fallback && !exists(ctx, vendor)) return fallback;
  return vendor;
}

export function getQemuBundleName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "qemu-pebble-win";
  if (platform === "darwin") return "qemu-pebble-mac";
  return "qemu-pebble-linux";
}

export function getPyBundleName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "pebble-py";
  if (platform === "darwin") return "pebble-py-mac";
  return "pebble-py-linux";
}

export function qemuExe(ctx: BundledRuntimeCtx): string {
  const exe = ctx.platform === "win32" ? "qemu-pebble.exe" : "qemu-pebble";
  return join(bundleDir(ctx, getQemuBundleName(ctx.platform)), exe);
}

export function pebblePyDir(ctx: BundledRuntimeCtx): string {
  const fallback = ctx.platform === "win32" ? "C:\\tmp\\pebble-py-build\\python" : undefined;
  return bundleDir(ctx, getPyBundleName(ctx.platform), fallback);
}

export function pebblePyExe(ctx: BundledRuntimeCtx): string {
  const rel = ctx.platform === "win32" ? "python.exe" : "bin/python";
  return join(pebblePyDir(ctx), rel);
}

export function sdkBundleRoot(ctx: BundledRuntimeCtx): string {
  return bundleDir(ctx, SDK_BUNDLE);
}

export function timeShimWinDir(ctx: BundledRuntimeCtx): string {
  return bundleDir(ctx, "timeshim-win");
}

export function bundledToolsPresent(ctx: BundledRuntimeCtx): boolean {
  return exists(ctx, qemuExe(ctx)) && exists(ctx, pebblePyExe(ctx));
}

export function pebbleDataDir(ctx: BundledRuntimeCtx): string {
  return join(ctx.userDataDir, "pebble-data");
}

export function pebbleCmd(args: string[], ctx: BundledRuntimeCtx): PebbleCommand {
  return {
    cmd: pebblePyExe(ctx),
    args: ["-c", "from pebble_tool import run_tool; run_tool()", ...args],
    env: {
      PEBBLE_QEMU_PATH: qemuExe(ctx),
      XDG_DATA_HOME: pebbleDataDir(ctx),
    },
  };
}

export async function defaultCtx(): Promise<BundledRuntimeCtx> {
  const { app } = await import("electron");
  return {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: resolve(__dirname, "..", ".."),
    userDataDir: app.getPath("userData"),
    platform: process.platform,
  };
}
