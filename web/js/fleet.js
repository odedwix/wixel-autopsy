import { $, h, icon, getJson, debounce } from './util.js';
import { toast, popover, closePopover, copyText, mailto } from './ui.js';
import { renderTab, renderDetail, fleetSummary, renderReport, nameOf } from './fleet-views.js';

// Fleet: every major skill at once. View state lives in the URL hash (#f=…) so any view is a
// link, and in localStorage so a reload restores it. Data comes from /api/fleet (daily rollups,
// summed per period on the server); missing days build in the background and fill in as they land.

const KEY = 'autopsy-fleet:v1';
const MAIN_KEY = 'skill-runs:v1';
const defaults = { tab: 'overview', days: 7, today: false, aud: 'real', major: true, q: '', sel: null, cls: [], fix: [], status: 'open', oppKind: null, fixSkill: null, fixSkillFor: null, sort: {}, wide: false, theme: null, textScale: null };

function fromHash() {
  if (!location.hash.startsWith('#f=')) return null;
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(3)));
  } catch {
    return null;
  }
}
const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
})();
const main = (() => {
  try {
    return JSON.parse(localStorage.getItem(MAIN_KEY) || 'null') || {};
  } catch {
    return {};
  }
})();

export const fs = { ...defaults, ...stored, ...fromHash() };
fs.theme ??= main.theme || 'dark';
fs.textScale ??= main.textScale || 1;
const report = new URLSearchParams(location.search).get('report') === 'fleet';

let saveTimer;
export function setFs(patch, { render = true } = {}) {
  const reload = ['days', 'today', 'aud'].some((k) => k in patch && patch[k] !== fs[k]);
  Object.assign(fs, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 120);
  if (reload) return load();
  if (render) draw();
}
function save() {
  const { tab, days, today, aud, major, q, sel, cls, fix, status, oppKind, sort, wide, theme, textScale } = fs;
  try {
    localStorage.setItem(KEY, JSON.stringify({ tab, days, today, aud, major, q, sel, cls, fix, status, oppKind, sort, wide, theme, textScale }));
  } catch {}
  history.replaceState(null, '', `${location.pathname}${location.search}#f=${encodeURIComponent(JSON.stringify(linkState()))}`);
}
export const linkState = () => ({ tab: fs.tab, days: fs.days, today: fs.today, aud: fs.aud, major: fs.major, q: fs.q, sel: fs.sel, cls: fs.cls, fix: fs.fix, status: fs.status, oppKind: fs.oppKind });
export const fleetLink = (patch = {}) => `${location.origin}/fleet.html#f=${encodeURIComponent(JSON.stringify({ ...linkState(), ...patch }))}`;
window.addEventListener('hashchange', () => {
  const v = fromHash();
  if (v) setFs(v);
});

// ---- data ----
let view = null;
let loading = false;
let loadSeq = 0;
let progressTimer;
const params = () => new URLSearchParams({ days: String(fs.days), today: fs.today ? '1' : '0', aud: fs.aud }).toString();

async function load() {
  const seq = ++loadSeq;
  loading = true;
  progress(true);
  draw();
  const t0 = Date.now();
  const tick = setInterval(() => status(`Loading ${periodText()}… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
  try {
    const v = await getJson(`/api/fleet?${params()}`);
    if (seq !== loadSeq) return;
    view = v;
    window.__fleet = v;
  } catch (err) {
    if (seq !== loadSeq) return;
    toast(`Couldn't load the Fleet: ${err.message}`, { ms: 6000 });
  } finally {
    clearInterval(tick);
    if (seq === loadSeq) {
      loading = false;
      progress(false);
      draw();
      watchBuild();
    }
  }
}

// While days are missing or being built, poll the build status and reload when new days land.
let lastHave = '';
function watchBuild() {
  clearTimeout(progressTimer);
  if (!view) return;
  const pending = view.coverage.missing.length + view.coverage.stale.length;
  const building = view.backfill.building || view.backfill.queued;
  drawBuild();
  if (!pending && !building) return;
  progressTimer = setTimeout(async () => {
    try {
      const st = await getJson(`/api/fleet/status?${fs.today ? 'today=1' : `days=${fs.days}`}`);
      view.backfill = st;
      const have = st.days.filter((d) => d.present).map((d) => `${d.day}:${d.builtAt}:${JSON.stringify(d.parts)}`).join(',');
      if (have !== lastHave && lastHave) {
        lastHave = have;
        return load();
      }
      lastHave = have;
    } catch {}
    watchBuild();
  }, 5000);
}

function drawBuild() {
  const el = $('#build');
  if (!view) return (el.hidden = true);
  const want = view.period.days.length;
  const have = view.period.have.length;
  const b = view.backfill;
  el.hidden = false;
  el.className = `fl-build${have === want && !b.building ? ' ok' : ''}`;
  el.replaceChildren(h('i', { class: 'dot' }),
    have === want && !b.building ? `${have}/${want} days`
      : b.waitingForTrinoUntil ? `${have}/${want} days · Trino is busy, waiting ${Math.max(0, Math.round((b.waitingForTrinoUntil - Date.now()) / 1000))}s`
        : `Building ${have}/${want} days${b.building ? ` · ${b.building}` : ''}${b.queued ? ` · ${b.queued} queued` : ''}`);
  el.title = b.readOnly
    ? 'Read-only: this install only reads rollups another machine builds (FLEET_READONLY=1).'
    : `Each day is built once (about a minute of Trino, one query at a time, background priority) and kept in ${b.dir}. Click for the Data tab.`;
  el.onclick = () => setFs({ tab: 'data' });
}

// ---- chrome ----
function progress(on) {
  $('#loadbar').classList.toggle('on', on);
  $('#loadbar').classList.toggle('ind', on);
}
function status(text) {
  $('#statusLine').textContent = text;
}
export function periodText(v = view) {
  if (fs.today) return 'today so far (UTC)';
  if (!v) return `last ${fs.days} days`;
  const d = v.period.days;
  return d.length === 1 ? d[0] : `${d[0]} → ${d.at(-1)} (${d.length} days)`;
}
const audLabel = () => ({ real: 'real users', all: 'everyone', internal: 'employees & team' })[fs.aud];

function draw() {
  for (const b of $('#period').querySelectorAll('button')) b.setAttribute('aria-checked', String(fs.today ? b.dataset.p === 'today' : b.dataset.p === String(fs.days)));
  for (const b of $('#aud').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.a === fs.aud));
  for (const b of $('#tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === fs.tab));
  $('#major').checked = fs.major;
  if (document.activeElement !== $('#q')) $('#q').value = fs.q;
  document.documentElement.dataset.theme = fs.theme;
  document.documentElement.style.setProperty('--fs', String(Math.min(1.6, Math.max(0.9, Number(fs.textScale) || 1))));
  $('#periodLabel').textContent = view ? `${periodText()} · ${audLabel()}${view.period.comparable ? ` · changes vs ${view.period.prevDays[0]} → ${view.period.prevDays.at(-1)}` : view.period.prevDays.length ? ' · no comparison yet (previous period still building)' : ''}` : '';
  const body = $('#body');
  if (!view) {
    body.replaceChildren(h('div', { class: 'fl-empty' }, h('b', {}, loading ? 'Loading the Fleet…' : 'Nothing loaded yet'), 'Daily rollups for every skill, summed for the period.'));
    $('#detail').hidden = true;
    return;
  }
  const counts = { cntIssues: view.issues.filter((i) => i.score > 0).length, cntWaits: view.waits.filter((w) => w.recommend || w.hidden).length, cntOpps: view.opportunities.length, cntSkills: view.skills.filter((s) => s.major).length };
  for (const [id, n] of Object.entries(counts)) $(`#${id}`).textContent = n ? String(n) : '';
  const scroll = body.scrollTop;
  body.replaceChildren(renderTab(view, fs, act));
  body.scrollTop = scroll;
  drawDetail();
  const t = view.totals;
  status(`${periodText()} · ${audLabel()} · ${t.sessions.toLocaleString()} sessions · ${t.turns.toLocaleString()} turns · ${t.calls.toLocaleString()} tool calls · ${view.period.have.length}/${view.period.days.length} days built${view.coverage.prevMissing.length ? ` · comparison period ${view.period.prevHave.length}/${view.period.prevDays.length} days` : ''}`);
  drawBuild();
}

// The panel belongs to the tab its row lives on (Overview shows any of them).
const PANEL_TABS = { issue: 'issues', wait: 'waits', opp: 'opps', skill: 'skills' };
function drawDetail() {
  const el = $('#detail');
  if (!fs.sel || !view || (fs.tab !== 'overview' && PANEL_TABS[fs.sel.kind] !== fs.tab)) {
    el.hidden = true;
    return;
  }
  const node = renderDetail(view, fs, act);
  if (!node) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.toggle('wide', Boolean(fs.wide));
  // Redraws of the same panel keep where you were and what you typed.
  const same = el.dataset.sel === JSON.stringify(fs.sel);
  const scroll = same ? el.querySelector('.insp-body')?.scrollTop || 0 : 0;
  const typed = same ? [...el.querySelectorAll('input[id], select[id]')].map((x) => [x.id, x.value]) : [];
  el.replaceChildren(node);
  el.dataset.sel = JSON.stringify(fs.sel);
  for (const [id, v] of typed) {
    const x = el.querySelector(`#${CSS.escape(id)}`);
    if (x) x.value = v;
  }
  const body = el.querySelector('.insp-body');
  if (body) body.scrollTop = scroll;
}

// ---- actions the views call ----
export const act = {
  select: (kind, key) => setFs({ sel: fs.sel?.kind === kind && fs.sel?.key === key ? null : { kind, key } }),
  open: (kind, key, tab) => setFs({ sel: { kind, key }, ...(tab ? { tab } : {}) }),
  close: () => setFs({ sel: null }),
  tab: (tab) => setFs({ tab }),
  set: (patch) => setFs(patch),
  sort: (table, col) => {
    const cur = fs.sort[table];
    setFs({ sort: { ...fs.sort, [table]: cur === col ? `-${col}` : cur === `-${col}` ? col : col } });
  },
  toggleIn: (key, value) => {
    const cur = new Set(fs[key] || []);
    cur.has(value) ? cur.delete(value) : cur.add(value);
    setFs({ [key]: [...cur] });
  },
  async saveState(kind, id, patch) {
    try {
      const st = await fetch('/api/fleet/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, id, patch }) }).then((r) => r.json());
      if (st.error) throw new Error(st.error);
      view.state = st;
      if (kind === 'issue') for (const i of view.issues) if (i.key === id) i.status = st.issues[id] || null;
      if (kind === 'opportunity') for (const o of view.opportunities) if (o.id === id) o.status = st.opportunities[id] || null;
      toast(kind === 'pin' ? (patch.pinned ? `Pinned ${id}` : `Unpinned ${id}`) : 'Saved');
      if (kind === 'pin') return load();
      draw();
    } catch (err) {
      toast(`Couldn't save: ${err.message}`);
    }
  },
  build: async (days) => {
    await getJson(`/api/fleet/build?days=${days}`);
    toast(`Queued the last ${days} days — they build one at a time in the background`);
    load();
  },
  reload: () => load(),
  view: () => view,
};

// ---- share: link, summary, email, PDF ----
function share(anchor) {
  const item = (ic, label, sub, fn) => h('button', { class: 'sh-row', onclick: () => { fn(); closePopover(); } }, icon(ic), h('span', {}, h('b', {}, label), h('small', {}, sub)));
  const name = `Autopsy Fleet · ${periodText()} · ${audLabel()}`;
  popover(anchor, h('div', { class: 'sh-pop' },
    h('div', { class: 'sh-h' }, 'Share the Fleet'),
    item('copy', 'Copy link', 'This view (tab, period, filters, selection) — opens for anyone running Autopsy', () => copyText(fleetLink(), 'Link')),
    item('copy', 'Copy summary', 'Top actions, issues, wait times and opportunities as text', () => copyText(fleetSummary(view, fs), 'Summary')),
    item('external', 'Email…', 'Opens your mail app with the summary', () => mailto({ subject: `[Autopsy Fleet] ${periodText()}`, body: fleetSummary(view, fs) })),
    item('download', 'Export PDF', 'The digest: actions, issues, wait times, opportunities, skills — saved to Downloads', () => exportPdf(name)),
  ), { align: 'right', width: 340 });
}

async function exportPdf(name) {
  const file = `${name} · ${new Date().toISOString().slice(0, 10)}`.replace(/[/:*?"<>|]+/g, '-');
  const started = Date.now();
  const tick = setInterval(() => toast(`Building the PDF… ${Math.round((Date.now() - started) / 1000)}s`, { ms: 120000 }), 1000);
  try {
    const res = await fetch(`/api/report.pdf?kind=fleet&name=${encodeURIComponent(file)}&view=${encodeURIComponent(`#f=${encodeURIComponent(JSON.stringify(linkState()))}`)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const blob = await res.blob();
    const a = h('a', { href: URL.createObjectURL(blob), download: `${file}.pdf` });
    document.body.append(a);
    a.click();
    a.remove();
    toast(`Saved to Downloads: ${a.download}`, { ms: 5000 });
  } catch (err) {
    toast(`No headless Chrome (${err.message}) — opening the print dialog`, { ms: 4000 });
    location.href = `/fleet.html?report=fleet#f=${encodeURIComponent(JSON.stringify(linkState()))}`;
  } finally {
    clearInterval(tick);
  }
}

// ---- wiring ----
$('#period').addEventListener('click', (e) => {
  const p = e.target.closest('button')?.dataset.p;
  if (!p) return;
  setFs(p === 'today' ? { today: true } : { today: false, days: Number(p) });
});
$('#aud').addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.a;
  if (a) setFs({ aud: a });
});
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.tab;
  if (t) setFs({ tab: t });
});
$('#major').addEventListener('change', (e) => setFs({ major: e.target.checked }));
$('#q').addEventListener('input', debounce((e) => setFs({ q: e.target.value.trim() }), 150));
$('#share').addEventListener('click', (e) => view && share(e.currentTarget));
$('#theme').addEventListener('click', () => setFs({ theme: fs.theme === 'dark' ? 'light' : 'dark' }));
$('#textSize').addEventListener('click', () => {
  const steps = [1, 1.15, 1.3, 1.45, 0.9];
  const cur = Number(fs.textScale) || 1;
  setFs({ textScale: steps[(steps.findIndex((s) => Math.abs(s - cur) < 0.01) + 1) % steps.length] || 1 });
});
const TABS = { o: 'overview', 1: 'issues', 2: 'waits', 3: 'opps', 4: 'skills', 5: 'data' };
document.addEventListener('keydown', (e) => {
  if (e.altKey && ['=', '+', '-', '0', '≠', '–', 'º'].includes(e.key)) {
    const cur = Number(fs.textScale) || 1;
    const next = e.key === '0' || e.key === 'º' ? 1 : Math.min(1.6, Math.max(0.9, cur + (['-', '–'].includes(e.key) ? -0.1 : 0.1)));
    e.preventDefault();
    return setFs({ textScale: Math.round(next * 100) / 100 });
  }
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
    if (e.key === 'Escape' && document.activeElement === $('#q')) $('#q').blur();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    $('#q').focus();
  } else if (e.key === 'Escape') {
    if (fs.sel) setFs({ sel: null });
    else if (fs.q) setFs({ q: '' });
  } else if (e.key.toLowerCase() === 'w' && fs.sel) setFs({ wide: !fs.wide });
  else if (TABS[e.key.toLowerCase()]) setFs({ tab: TABS[e.key.toLowerCase()] });
  else if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key) && fs.sel) {
    const rows = [...document.querySelectorAll('[data-sel-kind]')];
    const i = rows.findIndex((r) => r.dataset.selKind === fs.sel.kind && r.dataset.selKey === fs.sel.key);
    const next = rows[i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      setFs({ sel: { kind: next.dataset.selKind, key: next.dataset.selKey } });
      document.querySelector(`[data-sel-key="${CSS.escape(next.dataset.selKey)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }
});

// Report mode (headless Chrome → PDF, or the print dialog): render the digest once data is in.
async function runReport() {
  document.body.classList.add('fl-report');
  document.documentElement.dataset.theme = 'dark';
  await load();
  // Wait until every day of the period is built (or 4 minutes).
  const until = Date.now() + 240000;
  while (view && view.period.have.length < view.period.days.length && Date.now() < until && !view.backfill.readOnly) {
    await new Promise((r) => setTimeout(r, 5000));
    await load();
  }
  if (!view) {
    window.__reportState = { error: 'no data' };
    return;
  }
  clearTimeout(progressTimer);
  $('#body').replaceChildren(renderReport(view, fs, { periodText: periodText(), audLabel: audLabel() }));
  document.title = `Autopsy Fleet · ${periodText()}`;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (window.__AUTOPSY_HEADLESS) window.__reportState = { title: document.title };
  else setTimeout(() => window.print(), 100);
}

if (report) runReport();
else load();
export { nameOf };
