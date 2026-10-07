import { getJson } from './util.js';

// What this install can do (from /api/health). Optional features check these and explain how
// to turn themselves on instead of failing.
export const caps = { temporalKey: true, ffmpeg: true, player: true };
export const capsReady = getJson('api/health').then((c) => Object.assign(caps, c)).catch(() => caps);

export const HINT = {
  temporalKey: 'Needs a Temporal API key — add TEMPORAL_API_KEY to .env (see .env.example), then restart',
  player: 'Needs the product player — run npm run build:player (with a wixel-video-client checkout)',
  ffmpeg: 'Needs ffmpeg — brew install ffmpeg, then restart',
};
