import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { getSessionBundle } from './admin.js';
import { cached } from './cache.js';

// Live player: the product's own Remotion composition (wixel-video-player, vendored by
// `npm run build:player`) plays the finished ad with text, captions and music, exactly as the
// product would.

const VENDOR = path.join(config.cacheDir, 'vendor');
const require = createRequire(import.meta.url);

let buildProps;
function converter() {
  if (!buildProps) {
    try {
      buildProps = require(path.join(VENDOR, 'build-player-props.cjs')).buildPlayerPropsFromSnapshot;
    } catch {
      throw Object.assign(new Error('Live player not built. Run `npm run build:player`.'), { status: 503 });
    }
  }
  return buildProps;
}

// project-assets → the `GetVideoPlayerInputV2` snapshot shape the player's transform expects.
export function snapshotFromAssets(assets, rootId) {
  const list = Array.isArray(assets?.assets) ? assets.assets : [];
  const root = list.find((a) => a.id === (rootId || assets?.rootAssetId)) || list.find((a) => a.type === 'VIDEO' && !a.parentId);
  if (!root) return null;
  const strip = ({ components, ...asset }) => asset;
  const children = list
    .filter((a) => a.parentId === root.id)
    .sort((a, b) => (a.layout?.order?.indexInParent ?? 0) - (b.layout?.order?.indexInParent ?? 0))
    .map((a) => ({ asset: strip(a), components: a.components || [] }));
  return { root_asset: strip(root), root_components: root.components || [], children };
}

export async function playerInput(sessionId, rootId) {
  const bundle = await getSessionBundle(sessionId);
  const snapshot = snapshotFromAssets(bundle.assets, rootId);
  if (!snapshot) throw Object.assign(new Error('No finished video asset in this run'), { status: 404 });
  return converter()(snapshot);
}

// Same-origin pass-through for the Module Federation bundle list (the browser can't call
// manage.wix.com directly from localhost because of CORS). Public data; cached an hour.
export function bundleList(search) {
  return cached('bundles', search.replace(/[^\w-]/g, '').slice(0, 180), 3600000, async () => {
    const res = await fetch(`https://manage.wix.com/_api/wixel-viewer-bundle-server/bundles${search}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw Object.assign(new Error(`bundle server ${res.status}`), { status: 502 });
    return { value: await res.json(), ttlMs: 3600000 };
  });
}

export async function playerScript() {
  return fs.readFile(path.join(VENDOR, 'iframe-bootstrap.js'));
}
