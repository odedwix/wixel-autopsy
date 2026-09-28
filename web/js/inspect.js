import { h, icon, ago, dur, dateTime, tc, getJson, copy } from './util.js';
import { state, set, famParam } from './state.js';
import { renderTimeline } from './timeline.js';
import { renderScenes, renderBrand, renderAssets, renderRaw } from './deep.js';
import { shareRun } from './share.js';
import { caps, HINT } from './caps.js';
import { toast } from './ui.js';
import { MOOD, worstMood, failedRun, hasAd, primaryOutput, typeLabel } from './filters.js';
import { isVideoRun } from './grid.js';
import { mediaOf, isReady, prioritize, onMedia, videoUrl, spriteUrl, placeSprite, downloadRun, downloadOutput } from './media.js';
import { showUser } from './skillpicker.js';

const ADMIN = 'https://wix-bo.com/wixel-agent/admin/#/sessions/';
const detailCache = new Map();

// In skill mode the detail says which turns count for the skill (same rule as the grid).
export function prefetchDetail(id) {
  const q = state.mode === 'user' ? '' : `?skill=${encodeURIComponent(state.skill)}&fam=${encodeURIComponent(famParam())}`;
  const key = `${id}${q}`;
  if (!detailCache.has(key)) detailCache.set(key, getJson(`/api/session/${id}${q}`).catch((e) => ({ error: e.message })));
  return detailCache.get(key);
}

// The run as this view counts it: only the skill's turns, unless "show other skills" is on.
// Everything turn-bound is filtered; timing and the request are recomputed from what's left.
function counted(d) {
  const sc = d?.scope;
  if (!sc || sc.whole || state.showOther || sc.owned.length === sc.turns.length) return d;
  const own = new Set(sc.owned);
  const keep = (x) => !x.turnId || own.has(x.turnId);
  const steps = (d.steps || []).filter(keep);
  const modelCalls = (d.modelCalls || []).filter(keep);
  const userMessages = (d.userMessages || []).filter(keep);
  const ats = [...steps.flatMap((x) => [x.startedAt, x.endedAt]), ...modelCalls.flatMap((m) => [m.startedAt, m.at]), ...userMessages.map((m) => m.at)].filter(Boolean);
  const firstAt = ats.length ? Math.min(...ats) : d.timing?.firstAt;
  const lastAt = ats.length ? Math.max(...ats) : d.timing?.lastAt;
  const byCategory = {};
  for (const x of steps) if (x.durationMs != null) byCategory[x.category] = (byCategory[x.category] || 0) + Number(x.durationMs);
  byCategory.model = modelCalls.reduce((a, m) => a + (m.latencyMs || 0), 0);
  return {
    ...d,
    steps,
    modelCalls,
    userMessages,
    prompt: userMessages[0]?.text ?? d.prompt,
    turns: (d.turns || []).filter(keep),
    errors: (d.errors || []).filter(keep),
    feedback: (d.feedback || []).filter(keep),
    outOfFunds: (d.outOfFunds || []).filter(keep),
    streamErrors: (d.streamErrors || []).filter(keep),
    sentiments: (d.sentiments || []).filter(keep),
    generations: steps.filter((x) => x.workflowId).length,
    cost: { ...d.cost, inputTokens: modelCalls.reduce((a, m) => a + m.inputTokens, 0), outputTokens: modelCalls.reduce((a, m) => a + m.outputTokens, 0) },
    timing: { ...d.timing, firstAt, lastAt, wallMs: firstAt && lastAt ? lastAt - firstAt : null, byCategory },
  };
}

// "Counting turns 1–2 of 7 for wixel-ads · the rest used logo-create…  [Show them]"
function scopeBanner(d) {
  const sc = d?.scope;
  if (!sc || sc.whole || sc.owned.length === sc.turns.length) return null;
  const other = sc.turns.filter((t) => !t.owned);
  const otherSkills = [...new Set(other.flatMap((t) => t.skills))];
  const nums = (ts) => ts.map((t) => t.n).join(', ');
  return h('div', { class: `scope-banner${state.showOther ? ' showing' : ''}` },
    icon('alert', 'sm'),
    h('span', {}, state.showOther
      ? `Showing the whole session. Turns ${nums(other)} aren't ${sc.skill.endsWith('s') ? `${sc.skill}'` : `${sc.skill}'s`} work${otherSkills.length ? ` (${otherSkills.join(', ')})` : ''} — the grid and insights leave them out.`
      : `Counting ${sc.owned.length} of ${sc.turns.length} turns for ${sc.skill}. Turn${other.length > 1 ? 's' : ''} ${nums(other)} ${other.length > 1 ? 'are' : 'is'} other ${otherSkills.length ? `skills' work (${otherSkills.join(', ')})` : 'work before the skill was loaded'}.`),
    h('button', { class: 'btn ghost', onclick: () => { set({ showOther: !state.showOther }, { silent: true }); renderTab(); } }, state.showOther ? 'Hide them' : 'Show them'));
}

let panel;
let current = null; // { run, player }

export function initInspect(el, { close }) {
  panel = el;
  panel._close = close;
  onMedia((ids) => {
    if (current && ids.includes(current.run.id)) mountPlayer(current.run);
  });
}

export function openInspect(run) {
  if (!run) return;
  panel.hidden = false;
  if (current?.run.id === run.id) {
    // Opened early from a link with only an id; now the list row (signals, render links) is here.
    if (current.run._stub && !run._stub) {
      current.run = run;
      panel.querySelector('.insp-head')?.replaceWith(header(run, current.detail || null));
      mountPlayer(run);
    }
    return;
  }
  current?.player?.destroy();
  current = { run, player: null };
  panel.classList.toggle('wide', Boolean(state.inspectWide));
  panel.replaceChildren(header(run, null), h('div', { class: 'insp-body' }, h('div', { class: 'player', id: 'playerMount' }), tabBar(), h('div', { id: 'detailMount' }, h('div', { class: 'loading-line' }, 'Loading run…'))));
  mountPlayer(run);
  prioritize(run.id);
  prefetchDetail(run.id).then((d) => {
    if (current?.run.id !== run.id) return;
    current.detail = d;
    panel.querySelector('.insp-head').replaceWith(header(run, d));
    renderTab();
    current.player?.setScenes(d.outputs?.scenes || []);
    current.player?.setDetail?.(d);
  });
}

// ---------- tabs ----------
const TABS = [['overview', 'Overview', '1'], ['timeline', 'Timeline', '2'], ['scenes', 'Scenes', '3'], ['brand', 'Brand', '4'], ['assets', 'Assets', '5'], ['raw', 'Raw', '6']];

function tabBar() {
  return h('div', { class: 'insp-tabs', role: 'tablist' }, TABS.map(([k, label, key]) =>
    h('button', { role: 'tab', 'aria-selected': String((state.inspectTab || 'overview') === k), title: `${label} (${key})`, onclick: () => setInspectTab(k) }, label)));
}

export function setInspectTab(k) {
  set({ inspectTab: k }, { silent: true });
  const bar = panel.querySelector('.insp-tabs');
  if (bar) bar.replaceWith(tabBar());
  renderTab();
}

export function setInspectTabByIndex(i) {
  if (current && TABS[i]) setInspectTab(TABS[i][0]);
}

export function toggleWide() {
  set({ inspectWide: !state.inspectWide }, { silent: true });
  panel.classList.toggle('wide', Boolean(state.inspectWide));
}

function renderTab() {
  const mount = panel.querySelector('#detailMount');
  const full = current?.detail;
  if (!mount || !full) return;
  if (full.error) return mount.replaceChildren(...details(current.run, full));
  const d = counted(full);
  const banner = scopeBanner(full);
  const tab = state.inspectTab || 'overview';
  const box = h('div', { class: 'section dz' });
  const seek = (sec) => current?.player?.seekSec(sec);
  if (tab === 'overview') return mount.replaceChildren(...[banner, ...details(current.run, d)].filter(Boolean));
  mount.replaceChildren(...[banner, box].filter(Boolean));
  if (tab === 'timeline') renderTimeline(box, d);
  if (tab === 'scenes') renderScenes(box, d, { seek });
  if (tab === 'brand') renderBrand(box, d);
  if (tab === 'assets') renderAssets(box, d);
  if (tab === 'raw') renderRaw(box, d);
}

export function closeInspect() {
  current?.player?.destroy();
  current = null;
  if (panel) {
    panel.hidden = true;
    panel.replaceChildren();
  }
}

export const inspectedPlayer = () => current?.player || null;
export const inspectedRun = () => current?.run || null;

// ---------- header ----------
const fileSkill = () => (state.mode === 'user' ? null : state.skill);
function header(r, d) {
  const email = d?.user?.email;
  const ut = r.userType === 'employee' || d?.user?.isWixEmail ? 'employee' : r.userType;
  return h('div', { class: 'insp-head' },
    h('div', { class: 't' },
      h('h2', { title: r.prompt }, r.adName?.replace(/\s*[-—]\s*Root$/i, '') || r.title || 'Untitled run'),
      h('div', { class: 'sub' },
        ut && ut !== 'unknown' ? h('span', { class: `utype ${ut}` }, ut === 'employee' ? 'Employee' : ut === 'wixel-team' ? 'Team' : 'Real') : null,
        email || r.userId ? h('button', { class: 'link-btn', title: 'Every run by this user, any skill', onclick: () => showUser({ id: d?.user?.id || r.userId, email: email || null }) }, icon('user', 'sm'), email || 'this user') : null,
        h('span', { class: 'sep' }, '·'),
        h('time', { title: new Date(r.createdAt).toLocaleString() }, `${dateTime(r.createdAt)} (${ago(r.createdAt)})`),
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'num' }, dur(r.wallMs)),
        r.agent ? [h('span', { class: 'sep' }, '·'), h('span', {}, `${r.agent}${r.source ? ` / ${r.source}` : ''}`)] : null,
      ),
    ),
    isVideoRun(r)
      ? h('button', { class: 'btn share-btn', title: 'Download the video (D) — the exact render when there is one', onclick: () => downloadRun(current?.run || r, fileSkill()) || toast('The video is still being prepared — try again in a moment') }, icon('download'), 'Download')
      : primaryOutput(r) ? h('button', { class: 'btn share-btn', title: `Download the ${typeLabel(primaryOutput(r).type).toLowerCase()} (D) — the user's own export when reachable, else the original image or a PDF of its pages`, onclick: () => downloadOutput(current?.run || r, current?.player?.currentOutput?.() || primaryOutput(r), fileSkill()) }, icon('download'), 'Download') : null,
    h('button', { class: 'btn share-btn', title: 'Share this run', onclick: (e) => shareRun(e.currentTarget, current?.run || r, current?.detail || d) }, icon('external'), 'Share'),
    h('button', { class: 'icon-btn', title: 'Wide panel (W)', onclick: () => toggleWide() }, icon('expand')),
    h('a', { class: 'icon-btn', href: ADMIN + r.id, target: '_blank', rel: 'noopener', title: 'Open in Wixel admin (O)' }, icon('external')),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => panel._close() }, icon('x')),
  );
}

// ---------- player ----------
function mountPlayer(r) {
  const mount = panel.querySelector('#playerMount');
  if (!mount) return;
  current.player?.destroy();
  // Skills that make images, logos, docs, slides… get a gallery instead of a video player.
  if (!r._stub && !isVideoRun(r) && (r.outputs?.length || r.thumbnail)) {
    current.player = new OutputViewer(mount, r, current.detail);
    return;
  }
  const m = mediaOf(r.id);
  const live = current.live ?? (!isReady(m) && hasAd(r) && caps.player);
  current.player = live ? new LivePlayer(mount, r) : isReady(m) ? new ReviewPlayer(mount, r, m) : null;
  if (!current.player) {
    const why = !r.generations ? 'This run never reached generation.' : m?.state === 'failed' ? `Couldn't prepare video: ${m.reason}` : m?.state === 'unavailable' ? m.reason : 'Preparing review video…';
    mount.replaceChildren(h('div', { class: 'stage' }, h('div', { class: 'note' }, why)));
  }
  if (current.detail) current.player?.setScenes?.(current.detail.outputs?.scenes || []);
}

export function toggleLive() {
  if (!current || !hasAd(current.run)) return;
  if (!caps.player && !(current.player instanceof LivePlayer)) {
    toast(HINT.player, { ms: 6000 });
    return;
  }
  const wasLive = current.player instanceof LivePlayer;
  current.live = !wasLive;
  mountPlayer(current.run);
}

class ReviewPlayer {
  constructor(mount, run, meta) {
    this.meta = meta;
    this.scenes = [];
    this.v = h('video', { src: videoUrl(run.id), preload: 'auto', playsinline: true });
    this.v.muted = false;
    const stage = h('div', { class: 'stage' }, this.v);
    this.fill = h('div', { class: 'fill' });
    this.head = h('div', { class: 'head' });
    this.segs = h('div');
    this.track = h('div', { class: 'track' }, this.segs, this.fill, this.head);
    this.prevImg = h('div', { class: 'img', style: { backgroundImage: `url(${spriteUrl(run.id)})` } });
    this.prevTc = h('div', { class: 'tc' });
    this.prev = h('div', { class: 'hover-prev' }, this.prevImg, this.prevTc);
    this.scrub = h('div', { class: 'scrub' }, this.track, this.prev);
    this.playBtn = h('button', { title: 'Play / pause (Space)', onclick: () => this.toggle() }, icon('play'));
    this.time = h('span', { class: 'time' }, '0:00:00');
    this.rateBtn = h('button', { class: 'rate', title: 'Playback speed', onclick: () => this.cycleRate() }, '1×');
    this.muteBtn = h('button', { title: 'Mute', onclick: () => { this.v.muted = !this.v.muted; this.sync(); } }, icon('volume'));
    const src = meta.kind === 'render' ? 'Exact render' : meta.kind === 'assembled' ? 'Assembled — no text/captions' : 'Single clip';
    this.modeBtn = h('button', { class: 'mode', title: 'Switch to the exact live player (E)', onclick: () => toggleLive() }, icon('sparkle', 'sm'), 'Exact');
    const controls = h('div', { class: 'controls' }, this.playBtn, this.time, h('span', { style: { flex: 1 } }), this.rateBtn, this.muteBtn,
      h('button', { title: `Download ${meta.kind === 'render' ? 'the exact render' : 'this video'} (D)`, onclick: () => downloadRun(run, state.skill) }, icon('download')), hasAd(run) ? this.modeBtn : null,
      h('button', { title: 'Fullscreen', onclick: () => stage.requestFullscreen?.() }, icon('expand')));
    const note = h('div', { class: 'src-note' }, h('span', { class: 'dot', style: { background: meta.kind === 'render' ? 'var(--ok)' : meta.kind === 'assembled' ? 'var(--info)' : 'var(--warn)' } }),
      h('span', {}, `${meta.label} · ${meta.duration.toFixed(1)}s · ${src === 'Exact render' ? 'what the user got' : 'press E for the exact composition'}`));
    mount.replaceChildren(stage, this.scrub, controls, note);

    this.v.addEventListener('timeupdate', () => this.sync());
    this.v.addEventListener('play', () => this.sync());
    this.v.addEventListener('pause', () => this.sync());
    this.v.addEventListener('seeked', () => {
      if (this.pendingSeek != null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        this.v.currentTime = t;
      }
      this.sync();
    });
    this.v.addEventListener('click', () => this.toggle());
    this.raf = requestAnimationFrame(this.loop);
    this.scrub.addEventListener('pointermove', (e) => this.preview(e));
    this.scrub.addEventListener('pointerdown', (e) => {
      this.scrub.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.resume = !this.v.paused;
      this.v.pause();
      this.seekTo(this.fracAt(e));
    });
    this.scrub.addEventListener('pointerup', () => {
      this.dragging = false;
      if (this.resume) this.v.play();
    });
    // Autoplay with sound can be refused (no click on the page yet): play muted and offer Unmute
    // rather than leaving a silent or paused player.
    this.v.play().catch(() => {
      this.v.muted = true;
      this.v.play().catch(() => {});
      this.sync();
      const btn = h('button', { class: 'unmute', onclick: (e) => { e.stopPropagation(); this.v.muted = false; this.v.play().catch(() => {}); btn.remove(); this.sync(); } }, icon('volume'), 'Unmute');
      stage.append(btn);
    });
  }

  loop = () => {
    this.drawHead();
    this.raf = requestAnimationFrame(this.loop);
  };

  get duration() {
    return this.v.duration || this.meta.duration || 1;
  }

  fracAt(e) {
    const r = this.track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  seekTo(frac) {
    const t = frac * this.duration;
    // Coalesce seeks: at most one in flight, the latest one wins — this is what keeps drag smooth.
    if (this.v.seeking) this.pendingSeek = t;
    else this.v.currentTime = t;
    this.drawHead(frac);
  }

  preview(e) {
    const frac = this.fracAt(e);
    if (this.dragging) this.seekTo(frac);
    const tr = this.track.getBoundingClientRect();
    const tile = this.meta.sprite;
    const w = tile.tileWidth;
    const hgt = tile.tileHeight;
    this.prevImg.style.width = `${w}px`;
    this.prevImg.style.height = `${hgt}px`;
    placeSprite(this.prevImg, { clientWidth: w, clientHeight: hgt }, this.meta, frac);
    this.prevImg.style.position = 'relative';
    this.prevImg.style.left = this.prevImg.style.top = '0';
    this.prev.style.left = `${10 + frac * tr.width}px`;
    const t = frac * this.duration;
    const sc = this.scenes.find((s) => t >= s.startSec && t < s.endSec);
    this.prevTc.textContent = `${tc(t)}${sc ? ` · ${sc.name?.replace(/^Scene\s*/i, 'S') || ''}` : ''}`;
  }

  drawHead(frac = this.v.currentTime / this.duration) {
    const pct = `${Math.min(100, frac * 100)}%`;
    this.fill.style.width = pct;
    this.head.style.left = pct;
  }

  sync() {
    this.time.textContent = `${tc(this.v.currentTime)} / ${tc(this.duration)}`;
    this.playBtn.replaceChildren(icon(this.v.paused ? 'play' : 'pause'));
    this.muteBtn.replaceChildren(icon(this.v.muted ? 'mute' : 'volume'));
    if (!this.v.muted) this.v.parentElement?.querySelector('.unmute')?.remove();
  }

  setScenes(scenes) {
    this.scenes = scenes || [];
    const total = this.duration;
    this.segs.replaceChildren(...this.scenes.map((s, i) => h('div', {
      class: 'seg-scene',
      title: s.name,
      style: { left: `${(s.startSec / total) * 100}%`, width: `${((s.endSec - s.startSec) / total) * 100}%`, background: i % 2 ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.05)' },
    })));
  }

  toggle() {
    this.v.paused ? this.v.play() : this.v.pause();
  }

  step(frames) {
    this.v.pause();
    this.v.currentTime = Math.max(0, Math.min(this.duration, this.v.currentTime + frames / 24));
  }

  seekBy(sec) {
    this.v.currentTime = Math.max(0, Math.min(this.duration, this.v.currentTime + sec));
  }

  seekSec(sec) {
    this.v.currentTime = sec;
    this.v.play().catch(() => {});
  }

  cycleRate() {
    const rates = [1, 1.5, 2, 0.5];
    const next = rates[(rates.indexOf(this.v.playbackRate) + 1) % rates.length];
    this.v.playbackRate = next;
    this.rateBtn.textContent = `${next}×`;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
  }
}

// Non-video outputs: a large view of the selected output, a strip of everything the run made,
// and the selected output's pages/parts (docs, slides) from the project's asset tree.
class OutputViewer {
  constructor(mount, run, detail) {
    this.run = run;
    this.mount = mount;
    this.detail = detail || null;
    this.outputs = (run.outputs || []).length ? run.outputs : [{ id: run.adAssetId, type: run.outputType, name: run.adName, thumb: run.thumbnail }];
    const p = primaryOutput(run);
    this.index = Math.max(0, this.outputs.findIndex((o) => o.id === p?.id));
    this.page = -1;
    this.render();
  }

  setDetail(d) {
    this.detail = d;
    this.render();
  }

  pages() {
    const o = this.outputs[this.index];
    return (this.detail?.assetTree || []).find((a) => a.id === o?.id)?.children?.filter((c) => c.thumbnailUrl) || [];
  }

  render() {
    const o = this.outputs[this.index] || {};
    const pages = this.pages();
    const src = this.page >= 0 && pages[this.page] ? pages[this.page].thumbnailUrl : o.thumb;
    const stage = h('div', { class: 'stage ov-stage' }, src ? h('img', { class: 'ov-main', src, alt: o.name || '' }) : h('div', { class: 'note' }, 'No preview for this output'));
    const strip = this.outputs.length > 1 ? h('div', { class: 'ov-strip' }, this.outputs.map((x, i) => h('button', { class: `ov-thumb${i === this.index ? ' on' : ''}`, title: `${typeLabel(x.type)} · ${x.name || ''}`, onclick: () => { this.index = i; this.page = -1; this.render(); } },
      x.thumb ? h('img', { src: x.thumb, loading: 'lazy', alt: '' }) : h('span', {}, typeLabel(x.type))))) : null;
    const pageStrip = pages.length ? h('div', { class: 'ov-strip pages' }, h('span', { class: 'ov-k' }, `${pages.length} pages`), pages.map((pg, i) => h('button', { class: `ov-thumb${i === this.page ? ' on' : ''}`, title: pg.name || `Page ${i + 1}`, onclick: () => { this.page = this.page === i ? -1 : i; this.render(); } }, h('img', { src: pg.thumbnailUrl, loading: 'lazy', alt: '' })))) : null;
    const info = h('div', { class: 'src-note' }, h('span', { class: 'dot', style: { background: 'var(--ok)' } }),
      h('span', {}, `${typeLabel(o.type)} · ${o.name || 'Untitled'}${this.outputs.length > 1 ? ` · ${this.index + 1} of ${this.outputs.length} outputs` : ''}`),
      h('span', { style: { flex: 1 } }),
      o.publishedUrl ? h('a', { href: o.publishedUrl, target: '_blank', rel: 'noopener' }, 'Published ↗') : null,
      o.id ? h('button', { class: 'link-btn', title: o.type === 'video' ? 'Download this video' : pages.length ? `PDF of its ${pages.length} pages (or the user's own export when reachable)` : 'The original image (or the design as the user saw it)', onclick: () => downloadOutput(this.run, o, fileSkill()) }, icon('download', 'sm'), pages.length ? 'Download PDF' : 'Download') : null,
      src ? h('a', { href: src, target: '_blank', rel: 'noopener' }, 'Open image ↗') : null);
    this.mount.replaceChildren(stage, strip, pageStrip, info);
  }

  currentOutput() {
    return this.outputs[this.index] || null;
  }

  // Player interface: arrows step through outputs.
  seekBy(d) {
    this.index = (this.index + (d > 0 ? 1 : -1) + this.outputs.length) % this.outputs.length;
    this.page = -1;
    this.render();
  }
  step(d) {
    this.seekBy(d);
  }
  toggle() {}
  seekSec() {}
  setScenes() {}
  destroy() {}
}

// The product's own Remotion player in an iframe: exact text, captions, music.
class LivePlayer {
  constructor(mount, run) {
    this.frame = h('iframe', { src: '/player/frame.html', allow: 'autoplay; fullscreen' });
    this.status = h('span', {}, 'Loading the product player…');
    const back = h('button', { class: 'mode on', title: 'Back to the review copy (E)', onclick: () => toggleLive() }, icon('sparkle', 'sm'), 'Exact');
    mount.replaceChildren(
      h('div', { class: 'stage' }, this.frame),
      h('div', { class: 'controls' }, h('span', { class: 'time' }, 'Live composition'), h('span', { style: { flex: 1 } }), isReady(mediaOf(run.id)) ? back : null),
      h('div', { class: 'src-note' }, h('span', { class: 'dot', style: { background: 'var(--ok)' } }), this.status),
    );
    const root = run.videoAssetId || (run.outputType === 'video' ? run.adAssetId : null);
    this.input = getJson(`/api/player-input/${run.id}${root ? `?root=${root}` : ''}`);
    this.onMsg = async (e) => {
      if (e.source !== this.frame.contentWindow) return;
      const t = e.data?.type;
      if (t === 'wixel-player:ready') {
        try {
          const input = await this.input;
          this.frame.contentWindow.postMessage({ type: 'wixel-player:init', input, options: { controls: true, autoPlay: true, bundleServerBaseUrl: '' } }, '*');
        } catch (err) {
          this.status.textContent = `Couldn't build the player input: ${err.message}`;
        }
      }
      if (t === 'wixel-player:mounted') this.status.textContent = 'Exact composition — the product player (text, captions, music). Captions may show even when the export has them off.';
      if (t === 'wixel-player:error') this.status.textContent = `Player error: ${e.data.error}`;
    };
    window.addEventListener('message', this.onMsg);
  }

  setScenes() {}
  toggle() {}
  step() {}
  seekBy() {}
  seekSec() {}

  destroy() {
    window.removeEventListener('message', this.onMsg);
    try {
      this.frame.contentWindow?.postMessage({ type: 'wixel-player:dispose' }, '*');
    } catch {}
    this.frame.remove();
  }
}

// ---------- detail sections ----------
function section(title, count, ...body) {
  return h('div', { class: 'section' }, h('h4', {}, title, count != null ? h('span', { class: 'n' }, count) : null), ...body);
}

function outcome(r, d) {
  const pills = [];
  if (r.userDownloads) pills.push(h('span', { class: 'pill info', title: r.downloadedAt ? new Date(r.downloadedAt).toLocaleString() : '' }, icon('download', 'sm'), `Downloaded ${r.userDownloads}× in the editor`));
  if (r.agentDownloads) pills.push(r.agentDownloadLink
    ? h('a', { class: 'pill info', href: r.agentDownloadLink, target: '_blank', rel: 'noopener' }, icon('download', 'sm'), 'Downloaded via the agent')
    : h('span', { class: 'pill info' }, icon('download', 'sm'), 'Asked the agent to download'));
  if (!r.userDownloads && !r.agentDownloads) pills.push(h('span', { class: 'pill' }, icon('download', 'sm'), 'Not downloaded'));
  pills.push(r.publishedUrl
    ? h('a', { class: 'pill ok', href: r.publishedUrl, target: '_blank', rel: 'noopener' }, icon('globe', 'sm'), 'Published')
    : h('span', { class: 'pill' }, icon('globe', 'sm'), 'Not published'));
  for (const f of d.feedback || []) pills.push(h('span', { class: `pill ${f.value === 'thumbs_up' ? 'ok' : 'err'}` }, icon(f.value === 'thumbs_up' ? 'up' : 'down', 'sm'), f.value === 'thumbs_up' ? 'Thumbs up' : 'Thumbs down', f.tags?.length ? ` · ${f.tags.join(', ')}` : ''));
  if (d.outOfFunds?.length) pills.push(h('span', { class: 'pill warn', title: d.outOfFunds.map((o) => o.message).join('\n') }, icon('card', 'sm'), `Out of credits ×${d.outOfFunds.length}`));
  if (failedRun(r)) pills.push(h('span', { class: 'pill err' }, icon('alert', 'sm'), 'Generated but no finished video'));
  return section('Outcome', null, h('div', { class: 'pills' }, pills));
}

function mood(d) {
  if (!d.sentiments?.length) return null;
  return section('User mood by turn', d.sentiments.length, h('div', { class: 'mood' }, d.sentiments.map((s, i) => {
    const m = MOOD[s.label] || MOOD.neutral;
    return h('div', { class: 'row' }, h('span', { class: `s ${s.label}` }, icon(m.icon)), h('div', {}, h('b', {}, `Turn ${i + 1}: ${m.label}`), s.detail ? h('div', { class: 'd' }, s.detail) : null));
  })));
}

// The user's own words first; injected context (<HIDDEN>…) folds away. The fade + "Show all"
// only appear when the text actually overflows (measured after render), never over a short prompt.
function splitPrompt(text) {
  const t = String(text || '');
  const i = t.search(/<HIDDEN>/i);
  if (i < 0) return { said: t.trim(), hidden: null };
  return { said: t.slice(0, i).trim(), hidden: t.slice(i).replace(/<\/?HIDDEN>/gi, '').trim() };
}

function promptBlock(text, cls = '') {
  const { said, hidden } = splitPrompt(text);
  const p = h('div', { class: `prompt ${cls}` }, said || '—');
  const more = h('button', { class: 'linkish', hidden: true, onclick: () => { p.classList.toggle('open'); more.textContent = p.classList.contains('open') ? 'Show less' : 'Show all'; } }, 'Show all');
  requestAnimationFrame(() => {
    if (p.scrollHeight > p.clientHeight + 4) {
      p.classList.add('long');
      more.hidden = false;
    }
  });
  return [p, more, hidden ? h('details', { class: 'hidden-ctx' }, h('summary', {}, 'Hidden context sent with the request'), h('pre', { class: 'tl-pre' }, hidden)) : null];
}

function request(d) {
  const follow = (d.userMessages || []).slice(1);
  return section('Request', null, ...promptBlock(d.prompt),
    follow.length ? h('div', { style: { marginTop: '10px' } }, h('h4', {}, 'Follow-ups', h('span', { class: 'n' }, follow.length)),
      ...follow.map((m) => h('div', { class: 'prompt open followup' }, `› ${splitPrompt(m.text).said}`))) : null);
}

function errorsSection(d) {
  if (!d.errors?.length) return null;
  const t0 = d.timing?.firstAt || 0;
  return section('Errors', d.errors.length, h('div', { class: 'errs' }, d.errors.slice(0, 30).map((e) => h('div', { class: 'err-row' },
    h('div', { class: 'h' }, h('span', {}, [e.source, e.tool, e.method].filter(Boolean).join(' · ')), h('span', { class: 'at mono' }, e.at && t0 ? `+${dur(e.at - t0)}` : '')),
    h('pre', {}, String(e.message).slice(0, 800))))));
}

// A scene without a snapshot shows the picture its clip was made from (the image-to-video input),
// or failing that a frame of the clip itself.
function sceneThumb(s, d) {
  if (s.thumbnailUrl) return h('div', { class: 'im', style: { backgroundImage: `url(${s.thumbnailUrl})` } });
  const byId = new Map((d.steps || []).map((x) => [x.id, x]));
  const img = (s.lineage || []).map((id) => byId.get(id)).flatMap((x) => x?.mediaOut || []).find((m) => m.kind === 'image');
  if (img) return h('div', { class: 'im', style: { backgroundImage: `url(${img.url})` } });
  if (s.clipUrl) return h('video', { class: 'im', src: `${s.clipUrl}#t=0.5`, muted: true, preload: 'metadata', playsinline: true });
  return h('div', { class: 'im' });
}

function scenes(d) {
  const sc = d.outputs?.scenes || [];
  if (!sc.length) return null;
  return section('Scenes', sc.length, h('div', { class: 'scenes' }, sc.map((s) => h('div', { class: 'scene', title: s.texts?.join('\n') || s.name, onclick: () => current?.player?.seekSec(s.startSec) },
    sceneThumb(s, d),
    h('div', { class: 'tc' }, `${tc(s.startSec)} · ${((s.endSec - s.startSec)).toFixed(1)}s`),
    h('div', { class: 'n' }, s.texts?.[0] || s.name)))));
}

function ids(r, d) {
  const row = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, h('span', { class: 'mono', style: { cursor: 'copy' }, title: 'Click to copy', onclick: () => copy(v) }, v))] : null);
  return section('Identifiers', null, h('dl', { class: 'kv' },
    row('Session', r.id), row('Project', r.projectId || d.projectId), row('Ad asset', r.adAssetId), row('MSID', r.msid || d.msid),
    row('User', r.userId), row('Account', r.accountId), row('Skill version', (r.codexVersions || []).join(', '))),
    h('div', { class: 'links', style: { marginTop: '10px' } },
      h('a', { class: 'btn', href: ADMIN + r.id, target: '_blank', rel: 'noopener' }, icon('external'), 'Wixel admin'),
      r.publishedUrl ? h('a', { class: 'btn', href: r.publishedUrl, target: '_blank', rel: 'noopener' }, icon('globe'), 'Published page') : null,
      isReady(mediaOf(r.id)) ? h('button', { class: 'btn', onclick: () => downloadRun(r, state.skill) }, icon('download'), mediaOf(r.id).kind === 'render' ? 'Exact render mp4' : 'Review copy mp4') : null,
    ));
}

function details(r, d) {
  if (d.error) return [h('div', { class: 'loading-line' }, `Couldn't load this run: ${d.error}`)];
  return [outcome(r, d), mood(d), request(d), errorsSection(d), scenes(d), ids(r, d)].filter(Boolean);
}

export { worstMood };
