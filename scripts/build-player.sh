#!/bin/sh
# Builds the product's own Remotion player (wixel-video-client/packages/wixel-video-player) and
# vendors two artifacts into .cache/vendor (gitignored — Wix code stays out of this repo):
#   iframe-bootstrap.js      the standalone player, served to the live-player iframe
#   build-player-props.cjs   buildPlayerPropsFromSnapshot, run by the proxy to build the player input
set -e
CLIENT=${WIXEL_VIDEO_CLIENT:-/Users/odedgr/dev/wixel-video-client}
PKG="$CLIENT/packages/wixel-video-player"
OUT="$(cd "$(dirname "$0")/.." && pwd)/.cache/vendor"
mkdir -p "$OUT"
(cd "$PKG" && npx tsup >/dev/null)
cp "$PKG/dist/iframe-bootstrap.js" "$OUT/iframe-bootstrap.js"
"$CLIENT/node_modules/.bin/esbuild" "$PKG/src/buildPlayerPropsFromSnapshot.ts" \
  --bundle --platform=node --format=cjs --target=node18 --log-level=warning \
  --outfile="$OUT/build-player-props.cjs"
echo "player vendored from $(git -C "$CLIENT" rev-parse --abbrev-ref HEAD)@$(git -C "$CLIENT" rev-parse --short HEAD) into $OUT"
