import { h, icon, ago, dur } from './util.js';
import { state } from './state.js';
import { hasAd, failedRun, attempted, worstMood, MOOD, primaryOutput, typeLabel, getProfile } from './filters.js';
import { mediaOf, isReady, want, onMedia, prioritize, videoUrl, spriteUrl, placeSprite } from './media.js';
import { richTip } from './ui.js';
import { stepKey } from './filters.js';

// Virtualized card grid. Only rows in (or near) the viewport exist in the DOM; cards are keyed by
// run id and reused across scrolls. One shared <video> does hover playback.

const GAP = 12;
const META_H = 62;
const SKILLS_H = 15; // user mode: the skills line under the title
const metaH = () => Math.round((META_H + (state.mode === 'user' ? SKILLS_H : 0)) * (Number(state.textScale) || 1));
const OVERSCAN_ROWS = 2;

let scroller;
let sizer;
let runs = [];
let layout = { cols: 1, cardW: 200, thumbH: 356, rowH: 442 };
const cards = new Map(); // id → element
let onOpen = () => {};
let onSelect = () => {};

export function initGrid(el, sizerEl, { open, select }) {
  scroller = el;
  sizer = sizerEl;
  onOpen = open;
  onSelect = select;
  scroller.addEventListener('scroll', () => requestAnimationFrame(render), { passive: true });
  new ResizeObserver(() => {
    measure();
    render();
  }).observe(scroller);
  onMedia((ids) => {
    for (const id of ids) {
      const c = cards.get(id);
      if (c) fillThumb(c, c._run);
    }
  });
}

let lastShape = null;
export function setRuns(list) {
  runs = list;
  const shape = effectiveAspect();
  if (shape !== lastShape) {
    lastShape = shape;
    for (const [id, c] of cards) {
      c.remove();
      cards.delete(id);
    }
  }
  for (const [id, c] of cards) {
    c.remove();
    cards.delete(id);
  }
  measure();
  render();
}

export function relayout() {
  for (const [id, c] of cards) {
    c.remove();
    cards.delete(id);
  }
  measure();
  render();
}

// "auto" picks the card shape from what the skill makes, so logos aren't letterboxed into
// vertical video cards (and more of them fit on screen).
const AUTO_SHAPE = { video: '9:16', story: '9:16', logo: '1:1', image: '1:1', icons: '1:1', slides: '16:9', doc: '3:4', pdf: '3:4' };
export function effectiveAspect() {
  if (state.aspect !== 'auto') return state.aspect;
  return AUTO_SHAPE[getProfile()[0]?.type] || '1:1';
}
function aspect() {
  const [w, h] = effectiveAspect().split(':').map(Number);
  return h / w;
}

function measure() {
  if (!scroller) return;
  const width = scroller.clientWidth - 28; // padding
  const target = state.size;
  const cols = Math.max(1, Math.floor((width + GAP) / (target + GAP)));
  const cardW = (width - GAP * (cols - 1)) / cols;
  const thumbH = Math.round(cardW * aspect());
  layout = { cols, cardW, thumbH, rowH: thumbH + metaH() + GAP, width };
  sizer.style.height = `${Math.ceil(runs.length / cols) * layout.rowH}px`;
}

export const columns = () => layout.cols;
export { isVideoRun };

function render() {
  if (!scroller) return;
  const top = scroller.scrollTop - 12;
  const firstRow = Math.max(0, Math.floor(top / layout.rowH) - OVERSCAN_ROWS);
  const lastRow = Math.ceil((top + scroller.clientHeight) / layout.rowH) + OVERSCAN_ROWS;
  const from = firstRow * layout.cols;
  const to = Math.min(runs.length, (lastRow + 1) * layout.cols);
  const keep = new Set();
  for (let i = from; i < to; i++) {
    const r = runs[i];
    keep.add(r.id);
    let c = cards.get(r.id);
    if (!c) {
      c = buildCard(r);
      cards.set(r.id, c);
      sizer.append(c);
    }
    const row = Math.floor(i / layout.cols);
    const col = i % layout.cols;
    c.style.transform = `translate(${col * (layout.cardW + GAP)}px, ${row * layout.rowH}px)`;
    c.style.width = `${layout.cardW}px`;
    c._thumb.style.height = `${layout.thumbH}px`;
    c.classList.toggle('sel', r.id === state.selected);
  }
  for (const [id, c] of cards) {
    if (!keep.has(id)) {
      if (c === hover.card) stopHover();
      c.remove();
      cards.delete(id);
    }
  }
  // Ask for media of what's actually on screen first, then the overscan.
  const visFrom = Math.floor(Math.max(0, scroller.scrollTop) / layout.rowH) * layout.cols;
  const ids = [];
  for (let i = visFrom; i < to; i++) if (wantsMedia(runs[i])) ids.push(runs[i].id);
  for (let i = from; i < visFrom; i++) if (wantsMedia(runs[i])) ids.push(runs[i].id);
  want(ids);
}

// Review media (hover video, sprite) only exists for video outputs.
const primary = (r) => primaryOutput(r);
const isVideoRun = (r) => {
  const p = primary(r);
  return p ? p.type === 'video' : r.generations > 0 && !r.outputs?.length;
};
const wantsMedia = (r) => r && (hasAd(r) || r.generations > 0) && isVideoRun(r);

export function markSelected() {
  for (const [id, c] of cards) c.classList.toggle('sel', id === state.selected);
}

export function scrollToIndex(i) {
  const row = Math.floor(i / layout.cols);
  const y = row * layout.rowH;
  if (y < scroller.scrollTop) scroller.scrollTop = y;
  else if (y + layout.rowH > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + layout.rowH - scroller.clientHeight + 12;
}

// ---------- card ----------
function title(r) {
  return primary(r)?.name?.replace(/\s*[-—]\s*Root$/i, '') || r.title || r.prompt?.slice(0, 80) || 'Untitled run';
}

function userType(r) {
  if (r.userType === 'employee') return h('span', { class: 'utype employee', title: 'Wix employee (account not in wt_accounts.base)' }, 'Employee');
  if (r.userType === 'wixel-team') return h('span', { class: 'utype wixel-team', title: 'Wixel team account' }, 'Team');
  if (r.userType === 'real') return h('span', { class: 'utype real', title: 'Real user' }, 'Real');
  return null;
}

function sig(name, cls, text, tip) {
  return h('span', { class: `s ${cls}`, title: tip }, icon(name), text != null && text !== '' ? h('span', {}, text) : null);
}

function signals(r) {
  const out = [];
  const dl = r.userDownloads > 0 || r.agentDownloads > 0;
  out.push(sig('download', dl ? 'info' : 'dim', r.userDownloads > 1 ? r.userDownloads : '', dl ? `Downloaded${r.userDownloads ? ` ${r.userDownloads}× in the editor` : ''}${r.agentDownloads ? `${r.userDownloads ? ',' : ''} via the agent` : ''}` : 'Not downloaded'));
  out.push(sig('globe', r.publishedUrl ? 'ok' : 'dim', '', r.publishedUrl ? 'Published' : 'Not published'));
  const mood = worstMood(r);
  if (mood) out.push(sig(MOOD[mood].icon, mood, '', `${MOOD[mood].label}${r.sentimentDetail ? ` — ${r.sentimentDetail}` : ''}\nAll turns: ${r.sentiments.join(', ')}`));
  if (r.thumbsUp) out.push(sig('up', 'ok', r.thumbsUp > 1 ? r.thumbsUp : '', 'Thumbs up'));
  if (r.thumbsDown) out.push(sig('down', 'err', r.thumbsDown > 1 ? r.thumbsDown : '', `Thumbs down${r.feedbackTags.length ? `: ${r.feedbackTags.join(', ')}` : ''}`));
  const issues = (r.errors || 0) + (r.failedTurns || 0) + (r.streamErrors || 0);
  if (issues) out.push(richTip(sig('alert', 'err', issues, ''), () => errorList(r)));
  if (r.outOfFunds) out.push(sig('card', 'warn', '', 'Ran out of credits'));
  return out;
}

// What went wrong in a run, for the error icon's hover: each failing step with its message.
function errorList(r) {
  const rows = (r.steps || []).filter((x) => x[4] > 0).sort((a, b) => b[4] - a[4]).slice(0, 8)
    .map(([tool, method, , n, e, , , err]) => h('div', { class: 'tip-row' }, h('b', {}, `${stepKey(tool, method)} ×${e}`), h('span', { class: 'tip-dim' }, ` of ${n}`), err ? h('div', { class: 'tip-msg' }, err.slice(0, 180)) : null));
  const extra = [
    r.failedTurns ? `${r.failedTurns} failed turn${r.failedTurns > 1 ? 's' : ''}` : null,
    r.streamErrors ? `${r.streamErrors} model stream error${r.streamErrors > 1 ? 's' : ''}` : null,
    r.outOfFunds ? 'ran out of credits' : null,
  ].filter(Boolean);
  return [
    h('div', { class: 'tip-h' }, `${r.errors || 0} tool error${r.errors === 1 ? '' : 's'}${extra.length ? ` · ${extra.join(' · ')}` : ''}`),
    ...(rows.length ? rows : r.firstError ? [h('div', { class: 'tip-msg' }, r.firstError)] : []),
    h('div', { class: 'tip-dim', style: { marginTop: '6px' } }, 'Open the run → Timeline → Failed for the full detail'),
  ];
}

// User mode: the skills this session used (a line under the title).
function skillLine(r) {
  const list = r.allSkills || r.skills || [];
  if (state.mode !== 'user' || !list.length) return null;
  return h('div', { class: 'skills-line', title: `Skills used: ${list.join(', ')}` },
    list.slice(0, 2).join(' · '), list.length > 2 ? h('span', { class: 'more' }, ` +${list.length - 2}`) : null);
}

// Skill mode: other skills also worked in this session; their turns aren't counted here.
function otherSkillsChip(r) {
  const list = r.otherSkills || [];
  if (state.mode === 'user' || !list.length) return null;
  return h('span', { class: 'sig other-sk', title: `Also in this session, not counted for ${state.skill}: ${list.join(', ')}${r.allTurns > r.turns ? `\n${r.turns} of ${r.allTurns} turns counted` : ''}` }, `+${list.length} skill${list.length > 1 ? 's' : ''}`);
}

function buildCard(r) {
  const thumb = h('div', { class: 'thumb', style: { height: `${layout.thumbH}px` } });
  const c = h('div', { class: `card${failedRun(r) ? ' failed' : ''}`, 'data-id': r.id },
    thumb,
    h('div', { class: 'meta' },
      h('div', { class: 'title', title: r.prompt }, title(r)),
      h('div', { class: 'sub' },
        userType(r),
        h('time', { title: new Date(r.createdAt).toLocaleString() }, ago(r.createdAt)),
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'num', title: state.mode === 'user' ? 'Session wall time' : `Wall time of the turns counted for ${state.skill}` }, dur(r.wallMs)),
        r.generations ? [h('span', { class: 'sep' }, '·'), h('span', { class: 'num', title: 'Generation calls' }, `${r.generations} gen`)] : null,
      ),
      skillLine(r),
      h('div', { class: 'signals' }, signals(r), otherSkillsChip(r)),
    ),
  );
  c._run = r;
  c._thumb = thumb;
  fillThumb(c, r);
  c.addEventListener('click', () => onSelect(r.id));
  c.addEventListener('dblclick', () => onOpen(r.id));
  thumb.addEventListener('pointerenter', (e) => startHover(c, e));
  thumb.addEventListener('pointermove', (e) => moveHover(c, e));
  thumb.addEventListener('pointerleave', () => stopHover());
  return c;
}

function fillThumb(c, r) {
  const thumb = c._thumb;
  const p = primary(r);
  const video = isVideoRun(r);
  const m = video ? mediaOf(r.id) : null;
  const keepVideo = hover.card === c ? hover.video : null;
  thumb.replaceChildren();
  const poster = isReady(m) ? `media/${r.id}/poster.jpg` : p?.thumb || r.thumbnail;
  if (poster) thumb.append(h('img', { class: 'poster', src: poster, loading: 'lazy', decoding: 'async', alt: '' }));
  else if (failedRun(r)) {
    thumb.append(h('div', { class: 'empty err' }, icon('alert'), h('b', {}, 'Tried, no output'), r.firstError ? h('div', { class: 'msg' }, r.firstError) : null));
  } else if (!attempted(r)) {
    thumb.append(h('div', { class: 'empty' }, icon('sparkle'), 'Never tried to make anything'));
  }
  if (isReady(m)) {
    const sp = h('div', { class: 'sprite', style: { backgroundImage: `url(${spriteUrl(r.id)})` } });
    thumb.append(sp);
    c._sprite = sp;
  } else c._sprite = null;
  thumb.append(h('div', { class: 'progress' }));
  if (video && m?.state === 'ready') {
    const cls = m.kind === 'render' ? 'exact' : m.kind;
    const label = m.kind === 'render' ? 'Exact' : m.kind === 'assembled' ? 'Assembled' : 'Clip';
    thumb.append(h('span', { class: `badge tl ${cls}`, title: m.label }, label));
    thumb.append(h('span', { class: 'badge tr' }, `${Math.round(m.duration)}s`));
  } else if (video && m && !['failed', 'unavailable'].includes(m.state) && wantsMedia(r)) {
    thumb.append(h('span', { class: 'badge tl pending', title: 'Preparing review video' }, m.state === 'processing' ? 'Preparing' : 'Queued'));
  } else if (p && p.type !== 'video') {
    thumb.append(h('span', { class: 'badge tl type' }, typeLabel(p.type)));
  }
  const n = r.outputs?.length || 0;
  if (n > 1) thumb.append(h('span', { class: 'badge br', title: r.outputs.map((o) => `${typeLabel(o.type)} · ${o.name || ''}`).join('\n') }, `${n} outputs`));
  if (failedRun(r) && poster) thumb.append(h('span', { class: 'badge br fail' }, 'No output'));
  if (keepVideo) thumb.append(keepVideo);
}

// ---------- hover: rest = play, move = scrub ----------
const hover = { card: null, video: null, restTimer: 0, lastX: null, frac: 0, seekPending: null };

function hoverVideo() {
  if (!hover.video) {
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.loop = true;
    v.addEventListener('playing', () => hover.card?._thumb.classList.add('playing'));
    v.addEventListener('seeked', () => {
      hover.card?._thumb.classList.remove('scrub');
      if (hover.seekPending != null) {
        const t = hover.seekPending;
        hover.seekPending = null;
        v.currentTime = t;
      }
    });
    v.addEventListener('timeupdate', () => progress(v.currentTime / (v.duration || 1)));
    hover.video = v;
  }
  return hover.video;
}

function progress(frac) {
  const bar = hover.card?._thumb.querySelector('.progress');
  if (bar) bar.style.width = `${Math.min(100, frac * 100)}%`;
}

function startHover(c, e) {
  stopHover();
  hover.card = c;
  hover.lastX = e.clientX;
  const r = c._run;
  if (!isVideoRun(r)) return cycleOutputs(c, r);
  const m = mediaOf(r.id);
  if (!isReady(m)) {
    prioritize(r.id);
    return;
  }
  const v = hoverVideo();
  v.muted = !state.sound;
  const src = videoUrl(r.id);
  if (!v.src.endsWith(src)) v.src = src;
  c._thumb.append(v);
  clearTimeout(hover.restTimer);
  hover.restTimer = setTimeout(() => play(), 120);
}

// Browsers block sound until the page has had a click or key press. Hover then plays muted and
// says so on the card, instead of silently dropping the dialogue.
let soundUnlocked = navigator.userActivation?.hasBeenActive || false;
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => {
    soundUnlocked = true;
    document.querySelectorAll('.sound-hint').forEach((n) => n.remove());
    if (hover.video && state.sound && hover.video.muted) hover.video.muted = false;
  }, { capture: true, passive: true });
}

function play() {
  const v = hover.video;
  if (!v || !hover.card) return;
  v.muted = !state.sound;
  v.play().catch(() => {
    v.muted = true;
    v.play().catch(() => {});
    if (state.sound && !soundUnlocked && hover.card && !hover.card._thumb.querySelector('.sound-hint')) {
      hover.card._thumb.append(h('span', { class: 'badge sound-hint' }, icon('mute', 'sm'), 'Sound blocked — click anywhere once'));
    }
  });
}

function moveHover(c, e) {
  if (hover.card !== c) return startHover(c, e);
  if (!isVideoRun(c._run)) return;
  const m = mediaOf(c._run.id);
  if (!isReady(m) || hover.lastX == null) return;
  if (Math.abs(e.clientX - hover.lastX) < 3) return;
  hover.lastX = e.clientX;
  const rect = c._thumb.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  hover.frac = frac;
  // Instant feedback from the sprite while the real frame decodes.
  if (c._sprite) {
    placeSprite(c._sprite, c._thumb, m, frac);
    c._thumb.classList.add('scrub');
  }
  progress(frac);
  const v = hover.video;
  if (v) {
    v.pause();
    const t = frac * (m.duration || v.duration || 0);
    if (v.seeking) hover.seekPending = t;
    else v.currentTime = t;
  }
  clearTimeout(hover.restTimer);
  hover.restTimer = setTimeout(() => play(), 380);
}

// Non-video runs: hovering flips through everything the run made (logos, images, pages…).
function cycleOutputs(c, r) {
  const thumbs = (r.outputs || []).map((o) => o.thumb).filter(Boolean);
  if (thumbs.length < 2) return;
  const img = c._thumb.querySelector('img.poster');
  if (!img) return;
  hover.origSrc = img.src;
  let i = 0;
  const bar = c._thumb.querySelector('.progress');
  c._thumb.classList.add('scrub');
  hover.cycle = setInterval(() => {
    i = (i + 1) % thumbs.length;
    img.src = thumbs[i];
    if (bar) bar.style.width = `${((i + 1) / thumbs.length) * 100}%`;
  }, 650);
  hover.cycleImg = img;
}

export function stopHover() {
  clearInterval(hover.cycle);
  if (hover.cycleImg && hover.origSrc) hover.cycleImg.src = hover.origSrc;
  hover.cycle = hover.cycleImg = hover.origSrc = null;
  clearTimeout(hover.restTimer);
  if (hover.video) {
    hover.video.pause();
    hover.video.remove();
  }
  if (hover.card) hover.card._thumb.classList.remove('playing', 'scrub');
  hover.card = null;
  hover.lastX = null;
  hover.seekPending = null;
}

export function applySound() {
  if (hover.video) hover.video.muted = !state.sound;
}
