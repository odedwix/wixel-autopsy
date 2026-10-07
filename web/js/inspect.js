import { h, icon, ago, dur, dateTime, tc, getJson, copy } from './util.js';
import { state, set, famParam } from './state.js';
import { renderTimeline } from './timeline.js';
import { renderScenes, renderBrand, renderAssets, renderRaw } from './deep.js';
import { shareRun, publicOutputUrl } from './share.js';
import { printReport, downloadReport, section as rpSection } from './report.js';
import { CAT_COLOR, CAT_LABEL } from './insights.js';
import { caps, capsReady, HINT } from './caps.js';
import { toast, popover, closePopover } from './ui.js';
import { MOOD, worstMood, failedRun, hasAd, primaryOutput, typeLabel, getExpected, STOPS, stopFact } from './filters.js';
import { runTimeBar } from './timebar.js';
import { isVideoRun } from './grid.js';
import { mediaOf, isReady, prioritize, onMedia, videoUrl, spriteUrl, posterUrl, placeSprite, downloadRun, downloadOutput } from './media.js';
import { showUser } from './skillpicker.js';
import { modelStats, detailSteps, money, pricesReady } from './models.js';

const ADMIN = 'https://wix-bo.com/wixel-agent/admin/#/sessions/';
const detailCache = new Map();
// After Refresh, each run's session is read again from the admin API the first time it's opened.
let refreshed = false;
const reread = new Set();
// `ids`: only these runs (Refresh's top-up); none = every run (full refresh).
const freshIds = new Set();
export function clearDetails(ids) {
  if (ids) {
    for (const key of [...detailCache.keys()]) if (ids.some((id) => key.startsWith(id))) detailCache.delete(key);
    for (const id of ids) {
      freshIds.add(id);
      reread.delete(id);
    }
    return;
  }
  detailCache.clear();
  reread.clear();
  refreshed = true;
}

// In skill mode the detail says which turns count for the skill (same rule as the grid).
export function prefetchDetail(id) {
  const q = state.mode === 'user' ? '' : `?skill=${encodeURIComponent(state.skill)}&fam=${encodeURIComponent(famParam())}`;
  const key = `${id}${q}`;
  if (!detailCache.has(key)) {
    const fresh = (refreshed || freshIds.has(id)) && !reread.has(id);
    if (fresh) reread.add(id);
    detailCache.set(key, getJson(`/api/session/${id}${q}${fresh ? `${q ? '&' : '?'}fresh=1` : ''}`).catch((e) => ({ error: e.message })));
  }
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
let autoReported = false;
let current = null; // { run, player }

export function initInspect(el, { close }) {
  panel = el;
  panel._close = close;
  onMedia((ids) => {
    if (!current || !ids.includes(current.run.id)) return;
    mountPlayer(current.run);
    // The download choices depend on the media (exact render vs review copy).
    panel.querySelector('.insp-head')?.replaceWith(header(current.run, current.detail || null));
  });
}

export function openInspect(run) {
  if (!run) return;
  panel.hidden = false;
  if (current?.run.id === run.id) {
    // Opened early from a link with only an id; now the list row (signals, render links) is here.
    if ((current.run._stub || current.run._detailOnly) && !run._stub) {
      current.run = run;
      panel.querySelector('.insp-head')?.replaceWith(header(run, current.detail || null));
      mountPlayer(run);
      maybeAutoReport();
    }
    return;
  }
  destroyPlayers();
  current = { run, player: null };
  panel.classList.toggle('wide', Boolean(state.inspectWide));
  panel.replaceChildren(header(run, null), h('div', { class: 'insp-body' }, h('div', { class: 'player', id: 'playerMount' }), tabBar(), h('div', { id: 'detailMount' }, h('div', { class: 'loading-line' }, 'Loading run…'))));
  mountPlayer(run);
  prioritize(run.id);
  // Capabilities may still be loading when a run opens from a link.
  capsReady.then(() => current?.run.id === run.id && isVideoRun(current.run) && caps.exact && refreshExact(current.run));
  prefetchDetail(run.id).then(async (d) => {
    if (current?.run.id !== run.id) return;
    current.detail = d;
    // Opened from a link and not in the list (another window, sampled out): the proxy's row if it
    // has one, else the run as its detail describes it — so Download, Share and reports work.
    if (current.run._stub && !d.error) {
      const row = await getJson(`/api/run/${run.id}`).catch(() => null);
      if (current?.run.id !== run.id) return;
      if (current.run._stub) current.run = row || { ...reportRun(current.run, d), _stub: false, _detailOnly: true };
      mountPlayer(current.run);
      capsReady.then(() => current && isVideoRun(current.run) && caps.exact && refreshExact(current.run));
    }
    panel.querySelector('.insp-head').replaceWith(header(run, d));
    renderTab();
    // Model prices may land after the run (first open of the app).
    pricesReady.then(() => current?.run.id === run.id && tabOf(state.inspectTab) === 'overview' && renderTab());
    current.review?.setScenes?.(d.outputs?.scenes || []);
    current.player?.setDetail?.(d);
    maybeAutoReport();
  });
}

// ---------- tabs ----------
const TABS = [['overview', 'Overview', '1'], ['timeline', 'Timeline', '2'], ['scenes', 'Scenes', '3'], ['media', 'Brand & media', '4'], ['raw', 'Raw', '5']];
// Saved views from before Brand and Assets were one tab.
const tabOf = (t) => (t === 'brand' || t === 'assets' ? 'media' : TABS.some(([k]) => k === t) ? t : 'overview');

function tabBar() {
  return h('div', { class: 'insp-tabs', role: 'tablist' }, TABS.map(([k, label, key]) =>
    h('button', { role: 'tab', 'aria-selected': String(tabOf(state.inspectTab) === k), title: `${label} (${key})`, onclick: () => setInspectTab(k) }, label)));
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
  const tab = tabOf(state.inspectTab);
  const box = h('div', { class: 'section dz' });
  const seek = (sec) => current?.player?.seekSec(sec);
  if (tab === 'overview') return mount.replaceChildren(...[banner, ...details(current.run, d)].filter(Boolean));
  mount.replaceChildren(...[banner, box].filter(Boolean));
  if (tab === 'timeline') renderTimeline(box, d);
  if (tab === 'scenes') renderScenes(box, d, { seek });
  if (tab === 'media') {
    renderBrand(box, d);
    const as = h('div', { class: 'section dz' });
    mount.append(as);
    renderAssets(as, d);
  }
  if (tab === 'raw') renderRaw(box, d);
}

function destroyPlayers() {
  if (!current) return;
  for (const p of new Set([current.player, current.review, current.exact])) p?.destroy();
  current.player = current.review = current.exact = null;
}

export function closeInspect() {
  destroyPlayers();
  current = null;
  if (panel) {
    panel.hidden = true;
    panel.replaceChildren();
  }
}

export const inspectedPlayer = () => current?.player || null;
export const inspectedRun = () => current?.run || null;

// ?report=run on a run link builds its PDF report once both the list row and the detail are in
// (scripted / headless export).
// The list may never contain the run (another skill's view, an old link): once it has loaded, the
// report is built from the run's own detail instead.
let listDone = false;
export function listLoaded() {
  listDone = true;
  maybeAutoReport();
}
async function maybeAutoReport() {
  if (autoReported || new URLSearchParams(location.search).get('report') !== 'run') return;
  if (!current || !current.detail) return;
  autoReported = true;
  // The list row (downloads, publishes, user type, cost) straight from the proxy if it has it;
  // otherwise the report is built from the run's detail.
  if (current.run._stub) {
    const row = await getJson(`/api/run/${current.run.id}`).catch(() => null);
    if (row && current) current.run = row;
  }
  buildRunReport(current.run);
}

// The run as the report shows it: the list row, or (not in the list) what its detail says.
function reportRun(r, d) {
  if (!r._stub && (r.outputs || r.title || r.adName)) return r;
  // Only what this session made (the project also holds other sessions' work).
  const outs = (d.assetTree || []).filter((a) => a.own !== false).map((a) => ({ id: a.id, type: a.type === 'slide' ? 'slides' : a.type, name: a.name, thumb: a.thumbnailUrl }));
  return {
    ...r,
    videoAssetId: r.videoAssetId || (d.outputs?.kind === 'video' ? d.outputs.rootAssetId : null),
    storyAssetId: r.storyAssetId || (d.outputs?.kind === 'story' ? d.outputs.rootAssetId : null),
    title: d.title || d.outputs?.name || String(d.prompt || '').replace(/<HIDDEN>[\s\S]*/i, '').trim().slice(0, 70) || null,
    adName: d.outputs?.name || outs[0]?.name || null,
    outputs: outs,
    outputType: outs[0]?.type || null,
    createdAt: d.createdAt,
    wallMs: d.timing?.wallMs,
    generations: d.generations,
    agent: d.agentName,
    source: d.source,
    userType: d.user?.isWixEmail ? 'employee' : r.userType,
    sentiments: (d.sentiments || []).map((x) => x.label),
  };
}

// Name, user, run time and date — in the report's title and its file name.
function reportNames(r, d) {
  const name = r.adName?.replace(/\s*[-—]\s*Root$/i, '') || r.title || 'Untitled run';
  const email = d.user?.email || null;
  const runTime = dur(d.timing?.wallMs ?? r.wallMs);
  const at = new Date(r.createdAt || d.createdAt || Date.now());
  const date = `${at.toISOString().slice(0, 10)} ${String(at.getHours()).padStart(2, '0')}.${String(at.getMinutes()).padStart(2, '0')}`;
  const skill = state.mode === 'user' ? null : state.skill;
  return {
    name,
    meta: [email, runTime, dateTime(at.getTime())].filter(Boolean).join(' · '),
    file: [name.slice(0, 70), email, runTime.replace(/\s+/g, ''), date, skill, r.id.slice(0, 8)].filter(Boolean).join(' · '),
  };
}

async function exportRunReport(r) {
  const full = current?.detail && !current.detail.error ? current.detail : await prefetchDetail(r.id);
  if (!full || full.error) return toast(`Can't build the report: ${full?.error || 'run not loaded'}`);
  const run = reportRun(r, full);
  await downloadReport({ kind: 'run', fileName: reportNames(run, full).file, inPage: () => buildRunReport(run) });
}

// ---------- run report (PDF) ----------
// Everything about one run on paper: the facts, outputs, request, errors, the timeline, every step
// (with links to its output and graph run), scenes, brand and assets, in the dark UI's colours.
const PLUMB = new Set(['read', 'list', 'skill', 'write', 'send_feedback', 'task_status', 'poll_process_job']);
async function buildRunReport(r0) {
  const full = current?.detail && !current.detail.error ? current.detail : await prefetchDetail(r0.id);
  if (!full || full.error) return toast(`Can't build the report: ${full?.error || 'run not loaded'}`);
  const r = reportRun(r0, full);
  const names = reportNames(r, full);
  const d = counted(full);
  const p = primaryOutput(r);
  const m = mediaOf(r.id);
  const out = publicOutputUrl(r);
  const name = names.name;
  const ut = r.userType === 'employee' ? 'Employee' : r.userType === 'wixel-team' ? 'Wixel team' : r.userType === 'real' ? 'Real user' : '';
  const t0 = d.timing?.firstAt || r.createdAt;
  const skill = state.mode === 'user' ? (r.allSkills || []).join(', ') : state.skill;
  const temporal = caps.temporalUi ? (wid) => `${caps.temporalUi.replace(/\/workflows\/?$/, '')}/workflows?query=${encodeURIComponent(`WorkflowId STARTS_WITH "${wid}"`)}` : null;
  const fact = (v, k, bad) => h('div', { class: `rp-fact${bad ? ' bad' : ''}` }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
  await printReport({
    title: name,
    titleMeta: names.meta,
    subtitle: [skill, ut, r.agent ? `${r.agent}${r.source ? ` / ${r.source}` : ''}` : null].filter(Boolean).join(' · '),
    fileName: names.file,
    links: [
      { href: ADMIN + r.id, label: 'Wixel admin ↗' },
      out ? { href: out.url, label: `${out.label} ↗` } : null,
      r.publishedUrl && r.publishedUrl !== out?.url ? { href: r.publishedUrl, label: 'Published page ↗' } : null,
      { href: `${location.origin}/${location.hash}`, label: 'Open in Autopsy (local app)' },
    ],
    build: (body) => {
      const errs = (d.errors || []).length;
      body.append(...[
        h('div', { class: 'rp-facts' },
          fact(hasAd(r) ? `${(r.outputs || []).length || 1} × ${typeLabel(p?.type || r.outputType || 'output')}` : failedRun(r) ? 'No output' : 'Nothing made', 'Result', !hasAd(r)),
          fact(r.userDownloads || r.agentDownloads ? 'Yes' : 'No', 'Downloaded'),
          fact(r.publishedUrl ? 'Yes' : 'No', 'Published'),
          fact(worstMood(r) ? MOOD[worstMood(r)]?.label || worstMood(r) : '–', 'Worst mood', ['frustrated', 'confused'].includes(worstMood(r))),
          fact(String(errs), 'Errors', errs > 0),
          fact(String(d.generations ?? r.generations ?? 0), 'Generations'),
          fact(dur(d.timing?.wallMs), 'Wall time'),
          d.assetBuild?.final ? fact(dur(d.assetBuild.final.ms), 'Building the result') : null,
          r.costUsd != null ? fact(`$${r.costUsd.toFixed(2)}`, 'Cost') : null,
          fact(`${Math.round((d.cost?.inputTokens || 0) / 1000)}k / ${Math.round((d.cost?.outputTokens || 0) / 1000)}k`, 'Tokens in / out')),
        heroOf(r, m),
        scopeBanner(full) ? h('p', { class: 'rp-sub' }, scopeBanner(full).querySelector('span')?.textContent) : null,
      ].filter(Boolean));
      body.append(rpSection('Overview', details(r, d)));
      const tl = h('div', { class: 'section dz' });
      body.append(rpSection('Timeline', tl));
      renderTimeline(tl, d);
      body.append(rpSection(`Steps (${d.steps.length})`, stepsTable(d, t0, temporal)));
      if (d.outputs?.scenes?.length) {
        const sc = h('div', { class: 'section dz' });
        body.append(rpSection('Scenes', sc));
        renderScenes(sc, d, { seek: () => {} });
      }
      const br = h('div', { class: 'section dz' });
      body.append(rpSection('Brand', br));
      renderBrand(br, d);
      const as = h('div', { class: 'section dz' });
      body.append(rpSection('Assets', as));
      renderAssets(as, d);
    },
  }).catch((err) => toast(`Couldn't build the report: ${err.message}`));
}

function heroOf(r, m) {
  const imgs = [];
  if (isVideoRun(r) && isReady(m)) imgs.push(posterUrl(r.id));
  for (const o of r.outputs || []) if (o.thumb && o.type !== 'video') imgs.push(o.thumb);
  if (!imgs.length && r.thumbnail) imgs.push(r.thumbnail);
  return imgs.length ? h('div', { class: 'rp-hero' }, imgs.slice(0, 6).map((src) => h('img', { src, alt: '' }))) : null;
}

function stepsTable(d, t0, temporal) {
  const rows = d.steps.filter((s) => !PLUMB.has(s.tool) || s.category === 'assets' || s.status === 'failed');
  return h('table', { class: 'rp-steps' },
    h('thead', {}, h('tr', {}, ...['Step', 'Kind', 'Starts', 'Takes', 'Status', 'Model', 'Links'].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((s) => h('tr', { class: s.status === 'failed' ? 'fail' : '' },
      h('td', {}, s.label, s.error ? h('div', { class: 'rp-err' }, String(s.error).slice(0, 240)) : null),
      h('td', { class: 'kind' }, h('span', { class: 'cat', style: { background: CAT_COLOR[s.category] || 'var(--text-3)' } }), CAT_LABEL[s.category] || s.category),
      h('td', { class: 'num' }, `+${dur(s.startedAt - t0)}`),
      h('td', { class: 'num' }, dur(s.durationMs)),
      h('td', {}, s.status),
      h('td', {}, s.model || ''),
      h('td', { class: 'lnk' }, ...[
        s.resultUrl && /^https?:/.test(s.resultUrl) ? h('a', { href: s.resultUrl, target: '_blank', rel: 'noopener' }, 'output ↗') : null,
        s.workflowId && temporal ? h('a', { href: temporal(s.workflowId), target: '_blank', rel: 'noopener' }, 'graph ↗') : null,
      ].filter(Boolean))))));
}

// ---------- downloads ----------
// The Exact composition as an mp4 (runs with no render): rendered once by the proxy from the product
// player, frame by frame (server/exact.js), then cached. Status per run, refreshed while rendering.
const exactState = new Map();
async function refreshExact(run) {
  const s = await getJson(`/api/exact/${run.id}`).catch(() => null);
  if (s) exactState.set(run.id, s);
  if (current?.run.id === run.id) panel.querySelector('.insp-head')?.replaceWith(header(current.run, current.detail || null));
  return s;
}
// Captions go into the download only if a person turned them on: the user in the editor, or you
// with CC in the player for this run (the agent switching them on itself doesn't count).
const viewerCaptions = (run) => Boolean(current?.exact?.run.id === run.id && current.exact.captions);
async function downloadExact(run) {
  await capsReady;
  const cc = viewerCaptions(run);
  const key = `${run.id}${cc ? '|cc' : ''}`;
  const q = cc ? '&cc=1' : '';
  let s = exactState.get(key);
  if (s?.state !== 'ready') s = await getJson(`/api/exact/${run.id}?start=1${q}`).catch((e) => ({ state: 'failed', error: e.message }));
  while (['queued', 'loading', 'rendering', 'encoding'].includes(s?.state)) {
    toast(s.state === 'rendering' ? `Preparing the video${cc ? ' with captions' : ''}… ${s.done} / ${s.total} frames` : s.state === 'encoding' ? 'Encoding the mp4…' : 'Loading the product player…', { ms: 5000 });
    await new Promise((r) => setTimeout(r, 1500));
    s = await getJson(`/api/exact/${run.id}?${q.slice(1)}`).catch(() => s);
  }
  exactState.set(key, s);
  if (s?.state !== 'ready') return toast(`Couldn't prepare the video: ${s?.error || 'unknown error'}`, { ms: 8000 });
  toast(`Video ready — downloading${cc ? ' (with captions)' : ''}`, { ms: 3000 });
  downloadRun(run, fileSkill(), 'exact', { cc });
  if (current?.run.id === run.id) panel.querySelector('.insp-head')?.replaceWith(header(current.run, current.detail || null));
}

// Downloads are the exact output only (a copy that doesn't show what the user got isn't offered):
//   a video: the user's own render, else the Exact composition rendered from the product's player;
//   a story: the user's own export when it's up to date, else its pages as a PDF (as they look);
//   other outputs the skill makes: their own files.
function downloadChoices(r) {
  const run = current?.run || r;
  const m = mediaOf(run.id);
  const out = [];
  const notReady = () => toast('The video is still being prepared — try again in a moment');
  const story = !run.videoAssetId && run.storyAssetId ? (run.outputs || []).find((o) => o.id === run.storyAssetId) : null;
  if (isVideoRun(run) && hasAd(run)) {
    const ex = exactState.get(`${run.id}${viewerCaptions(run) ? '|cc' : ''}`);
    const rendering = ['queued', 'loading', 'rendering', 'encoding'].includes(ex?.state);
    if (m?.kind === 'render') out.push({ label: story ? 'Story' : 'Video', sub: story ? 'The story export the user made (up to date with the story)' : 'The file the user got: full quality, with text, captions and music', go: () => downloadRun(run, fileSkill()) || notReady() });
    else if (exactRoot(run) && caps.exact) {
      out.push({
        label: story ? 'Story' : 'Video',
        sub: `${ex?.state === 'ready' ? 'As the product plays it: text overlays and music' : rendering ? `Rendering… ${ex.done || 0} / ${ex.total || '?'} frames` : 'As the product plays it — renders in ~2 min the first time'} · ${viewerCaptions(run) ? 'with captions (you turned them on)' : 'captions only if the user turned them on'}`,
        go: () => downloadExact(run),
      });
    }
  }
  const main = new Set([run.videoAssetId, story?.id].filter(Boolean));
  for (const o of (run.outputs || []).filter((x) => !main.has(x.id) && x.type !== 'video')) {
    out.push({ group: out.length ? 'Its other outputs' : null, label: `${typeLabel(o.type)}${o.name ? ` · ${o.name}` : ''}`, sub: ['slides', 'doc', 'story'].includes(o.type) ? 'PDF of its pages (or the user’s own export when reachable)' : 'Original image, or the design as the user saw it', go: () => downloadOutput(run, o, fileSkill()) });
  }
  return out;
}

// The D key and the grid: the same exact-only download for a run that isn't open.
export function downloadExactRun(run) {
  const m = mediaOf(run.id);
  if (m?.kind === 'render') return downloadRun(run, fileSkill()) || toast('The video is still being prepared — try again in a moment');
  if (!exactRoot(run)) return toast('This run has no finished video (only clips) — nothing to download');
  if (!caps.exact) return toast('Video downloads need Google Chrome and the player build (npm run build:player)', { ms: 6000 });
  return downloadExact(run);
}

// Download: one choice downloads right away; more than one (regular and exact full ad, other
// outputs) opens a menu listing them all.
function downloadButton(r) {
  const choices = downloadChoices(r);
  if (!choices.length) return null;
  if (choices.length === 1) return h('button', { class: 'btn dl-main', title: `${choices[0].label}: ${choices[0].sub} (D)`, onclick: () => choices[0].go() }, icon('download'), 'Download');
  const btn = h('button', { class: 'btn dl-main', title: 'Choose what to download (D)', onclick: () => {
    let group = null;
    const rows = [];
    for (const c of downloadChoices(r)) {
      if (c.group && c.group !== group) rows.push(h('div', { class: 'sh-h' }, (group = c.group)));
      rows.push(h('button', { class: 'sh-row', onclick: () => { closePopover(); c.go(); } }, icon('download'), h('span', {}, h('b', {}, c.label), h('small', {}, c.sub))));
    }
    popover(btn, h('div', { class: 'sh-pop' }, h('div', { class: 'sh-h' }, 'Download'), ...rows), { align: 'right', width: 360 });
  } }, icon('download'), 'Download', icon('down', 'sm'));
  return btn;
}

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
        // A campaign's sub-agent: the session that started it.
        r.parentSessionId ? [h('span', { class: 'sep' }, '·'), h('a', { href: ADMIN + r.parentSessionId, target: '_blank', rel: 'noopener', title: 'This run is a sub-agent; open the session that started it (Wixel admin)' }, 'parent session ↗')] : null,
      ),
    ),
    downloadButton(r),
    h('button', { class: 'btn share-btn', title: 'Share this run', onclick: (e) => shareRun(e.currentTarget, current?.run || r, current?.detail || d, { exportPdf: () => exportRunReport(current?.run || r) }) }, icon('external'), 'Share'),
    h('button', { class: 'icon-btn', title: 'Wide panel (W)', onclick: () => toggleWide() }, icon('expand')),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => panel._close() }, icon('x')),
  );
}

// ---------- player ----------
// Video runs: the regular copy (review mp4, ready in seconds) plays at once while the Exact
// composition (the product's own player: text overlays, music, exact timing) loads hidden behind
// it; once every file is in memory it takes over at the same moment and keeps playing. E switches
// back and forth. Runs whose video is the user's own render already show the exact thing.
// The composition the exact player draws: the run's video, or its story (pages as timed scenes —
// the same clip, text and image components the product uses; see server/player.js).
const exactRoot = (r) => r.videoAssetId || r.storyAssetId || null;
const exactWanted = (r) => !r._stub && hasAd(r) && Boolean(exactRoot(r)) && isVideoRun(r) && mediaOf(r.id)?.kind !== 'render';

function mountPlayer(r) {
  const mount = panel.querySelector('#playerMount');
  if (!mount) return;
  current.review?.destroy();
  current.review = null;
  // Skills that make images, logos, docs, slides… get a gallery instead of a video player.
  if (!r._stub && !isVideoRun(r) && (r.outputs?.length || r.thumbnail)) {
    current.exact?.destroy();
    current.exact = null;
    current.player = new OutputViewer(mount, r, current.detail);
    return;
  }
  // Two layers: the regular copy, and the Exact player kept alive across re-mounts.
  let main = mount.querySelector(':scope > .pv-main');
  if (!main) {
    mount.replaceChildren(main = h('div', { class: 'pv-main' }));
    if (current.exact) mount.append(current.exact.el);
  }
  const m = mediaOf(r.id);
  // An older player build (no AutopsyLive): the product player only on request (E), as before.
  if (!caps.live && current.live && caps.player) {
    current.review = current.player = new LivePlayer(main, r);
    return;
  }
  // Behind a showing Exact player the regular copy waits paused.
  current.review = isReady(m) ? new ReviewPlayer(main, r, m, { autoplay: !current.exact?.shown }) : null;
  if (!current.review) {
    // A run that made nothing says why, as its card does (server/runs.js stopReason).
    if (r.stop && !hasAd(r)) {
      const d = STOPS[r.stop.kind] || STOPS.ended;
      const fact = stopFact(r.stop);
      main.replaceChildren(h('div', { class: 'stage' }, h('div', { class: `stop-note${d.tone ? ` ${d.tone}` : ''}` },
        icon(d.icon), h('b', {}, d.title ? d.title(r.stop) : d.label), fact ? h('div', { class: 'fact' }, fact) : null, r.stop.text ? h('q', {}, r.stop.text) : null)));
    } else {
      const why = !r.generations ? 'This run never reached generation.' : m?.state === 'failed' ? `Couldn't prepare video: ${m.reason}` : m?.state === 'unavailable' ? m.reason : 'Preparing the video…';
      main.replaceChildren(h('div', { class: 'stage' }, h('div', { class: 'note' }, why)));
    }
  }
  if (current.detail) current.review?.setScenes?.(current.detail.outputs?.scenes || []);
  startExact(r);
  // The capabilities can arrive after a run opened from a link.
  if (caps.live === undefined) capsReady.then(() => current?.run === r && startExact(r));
}

function startExact(r) {
  const mount = panel.querySelector('#playerMount');
  if (mount && caps.live && exactWanted(r) && !current.exact) {
    current.exact = new ExactLayer(r, { onReady: () => current?.exact && !current.preferRegular && showExact(true), onStatus: () => syncExactUi() });
    mount.append(current.exact.el);
  }
  current.player = current.exact?.shown ? current.exact : current.review;
  syncExactUi();
}

// Flip between the regular copy and the Exact player, carrying over the position and play state.
function showExact(on) {
  const x = current?.exact;
  if (!x?.ready) return;
  const rv = current.review;
  const t = on ? rv?.v?.currentTime ?? 0 : x.timeSec();
  const playing = on ? (rv ? !rv.v.paused : true) : x.isPlaying();
  const muted = rv?.v?.muted ?? false;
  if (on) {
    rv?.v?.pause();
    x.show(t, { play: playing, muted });
  } else {
    x.hide();
    if (rv?.v) {
      rv.v.currentTime = Math.min(t, rv.duration);
      if (playing) rv.v.play().catch(() => {});
    }
  }
  current.player = on ? x : rv;
  panel.querySelector('#playerMount .pv-main')?.toggleAttribute('hidden', on);
  syncExactUi();
}

// No switch on screen any more (one player at a time, and E for anyone who wants the other); kept as
// the hook the preload calls.
function syncExactUi() {}

// ~ : the player on screen (the product's own, or the regular copy) full screen, and back. From the app's
// keys only with the pointer over the player; from inside the product player (live.html forwards it)
// always, since the focus being there means it's the one in use.
export function togglePlayerFullscreen({ hovered = true } = {}) {
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    return true;
  }
  const mount = panel?.querySelector('#playerMount');
  if (!mount || (hovered && !mount.matches(':hover'))) return false;
  const stage = mount.querySelector(current?.exact?.shown ? '.pv-exact .stage' : '.pv-main:not([hidden]) .stage') || mount.querySelector('.stage');
  if (!stage) return false;
  stage.requestFullscreen?.().catch(() => {});
  return true;
}
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.type === 'autopsy-key' && e.data.code === 'Backquote') togglePlayerFullscreen({ hovered: false });
});

export function toggleLive() {
  if (!current || !hasAd(current.run)) return;
  if (caps.live && current.exact) {
    if (!current.exact.ready) return toast(current.exact.error ? `The product’s player failed: ${current.exact.error}` : `${current.exact.status} — it takes over by itself when ready`, { ms: 4000 });
    current.preferRegular = current.exact.shown;
    return showExact(!current.exact.shown);
  }
  if (!caps.player && !(current.player instanceof LivePlayer)) {
    toast(HINT.player, { ms: 6000 });
    return;
  }
  const wasLive = current.player instanceof LivePlayer;
  current.live = !wasLive;
  mountPlayer(current.run);
}

class ReviewPlayer {
  constructor(mount, run, meta, { autoplay = true } = {}) {
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
    const canExact = Boolean(exactRoot(run)) && meta.kind !== 'render';
    const controls = h('div', { class: 'controls' }, this.playBtn, this.time, h('span', { style: { flex: 1 } }), this.rateBtn, this.muteBtn,
      h('button', { title: 'Download (D)', onclick: () => panel.querySelector('.insp-head .dl-main')?.click() }, icon('download')),
      h('button', { title: 'Fullscreen', onclick: () => stage.requestFullscreen?.() }, icon('expand')));
    const note = h('div', { class: 'src-note' }, h('span', { class: 'dot', style: { background: meta.kind === 'render' ? 'var(--ok)' : meta.kind === 'assembled' ? 'var(--info)' : 'var(--warn)' } }),
      h('span', {}, `${meta.label} · ${meta.duration.toFixed(1)}s · ${src === 'Exact render' ? 'what the user got' : !canExact ? 'no finished composition to show exactly' : caps.live ? 'the product’s own player takes over as soon as it has loaded' : 'press E for the product’s own player'}`));
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
    if (autoplay) this.v.play().catch(() => {
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

// The Exact composition: the product's own player (web/player/live.html, AutopsyLive from the
// capture bundle) in a same-origin iframe, loaded hidden while the regular copy plays. Captions
// start off (CC turns them on); the player input is built from the run's own video asset.
class ExactLayer {
  constructor(run, { onReady, onStatus } = {}) {
    this.run = run;
    this.ready = false;
    this.shown = false;
    this.error = null;
    this.captions = false;
    this.hasCaptions = false;
    this.onReady = onReady;
    this.onStatus = onStatus;
    this.t0 = Date.now();
    this.frame = h('iframe', { src: '/player/live.html', allow: 'autoplay; fullscreen', title: 'The product’s own player' });
    this.ccBtn = h('button', { class: 'mode cc', title: 'Captions (C)', hidden: true, onclick: () => this.setCaptions(!this.captions) }, h('span', {}, 'CC'));
    this.noteText = h('span', {}, '');
    this.el = h('div', { class: 'pv-exact' },
      h('div', { class: 'stage' }, this.frame),
      h('div', { class: 'controls' }, h('span', { style: { flex: 1 } }), this.ccBtn,
        h('button', { title: 'Download (D)', onclick: () => panel.querySelector('.insp-head .dl-main')?.click() }, icon('download'))),
      h('div', { class: 'src-note' }, h('span', { class: 'dot', style: { background: 'var(--ok)' } }), this.noteText));
    this.status = 'Loading the product’s own player';
    this.ticker = setInterval(() => !this.ready && !this.error && this.onStatus?.(), 1000);
    this.frame.addEventListener('load', () => this.load(), { once: true });
  }

  get status() {
    return `${this._status} · ${Math.round((Date.now() - this.t0) / 1000)}s`;
  }

  set status(s) {
    this._status = s;
    this.onStatus?.();
  }

  async load() {
    try {
      const live = this.frame.contentWindow?.autopsyLive;
      if (!live?.available) throw new Error('the Exact player isn’t built — run npm run build:player');
      const input = await getJson(`/api/player-input/${this.run.id}?root=${exactRoot(this.run)}&captions=${this.captions ? 1 : 0}`);
      this.hasCaptions = Boolean(input.autopsy?.hasCaptions);
      this.status = 'Loading every scene';
      this.handle = await live.load(input, { controls: true });
      this.ready = true;
      clearInterval(this.ticker);
      this.ccBtn.hidden = !this.hasCaptions;
      this.ccBtn.classList.toggle('on', this.captions);
      const story = !this.run.videoAssetId;
      this.noteText.textContent = story
        ? `The story · ${(this.handle.frames / this.handle.fps).toFixed(1)}s — every page drawn by the product's own components (clip, text, images) for its duration, with the voice-over and music; page transitions, music ducking and the story's caption style aren't reproduced`
        : `The product’s own player · ${(this.handle.frames / this.handle.fps).toFixed(1)}s — text overlays, music and timing as the user saw them${this.hasCaptions ? ` · captions ${this.captions ? 'on' : 'off (CC)'}` : ''}`;
      this.onStatus?.();
      this.onReady?.();
    } catch (err) {
      clearInterval(this.ticker);
      this.error = String(err?.message || err);
      this.onStatus?.();
    }
  }

  get fps() {
    return this.handle?.fps || 24;
  }
  timeSec() {
    return this.handle ? this.handle.player.getCurrentFrame() / this.fps : 0;
  }
  isPlaying() {
    return Boolean(this.handle?.player.isPlaying());
  }
  seekFrame(f) {
    this.handle?.player.seekTo(Math.max(0, Math.min((this.handle.frames || 1) - 1, Math.round(f))));
  }

  show(t, { play = true, muted = false } = {}) {
    if (!this.handle) return;
    this.shown = true;
    this.el.classList.add('on');
    const p = this.handle.player;
    this.seekFrame(t * this.fps);
    if (muted) p.mute();
    else p.unmute();
    if (!play) return;
    p.play();
    // Browsers can refuse sound without a click on the page: play muted and offer Unmute.
    setTimeout(() => {
      if (!this.shown || p.isPlaying()) return;
      p.mute();
      p.play();
      const btn = h('button', { class: 'unmute', onclick: (e) => { e.stopPropagation(); p.unmute(); p.play(); btn.remove(); } }, icon('volume'), 'Unmute');
      this.el.querySelector('.stage').append(btn);
    }, 700);
  }

  hide() {
    this.shown = false;
    this.el.classList.remove('on');
    this.handle?.player.pause();
  }

  // Captions are part of the composition's input: reload with or without them, same position.
  async setCaptions(on) {
    if (!this.ready) return;
    const t = this.timeSec();
    const playing = this.isPlaying();
    this.captions = on;
    this.ready = false;
    this.t0 = Date.now();
    this.status = on ? 'Adding captions' : 'Removing captions';
    await this.load();
    if (this.ready && this.shown) this.show(t, { play: playing });
  }

  // Player interface (keyboard: space, arrows, , .)
  toggle() {
    const p = this.handle?.player;
    if (p) p.isPlaying() ? p.pause() : p.play();
  }
  seekBy(sec) {
    if (this.handle) this.seekFrame(this.handle.player.getCurrentFrame() + sec * this.fps);
  }
  step(frames) {
    if (!this.handle) return;
    this.handle.player.pause();
    this.seekFrame(this.handle.player.getCurrentFrame() + frames);
  }
  seekSec(sec) {
    if (!this.handle) return;
    this.seekFrame(sec * this.fps);
    this.handle.player.play();
  }
  setScenes() {}

  destroy() {
    clearInterval(this.ticker);
    try {
      this.frame.contentWindow?.autopsyLive?.unload();
    } catch {}
    this.el.remove();
  }
}

// Older player builds (no AutopsyLive): the product's own Remotion player in an iframe, on request.
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
  if (failedRun(r)) pills.push(h('span', { class: 'pill err' }, icon('alert', 'sm'), `Tried, but made no ${(getExpected() || ['output']).map((t) => typeLabel(t).toLowerCase()).join(' or ')}`));
  // What else it wrote, outside what the skill makes (not counted as its output).
  if (r.otherOutputs?.length) pills.push(h('span', { class: 'pill', title: r.otherOutputs.map((o) => `${typeLabel(o.type)} · ${o.name || ''}`).join('\n') }, `Also made ${r.otherOutputs.length} ${[...new Set(r.otherOutputs.map((o) => typeLabel(o.type).toLowerCase()))].join(' / ')}${r.otherOutputs.length > 1 ? 's' : ''} — not what ${state.skill} makes`));
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
// The clip first: the editor's snapshot of a video scene is a blank white frame.
function sceneThumb(s, d) {
  if (s.clipUrl) return h('video', { class: 'im', src: `${s.clipUrl}#t=0.5`, muted: true, preload: 'metadata', playsinline: true });
  if (s.thumbnailUrl) return h('div', { class: 'im', style: { backgroundImage: `url(${s.thumbnailUrl})` } });
  const byId = new Map((d.steps || []).map((x) => [x.id, x]));
  const img = (s.lineage || []).map((id) => byId.get(id)).flatMap((x) => x?.mediaOut || []).find((m) => m.kind === 'image');
  if (img) return h('div', { class: 'im', style: { backgroundImage: `url(${img.url})` } });
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

// Which models this run used: per model, its calls, the time they took and what they cost (the
// product's price list; see models.js), as bars against the run's slowest / most expensive model.
function modelsSection(d) {
  const stats = modelStats([detailSteps(d)]).sort((a, b) => b.ms - a.ms);
  if (!stats.length) return null;
  const maxMs = Math.max(1, ...stats.map((m) => m.ms));
  const maxCost = Math.max(0.0001, ...stats.map((m) => m.cost));
  const totalMs = stats.reduce((a, m) => a + m.ms, 0);
  const totalCost = stats.reduce((a, m) => a + m.cost, 0);
  return section('Models', `${dur(totalMs)} · ${money(totalCost)}`, h('div', { class: 'models' },
    h('div', { class: 'model-row head' }, h('span', {}, 'Model'), h('span', {}, 'Time'), h('span', {}), h('span', {}, 'Cost'), h('span', {})),
    ...stats.map((m) => h('div', { class: 'model-row', title: `${m.name} (${m.methods.join(', ')})\n${m.calls} call${m.calls === 1 ? '' : 's'}${m.fails ? `, ${m.fails} failed` : ''} · ${dur(m.avgMs)} each, slowest ${dur(m.maxMs)}\n${m.avgCost != null ? `${money(m.avgCost)} per successful call (list price)` : 'no price in the price list'}` },
      h('span', { class: 'mn' }, h('i', { class: `mk ${m.kind}` }), h('b', {}, m.name), h('small', {}, `${m.calls}×${m.fails ? ` · ${m.fails} failed` : ''}`)),
      h('span', { class: 'mbar' }, h('i', { style: { width: `${(m.ms / maxMs) * 100}%` } })),
      h('span', { class: 'mv' }, dur(m.ms), m.calls > 1 ? h('small', {}, `${dur(m.avgMs)} each`) : null),
      h('span', { class: 'mbar cost' }, h('i', { style: { width: `${(m.cost / maxCost) * 100}%` } })),
      h('span', { class: 'mv' }, m.avgCost != null ? money(m.cost) : '–', m.calls > 1 && m.avgCost != null ? h('small', {}, `${money(m.avgCost)} each`) : null)))),
    h('p', { class: 'desc', style: { margin: '6px 0 0' } }, 'Time is each call\'s own duration (the agent waits on it). Cost is the product\'s list price for what each successful call asked for (per second of video, or per generation); failed calls are counted as free.'));
}

function ids(r, d) {
  const row = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, h('span', { class: 'mono', style: { cursor: 'copy' }, title: 'Click to copy', onclick: () => copy(v) }, v))] : null);
  return h('details', { class: 'section ids' }, h('summary', {}, 'Identifiers & links'), h('dl', { class: 'kv' },
    row('Session', r.id), row('Project', r.projectId || d.projectId), row('Ad asset', r.adAssetId), row('MSID', r.msid || d.msid),
    row('User', r.userId), row('Account', r.accountId), row('Skill version', (r.codexVersions || []).join(', '))),
    h('div', { class: 'links', style: { marginTop: '10px' } },
      h('a', { class: 'btn', href: ADMIN + r.id, target: '_blank', rel: 'noopener' }, icon('external'), 'Wixel admin'),
      r.publishedUrl ? h('a', { class: 'btn', href: r.publishedUrl, target: '_blank', rel: 'noopener' }, icon('globe'), 'Published page') : null,
    ));
}

// Where this run's time went, from its first message to the end of its last counted turn (the run's
// own steps; the list row's when the detail has none), every moment counted once.
function timeSection(r, d) {
  const t = d.timeSplit || r.time;
  const bar = runTimeBar(t);
  if (!bar) return null;
  return section('Where the time went', dur(t.total * 1000), bar);
}

function details(r, d) {
  if (d.error) return [h('div', { class: 'loading-line' }, `Couldn't load this run: ${d.error}`)];
  return [outcome(r, d), timeSection(r, d), request(d), modelsSection(d), errorsSection(d), mood(d), scenes(d), ids(r, d)].filter(Boolean);
}

export { worstMood };
