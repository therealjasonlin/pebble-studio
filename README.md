# Pebble Studio

A modern desktop GUI for the [`qemu-pebble`](https://github.com/pebble/qemu) emulator. Pebble Studio lets you boot Pebble smartwatch firmware on your computer, drive it with on-screen and keyboard buttons, control the watch's clock, and capture screenshots and GIFs — all from a clean Electron app, with no command line required.

> **Unofficial project.** Pebble Studio is a community tool and is not affiliated with, endorsed by, or supported by Pebble, Core Devices, or Google. "Pebble" is used here only to describe compatibility.

## Features

- **One-click emulator** — pick a watch model and launch; the emulator display is embedded directly in the window.
- **Time control** — set a custom date/time, freeze the clock, or run it at an accelerated rate (2×, 4×, 10×) to test time-dependent watchfaces and apps.
- **Capture** — save PNG screenshots and animated GIFs of the running watch.
- **Full input** — on-screen Back / Up / Select / Down buttons plus keyboard shortcuts, with visual feedback on every press; touch input on models that support it.
- **Multiple watch models** — aplite, basalt, chalk, diorite, and the newer emery (Pebble Time 2), gabbro (Pebble Round 2), and flint (Pebble 2 Duo).

## Supported platforms

The app is built and packaged for **Windows** as a self-contained bundle (it ships its own emulator, Python runtime, and SDK as release assets, so no separate install is needed). The codebase is cross-platform Electron/TypeScript; other platforms can be built from source but are not currently packaged.

**macOS** runs from source against a locally installed [`pebble-tool`](https://github.com/coredevices/pebble-tool) (e.g. `uv tool install pebble-tool`) with an SDK installed (`pebble sdk install latest`). The app auto-detects the native toolchain — its `qemu-pebble` under `~/Library/Application Support/Pebble SDK` — and drives the emulator directly; no WSL or bundled runtime is used. Custom date / freeze / time-rate work on macOS via a `DYLD_INSERT_LIBRARIES` time-shim — the macOS analog of the Linux `LD_PRELOAD` shim, a small dylib compiled from source (universal arm64+x86_64, ad-hoc signed) during `npm run build` and force-loaded into `qemu-pebble`. This requires the Xcode Command Line Tools (`xcode-select --install`); without them the shim can't be built and time falls back to the host clock with timezone offset.

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
npm test           # run the vitest suite
npm run typecheck  # TypeScript type-check (main + renderer)
npm run dev        # Vite dev server for the renderer
npm run dist       # produce a packaged Windows build (npm run dist)
```

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
