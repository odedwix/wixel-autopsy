#!/bin/zsh
# Builds "Autopsy.app" on the Desktop: double-click restarts the app and opens it.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Desktop/Autopsy.app"
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
# Recent macOS takes an applet's icon from its asset catalog (Assets.car via CFBundleIconName),
# which would override applet.icns — drop both so our icon is used.
rm -f "$APP/Contents/Resources/Assets.car"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
# Editing the bundle breaks its ad-hoc signature; re-sign, then make Finder/Dock re-read it.
codesign --force --deep -s - "$APP" 2>/dev/null
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
rm -rf "$TMP"
echo "Created $APP"
