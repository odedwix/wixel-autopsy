#!/bin/sh
# Builds the product's own Remotion player (wixel-video-client/packages/wixel-video-player) and
# vendors two artifacts into .cache/vendor (gitignored — Wix code stays out of this repo):
#   iframe-bootstrap.js      the standalone player, served to the live-player iframe
#   build-player-props.cjs   buildPlayerPropsFromSnapshot, run by the proxy to build the player input
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# WIXEL_VIDEO_CLIENT from the environment or .env, default ~/dev/wixel-video-client
[ -z "$WIXEL_VIDEO_CLIENT" ] && [ -f "$ROOT/.env" ] && WIXEL_VIDEO_CLIENT=$(grep -E '^WIXEL_VIDEO_CLIENT=' "$ROOT/.env" | cut -d= -f2-)
CLIENT=${WIXEL_VIDEO_CLIENT:-$HOME/dev/wixel-video-client}
if [ ! -d "$CLIENT/packages/wixel-video-player" ]; then
  echo "No wixel-video-client checkout at $CLIENT — the exact live player stays off (everything else works)."
  echo "Clone wix-private/wixel-video-client there (and install it), or set WIXEL_VIDEO_CLIENT in .env."
  exit 0
fi
PKG="$CLIENT/packages/wixel-video-player"
OUT="$ROOT/.cache/vendor"
mkdir -p "$OUT"
(cd "$PKG" && npx tsup >/dev/null)
cp "$PKG/dist/iframe-bootstrap.js" "$OUT/iframe-bootstrap.js"
"$CLIENT/node_modules/.bin/esbuild" "$PKG/src/buildPlayerPropsFromSnapshot.ts" \
  --bundle --platform=node --format=cjs --target=node18 --log-level=warning \
  --outfile="$OUT/build-player-props.cjs"
echo "player vendored from $(git -C "$CLIENT" rev-parse --abbrev-ref HEAD)@$(git -C "$CLIENT" rev-parse --short HEAD) into $OUT"
