import { $, h, icon, ago, fmtInt, getJson, debounce } from './util.js';
import { state, set, onChange, toggleFilter, clearFilter } from './state.js';
import { FACETS, STATS, SORTS, applyFilters, facetCounts, facetOptions } from './filters.js';
import { initGrid, setRuns, relayout, markSelected, scrollToIndex, columns, applySound, stopHover } from './grid.js';
import { initInspect, openInspect, closeInspect, inspectedPlayer, prefetchDetail, toggleLive } from './inspect.js';
import { computeInsights, renderInsights, headlines } from './insights.js';

let allRuns = [];
let view = [];
let loadToken = 0;
let missing = [];
let lastSeen = null;
let insights = null;
const insightState = { expanded: {}, scrollTo: null };
const loadEl = h('span', { class: 'load' });
let loading = null; // { done, total, sessions } while days are streaming in
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
  const sel = $('#skill');
  sel.replaceChildren(h('option', { value: state.skill }, state.skill));
  try {
    const skills = await getJson('/api/skills?days=30');
    sel.replaceChildren(...skills.map((s) => h('option', { value: s.skill, selected: s.skill === state.skill }, `${s.skill}  ·  ${fmtInt(s.sessions)}`)));
    if (!skills.some((s) => s.skill === state.skill)) sel.prepend(h('option', { value: state.skill, selected: true }, state.skill));
  } catch {}
}

// Progressive: the index says which days have runs (seconds), then days stream in newest first,
// three at a time, and the grid fills as each one lands. Empty days are never queried.
async function loadRuns() {
  const token = ++loadToken;
  allRuns = [];
  missing = [];
  lastSeen = null;
  loading = { done: 0, total: null };
  skeleton();
  status(`Finding which days ${state.skill} ran in the last ${state.days}d…`);
  try {
    const index = await getJson(`/api/runs-index?skill=${encodeURIComponent(state.skill)}&days=${state.days}`);
    if (token !== loadToken) return;
    lastSeen = index.lastSeen;
    loading.total = index.dayList.length;
    loading.sessions = index.total;
    const queue = index.dayList.map((d) => d.day);
    const seen = new Set();
    const worker = async () => {
      while (queue.length) {
        const day = queue.shift();
        try {
          const runs = await getJson(`/api/runs-day?skill=${encodeURIComponent(state.skill)}&day=${day}`);
          if (token !== loadToken) return;
          for (const r of runs) if (!seen.has(r.id) && seen.add(r.id)) allRuns.push(r);
        } catch (err) {
          if (token !== loadToken) return;
          missing.push({ day, error: err.message });
        }
        loading.done++;
        scheduleRefresh();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (token !== loadToken) return;
  } catch (err) {
    if (token !== loadToken) return;
    loading = null;
    status(`Failed to load runs: ${err.message}`);
    $('#gridSizer').replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'Couldn’t load runs'), h('p', {}, err.message), h('button', { class: 'btn', onclick: loadRuns }, 'Retry')));
    return;
  }
  loading = null;
  refreshView();
  if (state.open && state.selected) {
    const r = allRuns.find((x) => x.id === state.selected);
    if (r) openInspect(r);
  }
}

let refreshQueued = false;
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
  const [aw, ah] = state.aspect.split(':').map(Number);
  const cols = Math.max(1, Math.floor(($('#gridScroll').clientWidth - 28 + 12) / (w + 12)));
  for (let i = 0; i < cols * 2; i++) {
    sizer.append(h('div', { class: 'skeleton', style: { width: `${w}px`, height: `${(w * ah) / aw + 74}px`, transform: `translate(${(i % cols) * (w + 12)}px, ${Math.floor(i / cols) * ((w * ah) / aw + 86)}px)` } }));
  }
}

function refreshView() {
  view = applyFilters(allRuns, state.filters, state.q).sort(SORTS[state.sort] || SORTS.newest);
  const sizer = $('#gridSizer');
  const keepSkeleton = loading && !allRuns.length;
  if (!keepSkeleton) sizer.querySelectorAll('.skeleton, .empty-state').forEach((n) => n.remove());
  setRuns(view);
  sizer.querySelectorAll('.empty-state').forEach((n) => n.remove());
  if (!keepSkeleton && !view.length) sizer.append(emptyState());
  const counts = facetCounts(allRuns, state.filters, state.q);
  renderFilters(counts);
  renderSummary(counts);
  renderChips();
  insights = computeInsights(view);
  renderInsightViews();
  $('#statusLine').dataset.count = view.length;
  const progress = loading ? (loading.total == null ? ' · finding days…' : ` · loading day ${Math.min(loading.done + 1, loading.total)} of ${loading.total} (${fmtInt(loading.sessions)} sessions)…`) : '';
  const failed = missing.length ? ` · ⚠ ${missing.length} day(s) failed to load (${missing.map((m) => m.day).join(', ')}) — reload to retry` : '';
  status(`${fmtInt(view.length)} of ${fmtInt(allRuns.length)} runs · ${state.skill} · last ${state.days}d${progress}${failed}`);
}

// Why the grid is empty, and the one click that fixes it.
function emptyState() {
  if (allRuns.length) {
    return h('div', { class: 'empty-state' }, h('h2', {}, 'No runs match these filters'), h('p', {}, `${fmtInt(allRuns.length)} runs are hidden by the filters or search.`),
      h('button', { class: 'btn', onclick: () => { set({ q: '' }); clearFilter(); } }, 'Clear filters'));
  }
  const at = lastSeen?.at;
  const ageDays = at ? (Date.now() - at) / 86400000 : null;
  const fit = ageDays != null ? [3, 7, 14, 30, 90].find((d) => d > ageDays) : null;
  return h('div', { class: 'empty-state' },
    h('h2', {}, `No ${state.skill} runs in the last ${state.days} days`),
    h('p', {}, at
      ? `It last ran ${ago(at)} (${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}) · ${fmtInt(lastSeen.sessions90d)} sessions in the last 90 days.`
      : 'It hasn’t run in the last 90 days.'),
    fit && fit !== state.days ? h('button', { class: 'btn', onclick: () => set({ days: fit }) }, `Show the last ${fit} days`) : null);
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
  label: () => `${state.skill} · last ${state.days} days · ${fmtInt(view.length)} runs${Object.keys(state.filters).length || state.q ? ' (filtered)' : ''}`,
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
function renderFilters(counts = facetCounts(allRuns, state.filters, state.q)) {
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
      const o = facetOptions(f, allRuns).find((x) => x.value === v);
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
  $('#skill').addEventListener('change', (e) => set({ skill: e.target.value, selected: null, open: false }));
  $('#days').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) set({ days: Number(b.dataset.days) });
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
  for (const b of $('#days').children) b.setAttribute('aria-checked', String(Number(b.dataset.days) === state.days));
  for (const b of $('#aspect').children) b.setAttribute('aria-checked', String(b.dataset.aspect === state.aspect));
  $('#size').value = state.size;
  $('#sort').value = state.sort;
  if (document.activeElement !== $('#q')) $('#q').value = state.q;
  const snd = $('#sound');
  snd.setAttribute('aria-pressed', String(state.sound));
  snd.replaceChildren(icon(state.sound ? 'volume' : 'mute'));
  $('#filters').hidden = !state.filtersOpen;
  if ($('#skill').value !== state.skill) $('#skill').value = state.skill;
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
    a: () => set({ aspect: { '9:16': '1:1', '1:1': '16:9', '16:9': '9:16' }[state.aspect] }),
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
