import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { getSessionBundle } from './admin.js';
import { cached } from './cache.js';
import { normalizeSession } from './normalize.js';

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
  if (root.type === 'STORY') return storySnapshot(root, list);
  const strip = ({ components, ...asset }) => asset;
  const children = list
    .filter((a) => a.parentId === root.id)
    .sort((a, b) => (a.layout?.order?.indexInParent ?? 0) - (b.layout?.order?.indexInParent ?? 0))
    .map((a) => ({ asset: strip(a), components: a.components || [] }));
  return { root_asset: strip(root), root_components: root.components || [], children };
}

// A STORY as the video player's input: its visible pages become scenes that each play for the
// page's duration (durationMs, else the root's defaultPageDurationMs, at the player's 24 fps), hard
// cuts. The pages' components (clip, text, image) are the same federated components the player
// already renders for ads; the story's voice-over and music (root externalConfig, in ms) become the
// player's voice-over and music components. Not reproduced: music ducking under the voice, page
// transitions other than cuts, and the story's own caption style.
const TTS_EXT = '7572e63a-bd77-4c6d-9809-e24f1b945c8e';
const MUSIC_EXT = '80e9c773-22c5-43e9-b48c-d72b99431882';
const IMAGE_EXT = '6227e29b-4034-4693-8e65-3ea5af904a83';
function storySnapshot(root, list) {
  const ec = root.externalConfig || {};
  const def = Number(ec.defaultPageDurationMs) || 3000;
  const strip = ({ components, ...asset }) => asset;
  const pages = list.filter((a) => a.parentId === root.id && !a.externalConfig?.hidden)
    .sort((a, b) => (a.layout?.order?.indexInParent ?? 0) - (b.layout?.order?.indexInParent ?? 0));
  // A still page's clip has no source; the story player paints its poster, so here it becomes the
  // story's image component (same box) showing that poster.
  const still = (c) => {
    const pr = c.data?.props || {};
    if (!String(c.data?.extensionId || '').startsWith('bf89429d') || pr.src || !(pr.poster_url || pr.first_frame_image_url)) return c;
    return { ...c, data: { ...c.data, extensionId: IMAGE_EXT, props: { imageUrl: pr.poster_url || pr.first_frame_image_url } } };
  };
  const children = pages.map((p) => ({
    asset: { ...strip(p), type: 'VIDEO', externalConfig: { ...(p.externalConfig || {}), frameDuration: Math.max(1, Math.round((Number(p.externalConfig?.durationMs ?? def) * 24) / 1000)), trim_start: 0, trim_end: 0 } },
    components: (p.components || []).map(still),
  }));
  const fixUrl = (u) => String(u || '').replace(/^https:\/\/wixstatic\.com\//, 'https://static.wixstatic.com/');
  const frames = (ms) => Math.round((Number(ms || 0) * 24) / 1000);
  const comps = [];
  const voices = [...(ec.voiceover?.url ? [ec.voiceover] : []), ...(ec.voiceoverClips || [])].filter((v) => v?.url);
  for (const v of voices) comps.push({ data: { extensionId: TTS_EXT }, externalConfig: { resultUrl: fixUrl(v.url), volume: Number(v.volume ?? 1), frame_shift: frames(v.startMs ?? v.atMs), captionsEnabled: false } });
  const music = ec.musicClips?.length ? ec.musicClips : ec.backgroundMusic?.url && ec.backgroundMusic.enabled !== false ? [ec.backgroundMusic] : [];
  for (const m of music.filter((x) => x?.url)) comps.push({ data: { extensionId: MUSIC_EXT }, externalConfig: { url: fixUrl(m.url), volume: Number(m.volume ?? 1), enabled: true, frame_shift: frames(m.startMs ?? m.atMs), fadeOutSec: Number(m.fadeOutMs ?? 1500) / 1000 } });
  const { externalConfig, ...rootRest } = strip(root);
  return { root_asset: { ...rootRest, type: 'VIDEO', externalConfig: { ...externalConfig, background_music: undefined } }, root_components: comps, children };
}

// Who turned the voice-over captions on. The agent switches them on itself in most runs (it writes
// captionsEnabled: true — 133 of 138 caption-on sessions checked on 2026-10-07); captions that are on
// with no such write from the agent were turned on by a person in the editor.
function captionsByUser(bundle) {
  const agentOn = (bundle.entries || []).some((e) => e.entryType === 'TOOL_CALL' && ['write', 'invoke_rpc'].includes(e.toolCall?.toolName)
    && /captionsEnabled\\?"\s*:\s*true/.test(JSON.stringify(e.toolCall?.arguments || {})));
  return !agentOn;
}

// `captions`: true keeps the voice-over captions as the asset has them, false drops them (the run
// view starts without), 'user' keeps them only if a person turned them on (downloads).
export async function playerInput(sessionId, rootId, { captions = 'user' } = {}) {
  const bundle = await getSessionBundle(sessionId);
  // Without an explicit root: the session's own video, not the project's root asset (a shared
  // project's root is often another session's story or post).
  const snapshot = snapshotFromAssets(bundle.assets, rootId || normalizeSession(bundle).outputs?.rootAssetId);
  if (!snapshot) throw Object.assign(new Error('No finished video asset in this run'), { status: 404 });
  const input = converter()(snapshot);
  const hasCaptions = (input.ttsAudioConfigs || []).some((t) => t.captionsUrl);
  const userCaptions = hasCaptions && captionsByUser(bundle);
  const keep = captions === 'user' ? userCaptions : Boolean(captions);
  if (!keep) input.ttsAudioConfigs = (input.ttsAudioConfigs || []).map(({ captionsUrl, ...t }) => t);
  return { ...input, autopsy: { hasCaptions, userCaptions, captions: keep } };
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
