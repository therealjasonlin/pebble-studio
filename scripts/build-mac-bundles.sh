#!/bin/bash
set -e

REPO=$(pwd)
WORK="/tmp/pebble-py-build-mac"
mkdir -p "$WORK"

PBS_TAG="20260610"
PY_VER="3.12.13"

# Detect Mac architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    ASSET="cpython-$PY_VER+$PBS_TAG-aarch64-apple-darwin-install_only.tar.gz"
else
    ASSET="cpython-$PY_VER+$PBS_TAG-x86_64-apple-darwin-install_only.tar.gz"
fi

URL="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/$ASSET"
TGZ="$WORK/pbs.tar.gz"

echo "Downloading $ASSET ..."
curl -L -o "$TGZ" "$URL"

PY_DIR="$WORK/python"
rm -rf "$PY_DIR"
echo "Extracting ..."
tar -xzf "$TGZ" -C "$WORK"

PYEXE="$PY_DIR/bin/python3"
echo "Installing pebble-tool ..."
"$PYEXE" -m pip install --no-warn-script-location pebble-tool==5.0.37

echo "Applying patches ..."
SP_DIR=$("$PYEXE" -c 'import site; print(site.getsitepackages()[0])')
"$PYEXE" scripts/apply-pebble-tool-patches.py "$SP_DIR"

echo "Pruning ..."
find "$PY_DIR" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
rm -rf "$PY_DIR/lib/python3.12/test" || true

echo "Self-test ..."
"$PYEXE" -c "from pebble_tool import run_tool; run_tool()" --version

DEST="$REPO/vendor/pebble-py-mac"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$PY_DIR" "$DEST"
echo "pebble-py bundle ready at $DEST"

echo "Bundling QEMU ..."
QEMU_DEST="$REPO/vendor/qemu-pebble-mac"
rm -rf "$QEMU_DEST"
mkdir -p "$QEMU_DEST/pc-bios"
if [ -f "$HOME/.pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble" ]; then
    cp "$HOME/.pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble" "$QEMU_DEST/"
    # QEMU needs pc-bios for keymaps
    if [ -d "$HOME/.pebble-sdk/SDKs/current/toolchain/lib/pc-bios" ]; then
        cp -r "$HOME/.pebble-sdk/SDKs/current/toolchain/lib/pc-bios" "$QEMU_DEST/"
    elif [ -d "$HOME/.pebble-sdk/SDKs/current/toolchain/share/qemu" ]; then
        cp -r "$HOME/.pebble-sdk/SDKs/current/toolchain/share/qemu" "$QEMU_DEST/pc-bios"
    fi
    echo "qemu-pebble bundle ready at $QEMU_DEST"
else
    echo "WARNING: qemu-pebble not found in ~/.pebble-sdk/SDKs/current/toolchain/bin/"
    echo "Please ensure the SDK is installed on this Mac before running this script."
fi

echo "Bundling SDK Core (if needed) ..."
SDK_DEST="$REPO/vendor/pebble-sdk"
if [ ! -d "$SDK_DEST" ]; then
    if [ -L "$HOME/.pebble-sdk/SDKs/current" ]; then
        # On macOS, readlink -f might not be available, so we use Python to resolve
        SDK_REALPATH=$(python3 -c "import os; print(os.path.realpath('$HOME/.pebble-sdk/SDKs/current'))")
        SDK_VER=$(basename "$SDK_REALPATH")
        mkdir -p "$SDK_DEST/SDKs/$SDK_VER"
        cp -r "$SDK_REALPATH/sdk-core" "$SDK_DEST/SDKs/$SDK_VER/"
        echo "pebble-sdk bundle ready at $SDK_DEST"
    else
        echo "WARNING: SDK current link not found in ~/.pebble-sdk/"
    fi
else
    echo "pebble-sdk bundle already exists at $SDK_DEST"
fi
