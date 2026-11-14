#!/bin/sh
set -eu
NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$NATIVE_DIR/bin" "$NATIVE_DIR/.build/module-cache"
FLMOUSE_TEMP=$(mktemp "$NATIVE_DIR/bin/.flmouse.XXXXXX")
trap 'rm -f "$FLMOUSE_TEMP"' EXIT HUP INT TERM
swiftc -O -module-cache-path "$NATIVE_DIR/.build/module-cache" \
  -framework AppKit -framework CoreGraphics -framework ApplicationServices \
  "$NATIVE_DIR/flmouse.swift" -o "$FLMOUSE_TEMP"
mv -f "$FLMOUSE_TEMP" "$NATIVE_DIR/bin/flmouse"
echo 'Built native/bin/flmouse'
