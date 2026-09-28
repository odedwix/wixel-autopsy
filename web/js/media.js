import { getJson } from './util.js';

// Review-media status per run (built on demand by the proxy: exact render → assembled → clip).
const status = new Map();
const listeners = new Set();
export const onMedia = (fn) => listeners.add(fn);
export const mediaOf = (id) => status.get(id) || null;
export const isReady = (m) => m?.state === 'ready';
export const videoUrl = (id) => `/media/${id}/review.mp4`;
export const spriteUrl = (id) => `/media/${id}/sprite.jpg`;
export const posterUrl = (id) => `/media/${id}/poster.jpg`;

// Save a run's video: /download streams the exact render when there is one, else the review copy,
// as <skill>-<title>-<date>-<id8>.mp4.
export function downloadName(run, skill) {
  const title = (run.adName || run.title || 'video').replace(/\s*[-—]\s*Root$/i, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  const day = run.createdAt ? new Date(run.createdAt).toISOString().slice(0, 10) : '';
  return [skill, title, day, run.id.slice(0, 8)].filter(Boolean).join('-');
}
export function downloadRun(run, skill) {
  if (!isReady(mediaOf(run.id))) return false;
  const a = document.createElement('a');
  a.href = `/download/${run.id}?name=${encodeURIComponent(downloadName(run, skill))}`;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
  return true;
}

const FINAL = new Set(['ready', 'failed', 'unavailable']);
let wanted = [];
let timer;

// The grid calls this with the cards on screen (most visible first); the proxy queues builds.
export function want(ids) {
  wanted = ids.filter((id) => !FINAL.has(status.get(id)?.state));
  clearTimeout(timer);
  timer = setTimeout(poll, 150);
}

async function poll() {
  const ids = wanted.slice(0, 60);
  if (!ids.length) return;
  try {
    const res = await getJson(`/api/media-batch?ids=${ids.join(',')}`);
    const changed = [];
    for (const [id, s] of Object.entries(res)) {
      const prev = status.get(id);
      status.set(id, s);
      if (prev?.state !== s.state) changed.push(id);
    }
    if (changed.length) for (const fn of listeners) fn(changed);
    wanted = wanted.filter((id) => !FINAL.has(status.get(id)?.state));
  } catch {}
  clearTimeout(timer);
  if (wanted.length) timer = setTimeout(poll, 2500);
}

// Jump the build queue for a run the user is looking at right now.
export async function prioritize(id) {
  if (FINAL.has(status.get(id)?.state)) return status.get(id);
  const s = await getJson(`/api/media/${id}?priority=1`).catch(() => null);
  if (s) {
    status.set(id, s);
    for (const fn of listeners) fn([id]);
    if (!FINAL.has(s.state) && !wanted.includes(id)) {
      wanted.unshift(id);
      clearTimeout(timer);
      timer = setTimeout(poll, 1200);
    }
  }
  return s;
}

// Position a sprite-sheet tile inside a box, letterboxed like object-fit: contain.
export function placeSprite(el, box, meta, frac) {
  const { cols, rows, count } = meta.sprite;
  const ar = meta.width / meta.height;
  const bw = box.clientWidth;
  const bh = box.clientHeight;
  let w = bw;
  let hgt = bw / ar;
  if (hgt > bh) {
    hgt = bh;
    w = bh * ar;
  }
  const i = Math.min(count - 1, Math.max(0, Math.floor(frac * count)));
  const c = i % cols;
  const r = Math.floor(i / cols);
  el.style.left = `${(bw - w) / 2}px`;
  el.style.top = `${(bh - hgt) / 2}px`;
  el.style.width = `${w}px`;
  el.style.height = `${hgt}px`;
  el.style.right = el.style.bottom = 'auto';
  el.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
  el.style.backgroundPosition = `${cols > 1 ? (c / (cols - 1)) * 100 : 0}% ${rows > 1 ? (r / (rows - 1)) * 100 : 0}%`;
}
