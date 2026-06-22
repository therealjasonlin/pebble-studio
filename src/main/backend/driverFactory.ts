export type DriverKind = "native" | "wsl" | "bundled-native";

export interface ProbeResult {
  platform: NodeJS.Platform;
  nativePebbleOnPath: boolean;
  nativeQemuOnPath: boolean;
  wslAvailable: boolean;
  override?: DriverKind;
}

export function selectDriverKind(p: ProbeResult): DriverKind {
  const winToolsPresent = p.nativePebbleOnPath && p.nativeQemuOnPath;

  if (p.override) {
    if (p.override === "native" && !winToolsPresent)
      throw new Error("Override 'native' requested but native tools not found");
    if (p.override === "bundled-native" && !winToolsPresent)
      throw new Error("Override 'bundled-native' requested but native tools not found");
    if (p.override === "wsl" && !p.wslAvailable)
      throw new Error("Override 'wsl' requested but WSL not available");
    return p.override;
  }

  // Prefer the native bundled path when the bundled tools resolve.
  if (p.nativePebbleOnPath && p.nativeQemuOnPath) return "bundled-native";
  // Non-bundled native (Linux/macOS dev) fallback.
  if (p.platform !== "win32" && (p.nativePebbleOnPath || p.nativeQemuOnPath)) return "native";
  // Windows without native tools: fall back to WSL (the v1.0.0 default).
  if (p.wslAvailable) return "wsl";
  throw new Error("No usable emulator backend: install the Pebble SDK natively or enable WSL");
}
