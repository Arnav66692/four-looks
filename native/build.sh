#!/bin/sh
set -eu
NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$NATIVE_DIR/bin" "$NATIVE_DIR/.build/module-cache"
swiftc -O -module-cache-path "$NATIVE_DIR/.build/module-cache" \
  -framework CoreGraphics -framework ApplicationServices \
  "$NATIVE_DIR/flmouse.swift" -o "$NATIVE_DIR/bin/flmouse"
echo 'Built native/bin/flmouse'
