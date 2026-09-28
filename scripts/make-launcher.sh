#!/bin/zsh
# Builds "Skill Runs.app" on the Desktop: double-click restarts the app and opens it.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Desktop/Skill Runs.app"
TMP="$(mktemp -d)"

osacompile -o "$APP" -e "do shell script \"/bin/zsh -lc '$ROOT/scripts/launch.sh'\""

# Icon: see scripts/make-icon.py (violet tile, 2x2 run cards: video, image, doc, insights).
/usr/bin/env python3 "$ROOT/scripts/make-icon.py" "$TMP/icon.png"

ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
touch "$APP"
rm -rf "$TMP"
echo "Created $APP"
