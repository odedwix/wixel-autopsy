#!/bin/zsh
# Build the Fleet's daily rollups every morning, even when Autopsy isn't open (macOS LaunchAgent).
# One machine doing this is enough for a team: point everyone's FLEET_DIR at the same shared folder
# and set FLEET_READONLY=1 on the others, so Trino sees one producer instead of N.
#
#   npm run fleet:nightly              # install (runs daily at 06:15 local time)
#   npm run fleet:nightly -- --remove  # uninstall
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.wix.autopsy.fleet"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

if [[ "$1" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed the nightly Fleet build."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.cache"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-c</string><string>"$NODE" "$ROOT/scripts/fleet-rollup.js" --days 30 &amp;&amp; "$NODE" "$ROOT/scripts/fleet-snapshot.js"</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$ROOT/.cache/fleet-nightly.log</string>
  <key>StandardErrorPath</key><string>$ROOT/.cache/fleet-nightly.log</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed: the Fleet builds the last 30 days every day at 06:15 and refreshes knowledge/ (log: .cache/fleet-nightly.log). Commit .fleet/ and knowledge/ when you want them shared."
echo "It needs the Wix network (office or VPN) at that time; a missed day is picked up the next run."
