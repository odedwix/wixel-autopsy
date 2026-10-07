#!/bin/zsh
# Run the daily build every morning, even when Autopsy isn't open (macOS LaunchAgent): every
# skill's runs into DATA_DIR, then Fleet's day files and knowledge/. One machine doing this is
# enough: everyone else reads the result with `npm run shared` (AUTOPSY_SNAPSHOT=1).
# It replaces the Fleet-only nightly (npm run fleet:nightly), which this covers.
#
#   npm run build:data:nightly              # install (runs daily at 05:30 local time)
#   npm run build:data:nightly -- --remove  # uninstall
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.wix.autopsy.data"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

if [[ "$1" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed the nightly daily build."
  exit 0
fi

FLEET_PLIST="$HOME/Library/LaunchAgents/com.wix.autopsy.fleet.plist"
if [[ -f "$FLEET_PLIST" ]]; then
  launchctl bootout "gui/$(id -u)/com.wix.autopsy.fleet" 2>/dev/null || true
  rm -f "$FLEET_PLIST"
  echo "Removed the Fleet-only nightly (the daily build includes Fleet)."
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.cache"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-c</string><string>"$NODE" "$ROOT/scripts/build-data.js" --days 30 &amp;&amp; "$NODE" "$ROOT/scripts/fleet-snapshot.js"</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$ROOT/.cache/data-nightly.log</string>
  <key>StandardErrorPath</key><string>$ROOT/.cache/data-nightly.log</string>
</dict>
</plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || { launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
echo "Installed: the daily build runs every day at 05:30 (log: .cache/data-nightly.log)."
echo "It needs the Wix network (office or VPN) at that time; a missed day is picked up the next run."
