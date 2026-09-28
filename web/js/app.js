import { $, h, icon, ago, fmtInt, getJson, debounce } from './util.js';
import { state, set, onChange, toggleFilter, clearFilter } from './state.js';
import { FACETS, STATS, SORTS, applyFilters, facetCounts, facetOptions, outputProfile, setProfile, typeLabel } from './filters.js';
import { initGrid, setRuns, relayout, markSelected, scrollToIndex, columns, applySound, stopHover } from './grid.js';
import { initInspect, openInspect, closeInspect, inspectedPlayer, prefetchDetail, toggleLive, toggleWide, setInspectTabByIndex } from './inspect.js';
import { computeInsights, renderInsights, headlines } from './insights.js';
import { setSkills, renderSkillButton, openSkillPicker, rememberSkill } from './skillpicker.js';
import { toast } from './ui.js';
import { shareInsights } from './share.js';

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

// Time windows are rolling (the last 1h / 24h / … from now), not UTC calendar days.
const WINDOWS = { '1h': 1 / 24, '24h': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30, '90d': 90 };
const windowLabel = () => Object.entries(WINDOWS).find(([, v]) => Math.abs(v - state.days) < 1e-9)?.[0] || `${state.days}d`;
const inWindow = (r) => r.createdAt >= Date.now() - state.days * 86400000;
// UTC day slices needed to cover the rolling window.
const requestDays = () => Math.min(90, Math.ceil(state.days) + 1);
const expanded = new Set();

// ---------- boot ----------
document.documentElement.dataset.theme = state.theme;
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
  if ('skill' in patch || 'days' in patch) {
    if ('open' in patch && !patch.open) closeInspect();
    syncTopbar();
    return loadRuns();
  }
  if ('filters' in patch || 'q' in patch || 'sort' in patch) refreshView();
  if ('tab' in patch) applyTab();
  if ('aspect' in patch || 'size' in patch) relayout();
  if ('sound' in patch) applySound();
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
async function loadRuns() {
  const token = ++loadToken;
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
  rememberSkill(state.skill);
  skeleton();
  // While loading, the progress bar and status tick every second so it never looks frozen.
  clearInterval(loadTicker);
  loadTicker = setInterval(showProgress, 1000);
  showProgress();
  // A link/reload with a run open shows it immediately; its detail doesn't depend on the list.
  if (state.open && state.selected) openInspect({ id: state.selected, _stub: true });
  try {
    const index = await getJson(`/api/runs-index?skill=${encodeURIComponent(state.skill)}&days=${requestDays()}`, { signal });
    if (token !== loadToken) return;
    lastSeen = index.lastSeen;
    loading.total = index.dayList.length;
    loading.sessions = index.total;
    loadedSessions = index.total;
    const queue = [...index.dayList];
    const seen = new Set();
    const worker = async () => {
      while (queue.length) {
        const { day, sessions } = queue.shift();
        try {
          const runs = await getJson(`/api/runs-day?skill=${encodeURIComponent(state.skill)}&day=${day}&n=${sessions}`, { signal });
          if (token !== loadToken) return;
          for (const r of runs) if (!seen.has(r.id) && seen.add(r.id)) allRuns.push(r);
        } catch (err) {
          if (token !== loadToken) return;
          missing.push({ day, error: err.message });
        }
        loading.done++;
        // Don't leave the grid empty behind filters that don't fit this skill while the rest loads.
        if (loading.done === 1) {
          scope = allRuns.filter(inWindow);
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
    $('#gridSizer').replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'Couldn’t load runs'), h('p', {}, err.message), h('button', { class: 'btn', onclick: loadRuns }, 'Retry')));
    return;
  }
  loading = null;
  endProgress();
  refreshView();
  pruneFilters();
  if (state.open && state.selected) {
    const r = allRuns.find((x) => x.id === state.selected);
    if (r) openInspect(r);
  }
}

// ---------- loading feedback ----------
function showProgress() {
  const bar = $('#loadbar');
  if (!loading) return endProgress();
  bar.classList.add('on');
  bar.classList.toggle('ind', loading.total == null || loading.total === 0);
  if (loading.total) bar.style.setProperty('--p', `${Math.max(6, (loading.done / loading.total) * 100)}%`);
  const secs = Math.round((Date.now() - loadStart) / 1000);
  const q = lastLoad?.trino?.queued || 0;
  const busy = secs > 8 && (q || lastLoad?.trino?.inflight) ? ` · Trino is busy (${lastLoad.trino.inflight} running${q ? `, ${q} queued` : ''}) — still working` : '';
  const what = loading.total == null ? `Finding which days ${state.skill} ran` : `Loading day ${Math.min(loading.done + 1, loading.total)} of ${loading.total} (${fmtInt(loading.sessions)} sessions)`;
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

// After a skill/window change, drop filter values that match nothing in this skill's runs
// (e.g. "Wixel team" when no team member ran it), so the view is never empty for no reason.
function pruneFilters() {
  if (!scope.length) return;
  const filters = { ...state.filters };
  const removed = [];
  for (const f of FACETS) {
    const vals = filters[f.key];
    if (!vals?.length) continue;
    const opts = facetOptions(f, scope);
    const keep = vals.filter((v) => {
      const o = opts.find((x) => x.value === v);
      return o && scope.some(o.test);
    });
    for (const v of vals) if (!keep.includes(v)) removed.push(`${f.label}: ${opts.find((x) => x.value === v)?.label || v}`);
    if (keep.length) filters[f.key] = keep;
    else delete filters[f.key];
  }
  // Still nothing? The combination contradicts this skill: drop whole filters, most restrictive
  // first (the one whose removal brings back the most runs), until something shows.
  const label = (key) => {
    const f = FACETS.find((x) => x.key === key);
    const opts = facetOptions(f, scope);
    return `${f.label}: ${(filters[key] || []).map((v) => opts.find((o) => o.value === v)?.label || v).join(', ')}`;
  };
  for (let guard = 0; guard < 8 && !applyFilters(scope, filters, state.q).length && Object.keys(filters).length; guard++) {
    let best = null;
    for (const key of Object.keys(filters)) {
      const { [key]: _, ...rest } = filters;
      const n = applyFilters(scope, rest, state.q).length;
      if (!best || n > best.n) best = { key, n };
    }
    removed.push(label(best.key));
    delete filters[best.key];
  }
  if (removed.length) {
    set({ filters });
    toast(`Removed filters that don’t fit ${state.skill}: ${removed.join(' · ')}`, { ms: 7000 });
  }
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
  renderProfile(profile);
  // The first tab is named after what the skill makes (Logos, Slides, Videos…).
  const main = profile[0]?.type;
  const lbl = main ? typeLabel(main) : 'Runs';
  $('#tabMain').textContent = /s$/.test(lbl) ? lbl : `${lbl}s`;
  view = applyFilters(scope, state.filters, state.q).sort(SORTS[state.sort] || SORTS.newest);
  const sizer = $('#gridSizer');
  const keepSkeleton = loading && !allRuns.length;
  if (!keepSkeleton) sizer.querySelectorAll('.skeleton, .empty-state').forEach((n) => n.remove());
  setRuns(view);
  sizer.querySelectorAll('.empty-state').forEach((n) => n.remove());
  if (!keepSkeleton && !view.length) sizer.append(emptyState());
  const counts = facetCounts(scope, state.filters, state.q);
  renderFilters(counts);
  renderSummary(counts);
  renderChips();
  insights = computeInsights(view);
  renderInsightViews();
  refreshStatus();
}

function refreshStatus(busy = '') {
  const progress = loading ? (loading.total == null ? ' · finding days…' : ` · loading day ${Math.min(loading.done + 1, loading.total)} of ${loading.total}…`) : '';
  const sampled = allRuns.some((r) => r.sampleRate < 1) && loadedSessions ? ` · busy days sampled: showing ${fmtInt(allRuns.length)} of ~${fmtInt(loadedSessions)} sessions (${Math.round((allRuns.length / loadedSessions) * 100)}%)` : '';
  const failed = missing.length ? ` · ⚠ ${missing.length} day(s) failed to load (${missing.map((m) => m.day).join(', ')}) — reload to retry` : '';
  status(`${fmtInt(view.length)} of ${fmtInt(scope.length)} runs · ${state.skill} · last ${windowLabel()}${progress}${busy}${sampled}${failed}`);
}

// "Makes: Logo 97% · Image 7%" — the skill's output types, each a one-click filter.
function renderProfile(profile) {
  const el = $('#profile');
  if (!profile.length) return el.replaceChildren();
  el.replaceChildren(h('span', { class: 'k' }, 'Makes'), ...profile.slice(0, 5).map((p) => {
    const on = (state.filters.outputType || []).includes(p.type);
    return h('button', { class: `pf${on ? ' on' : ''}`, title: `${fmtInt(p.runs)} runs produced a ${typeLabel(p.type).toLowerCase()} — click to filter`, onclick: () => toggleFilter('outputType', p.type) },
      typeLabel(p.type), h('small', {}, `${Math.round(p.share * 100)}%`));
  }));
}

// Why the grid is empty, and the one click that fixes it.
function emptyState() {
  if (scope.length) {
    return h('div', { class: 'empty-state' }, h('h2', {}, 'No runs match these filters'), h('p', {}, `${fmtInt(scope.length)} runs are hidden by the filters or search.`),
      h('button', { class: 'btn', onclick: () => { set({ q: '' }); clearFilter(); } }, 'Clear filters'));
  }
  if (missing.length) {
    return h('div', { class: 'empty-state' }, h('h2', {}, `Couldn’t load ${missing.length} day(s)`), h('p', {}, missing[0].error?.slice(0, 200) || ''),
      h('button', { class: 'btn', onclick: loadRuns }, 'Retry'));
  }
  // Loaded runs exist but none inside a short window (e.g. 1h): suggest the next window up.
  const newest = allRuns.reduce((m, r) => Math.max(m, r.createdAt || 0), 0);
  const at = lastSeen?.at || newest || null;
  const ageDays = at ? (Date.now() - at) / 86400000 : null;
  const fit = ageDays != null ? Object.entries(WINDOWS).find(([, d]) => d > ageDays) : null;
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
  label: () => `${state.skill} · last ${windowLabel()} · ${fmtInt(view.length)} runs${Object.keys(state.filters).length || state.q ? ' (filtered)' : ''}`,
  share: (anchor) => shareInsights(anchor, insights, insightActions.label()),
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
    }));
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
  if (ins) stopHover();
  renderInsightViews();
}

// ---------- production load readout ----------
// Every upstream call goes through the proxy's limiters; show what they did recently.
async function pollLoad() {
  try {
    const l = await getJson('/api/load');
    lastLoad = l;
    const lane = (name, label) => {
      const x = l[name];
      return h('span', { title: `${label}: ${x.inflight} in flight, ${x.queued} queued, ${x.total} since start, ${x.errors} errors (max ${x.concurrency} concurrent)` },
        h('b', {}, label), ' ', h('span', { class: x.queued ? 'busy' : '' }, `${x.last5m}`));
    };
    loadEl.replaceChildren(h('span', { title: 'Requests to production-side systems in the last 5 minutes' }, 'Upstream, 5 min:'),
      lane('trino', 'Trino'), lane('admin', 'Admin API'), lane('temporal', 'Temporal'),
      h('span', { title: 'Review videos being prepared locally (ffmpeg; reads the CDN only)' }, h('b', {}, 'Media'), ` ${l.media.active + l.media.pending}`));
  } catch {}
  setTimeout(pollLoad, 5000);
}

// ---------- filters panel ----------
function renderFilters(counts = facetCounts(scope, state.filters, state.q)) {
  const panel = $('#filters');
  panel.hidden = !state.filtersOpen;
  const scroll = panel.scrollTop;
  panel.replaceChildren(...FACETS.map((f) => {
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

// ---------- summary + chips ----------
// Each stat counts like its facet option does: everything else applied, its own facet not — so
// "Generated, no video" still shows 30 while you're looking at finished videos.
function renderSummary(counts) {
  $('#summary').replaceChildren(...STATS.map((s) => {
    const opt = s.filter && counts[s.filter[0]]?.find((o) => o.value === s.filter[1]);
    const pool = s.filter ? counts[s.filter[0]]?.pool : view.length;
    const n = s.filter ? opt?.count ?? 0 : view.length;
    const on = s.filter && (state.filters[s.filter[0]] || []).includes(s.filter[1]);
    const pct = s.filter && pool ? Math.round((n / pool) * 100) : null;
    return h('button', { class: `stat${on ? ' on' : ''}`, title: s.filter ? `${fmtInt(n)} of ${fmtInt(pool)} — click to ${on ? 'remove' : 'add'} this filter` : 'Runs in view', onclick: () => (s.filter ? toggleFilter(...s.filter) : null) },
      h('span', { class: 'v' }, fmtInt(n), pct != null ? h('span', { class: 'pct' }, `${pct}%`) : null),
      h('span', { class: 'k' }, s.dot ? h('span', { class: 'dot', style: { background: s.dot } }) : null, s.label));
  }));
}

function renderChips() {
  const chips = [];
  for (const f of FACETS) {
    for (const v of state.filters[f.key] || []) {
      const o = facetOptions(f, scope).find((x) => x.value === v);
      chips.push(h('button', { class: 'chip', title: 'Remove', onclick: () => toggleFilter(f.key, v) }, h('b', {}, `${f.label}:`), o?.label || v, icon('x')));
    }
  }
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
  $('#days').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) set({ days: WINDOWS[b.dataset.win] });
  });
  $('#aspect').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) set({ aspect: b.dataset.aspect });
  });
  $('#size').addEventListener('input', (e) => set({ size: Number(e.target.value) }));
  const q = $('#q');
  q.value = state.q;
  q.addEventListener('input', debounce(() => set({ q: q.value.trim() }), 120));
  $('#sort').addEventListener('change', (e) => set({ sort: e.target.value }));
  $('#sound').addEventListener('click', () => set({ sound: !state.sound }));
  $('#theme').addEventListener('click', () => {
    const theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    set({ theme });
  });
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
  for (const b of $('#aspect').children) b.setAttribute('aria-checked', String(b.dataset.aspect === state.aspect));
  $('#size').value = state.size;
  $('#sort').value = state.sort;
  if (document.activeElement !== $('#q')) $('#q').value = state.q;
  const snd = $('#sound');
  snd.setAttribute('aria-pressed', String(state.sound));
  snd.replaceChildren(icon(state.sound ? 'volume' : 'mute'));
  $('#filters').hidden = !state.filtersOpen;
  renderSkillButton($('#skillBtn'));
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, select, textarea');
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
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const p = inspectedPlayer();
  const k = e.key;
  const act = {
    '/': () => $('#q').focus(),
    '?': () => ($('#helpDialog').hidden = !$('#helpDialog').hidden),
    f: () => set({ filtersOpen: !state.filtersOpen }),
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
    w: () => state.open && toggleWide(),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [String(n), () => state.open && setInspectTabByIndex(n - 1)])),
    o: () => state.selected && window.open(`https://wix-bo.com/wixel-agent/admin/#/sessions/${state.selected}`, '_blank', 'noopener'),
    d: () => state.selected && downloadSelected(),
  }[k];
  if (act) {
    e.preventDefault();
    stopHover();
    act();
  }
});

function downloadSelected() {
  const r = allRuns.find((x) => x.id === state.selected);
  if (!r) return;
  const a = h('a', { href: r.renderUrl || `/media/${r.id}/review.mp4`, download: `${r.id}.mp4`, target: '_blank', rel: 'noopener' });
  document.body.append(a);
  a.click();
  a.remove();
}
