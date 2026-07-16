# Pebble Studio

A modern desktop GUI for the [`qemu-pebble`](https://github.com/pebble/qemu) emulator. Pebble Studio lets you boot Pebble smartwatch firmware on your computer, drive it with on-screen and keyboard buttons, control the watch's clock, and capture screenshots and GIFs — all from a clean Electron app, with no command line required.

> **Unofficial project.** Pebble Studio is a community tool and is not affiliated with, endorsed by, or supported by Pebble, Core Devices, or Google. "Pebble" is used here only to describe compatibility.

## Features

- **One-click emulator** — pick a watch model and launch; the emulator display is embedded directly in the window.
- **Time control** — set a custom date/time, freeze the clock, or run it at an accelerated rate (2×, 4×, 10×) to test time-dependent watchfaces and apps.
- **Simulated location and weather** — choose presets or custom coordinates, weather conditions, temperature, and day/night values for watchfaces and apps that use phone-side geolocation or weather data.
- **Capture** — save PNG screenshots and animated GIFs of the running watch.
- **Full input** — on-screen Back / Up / Select / Down buttons plus keyboard shortcuts, with visual feedback on every press; touch input on models that support it.
- **Multiple watch models** — aplite, basalt, chalk, diorite, and the newer emery (Pebble Time 2), gabbro (Pebble Round 2), and flint (Pebble 2 Duo).

## Supported platforms

The app is built and packaged for **Windows** as a self-contained bundle (it ships its own emulator, Python runtime, and SDK as release assets, so no separate install is needed). A single download runs on both **Intel/AMD (x64)** and **Windows-on-ARM (ARM64)** PCs — on an ARM machine it automatically uses a native-ARM build of the emulator engine, so no separate ARM download is required. The codebase is cross-platform Electron/TypeScript; other platforms can be built from source but are not currently packaged.

## Install

Download the latest packaged build from the [Releases](../../releases) page, unzip it, and run `Pebble Studio.exe`. No installer or admin rights required.

## Build from source

Requires [Node.js](https://nodejs.org/) 20+.

```bash
npm install
npm run build      # build main + renderer
npm start          # launch the app
```

Other useful scripts:

```bash
npm test                           # run the vitest suite
npm run typecheck                  # TypeScript type-check (main + renderer)
npm run dev                        # Vite dev server for the renderer
npm run dist                       # produce a packaged Windows build
npm run patch:macos-geolocation    # reapply the macOS Pebble Tool location patch
```

### macOS simulated geolocation

When `npm install` runs on macOS, Pebble Studio automatically patches the installed Pebble Tool `pypkjs` geolocation provider so it reads the location configured under **Settings → Simulated location & weather**. When simulation is disabled, Pebble Tool retains its normal IP-based geolocation fallback.

The patch is idempotent, validates the resulting Python file, and saves a backup of the original provider before replacing it. Reinstalling or upgrading Pebble Tool may restore the upstream file; rerun the patch afterward with:

```bash
npm run patch:macos-geolocation
```

If the script cannot find Pebble Tool's Python environment, install or activate Pebble Tool first and rerun the command. The script safely skips this patch on non-macOS systems.

### Runtime bundles

The large runtime components — the patched `qemu-pebble` build, a relocatable Python with the Pebble tooling, and the Pebble SDK — are **not committed** to the repository (they total several hundred MB). They are distributed as release assets and reproduced by the scripts under [`scripts/`](scripts/). The app resolves them from its packaged resources at runtime, or from a local `vendor/` directory during development.

## Project layout

```
src/main      Electron main process — emulator lifecycle, time/SDK backends
src/renderer  UI (display, controls, modals)
src/capture   screenshot / GIF capture
src/shared    shared types and the changelog
tests         vitest unit tests
scripts       build + packaging helpers
```

## Acknowledgements

Pebble Studio stands on the work of the Pebble community: the [`qemu-pebble`](https://github.com/pebble/qemu) emulator, the Pebble SDK and `pebble-tool`, and [PebbleOS](https://github.com/coredevices/PebbleOS). The bundled emulator is itself licensed under the GPL; this repository's own GUI code is MIT-licensed (see below).

## License

[MIT](LICENSE) © 2026 Jason Lin
