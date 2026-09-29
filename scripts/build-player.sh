#!/bin/sh
# Builds the product's own Remotion player (wixel-video-client/packages/wixel-video-player) and
# vendors two artifacts into .cache/vendor (gitignored — Wix code stays out of this repo):
#   iframe-bootstrap.js      the standalone player, served to the live-player iframe
#   build-player-props.cjs   buildPlayerPropsFromSnapshot, run by the proxy to build the player input
#   capture-bootstrap.js     the player with a frame-by-frame handle, for saving the Exact composition
#   fonts.json               the platform font stylesheets both players load first
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
# The platform font stylesheets the product loads before any text renders (RemotionRoot.tsx does
# the same) — without them the players fall back to system fonts. From the installed fonts-data.
(cd "$CLIENT" && node -e 'const m=require("@wix/fonts-data");process.stdout.write(JSON.stringify([m.fontsCssFileUrl,m.wixMadeforFontsUrl,m.googleFonts,m.helveticaCssUrl].filter(Boolean)))') > "$OUT/fonts.json" || echo '[]' > "$OUT/fonts.json"

# The capture bundle (Exact composition → mp4): our entry, the package's own iframe bundle config.
BUILD="$ROOT/.cache/player-build"
mkdir -p "$BUILD"
# The config imports tsup and the package's config; resolve both from the client's node_modules.
ln -sfn "$CLIENT/node_modules" "$BUILD/node_modules"
cat > "$BUILD/tsup.capture.config.ts" <<CFG
import all from '$PKG/tsup.config';
const base: any = (Array.isArray(all) ? all : [all]).find((c: any) => c.globalName === 'WixelPlayerFrameBootstrap');
export default {
  ...base,
  entry: { 'capture-bootstrap': '$ROOT/scripts/player/capture-entry.tsx' },
  outDir: '$OUT',
  globalName: 'AutopsyCaptureBootstrap',
  sourcemap: false,
  esbuildOptions(opts: any, ctx: any) {
    base.esbuildOptions?.(opts, ctx);
    opts.alias = { ...(opts.alias || {}), '@wixel-player-src': '$PKG/src' };
    opts.nodePaths = ['$PKG/node_modules', '$CLIENT/node_modules'];
  },
};
CFG
(cd "$PKG" && npx tsup --config "$BUILD/tsup.capture.config.ts" >/dev/null) && echo "capture bundle built" || echo "capture bundle failed — Exact downloads stay off (the live player still works)"
echo "player vendored from $(git -C "$CLIENT" rev-parse --abbrev-ref HEAD)@$(git -C "$CLIENT" rev-parse --short HEAD) into $OUT"
