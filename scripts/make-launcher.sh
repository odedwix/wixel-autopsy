#!/bin/zsh
# Builds "Skill Runs.app" on the Desktop: double-click restarts the app and opens it.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Desktop/Skill Runs.app"
TMP="$(mktemp -d)"

osacompile -o "$APP" -e "do shell script \"/bin/zsh -lc '$ROOT/scripts/launch.sh'\""

# Icon: dark rounded tile, film frame + play mark in the app's accent colour.
/usr/bin/env python3 - "$TMP/icon.png" <<'PY'
import sys
from PIL import Image, ImageDraw
S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([64, 64, S - 64, S - 64], radius=200, fill=(21, 23, 26, 255))
d.rounded_rectangle([64, 64, S - 64, S - 64], radius=200, outline=(52, 57, 65, 255), width=6)
acc = (139, 123, 255, 255)
d.rounded_rectangle([232, 272, 792, 752], radius=48, outline=acc, width=36)
for x in (300, 724):
    for y in (330, 440, 550, 660):
        d.rounded_rectangle([x - 22, y - 20, x + 22, y + 20], radius=8, fill=acc)
d.polygon([(452, 402), (452, 622), (632, 512)], fill=(233, 235, 238, 255))
img.save(sys.argv[1])
PY

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
