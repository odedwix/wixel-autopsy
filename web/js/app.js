import { $, h, icon, ago, fmtInt, getJson, debounce } from './util.js';
import { state, set, onChange, toggleFilter, clearFilter, famParam } from './state.js';
import { FACETS, OUTCOMES, SORTS, applyFilters, facetCounts, facetOptions, outputProfile, setProfile, typeLabel, primaryOutput, expectedTypes, applyExpected, setExpected, setModelNamer, hasAd, pluralOf } from './filters.js';
import { initGrid, setRuns, relayout, markSelected, scrollToIndex, columns, applySound, stopHover, isVideoRun } from './grid.js';
import { downloadOutput, mediaOf, resetMedia } from './media.js';
import { initInspect, openInspect, closeInspect, inspectedPlayer, prefetchDetail, toggleLive, toggleWide, setInspectTabByIndex, listLoaded, downloadExactRun, clearDetails } from './inspect.js';
import { modelName, pricesReady } from './models.js';
import { computeInsights, renderInsights, headlines } from './insights.js';
import { setSkills, renderSkillButton, openSkillPicker, rememberSkill } from './skillpicker.js';
import { renderScopeButton, openFamilyEditor } from './family.js';
import { toast, popover, closePopover } from './ui.js';
import { shareInsights, exportPdf as exportInsightsPdf } from './share.js';
import { capsReady } from './caps.js';

let allRuns = [];
let view = [];
let loadToken = 0;
let missing = [];
let lastSeen = null;
// Module state lives up here: the boot code below runs before later declarations.
let loadAbort = null;
let loadedSessions = 0;
let refreshQueued = false;
let insights = null;
const insightState = { expanded: {}, scrollTo: null };
const loadEl = h('span', { class: 'load' });
let loading = null; // { done, total, sessions } while days are streaming in
let scope = []; // allRuns inside the rolling time window
let loadStart = 0;
let lastLoad = null;
let loadTicker = null;
let userInfo = null; // user mode: { id, email } and session count from the server
let loadedView = null; // { key, at, days }: the view on screen and when its load began (Refresh tops up from there)
let dayCounts = null; // the loading view's days and their session counts (from the index)
let refreshing = false;
const viewKey = () => `${state.mode}|${state.skill}|${famParam()}|${state.days}`;

// Time windows are rolling (the last 1h / 24h / … from now), not UTC calendar days.
const WINDOWS = { '1h': 1 / 24, '24h': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30, '90d': 90 };
const windowLabel = () => Object.entries(WINDOWS).find(([, v]) => Math.abs(v - state.days) < 1e-9)?.[0] || `${state.days}d`;
const inWindow = (r) => r.createdAt >= Date.now() - state.days * 86400000;
// UTC day slices needed to cover the rolling window.
const requestDays = () => Math.min(90, Math.ceil(state.days) + 1);
const expanded = new Set();

// ---------- text size ----------
// Text grows, the layout doesn't: every font size and text-row height in app.css is a multiple of
// --fs, so bigger text reflows (wraps, taller rows) inside the same columns and panels.
const TEXT_STEPS = [0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.6];
function applyTextScale() {
  const z = Math.min(1.6, Math.max(0.9, Number(state.textScale) || 1));
  document.documentElement.style.setProperty('--fs', String(z));
}
function stepText(dir) {
  const cur = Number(state.textScale) || 1;
  const next = dir === 0 ? 1 : dir > 0 ? TEXT_STEPS.find((x) => x > cur + 1e-6) ?? cur : [...TEXT_STEPS].reverse().find((x) => x < cur - 1e-6) ?? cur;
  set({ textScale: next });
  toast(`Text size ${Math.round(next * 100)}%`, { ms: 1200 });
}
// Everything about how the grid looks, in one menu: sort, card shape and size, sound on hover,
// text size, theme.
function openViewMenu(btn) {
  const seg = (items, cur, onPick) => h('div', { class: 'seg' }, items.map(([v, label, title]) => h('button', { 'aria-checked': String(v === cur), title, onclick: () => { onPick(v); openViewMenu(btn); } }, label)));
  const row = (k, ...v) => h('div', { class: 'vm-row' }, h('span', { class: 'vm-k' }, k), ...v);
  const sort = h('select', { onchange: (e) => set({ sort: e.target.value }) }, [['newest', 'Newest'], ['oldest', 'Oldest'], ['errors', 'Most errors'], ['longest', 'Longest run'], ['generations', 'Most generations'], ['cost', 'Highest cost']].map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l)));
  const size = h('input', { type: 'range', min: 120, max: 360, step: 10, value: state.size, oninput: (e) => set({ size: Number(e.target.value) }) });
  const pct = `${Math.round((Number(state.textScale) || 1) * 100)}%`;
  popover(btn, h('div', { class: 'view-menu' },
    row('Sort', sort),
    row('Card shape', seg([['auto', 'Auto', 'From what the skill makes (A)'], ['9:16', h('span', { class: 'shape v' }), 'Vertical'], ['1:1', h('span', { class: 'shape s' }), 'Square'], ['16:9', h('span', { class: 'shape h' }), 'Horizontal']], state.aspect, (v) => set({ aspect: v }))),
    row('Card size', size),
    row('Sound on hover', seg([[true, 'On'], [false, 'Off']], Boolean(state.sound), (v) => set({ sound: v }))),
    row('Text size', h('button', { class: 'btn', title: 'Smaller (⌥−)', onclick: () => { stepText(-1); openViewMenu(btn); } }, 'A−'), h('span', { class: 'ts-val' }, pct), h('button', { class: 'btn', title: 'Bigger (⌥+)', onclick: () => { stepText(1); openViewMenu(btn); } }, 'A+')),
    row('Theme', seg([['dark', 'Dark'], ['light', 'Light']], state.theme, (v) => { document.documentElement.dataset.theme = v; set({ theme: v }); }))), { align: 'right', width: 320 });
}

// Refresh (R): only what's new. The days already loaded stay as they are; only sessions that started
// since the last load (less 1 h, for runs that were still going) are queried, merged into the cached
// day on the server, and added to or updated in the grid. Media is rebuilt for those runs only.
// Shift-click (Shift+R): everything again, skipping every cache.
async function refreshAll(e) {
  if (refreshing) return;
  if (e?.shiftKey || state.mode === 'user' || !loadedView || loadedView.key !== viewKey()) return refreshEverything();
  refreshing = true;
  const btn = $('#refresh');
  btn.classList.add('busy');
  const started = Date.now();
  // Since the newest run on screen, not since the click: days can come from the cache, so that's
  // how current the grid really is (the 1 h overlap covers runs that were still going).
  const newest = allRuns.reduce((m, r) => Math.max(m, r.createdAt || 0), 0);
  const since = Math.min(loadedView.at, newest || loadedView.at);
  try {
    // The UTC days that can hold new or still-running sessions: from 1 h before the last load to now.
    // No index query: the last load's session counts are reused (a new day starts at 0).
    const days = [];
    for (let t = Date.parse(`${new Date(since - 3600000).toISOString().slice(0, 10)}T00:00:00Z`); t <= Date.now(); t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      days.push({ day, sessions: loadedView.days?.[day] || 0 });
    }
    const byId = new Map(allRuns.map((r, i) => [r.id, i]));
    let added = 0;
    let updated = 0;
    const touched = [];
    // A run counts as updated only if something about it changed (it went on, or its outputs did).
    const sig = (r) => `${r.lastAt}|${(r.allOutputs || r.outputs || []).map((o) => `${o.id}:${o.updated}`).join(',')}|${r.userDownloads}|${r.publishedUrl || ''}`;
    for (const d of days) {
      const rows = await getJson(`/api/runs-day?skill=${encodeURIComponent(state.skill)}&day=${d.day}&n=${d.sessions}&fam=${encodeURIComponent(famParam())}&since=${since}`);
      for (const r of rows) {
        if (byId.has(r.id)) {
          const i = byId.get(r.id);
          if (sig(allRuns[i]) === sig(r)) continue;
          allRuns[i] = r;
          updated++;
        } else {
          byId.set(r.id, allRuns.push(r) - 1);
          added++;
        }
        touched.push(r.id);
      }
    }
    // Their review copies and exact mp4s are rebuilt (they may have finished since), their sessions re-read.
    const stale = touched.filter((id) => mediaOf(id)?.kind !== 'render');
    if (stale.length) await fetch('/api/media-refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: stale }) }).catch(() => {});
    resetMedia(touched);
    clearDetails(touched);
    loadedView = { ...loadedView, at: started };
    refreshView();
    toast(added || updated ? `Refreshed in ${Math.round((Date.now() - started) / 1000)}s: ${fmtInt(added)} new run${added === 1 ? '' : 's'}, ${fmtInt(updated)} recent one${updated === 1 ? '' : 's'} updated` : 'Nothing new since the last load', { ms: 5000 });
  } catch (err) {
    toast(`Couldn't refresh: ${err.message}`, { ms: 6000 });
  } finally {
    refreshing = false;
    btn.classList.remove('busy');
  }
}

async function refreshEverything() {
  if (state.mode === 'user') return loadRuns();
  const ids = allRuns.filter((r) => mediaOf(r.id) && mediaOf(r.id).kind !== 'render').map((r) => r.id);
  clearDetails();
  if (ids.length) await fetch('/api/media-refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(0, 2000) }) }).catch(() => {});
  resetMedia();
  toast('Refreshing everything — querying every day again…', { ms: 3000 });
  loadRuns({ fresh: true });
}

// ---------- boot ----------
setModelNamer(modelName);
pricesReady.then(() => allRuns.length && refreshView());
document.documentElement.dataset.theme = state.theme;
applyTextScale();
initGrid($('#gridScroll'), $('#gridSizer'), {
  select: (id) => select(id, { open: true }),
  open: (id) => select(id, { open: true }),
});
initInspect($('#inspect'), { close: () => set({ open: false }) });
bindTopbar();
bindTabs();
loadSkills();
loadRuns();
pollLoad();

onChange((patch) => {
  // A new skill starts from its own view: only the result switch and the user type carry over.
  if (('skill' in patch || 'mode' in patch) && !('filters' in patch)) {
    const { outcome, user } = state.filters;
    set({ filters: { ...(outcome ? { outcome } : {}), ...(user ? { user } : {}) } }, { silent: true });
  }
  if ('skill' in patch || 'days' in patch || 'mode' in patch || 'user' in patch || 'families' in patch) {
    if ('open' in patch && !patch.open) closeInspect();
    syncTopbar();
    return loadRuns();
  }
  if ('filters' in patch || 'q' in patch || 'sort' in patch) refreshView();
  else if ('filtersOpen' in patch) {
    renderFilters();
    relayout();
  }
  if ('tab' in patch) applyTab();
  if ('aspect' in patch || 'size' in patch) relayout();
  if ('sound' in patch) applySound();
  if ('textScale' in patch) {
    applyTextScale();
    relayout();
  }
  if ('open' in patch && !patch.open) closeInspect();
  syncTopbar();
});

// ---------- data ----------
async function loadSkills() {
  renderSkillButton($('#skillBtn'));
  try {
    setSkills(await getJson('/api/skills?days=30'));
    renderSkillButton($('#skillBtn'));
  } catch {}
}

// Progressive: the index says which days have runs (seconds), then days stream in newest first,
// three at a time, and the grid fills as each one lands. Empty days are never queried.
// `fresh` (Refresh): every query and session read again, skipping the caches.
async function loadRuns({ fresh = false } = {}) {
  const token = ++loadToken;
  loadedView = null;
  const fq = fresh ? '&fresh=1' : '';
  // A new selection cancels the previous one's requests; the proxy then drops their queued queries.
  loadAbort?.abort();
  loadAbort = new AbortController();
  const { signal } = loadAbort;
  allRuns = [];
  scope = [];
  missing = [];
  lastSeen = null;
  loading = { done: 0, total: null };
  loadStart = Date.now();
  userInfo = null;
  if (state.mode !== 'user') rememberSkill(state.skill);
  skeleton();
  // While loading, the progress bar and status tick every second so it never looks frozen.
  clearInterval(loadTicker);
  loadTicker = setInterval(showProgress, 1000);
  showProgress();
  // A link/reload with a run open shows it immediately; its detail doesn't depend on the list.
  if (state.open && state.selected) openInspect({ id: state.selected, _stub: true });
  // A run's PDF report (rendered by the proxy's headless Chrome) needs that run only.
  if (new URLSearchParams(location.search).get('report') === 'run') return endProgress();
  if (state.mode === 'user') return loadUserRuns(token, signal);
  try {
    const index = await getJson(`/api/runs-index?skill=${encodeURIComponent(state.skill)}&days=${requestDays()}${fq}`, { signal });
    if (token !== loadToken) return;
    lastSeen = index.lastSeen;
    loading.total = index.dayList.length;
    dayCounts = index.dayList;
    loading.sessions = index.total;
    loadedSessions = index.total;
    const queue = [...index.dayList];
    const seen = new Set();
    const worker = async () => {
      while (queue.length) {
        const { day, sessions } = queue.shift();
        try {
          const runs = await getJson(`/api/runs-day?skill=${encodeURIComponent(state.skill)}&day=${day}&n=${sessions}&fam=${encodeURIComponent(famParam())}${fq}`, { signal });
          if (token !== loadToken) return;
          for (const r of runs) if (!seen.has(r.id) && seen.add(r.id)) allRuns.push(r);
          // The run opened from a link shows its full row as soon as its day lands.
          if (state.open && state.selected) {
            const open = runs.find((r) => r.id === state.selected);
            if (open) openInspect(open);
          }
        } catch (err) {
          if (token !== loadToken) return;
          missing.push({ day, error: err.message });
        }
        loading.done++;
        // Don't leave the grid empty behind filters that don't fit this skill while the rest loads.
        if (loading.done === 1) {
          scope = allRuns.filter(inWindow);
          applyExpected(allRuns, state.mode === 'user' ? null : expectedTypes(outputProfile(scope)));
          if (scope.length && !applyFilters(scope, state.filters, state.q).length) pruneFilters();
        }
        scheduleRefresh();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (token !== loadToken) return;
  } catch (err) {
    if (token !== loadToken) return;
    loading = null;
    endProgress();
    status(`Failed to load runs: ${err.message}`);
    $('#gridSizer').replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'Couldn’t load runs'), h('p', {}, err.message), h('button', { class: 'btn', onclick: () => loadRuns() }, 'Retry')));
    return;
  }
  loading = null;
  endProgress();
  // What Refresh tops up from: this view, as of when its load began, and its days' session counts
  // (reused so a busy day keeps the same sample, and its cached rows can be topped up).
  loadedView = { key: viewKey(), at: loadStart, days: Object.fromEntries((dayCounts || []).map((d) => [d.day, d.sessions])) };
  refreshView();
  pruneFilters();
  if (fresh) toast(`Refreshed everything: ${fmtInt(allRuns.length)} runs queried again — changed videos rebuild as they come on screen`, { ms: 5000 });
  if (state.open && state.selected) {
    const r = allRuns.find((x) => x.id === state.selected);
    if (r) openInspect(r);
  }
  autoReport();
}

// ?report=insights builds the insights PDF once everything has loaded (scripted / headless export).
let autoInsights = false;
function autoReport() {
  listLoaded();
  if (autoInsights || new URLSearchParams(location.search).get('report') !== 'insights' || !insights) return;
  autoInsights = true;
  exportInsightsPdf(insights, insightActions.label(), insightActions);
}

// User mode: one request; the server lists the user's sessions and loads their days.
async function loadUserRuns(token, signal) {
  try {
    const res = await getJson(`/api/user-runs?user=${encodeURIComponent(state.user.id)}&days=${requestDays()}`, { signal });
    if (token !== loadToken) return;
    allRuns = res.runs;
    missing = res.missingDays || [];
    userInfo = { ...res.user, sessions: res.sessions };
    // Fill in the email when the link only carried the id.
    if (res.user?.email && res.user.email !== state.user.email) set({ user: { ...state.user, email: res.user.email } }, { silent: true });
  } catch (err) {
    if (token !== loadToken) return;
    loading = null;
    endProgress();
    status(`Failed to load this user's runs: ${err.message}`);
    $('#gridSizer').replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'Couldn’t load this user’s runs'), h('p', {}, err.message), h('button', { class: 'btn', onclick: loadRuns }, 'Retry')));
    return;
  }
  loading = null;
  endProgress();
  syncTopbar();
  refreshView();
  pruneFilters();
  if (state.open && state.selected) {
    const r = allRuns.find((x) => x.id === state.selected);
    if (r) openInspect(r);
  }
  autoReport();
}

// What the view is about, for status lines and share labels.
const subject = () => (state.mode === 'user' ? `${state.user?.email || `user ${state.user?.id?.slice(0, 8)}`} · all skills` : state.skill);

// ---------- loading feedback ----------
function showProgress() {
  const bar = $('#loadbar');
  if (!loading) return endProgress();
  bar.classList.add('on');
  bar.classList.toggle('ind', loading.total == null || loading.total === 0);
  if (loading.total) bar.style.setProperty('--p', `${Math.max(6, (loading.done / loading.total) * 100)}%`);
  const secs = Math.round((Date.now() - loadStart) / 1000);
  const q = lastLoad?.trino?.queued || 0;
  const backoff = lastLoad?.trino?.backoffUntil ? ` · Trino is timing out — easing off (${lastLoad.trino.concurrency} at a time) until ${new Date(lastLoad.trino.backoffUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  const busy = backoff || (secs > 8 && (q || lastLoad?.trino?.inflight) ? ` · Trino is busy (${lastLoad.trino.inflight} running${q ? `, ${q} queued` : ''}) — still working` : '');
  const what = state.mode === 'user' ? `Loading every session by ${subject().replace(' · all skills', '')}` : loading.total == null ? `Finding which days ${state.skill} ran` : `Loading day ${Math.min(loading.done + 1, loading.total)} of ${loading.total} (${fmtInt(loading.sessions)} sessions)`;
  if (!allRuns.length) status(`${what}… ${secs}s${busy}`);
  else refreshStatus(busy);
}

function endProgress() {
  clearInterval(loadTicker);
  loadTicker = null;
  const bar = $('#loadbar');
  bar.style.setProperty('--p', '100%');
  setTimeout(() => !loading && bar.classList.remove('on', 'ind'), 250);
}

// Filters that leave nothing to show in this skill's runs are cleared, with one note saying so,
// rather than leaving an empty grid behind them.
function pruneFilters() {
  if (!scope.length || applyFilters(scope, state.filters, state.q).length) return;
  const { outcome } = state.filters;
  const keepOutcome = outcome && applyFilters(scope, { outcome }, state.q).length;
  const cleared = Object.keys(state.filters).filter((k) => !(k === 'outcome' && keepOutcome));
  if (!cleared.length) return;
  set({ filters: keepOutcome ? { outcome } : {} });
  toast(`Nothing in ${subject()} matched those filters — cleared ${cleared.map((k) => FACETS.find((f) => f.key === k)?.label || k).join(', ')}`, { ms: 6000 });
}

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refreshView();
  }, 200);
}

function skeleton() {
  const sizer = $('#gridSizer');
  sizer.replaceChildren();
  sizer.style.height = '0';
  const w = state.size;
  const [aw, ah] = (state.aspect === 'auto' ? '1:1' : state.aspect).split(':').map(Number);
  const cols = Math.max(1, Math.floor(($('#gridScroll').clientWidth - 28 + 12) / (w + 12)));
  for (let i = 0; i < cols * 2; i++) {
    sizer.append(h('div', { class: 'skeleton', style: { width: `${w}px`, height: `${(w * ah) / aw + 62}px`, transform: `translate(${(i % cols) * (w + 12)}px, ${Math.floor(i / cols) * ((w * ah) / aw + 74)}px)` } }));
  }
}

function refreshView() {
  scope = allRuns.filter(inWindow);
  const profile = outputProfile(scope);
  setProfile(profile);
  // What the skill is supposed to make (its main output type, and any other most of its runs make):
  // runs are shown and judged by those only. User mode shows everything.
  const expected = state.mode === 'user' ? null : expectedTypes(profile);
  setExpected(expected);
  applyExpected(allRuns, expected);
  // The first tab is named after what the skill makes (Logos, Slides, Videos…).
  const lbl = expected?.length ? expected.slice(0, 2).map(typeLabel).map(pluralOf).join(' & ') : 'Runs';
  $('#tabMain').textContent = lbl;
  $('#tabMain').parentElement.title = expected?.length ? `What ${state.skill} makes, learned from its runs: ${profile.slice(0, 4).map((p) => `${typeLabel(p.type)} ${Math.round(p.share * 100)}%`).join(' · ')}. Runs are judged by ${expected.map(typeLabel).join(' / ')} only (V)` : 'Outputs (V)';
  view = applyFilters(scope, state.filters, state.q).sort(SORTS[state.sort] || SORTS.newest);
  const sizer = $('#gridSizer');
  const keepSkeleton = loading && !allRuns.length;
  if (!keepSkeleton) sizer.querySelectorAll('.skeleton, .empty-state').forEach((n) => n.remove());
  setRuns(view);
  sizer.querySelectorAll('.empty-state').forEach((n) => n.remove());
  if (!keepSkeleton && !view.length) sizer.append(emptyState());
  const counts = facetCounts(scope, state.filters, state.q);
  renderFilters(counts);
  renderOutcome(counts);
  renderChips();
  // Insights are computed when they're on screen, or once the load is done (the headline uses them).
  if (state.tab === 'insights' || !loading) {
    insights = computeInsights(view);
    renderInsightViews();
  }
  refreshStatus();
}

function refreshStatus(busy = '') {
  const progress = loading ? (loading.total == null ? ' · finding days…' : ` · loading day ${Math.min(loading.done + 1, loading.total)} of ${loading.total}…`) : '';
  const sampled = allRuns.some((r) => r.sampleRate < 1) && loadedSessions ? ` · busy days sampled: showing ${fmtInt(allRuns.length)} of ~${fmtInt(loadedSessions)} sessions (${Math.round((allRuns.length / loadedSessions) * 100)}%)` : '';
  const failed = missing.length ? ` · ⚠ ${missing.length} day(s) failed to load (${missing.map((m) => m.day).join(', ')}) — reload to retry` : '';
  status(`${fmtInt(view.length)} of ${fmtInt(scope.length)} runs · ${subject()} · last ${windowLabel()}${progress}${busy}${sampled}${failed}${scopeNote()}`);
}

// How much of these sessions was other skills' work (left out, see the Counting button).
function scopeNote() {
  if (state.mode === 'user' || !scope.length) return '';
  if (state.families?.[state.skill] === 'all') return ' · counting whole sessions';
  const mixed = scope.filter((r) => r.otherSkills?.length).length;
  return mixed ? ` · ${fmtInt(mixed)} also used other skills (their turns not counted)` : '';
}

// Why the grid is empty, and the one click that fixes it.
function emptyState() {
  if (scope.length) {
    return h('div', { class: 'empty-state' }, h('h2', {}, 'No runs match these filters'), h('p', {}, `${fmtInt(scope.length)} runs are hidden by the filters or search.`),
      h('button', { class: 'btn', onclick: () => { set({ q: '' }); clearFilter(); } }, 'Clear filters'));
  }
  if (missing.length) {
    return h('div', { class: 'empty-state' }, h('h2', {}, `Couldn’t load ${missing.length} day(s)`), h('p', {}, missing[0].error?.slice(0, 200) || ''),
      h('button', { class: 'btn', onclick: () => loadRuns() }, 'Retry'));
  }
  // Loaded runs exist but none inside a short window (e.g. 1h): suggest the next window up.
  const newest = allRuns.reduce((m, r) => Math.max(m, r.createdAt || 0), 0);
  const at = lastSeen?.at || newest || null;
  const ageDays = at ? (Date.now() - at) / 86400000 : null;
  const fit = ageDays != null ? Object.entries(WINDOWS).find(([, d]) => d > ageDays) : null;
  if (state.mode === 'user') {
    return h('div', { class: 'empty-state' }, h('h2', {}, `No sessions by ${subject().replace(' · all skills', '')} in the last ${windowLabel()}`),
      h('p', {}, userInfo ? 'Try a longer time window.' : ''),
      state.days < 90 ? h('button', { class: 'btn', onclick: () => set({ days: 90 }) }, 'Show the last 90d') : null);
  }
  return h('div', { class: 'empty-state' },
    h('h2', {}, `No ${state.skill} runs in the last ${windowLabel()}`),
    h('p', {}, at
      ? `It last ran ${ago(at)} (${new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})${lastSeen?.sessions90d != null ? ` · ${fmtInt(lastSeen.sessions90d)} sessions in the last 90 days` : ''}.`
      : 'It hasn’t run in the last 90 days.'),
    fit && fit[1] !== state.days ? h('button', { class: 'btn', onclick: () => set({ days: fit[1] }) }, `Show the last ${fit[0]}`) : null);
}

function status(text) {
  $('#statusLine').replaceChildren(h('span', {}, text), h('span', { style: { marginLeft: 'auto' } }), loadEl, h('span', {}, 'Press ? for shortcuts'));
}

// ---------- insights ----------

const insightActions = {
  filter: (key, value) => {
    if (!(state.filters[key] || []).includes(value)) toggleFilter(key, value);
    set({ tab: 'videos' });
  },
  filterStep: (key, failed) => (failed ? insightActions.filter('failedStep', key) : insightActions.search(key)),
  search: (q) => set({ q, tab: 'videos' }),
  open: (id) => {
    set({ tab: 'videos' });
    select(id, { open: true });
  },
  label: () => `${state.mode === 'user' ? 'one user · all skills' : state.skill} · last ${windowLabel()} · ${fmtInt(view.length)} runs${Object.keys(state.filters).length || state.q ? ' (filtered)' : ''}`,
  runs: () => view,
  // A finding's click: its filter, its failing step, a pick of runs, or the card that explains it.
  go: (g) => {
    if (!g) return;
    if (g.filter) return insightActions.filter(...g.filter);
    if (g.filterStep) return insightActions.filterStep(g.filterStep, true);
    if (g.ids) return set({ filters: { ...state.filters, ids: g.ids.slice(0, 400) }, tab: 'videos' });
    if (g.section) document.querySelector(`#ins-${g.section}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },
  share: (anchor) => shareInsights(anchor, insights, insightActions.label(), insightActions),
  rerender: () => renderInsightViews(),
  get expanded() {
    return insightState.expanded;
  },
  get scrollTo() {
    return insightState.scrollTo;
  },
};

function renderInsightViews() {
  if (!insights) return;
  if (state.tab === 'insights') {
    renderInsights($('#insights'), insights, insightActions);
    insightState.scrollTo = null;
  } else {
    $('#headlines').replaceChildren(...headlines(insights, (section) => {
      insightState.scrollTo = section;
      set({ tab: 'insights' });
    }, view));
  }
}

function bindTabs() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) set({ tab: b.dataset.tab });
  });
  applyTab();
}

function applyTab() {
  const ins = state.tab === 'insights';
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  $('#insights').hidden = !ins;
  $('#gridScroll').hidden = ins;
  $('#headlines').hidden = ins;
  if (ins) {
    stopHover();
    // Not computed while days were still loading in the grid view.
    if (allRuns.length) insights = computeInsights(view);
  }
  renderInsightViews();
}

// ---------- connectivity: off the Wix VPN → say so ----------
// The proxy probes bo.wix.com every minute (and right after a network failure); anything but ok
// shows a banner with the reason and a re-check, and cached data keeps working underneath.
let netState = null;
function renderNet(net) {
  const el = $('#netBanner');
  if (!net || net.status === 'ok' || net.status === 'unknown') {
    if (netState && netState !== 'ok' && netState !== 'unknown' && net?.status === 'ok') toast('Connected to Wix again — live data is back', { ms: 4000 });
    netState = net?.status || null;
    el.hidden = true;
    return;
  }
  netState = net.status;
  el.hidden = false;
  el.className = `net-banner ${net.status}`;
  const btn = h('button', { class: 'btn', onclick: async () => {
    btn.textContent = 'Checking…';
    renderNet(await getJson('/api/connectivity?fresh=1').catch(() => net));
  } }, 'Check again');
  el.replaceChildren(icon('alert', 'sm'), h('span', {}, h('b', {}, net.status === 'degraded' ? 'Admin API errors' : 'Not connected to Wix'), ' — ', net.message || ''), h('span', { class: 'when' }, `checked ${ago(net.checkedAt)}`), btn);
}

// ---------- production load readout ----------
// Every upstream call goes through the proxy's limiters; show what they did recently.
async function pollLoad() {
  try {
    const l = await getJson('/api/load');
    lastLoad = l;
    renderNet(l.net);
    const lane = (name, label) => {
      const x = l[name];
      return h('span', { title: `${label}: ${x.inflight} in flight, ${x.queued} queued${x.queuedBackground ? ` (+${x.queuedBackground} background)` : ''}, ${x.total} since start, ${x.errors} errors (max ${x.concurrency} concurrent)${x.backoffUntil ? ` — backing off after ${x.timeouts2m} timeouts` : ''}` },
        h('b', {}, label), ' ', h('span', { class: x.queued || x.backoffUntil ? 'busy' : '' }, `${x.last5m}${x.backoffUntil ? ' · easing off' : ''}`));
    };
    loadEl.replaceChildren(h('span', { title: 'Requests to production-side systems in the last 5 minutes' }, 'Upstream, 5 min:'),
      lane('trino', 'Trino'), lane('admin', 'Admin API'), lane('temporal', 'Temporal'),
      h('span', { title: 'Review videos being prepared locally (ffmpeg; reads the CDN only)' }, h('b', {}, 'Media'), ` ${l.media.active + l.media.pending}`),
      l.cache ? h('span', { title: `Local cache in .cache — capped at ${(l.cache.cap / 1024 ** 3).toFixed(1)} GB (CACHE_MAX_GB); least-recently-used entries are evicted` }, h('b', {}, 'Cache'), ` ${(l.cache.bytes / 1024 ** 3).toFixed(1)}/${(l.cache.cap / 1024 ** 3).toFixed(0)} GB`) : null);
  } catch {}
  setTimeout(pollLoad, 5000);
}

// ---------- filters panel ----------
function renderFilters(counts = facetCounts(scope, state.filters, state.q)) {
  const panel = $('#filters');
  panel.hidden = !state.filtersOpen;
  const scroll = panel.scrollTop;
  $('#filtersBtn')?.setAttribute('aria-pressed', String(Boolean(state.filtersOpen)));
  const n = Object.keys(state.filters).filter((k) => k !== 'outcome').reduce((a, k) => a + state.filters[k].length, 0);
  if ($('#filtersCnt')) $('#filtersCnt').textContent = n ? String(n) : '';
  if (!state.filtersOpen) return;
  panel.replaceChildren(h('div', { class: 'filters-h' }, h('b', {}, 'Filters'), h('button', { class: 'linkish', onclick: () => set({ filtersOpen: false }) }, 'Hide')), ...FACETS.filter((f) => !f.hidden && counts[f.key].some((o) => o.count || (state.filters[f.key] || []).includes(o.value))).map((f) => {
    const active = state.filters[f.key] || [];
    let opts = counts[f.key];
    if (f.dynamic && !expanded.has(f.key) && opts.length > (f.limit || 6)) {
      const keep = new Set(opts.slice(0, f.limit || 6).map((o) => o.value));
      opts = opts.filter((o) => keep.has(o.value) || active.includes(o.value));
    }
    const total = counts[f.key].length;
    return h('div', { class: 'facet' },
      h('h3', {}, f.label, active.length ? h('button', { onclick: () => clearFilter(f.key) }, 'Clear') : null),
      ...opts.map((o) => h('label', { class: `opt${active.includes(o.value) ? ' on' : ''}${o.count ? '' : ' zero'}` },
        h('input', { type: 'checkbox', checked: active.includes(o.value), onchange: () => toggleFilter(f.key, o.value) }),
        h('span', { class: 'box' }),
        o.dot ? h('span', { class: 'dot', style: { background: o.dot } }) : null,
        h('span', { class: 'label', title: o.label }, o.label),
        h('span', { class: 'count' }, fmtInt(o.count)))),
      f.dynamic && total > (f.limit || 6) ? h('button', { class: 'more', onclick: () => { expanded.has(f.key) ? expanded.delete(f.key) : expanded.add(f.key); renderFilters(); } }, expanded.has(f.key) ? 'Show fewer' : `Show all ${total}`) : null,
    );
  }));
  panel.scrollTop = scroll;
}

// ---------- result switch + chips ----------
// One choice: every run, or the runs that made the skill's output, tried and didn't, or never
// tried. Each count follows the other filters and the search.
function renderOutcome(counts) {
  const cur = state.filters.outcome?.[0] || null;
  const opts = counts.outcome || [];
  const pool = opts.pool ?? view.length;
  const pick = (v) => {
    const { outcome, ...rest } = state.filters;
    set({ filters: v ? { ...rest, outcome: [v] } : rest });
  };
  $('#outcome').replaceChildren(
    h('button', { 'aria-checked': String(!cur), title: 'Every run in the window', onclick: () => pick(null) }, 'All', h('small', {}, fmtInt(pool))),
    ...OUTCOMES.map((o) => {
      const n = opts.find((x) => x.value === o.value)?.count ?? 0;
      return h('button', { 'aria-checked': String(cur === o.value), title: `${fmtInt(n)} of ${fmtInt(pool)} (${pool ? Math.round((n / pool) * 100) : 0}%)`, onclick: () => pick(cur === o.value ? null : o.value) },
        h('span', { class: 'dot', style: { background: o.dot } }), o.label(), h('small', {}, fmtInt(n)));
    }));
}

function renderChips() {
  const chips = [];
  for (const f of FACETS.filter((x) => !x.hidden)) {
    for (const v of state.filters[f.key] || []) {
      const o = facetOptions(f, scope).find((x) => x.value === v);
      chips.push(h('button', { class: 'chip', title: 'Remove', onclick: () => toggleFilter(f.key, v) }, h('b', {}, `${f.label}:`), o?.label || v, icon('x')));
    }
  }
  if (state.filters.ids?.length) chips.push(h('button', { class: 'chip', title: 'Runs picked from an insight — remove', onclick: () => { const { ids, ...rest } = state.filters; set({ filters: rest }); } }, h('b', {}, 'Picked:'), `${state.filters.ids.length} runs from Insights`, icon('x')));
  if (state.q) chips.push(h('button', { class: 'chip', onclick: () => set({ q: '' }) }, h('b', {}, 'Search:'), `“${state.q}”`, icon('x')));
  if (chips.length > 1) chips.push(h('button', { class: 'chip clear', onclick: () => { set({ q: '' }); clearFilter(); } }, 'Clear all'));
  $('#chips').replaceChildren(...chips);
}

// ---------- selection ----------
function select(id, { open = false } = {}) {
  set({ selected: id, ...(open ? { open: true } : {}) }, { silent: true });
  markSelected();
  const r = view.find((x) => x.id === id) || allRuns.find((x) => x.id === id);
  if (open || state.open) openInspect(r);
  syncTopbar();
}

function moveSelection(delta) {
  if (!view.length) return;
  let i = view.findIndex((r) => r.id === state.selected);
  i = i < 0 ? 0 : Math.max(0, Math.min(view.length - 1, i + delta));
  select(view[i].id);
  scrollToIndex(i);
  // Warm the next run's detail so J/K feels instant.
  const next = view[i + Math.sign(delta || 1)];
  if (next) prefetchDetail(next.id);
}

// ---------- top bar ----------
function bindTopbar() {
  $('#skillBtn').addEventListener('click', () => openSkillPicker($('#skillBtn')));
  $('#scopeBtn').addEventListener('click', () => openFamilyEditor($('#scopeBtn')));
  $('#days').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) set({ days: WINDOWS[b.dataset.win] });
  });
  const q = $('#q');
  q.value = state.q;
  q.addEventListener('input', debounce(() => set({ q: q.value.trim() }), 120));
  $('#refresh').addEventListener('click', (e) => refreshAll(e));
  $('#viewBtn').addEventListener('click', () => openViewMenu($('#viewBtn')));
  $('#filtersBtn').addEventListener('click', () => set({ filtersOpen: !state.filtersOpen }));
  $('#help').addEventListener('click', () => ($('#helpDialog').hidden = false));
  $('#helpDialog').addEventListener('click', () => ($('#helpDialog').hidden = true));
  // Hovering a card for a moment warms its detail, so opening it is instant.
  let hoverTimer;
  $('#gridScroll').addEventListener('pointerover', (e) => {
    const c = e.target.closest('.card');
    clearTimeout(hoverTimer);
    if (c) hoverTimer = setTimeout(() => prefetchDetail(c.dataset.id), 600);
  });
  syncTopbar();
}

function syncTopbar() {
  for (const b of $('#days').children) b.setAttribute('aria-checked', String(Math.abs(WINDOWS[b.dataset.win] - state.days) < 1e-9));
  if (document.activeElement !== $('#q')) $('#q').value = state.q;
  $('#filters').hidden = !state.filtersOpen;
  $('#filtersBtn')?.setAttribute('aria-pressed', String(Boolean(state.filtersOpen)));
  renderSkillButton($('#skillBtn'));
  renderScopeButton($('#scopeBtn'));
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = Boolean(e.target.matches?.('input, select, textarea'));
  if (e.key === 'Escape') {
    if (!$('#helpDialog').hidden) return ($('#helpDialog').hidden = true);
    if (typing) return e.target.blur();
    if (state.open) return set({ open: false });
    if (state.q) return set({ q: '' });
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return openSkillPicker($('#skillBtn'));
  }
  // ⌥+ / ⌥− / ⌥0: text size (by physical key; ⌥ changes the typed character on a Mac).
  if (e.altKey && !e.metaKey && !e.ctrlKey && ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(e.code)) {
    e.preventDefault();
    return stepText(/Equal|Add/.test(e.code) ? 1 : /Minus|Subtract/.test(e.code) ? -1 : 0);
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const p = inspectedPlayer();
  const k = e.key;
  const act = {
    '/': () => $('#q').focus(),
    '?': () => ($('#helpDialog').hidden = !$('#helpDialog').hidden),
    f: () => set({ filtersOpen: !state.filtersOpen }),
    r: () => refreshAll(e),
    R: () => refreshEverything(),
    v: () => set({ tab: 'videos' }),
    i: () => set({ tab: 'insights' }),
    s: () => set({ sound: !state.sound }),
    a: () => set({ aspect: { auto: '9:16', '9:16': '1:1', '1:1': '16:9', '16:9': 'auto' }[state.aspect] || 'auto' }),
    '+': () => set({ size: Math.min(360, state.size + 20) }),
    '=': () => set({ size: Math.min(360, state.size + 20) }),
    '-': () => set({ size: Math.max(120, state.size - 20) }),
    ArrowRight: () => (e.shiftKey && p ? p.seekBy(1) : moveSelection(1)),
    ArrowLeft: () => (e.shiftKey && p ? p.seekBy(-1) : moveSelection(-1)),
    ArrowDown: () => moveSelection(columns()),
    ArrowUp: () => moveSelection(-columns()),
    j: () => moveSelection(1),
    k: () => moveSelection(-1),
    Enter: () => state.selected && select(state.selected, { open: true }),
    ' ': () => (p ? p.toggle() : state.selected && select(state.selected, { open: true })),
    ',': () => p?.step(-1),
    '.': () => p?.step(1),
    e: () => toggleLive(),
    c: () => p?.setCaptions?.(!p.captions),
    w: () => state.open && toggleWide(),
    ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), () => state.open && setInspectTabByIndex(n - 1)])),
    o: () => state.selected && window.open(`https://wix-bo.com/wixel-agent/admin/#/sessions/${state.selected}`, '_blank', 'noopener'),
    d: () => state.selected && downloadSelected(),
  }[k];
  if (act) {
    e.preventDefault();
    stopHover();
    act();
  }
});

// Downloads are the exact output only: the user's own render, or the exact composition rendered
// from the product's player (~2 min the first time); other output types as their own files.
function downloadSelected() {
  const main = state.open && document.querySelector('#inspect .dl-main');
  if (main) return main.click();
  const r = allRuns.find((x) => x.id === state.selected);
  if (!r) return;
  if (!isVideoRun(r)) return downloadOutput(r, primaryOutput(r), state.mode === 'user' ? null : state.skill) || toast('This run has no output to download');
  if (!hasAd(r)) return toast('This run has no finished video to download');
  downloadExactRun(r);
}
