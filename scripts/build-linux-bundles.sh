#!/bin/bash
set -e

REPO=$(pwd)
WORK="/tmp/pebble-py-build-linux"
mkdir -p "$WORK"

PBS_TAG="20260610"
PY_VER="3.12.13"
ASSET="cpython-$PY_VER+$PBS_TAG-x86_64-unknown-linux-gnu-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/$ASSET"
TGZ="$WORK/pbs.tar.gz"

echo "Downloading $ASSET ..."
curl -L -o "$TGZ" "$URL"

PY_DIR="$WORK/python"
rm -rf "$PY_DIR"
echo "Extracting ..."
tar -xzf "$TGZ" -C "$WORK"

PYEXE="$PY_DIR/bin/python"
echo "Installing pebble-tool ..."
"$PYEXE" -m pip install --no-warn-script-location pebble-tool==5.0.37

echo "Applying patches ..."
# Site-packages location is different on Linux: lib/python3.12/site-packages
SP_DIR=$("$PYEXE" -c 'import site; print(site.getsitepackages()[0])')
"$PYEXE" scripts/apply-pebble-tool-patches.py "$SP_DIR"

echo "Pruning ..."
find "$PY_DIR" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
rm -rf "$PY_DIR/lib/python3.12/test" || true

echo "Self-test ..."
"$PYEXE" -c "from pebble_tool import run_tool; run_tool()" --version

DEST="$REPO/vendor/pebble-py-linux"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$PY_DIR" "$DEST"
echo "pebble-py bundle ready at $DEST"

echo "Bundling QEMU ..."
QEMU_DEST="$REPO/vendor/qemu-pebble-linux"
rm -rf "$QEMU_DEST"
mkdir -p "$QEMU_DEST/pc-bios"
cp "$HOME/.pebble-sdk/SDKs/current/toolchain/bin/qemu-pebble" "$QEMU_DEST/"
# QEMU needs pc-bios for keymaps
if [ -d "$HOME/.pebble-sdk/SDKs/current/toolchain/lib/pc-bios" ]; then
    cp -r "$HOME/.pebble-sdk/SDKs/current/toolchain/lib/pc-bios" "$QEMU_DEST/"
elif [ -d "$HOME/.pebble-sdk/SDKs/current/toolchain/share/qemu" ]; then
    cp -r "$HOME/.pebble-sdk/SDKs/current/toolchain/share/qemu" "$QEMU_DEST/pc-bios"
fi
echo "qemu-pebble bundle ready at $QEMU_DEST"

echo "Bundling SDK Core ..."
SDK_DEST="$REPO/vendor/pebble-sdk"
rm -rf "$SDK_DEST"
# Resolve the 'current' symlink to get the actual version folder
SDK_REALPATH=$(readlink -f "$HOME/.pebble-sdk/SDKs/current")
SDK_VER=$(basename "$SDK_REALPATH")
mkdir -p "$SDK_DEST/SDKs/$SDK_VER"
cp -r "$SDK_REALPATH/sdk-core" "$SDK_DEST/SDKs/$SDK_VER/"
echo "pebble-sdk bundle ready at $SDK_DEST"
