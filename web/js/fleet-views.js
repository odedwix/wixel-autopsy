import { h, icon, getJson } from './util.js';
import { richTip, toast, copyText, mailto } from './ui.js';

// Fleet views: tabs, detail panels, charts, the fix brief and the printable digest. Pure
// rendering over the /api/fleet payload (server/fleet-analyze.js); actions go through `act`.

// ---------- formatting ----------
const NO_SKILL = '(none)';
export const nameOf = (s) => (s === NO_SKILL ? 'no skill' : s);
const fmtN = (n) => (n == null ? '–' : Math.round(n).toLocaleString());
const fmtK = (n) => (n == null ? '–' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : fmtN(n));
const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(x < 0.1 && x > 0 && d === 0 ? 1 : d)}%`);
const hrs = (x) => (x == null ? '–' : x >= 100 ? `${fmtN(x)} h` : x >= 10 ? `${x.toFixed(0)} h` : x >= 1 ? `${x.toFixed(1)} h` : `${Math.round(x * 60)} min`);
const sec = (ms) => (ms == null || !Number.isFinite(ms) ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s` : ms < 3600000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 3600000).toFixed(1)} h`);
const opName = (tool, method) => (method ? `${tool} · ${method}` : tool);
const shortSig = (s, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);
const tip = (el, text) => richTip(el, () => (typeof text === 'function' ? text() : text));

// A change vs the previous period. `lowerIsBetter` colours it.
function delta(cur, prev, { lowerIsBetter = true, asPct = false } = {}) {
  if (prev == null || cur == null || !Number.isFinite(prev) || !Number.isFinite(cur)) return null;
  if (prev === 0 && cur === 0) return h('span', { class: 'delta flat' }, '±0');
  const d = asPct ? (cur - prev) * 100 : prev ? ((cur - prev) / prev) * 100 : 100;
  if (Math.abs(d) < (asPct ? 0.05 : 2)) return h('span', { class: 'delta flat' }, '≈');
  const worse = lowerIsBetter ? d > 0 : d < 0;
  return h('span', { class: `delta ${worse ? 'bad' : 'good'}` }, `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(asPct ? 1 : 0)}${asPct ? ' pt' : '%'}`);
}
const tag = (cls, text, title) => {
  const el = h('span', { class: `tag ${cls}` }, text);
  if (title) tip(el, title);
  return el;
};
const fixTag = (fix) => tag(fix, { easy: 'Easy fix', medium: 'Medium', hard: 'Hard', none: 'Not a bug' }[fix] || fix, { easy: 'Usually a change to instructions, a path or a schema check.', medium: 'Needs a code or prompt change with some care.', hard: 'Upstream or platform work.', none: 'Not a defect (e.g. out of credits).' }[fix]);
const statusTag = (st) => (st?.status ? tag(`st-${st.status}`, { fixed: `Fixed${st.version ? ` in ${st.version.slice(0, 10)}` : ''}`, accepted: 'Accepted', wontfix: "Won't fix", duplicate: 'Duplicate', dismissed: 'Dismissed' }[st.status] || st.status, st.note || null) : null);
const trendTag = (t) => (t?.dir && t.dir !== 'flat' ? tag(t.dir, { new: 'New', rising: '▲ Rising', falling: '▼ Falling' }[t.dir], t.prevRate != null ? `${(t.rate * 1000).toFixed(2)} per 1k turns now vs ${(t.prevRate * 1000).toFixed(2)} before (z = ${t.z.toFixed(1)})` : 'Not seen in the previous period') : null);
const patternTag = (p) => (p ? tag(p.kind, p.label, p.detail) : null);

// ---------- links into the rest of Autopsy ----------
const WINDOWS = [3, 7, 14, 30, 90];
const windowFor = (days) => WINDOWS.find((w) => w >= days) || 90;
export function autopsyLink(skill, { days = 7, filters = {}, selected = null, q = '' } = {}) {
  const v = { skill, days: windowFor(days), q, sort: 'newest', filters, selected, open: Boolean(selected), tab: 'videos' };
  return `/#v=${encodeURIComponent(JSON.stringify(v))}`;
}
const stepKey = (tool, method) => (tool === 'invoke_rpc' && method ? method : tool);
const daysSince = (t) => Math.ceil((Date.now() - (t || Date.now())) / 86400000) + 1;
const ADMIN = 'https://wix-bo.com/wixel-agent/admin/#/sessions/';

// ---------- charts (inline SVG) ----------
function spark(values, { w = 90, hgt = 22, bars = true, bad = false, title } = {}) {
  const max = Math.max(1, ...values);
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'spark');
  s.setAttribute('width', w);
  s.setAttribute('height', hgt);
  s.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  const bw = w / Math.max(1, values.length);
  if (bars) {
    values.forEach((v, i) => {
      const r = document.createElementNS(s.namespaceURI, 'rect');
      const bh = v ? Math.max(1.5, (v / max) * (hgt - 1)) : 1;
      r.setAttribute('x', i * bw + 0.5);
      r.setAttribute('y', hgt - bh);
      r.setAttribute('width', Math.max(1, bw - 1.5));
      r.setAttribute('height', bh);
      r.setAttribute('class', `bar${v ? (bad ? ' bad' : '') : ' dim'}`);
      s.append(r);
    });
  }
  if (title) tip(s, title);
  return s;
}

function dailyChart(daily, { key1, key2, label1, label2, fmt1 = fmtN, fmt2 = fmtN }) {
  const W = 760;
  const H = 150;
  const pad = { l: 34, r: 6, t: 8, b: 22 };
  const max = Math.max(1, ...daily.map((d) => (d[key1] || 0) + (key2 ? d[key2] || 0 : 0)));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const ns = svg.namespaceURI;
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (const f of [0, 0.5, 1]) {
    const y = pad.t + (1 - f) * (H - pad.t - pad.b);
    el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'gl' });
    el('text', { x: pad.l - 4, y: y + 3, 'text-anchor': 'end', class: 'ax' }, fmtK(max * f));
  }
  const bw = (W - pad.l - pad.r) / Math.max(1, daily.length);
  daily.forEach((d, i) => {
    const x = pad.l + i * bw;
    const v1 = d[key1] || 0;
    const v2 = key2 ? d[key2] || 0 : 0;
    const h1 = (v1 / max) * (H - pad.t - pad.b);
    const h2 = (v2 / max) * (H - pad.t - pad.b);
    const y0 = H - pad.b;
    const r1 = el('rect', { x: x + 2, y: y0 - h1, width: Math.max(2, bw - 4), height: h1, class: `b1${d.final === false ? ' partial' : ''}` });
    const r2 = key2 ? el('rect', { x: x + 2, y: y0 - h1 - h2, width: Math.max(2, bw - 4), height: h2, class: `b2${d.final === false ? ' partial' : ''}` }) : null;
    for (const r of [r1, r2].filter(Boolean)) tip(r, `${d.day}${d.final === false ? ' (still filling in)' : ''}\n${label1}: ${fmt1(v1)}${key2 ? `\n${label2}: ${fmt2(v2)}` : ''}`);
    if (daily.length <= 16 || i % Math.ceil(daily.length / 14) === 0) el('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'ax' }, d.day.slice(5));
  });
  return h('div', { class: 'fl-chart' }, svg);
}

// Durations histogram with p50/p90/p99, the current cap and the recommended wait.
function histChart(w, edges) {
  const W = 600;
  const H = 170;
  const pad = { l: 8, r: 8, t: 18, b: 24 };
  const n = edges.length + 1;
  const ok = Array.from({ length: n }, (_, i) => Number(w.okHist?.[i] || 0));
  const bad = Array.from({ length: n }, (_, i) => Number(w.failHist?.[i] || 0) + (i === bucketOf(w.cap, edges) ? w.hidden : 0));
  const max = Math.max(1, ...ok.map((v, i) => v + bad[i]));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const ns = svg.namespaceURI;
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  const bw = (W - pad.l - pad.r) / n;
  const yb = H - pad.b;
  const xOf = (ms) => {
    if (ms == null) return null;
    const i = bucketOf(ms, edges);
    const lo = i === 0 ? 0 : edges[i - 1] * 1000;
    const hi = i >= edges.length ? edges.at(-1) * 2000 : edges[i] * 1000;
    return pad.l + (i + Math.min(1, Math.max(0, (ms - lo) / (hi - lo)))) * bw;
  };
  for (let i = 0; i < n; i++) {
    const x = pad.l + i * bw;
    const h1 = (ok[i] / max) * (yb - pad.t);
    const h2 = (bad[i] / max) * (yb - pad.t);
    const label = `${i === 0 ? '< ' : ''}${sec(i === 0 ? edges[0] * 1000 : edges[i - 1] * 1000)}${i > 0 && i < edges.length ? `–${sec(edges[i] * 1000)}` : i >= edges.length ? '+' : ''}`;
    if (ok[i]) tip(el('rect', { x: x + 1, y: yb - h1, width: bw - 2, height: h1, class: 'bk' }), `${label}: ${fmtN(ok[i])} succeeded`);
    if (bad[i]) tip(el('rect', { x: x + 1, y: yb - h1 - h2, width: bw - 2, height: h2, class: 'bk f' }), `${label}: ${fmtN(bad[i])} failed or timed out`);
    if (i % 3 === 0) el('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, i === 0 ? '0' : sec(edges[i - 1] * 1000));
  }
  const mark = (ms, cls, text, row = 0) => {
    const x = xOf(ms);
    if (x == null) return;
    el('line', { x1: x, x2: x, y1: pad.t - 4 + row * 11, y2: yb, class: `mk ${cls}` });
    el('text', { x: x + 3, y: pad.t + 4 + row * 11, class: 'lbl' }, text);
  };
  mark(w.p50, 'p', `p50 ${sec(w.p50)}`, 0);
  mark(w.p99, 'p', `p99 ${sec(w.p99)}`, 1);
  if (w.cap) mark(w.cap, 'cap', `gives up at ${sec(w.cap)}`, 0);
  if (w.recommend) mark(w.recommend.tau, 'rec', `wait ≤ ${sec(w.recommend.tau)}`, 2);
  return h('div', { class: 'fl-hist' }, svg);
}
function bucketOf(ms, edges) {
  if (ms == null) return -1;
  const s = ms / 1000;
  let i = 0;
  while (i < edges.length && s >= edges[i]) i++;
  return i;
}

// E(τ): the expected time to a success if attempts are cut at τ and retried (same model as the
// server: successes past τ become timeouts, fail-fast attempts cost what they took, hung jobs τ).
function expected(w, edges, tau) {
  const lo = (i) => (i === 0 ? 0 : edges[i - 1] * 1000);
  const hi = (i) => (i >= edges.length ? edges.at(-1) * 2000 : edges[i] * 1000);
  let cost = 0;
  let succ = 0;
  for (const [k, c0] of Object.entries(w.okHist || {})) {
    const i = Number(k);
    const c = Number(c0);
    const a = lo(i);
    const b = hi(i);
    if (b <= tau) {
      cost += (c * (a + b)) / 2;
      succ += c;
    } else if (a >= tau) cost += c * tau;
    else {
      const f = (tau - a) / (b - a);
      cost += (c * f * (a + tau)) / 2 + c * (1 - f) * tau;
      succ += c * f;
    }
  }
  for (const [k, c0] of Object.entries(w.failHist || {})) cost += Number(c0) * Math.min((lo(Number(k)) + hi(Number(k))) / 2, tau);
  cost += (w.hidden || 0) * tau;
  return succ ? cost / succ : Infinity;
}
function eCurve(w, edges) {
  const taus = edges.map((e) => e * 1000).filter((t) => t >= (w.p50 || 0) * 0.8 && t <= Math.max(w.cap || 0, w.max || 0, 60000) * 1.05);
  const pts = taus.map((t) => [t, expected(w, edges, t)]).filter(([, e]) => Number.isFinite(e));
  if (pts.length < 2) return null;
  const W = 600;
  const H = 110;
  const pad = { l: 44, r: 8, t: 8, b: 20 };
  const maxE = Math.max(...pts.map((p) => p[1]));
  const minE = Math.min(...pts.map((p) => p[1]));
  const lx = (t) => pad.l + (Math.log(t) - Math.log(pts[0][0])) / (Math.log(pts.at(-1)[0]) - Math.log(pts[0][0]) || 1) * (W - pad.l - pad.r);
  const ly = (e) => pad.t + (1 - (e - minE) / (maxE - minE || 1)) * (H - pad.t - pad.b);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const ns = svg.namespaceURI;
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', pts.map(([t, e], i) => `${i ? 'L' : 'M'}${lx(t).toFixed(1)},${ly(e).toFixed(1)}`).join(''));
  p.setAttribute('class', 'ln');
  svg.append(p);
  for (const [t, e] of pts) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', lx(t));
    c.setAttribute('cy', ly(e));
    c.setAttribute('r', 3);
    c.setAttribute('fill', w.recommend && Math.abs(t - w.recommend.tau) < 1 ? 'var(--ok)' : w.cap && t >= w.cap * 0.95 && t <= w.cap * 1.3 ? 'var(--err)' : 'var(--viz-seq)');
    tip(c, `Give up after ${sec(t)} → about ${sec(e)} to a success on average`);
    svg.append(c);
  }
  for (const [y, label] of [[ly(maxE), sec(maxE)], [ly(minE), sec(minE)]]) {
    const tx = document.createElementNS(ns, 'text');
    tx.setAttribute('x', pad.l - 4);
    tx.setAttribute('y', y + 3);
    tx.setAttribute('text-anchor', 'end');
    tx.textContent = label;
    svg.append(tx);
  }
  return h('div', { class: 'fl-ecurve' }, svg);
}

// ---------- shared filters ----------
const matchQ = (q, ...xs) => !q || q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => xs.filter(Boolean).join('\n').toLowerCase().includes(t));
const majorSet = (view) => new Set(view.skills.filter((s) => s.major).map((s) => s.skill));
function visibleIssues(view, fs, { ignoreClass = false } = {}) {
  const major = majorSet(view);
  return view.issues.filter((i) => {
    if (fs.major && !i.owners.some((o) => major.has(o.skill) || o.skill === NO_SKILL)) return false;
    if (!matchQ(fs.q, i.sig, i.tool, i.method, i.cls.label, i.cls.owner, ...i.owners.map((o) => o.skill))) return false;
    const st = i.status?.status || 'open';
    if (fs.status === 'open' && ['fixed', 'wontfix', 'duplicate'].includes(st)) return false;
    if (fs.status !== 'open' && fs.status !== 'all' && st !== fs.status) return false;
    if (!ignoreClass) {
      if (fs.cls?.length ? !fs.cls.includes(i.cls.id) : i.cls.id === 'credits') return false;
      if (fs.fix?.length && !fs.fix.includes(i.cls.fix)) return false;
    }
    return true;
  });
}
function sorter(fs, table, cols, dflt) {
  const s = fs.sort?.[table] || dflt;
  const desc = !s.startsWith('-');
  const key = s.replace(/^-/, '');
  const f = cols[key] || cols[dflt];
  return { key, desc, fn: (a, b) => { const x = f(a); const y = f(b); return (typeof x === 'string' ? x.localeCompare(y) : (x ?? -Infinity) - (y ?? -Infinity)) * (desc ? -1 : 1); } };
}
function th(label, table, key, fs, act, { cls = '', title } = {}) {
  const cur = (fs.sort?.[table] || '').replace(/^-/, '');
  const el = h('th', { class: `${cls}${cur === key ? ' on' : ''}`, 'data-sort': key, onclick: () => act.sort(table, key) }, label);
  if (title) tip(el, title);
  return el;
}

// ---------- tabs ----------
export function renderTab(view, fs, act) {
  const fn = { overview, issues: issuesTab, waits: waitsTab, opps: oppsTab, skills: skillsTab, data: dataTab }[fs.tab] || overview;
  return fn(view, fs, act);
}

function overview(view, fs, act) {
  const t = view.totals;
  const p = view.prevTotals;
  const wf = view.period.weekFactor;
  const failRate = t.calls ? (t.fails - t.creditFails) / t.calls : null;
  const pFailRate = p?.calls ? (p.fails - p.creditFails) / p.calls : null;
  const tile = (v, k, x, { d = null, go = null, title = null } = {}) => {
    const el = h('div', { class: 'fl-tile', 'data-go': go ? '1' : null, onclick: go || null }, h('div', { class: 'v' }, v, d), h('div', { class: 'k' }, k), x ? h('div', { class: 'x' }, x) : null);
    if (title) tip(el, title);
    return el;
  };
  const tiles = h('div', { class: 'fl-tiles' },
    tile(fmtN(t.sessions), 'Sessions', `${fmtN(t.turns)} turns · ${fmtN(t.sessions * wf)}/week`, { d: delta(t.sessions, p?.sessions, { lowerIsBetter: false }), title: 'Sessions with at least one turn in the period (a session spanning midnight counts on both days).' }),
    tile(pct(failRate, 1), 'Tool calls failing', `${fmtN(t.fails - t.creditFails)} of ${fmtN(t.calls)} · out-of-credits excluded`, { d: delta(failRate, pFailRate, { asPct: true }), go: () => act.tab('issues'), title: 'Tool results that errored, excluding "insufficient credits" (not a defect). Measured.' }),
    tile(hrs((t.lostMs / 3600000) * wf), 'Time lost to failures / week', 'failed calls + recovery', { d: delta(t.lostMs, p?.lostMs), go: () => act.tab('issues'), title: 'Each failed call\'s own time, plus one recovery per run of consecutive failures: until the next successful attempt of that operation was started in the turn (or the turn ended). Measured from the agent\'s own entries.' }),
    tile(fmtN(t.hidden), 'Hidden timeouts', 'tool gave up, job still running', { d: delta(t.hidden, p?.hidden), go: () => act.tab('waits'), title: 'The tool returned "success" while its job was still IN_PROGRESS — the user waited the whole cap for nothing.' }),
    tile(pct(t.turns ? t.frustrated / t.turns : null, 1), 'Frustrated turns', `${fmtN(t.frustrated)} frustrated · ${fmtN(t.confused)} confused`, { d: delta(t.turns ? t.frustrated / t.turns : null, p?.turns ? p.frustrated / p.turns : null, { asPct: true }), title: 'The product\'s own turn analysis (sentiment of the user\'s message).' }),
    tile((t.iterations / Math.max(1, t.turns)).toFixed(1), 'Model iterations / turn', `${fmtK(t.iterations)} iterations`, { d: delta(t.iterations / Math.max(1, t.turns), p ? p.iterations / Math.max(1, p.turns) : null), go: () => act.tab('opps'), title: 'Every agent step is a model call over the whole context. Fewer iterations = faster and cheaper.' }),
    tile(`${Math.round(t.inTokens / Math.max(1, t.iterations) / 1000)}k`, 'Input tokens / iteration', `${pct(t.cachedTokens / Math.max(1, t.inTokens))} cached`, { d: delta(t.inTokens / Math.max(1, t.iterations), p ? p.inTokens / Math.max(1, p.iterations) : null), go: () => act.tab('opps') }),
    tile(hrs((t.thinkMs / 3600000) * wf), 'Agent thinking / week', `${sec(t.thinkMs / Math.max(1, t.iterations))} per iteration`, { title: 'Time between an entry and the next model call: the model\'s latency (gaps over 10 min excluded).' }),
    t.outcomeDays ? tile(pct(t.kept / Math.max(1, t.produced)), 'Outputs kept', `${fmtN(t.kept)} of ${fmtN(t.produced)} sessions with output were downloaded`, { d: delta(t.produced ? t.kept / t.produced : null, p?.produced ? p.kept / p.produced : null, { asPct: true, lowerIsBetter: false }), go: () => act.tab('skills'), title: 'Sessions where the agent wrote an asset, and someone downloaded it (the editor\'s download, or the agent\'s download tool). Session-level: credited to the session\'s first skill. Publishing isn\'t counted yet.' }) : null,
    t.outcomeDays ? tile(pct(t.triedNoOutput / Math.max(1, t.outSessions)), 'Tried, no output', `${fmtN(t.triedNoOutput)} sessions generated but wrote no asset`, { title: 'Sessions that ran at least one generation but never wrote an asset to the project.' }) : null,
    tile(pct(t.noSkillSessions / Math.max(1, t.sessions)), 'Sessions with no skill', `${fmtN(t.noSkillSessions)} — the agent works from tools alone`, { title: 'These sessions never loaded a skill. Their issues show under "no skill".' }),
  );

  const actions = view.actions.length
    ? h('div', { class: 'fl-actions' }, view.actions.map((a, i) => {
      const row = h('div', { class: 'fl-action', onclick: () => act.open(a.kind === 'issue' ? 'issue' : a.kind === 'wait' ? 'wait' : 'opp', a.ref, a.kind === 'issue' ? 'issues' : a.kind === 'wait' ? 'waits' : 'opps') },
        h('span', { class: 'n' }, String(i + 1)),
        h('div', { class: 't' }, h('b', {}, a.kind === 'issue' ? shortSig(a.title, 120) : a.title), h('small', {}, a.sub)),
        h('div', { class: 'h' }, h('b', {}, hrs(a.hPerWeek)), h('small', {}, a.kind === 'opportunity' ? 'est. / week' : 'given back / week')));
      tip(row, `${a.kind === 'issue' ? 'Fix' : a.kind === 'wait' ? 'Timeout' : 'Agent design'} · owner: ${a.owner} · ${a.fix} fix\n${a.kind === 'opportunity' ? 'Estimated' : 'Measured time lost × how fixable it is'}`);
      return row;
    }))
    : h('p', { class: 'desc' }, 'Nothing stands out yet — or the period is still building.');

  const skills = view.skills.filter((s) => s.major && matchQ(fs.q, s.skill)).slice(0, 14);
  const maxLost = Math.max(1, ...skills.map((s) => s.lostHPerWeek));
  const board = h('table', { class: 'fl' },
    h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Skill'), h('th', {}, 'Sessions / wk'), h('th', {}, 'Failing calls'), h('th', {}, 'Time lost / wk'), h('th', {}, 'Frustrated'), h('th', {}, 'Output kept'), h('th', {}, 'Iter. / turn'), h('th', { class: 'l' }, 'Top issue'))),
    h('tbody', {}, skills.map((s) => h('tr', { 'data-sel-kind': 'skill', 'data-sel-key': s.skill, class: fs.sel?.kind === 'skill' && fs.sel.key === s.skill ? 'sel' : '', onclick: () => act.select('skill', s.skill) },
      h('td', { class: 'l' }, nameOf(s.skill)),
      h('td', {}, fmtN(s.sessionsPerWeek), ' ', delta(s.sessions, s.prevSessions, { lowerIsBetter: false })),
      h('td', {}, pct(s.failRate, 1), ' ', delta(s.failRate, s.prevFailRate, { asPct: true })),
      h('td', {}, h('span', { class: 'minibar' }, h('i', { class: 'bad', style: { width: `${(s.lostHPerWeek / maxLost) * 60}px` } }), hrs(s.lostHPerWeek))),
      h('td', {}, pct(s.frustration, 1)),
      h('td', {}, s.keptRate != null ? pct(s.keptRate) : '–'),
      h('td', {}, s.iterPerTurn.toFixed(1)),
      h('td', { class: 'l dim', style: { maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.topIssue ? shortSig(s.topIssue.label, 60) : '–')))));

  const byFix = {};
  for (const i of view.issues) byFix[i.cls.fix] = (byFix[i.cls.fix] || 0) + i.lostHPerWeek;
  const fixBars = h('div', { class: 'bars' }, ['easy', 'medium', 'hard'].map((f) => {
    const max = Math.max(1, ...Object.values(byFix));
    return h('div', { class: 'bar-row', onclick: () => act.set({ tab: 'issues', fix: [f], cls: [] }) }, h('span', { class: 'lbl' }, fixTag(f), h('small', {}, { easy: 'paths, instructions, schema checks', medium: 'prompt / code changes', hard: 'upstream & platform' }[f])), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${((byFix[f] || 0) / max) * 100}%`, background: f === 'easy' ? 'var(--viz-good)' : f === 'medium' ? 'var(--viz-warn)' : 'var(--viz-crit)' } })), h('span', { class: 'val' }, hrs(byFix[f] || 0)));
  }));

  return h('div', {},
    tiles,
    h('div', { class: 'fl-cols' },
      h('section', { class: 'fl-card' }, h('h3', {}, icon('bolt'), 'Do these first', h('span', { class: 'r' }, 'hours a week given back')), h('p', { class: 'desc' }, 'Issues, timeouts and agent-design changes on one scale. Issues count measured time lost × how fixable the class is; opportunities are estimates (see each card).'), actions),
      h('section', { class: 'fl-card' }, h('h3', {}, 'Failed tool calls per day', h('span', { class: 'r' }, 'faded = day still filling in')),
        dailyChart(view.daily.map((d) => ({ ...d, okFails: Math.max(0, d.fails) })), { key1: 'fails', label1: 'Failed tool calls (incl. out of credits)' }),
        h('div', { class: 'legend' }, h('span', {}, h('i', { style: { background: 'var(--viz-seq)' } }), 'failed tool calls')),
        h('p', { class: 'desc', style: { marginTop: '8px' } }, `Time lost: ${view.daily.map((d) => `${d.day.slice(5)} ${hrs(d.lostMs / 3600000)}`).join(' · ')}`)),
      shiftsCard(view, act),
      intentsCard(view, fs, act),
      h('section', { class: 'fl-card' }, h('h3', {}, 'Where the time lost could come back'), h('p', { class: 'desc' }, 'Time lost per week by how hard the fix is. Click to see those issues.'), fixBars),
      h('section', { class: 'fl-card wide' }, h('h3', {}, 'Major skills', h('span', { class: 'r' }, `≥50 sessions a week · ${view.skills.filter((s) => s.major).length} skills`)), board),
    ),
    h('p', { class: 'fl-note' }, h('b', {}, 'Measured vs estimated. '), 'Counts, durations, recoveries, tokens and versions are measured from the agent\'s own entries. Time lost uses one stated rule (failed calls + one recovery per run of failures). Savings from agent-design changes and recommended timeouts are estimates — each says how it was computed.'));
}

// What changed day over day (and the codex versions that went live that day).
function shiftsCard(view, act, { all = false } = {}) {
  const rows = (view.shifts || []).slice(0, all ? 40 : 8);
  const fmtV = (v, f) => (v == null ? '' : f === 'pct' ? pct(v, 1) : f === 'k' ? `${Math.round(v / 1000)}k` : f === 'n' ? fmtN(v) : v.toFixed(1));
  return h('section', { class: 'fl-card' }, h('h3', {}, icon('alert'), 'What changed', h('span', { class: 'r' }, 'a day vs the 7 before it')),
    h('p', { class: 'desc' }, 'Shifts beyond the normal day-to-day range, and codex versions that took over ≥20% of a day\'s turns. A shift right after a new version is the first place to look.'),
    rows.length ? h('div', {}, rows.map((x) => h('div', { class: 'rep', style: { cursor: 'default' } },
      h('span', { class: 't' }, h('b', { style: { color: x.worse ? 'var(--err)' : x.from == null ? 'var(--text)' : 'var(--ok)', fontWeight: 500 } }, x.metric), x.from != null ? ` ${fmtV(x.from, x.fmt)} → ${fmtV(x.to, x.fmt)}` : '',
        x.newVersions?.length ? h('span', { class: 'dim', style: { color: 'var(--text-3)' } }, ` · new version ${x.newVersions.map((v) => `${v.ver.slice(0, 10)} (${pct(v.share)} of turns)`).join(', ')}`) : null,
        x.note ? h('span', { class: 'dim', style: { color: 'var(--text-3)', display: 'block', fontSize: '11.5px' } }, x.note) : null),
      h('span', { class: 'n' }, x.day)))) : h('p', { class: 'desc' }, 'Nothing moved beyond its normal range in this period.'));
}

// What users ask for (the product's intent label on their first message) and how it ended.
function intentsCard(view, fs, act, { all = false } = {}) {
  const rows = (view.intents || []).filter((x) => x.intent !== '(unknown)' && matchQ(fs.q, x.intent, ...x.owners.map((o) => o[0])));
  const list = all ? rows : rows.filter((x) => x.flags.length).slice(0, 8);
  if (!view.totals.outcomeDays) return null;
  const table = h('table', { class: 'fl' },
    h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Users ask to…'), h('th', {}, 'Sessions / wk'), h('th', {}, 'Got output'), h('th', {}, 'Kept'), h('th', {}, 'Tried, none'), h('th', {}, 'Upset'), h('th', { class: 'l' }, 'Served by'))),
    h('tbody', {}, list.map((x) => h('tr', { style: { cursor: 'default' } },
      h('td', { class: 'l' }, x.intent, ' ', ...x.flags.map((f) => tag('rising', f))),
      h('td', {}, fmtN(x.perWeek)),
      h('td', {}, x.nonAsset ? h('span', { class: 'dim', title: 'Its result isn\'t an asset in the project (a website, an API call, an answer)' }, 'n/a') : pct(x.producedRate)),
      h('td', {}, x.keptRate != null && !x.nonAsset ? pct(x.keptRate) : '–'),
      h('td', {}, x.nonAsset ? '–' : pct(x.noOutputRate)),
      h('td', {}, pct(x.upsetRate)),
      h('td', { class: 'l dim' }, x.owners.map(([o, n]) => `${nameOf(o)} (${fmtN(n)})`).join(', '))))));
  return h('section', { class: `fl-card${all ? ' wide' : ''}` }, h('h3', {}, all ? 'What users ask for' : 'Asks that end badly', h('span', { class: 'r' }, all ? `${rows.length} kinds of request` : 'vs the fleet')),
    h('p', { class: 'desc' }, all
      ? 'The product\'s own label for each session\'s first request, and how those sessions ended (session-level). A request that fails whatever skill serves it is a product gap, not a bug.'
      : 'Requests whose sessions keep few outputs, upset users more than the fleet, or often generate without producing anything. Could be a product gap rather than a bug. All requests: the Skills tab.'),
    list.length ? table : h('p', { class: 'desc' }, 'No kind of request stands out.'));
}

// ---------- issues ----------
function issuesTab(view, fs, act) {
  const all = visibleIssues(view, fs, { ignoreClass: true });
  const rows = visibleIssues(view, fs);
  const s = sorter(fs, 'issues', { score: (i) => i.score, n: (i) => i.n, lost: (i) => i.lostHPerWeek, sessions: (i) => i.sessions, fatal: (i) => i.fatal, trend: (i) => i.trend.z }, 'score');
  rows.sort(s.fn);
  const classes = {};
  for (const i of all) classes[i.cls.id] = { label: i.cls.label, n: (classes[i.cls.id]?.n || 0) + 1 };
  const fixes = {};
  for (const i of all) fixes[i.cls.fix] = (fixes[i.cls.fix] || 0) + 1;
  const filters = h('div', { class: 'fl-filters' },
    h('span', { class: 'lbl' }, 'Kind'),
    Object.entries(classes).sort((a, b) => b[1].n - a[1].n).map(([id, c]) => h('button', { class: `fbtn${fs.cls?.includes(id) ? ' on' : ''}`, onclick: () => act.toggleIn('cls', id) }, c.label, h('small', {}, c.n))),
    h('span', { class: 'sep' }),
    h('span', { class: 'lbl' }, 'Fix'),
    ['easy', 'medium', 'hard'].filter((f) => fixes[f]).map((f) => h('button', { class: `fbtn${fs.fix?.includes(f) ? ' on' : ''}`, onclick: () => act.toggleIn('fix', f) }, { easy: 'Easy', medium: 'Medium', hard: 'Hard' }[f], h('small', {}, fixes[f]))),
    h('span', { class: 'sep' }),
    h('span', { class: 'lbl' }, 'Status'),
    ['open', 'accepted', 'fixed', 'wontfix', 'all'].map((st) => h('button', { class: `fbtn${fs.status === st ? ' on' : ''}`, onclick: () => act.set({ status: st }) }, { open: 'Open', accepted: 'Accepted', fixed: 'Fixed', wontfix: "Won't fix", all: 'All' }[st])),
    (fs.cls?.length || fs.fix?.length) ? h('button', { class: 'fbtn', onclick: () => act.set({ cls: [], fix: [] }) }, 'Clear') : null);
  const days = view.period.days;
  const table = h('table', { class: 'fl' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'l' }, '#'),
      h('th', { class: 'l' }, 'Issue'),
      th('Per week', 'issues', 'n', fs, act, { title: 'Occurrences per week (the period scaled to 7 days).' }),
      th('Sessions', 'issues', 'sessions', fs, act),
      th('Time lost / wk', 'issues', 'lost', fs, act, { title: 'Failed calls + one recovery per run of failures (until the next successful attempt started, else the turn\'s end). Measured.' }),
      th('No retry success', 'issues', 'fatal', fs, act, { title: 'Share of occurrences after which the same operation never succeeded later in that turn. The agent may still have worked around it with another tool.' }),
      h('th', {}, 'Per day'),
      th('Trend', 'issues', 'trend', fs, act, { title: 'Rate per 1k turns vs the previous period of the same length (Poisson z-test).' }),
      th('Priority', 'issues', 'score', fs, act, { title: 'Impact (time lost + 10 min per session it ended + 5 min per upset user) × how fixable the class is × how concentrated it is, boosted when new or rising.' }))),
    h('tbody', {}, rows.slice(0, 250).map((i, idx) => h('tr', { 'data-sel-kind': 'issue', 'data-sel-key': i.key, class: `${fs.sel?.kind === 'issue' && fs.sel.key === i.key ? 'sel' : ''}${['fixed', 'wontfix', 'duplicate'].includes(i.status?.status) ? ' muted' : ''}`, onclick: () => act.select('issue', i.key) },
      h('td', { class: 'rank' }, String(idx + 1)),
      h('td', { class: 'main' },
        h('div', { class: 's1' }, i.sig),
        h('div', { class: 's2' }, fixTag(i.cls.fix), tag('', i.cls.label), h('span', {}, opName(i.tool, i.method)), h('span', {}, '·'), h('span', {}, i.owners.slice(0, 3).map((o) => nameOf(o.skill)).join(', ') + (i.owners.length > 3 ? ` +${i.owners.length - 3}` : '')), patternTag(i.pattern), statusTag(i.status))),
      h('td', {}, fmtN(i.perWeek)),
      h('td', {}, fmtN(i.sessions)),
      h('td', {}, hrs(i.lostHPerWeek)),
      h('td', {}, pct(i.fatal)),
      h('td', {}, spark(days.map((d) => i.perDay[d] || 0), { bad: true, title: days.map((d) => `${d}: ${fmtN(i.perDay[d] || 0)}`).join('\n') })),
      h('td', {}, trendTag(i.trend) || h('span', { class: 'dim' }, i.trend.prevN == null ? '–' : '≈')),
      h('td', {}, i.score ? i.score.toFixed(0) : h('span', { class: 'dim' }, '–'))))));
  return h('div', {},
    h('p', { class: 'fl-note' }, `${rows.length} issues${rows.length !== all.length ? ` (of ${all.length})` : ''}. One row per error signature (ids, numbers and URLs blanked) and operation, across every skill it happens in. `,
      view.otherErrors ? `${fmtN(view.otherErrors)} rare errors are folded per day and not listed. ` : '',
      'Out of credits is hidden unless picked.'),
    filters,
    rows.length ? h('div', { class: 'fl-tablewrap' }, table) : h('div', { class: 'fl-empty' }, h('b', {}, 'No issues match'), 'Change the filters above, or the search.'));
}

// ---------- wait times ----------
function waitsTab(view, fs, act) {
  const rows = view.waits.filter((w) => matchQ(fs.q, w.tool, w.method, w.model, w.size, ...w.owners.map((o) => o[0])));
  const s = sorter(fs, 'waits', { saved: (w) => w.recommend?.savedHPerWeek || 0, calls: (w) => w.calls, p50: (w) => w.p50, p99: (w) => w.p99, hidden: (w) => w.hidden, wait: (w) => w.waitHPerWeek, fail: (w) => w.fails / w.calls }, 'saved');
  rows.sort(s.fn);
  const table = h('table', { class: 'fl' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'l' }, 'Operation'),
      th('Calls / wk', 'waits', 'calls', fs, act),
      th('Fails', 'waits', 'fail', fs, act),
      th('p50', 'waits', 'p50', fs, act, { title: 'Median duration of successful calls.' }),
      h('th', {}, 'p90'),
      th('p99', 'waits', 'p99', fs, act),
      th('Hidden timeouts', 'waits', 'hidden', fs, act, { title: 'Returned while the job was still running; the number after it is the cap they hit.' }),
      h('th', {}, 'Retry works', ),
      h('th', {}, 'Recommended wait'),
      th('Saved / wk', 'waits', 'saved', fs, act, { title: 'Estimated: the drop in expected time-to-success with the recommended wait, × successes per week.' }),
      th('Waiting / wk', 'waits', 'wait', fs, act, { title: 'Total time spent in this operation per week (successes + failures).' }))),
    h('tbody', {}, rows.slice(0, 200).map((w) => h('tr', { 'data-sel-kind': 'wait', 'data-sel-key': w.key, class: fs.sel?.kind === 'wait' && fs.sel.key === w.key ? 'sel' : '', onclick: () => act.select('wait', w.key) },
      h('td', { class: 'main' }, h('div', { class: 's1' }, opName(w.tool, w.method)), h('div', { class: 's2' }, w.model ? h('span', {}, w.model) : null, w.size ? tag('', w.size, 'Input size bucket (clip length / resolution)') : null, h('span', {}, w.owners.slice(0, 2).map((o) => nameOf(o[0])).join(', ')))),
      h('td', {}, fmtN(w.callsPerWeek)),
      h('td', {}, pct(w.fails / w.calls, 1)),
      h('td', {}, sec(w.p50)),
      h('td', {}, sec(w.p90)),
      h('td', {}, sec(w.p99)),
      h('td', {}, w.hidden ? h('span', { style: { color: 'var(--err)' } }, w.cap ? `${fmtN(w.hidden)} @ ${sec(w.cap)}` : `${fmtN(w.hidden)} (no duration)`) : h('span', { class: 'dim' }, '–')),
      h('td', {}, w.retries ? `${pct(w.retryOk / w.retries)} of ${fmtN(w.retries)}` : h('span', { class: 'dim' }, '–')),
      h('td', {}, w.recommend ? h('b', { style: { color: 'var(--ok)' } }, `≤ ${sec(w.recommend.tau)}`) : h('span', { class: 'dim' }, '–')),
      h('td', {}, w.recommend ? hrs(w.recommend.savedHPerWeek) : h('span', { class: 'dim' }, '–')),
      h('td', {}, hrs(w.waitHPerWeek))))));
  return h('div', {},
    h('p', { class: 'fl-note' }, h('b', {}, 'How long each operation really takes. '), 'Durations come from successful calls, per tool · method · model · input size, across every skill. A hidden timeout is a call that returned while its job was still running — the user waited the whole cap for nothing. The recommended wait minimizes the expected time to a success when longer attempts are cut and retried; it never cuts below 1.5× the p95 of successes. When the job is still running, re-attaching to it beats starting over.'),
    h('div', { class: 'fl-tablewrap' }, table));
}

// ---------- opportunities ----------
const KINDS = { 'trial-and-error': 'Trial and error', 'fixed-chain': 'Scripted pipeline', 'constant-args': 'Same call every time', 'co-load': 'Always loaded together', plumbing: 'File busywork', 'auto-correct': 'Let the tool fix it', 'rubber-stamp': 'Rubber-stamp approval', context: 'Heavy context', reattach: 'Re-attach, don\'t restart' };
function oppsTab(view, fs, act) {
  const major = majorSet(view);
  const kinds = {};
  const base = view.opportunities.filter((o) => (!fs.major || !o.skill || major.has(o.skill) || o.skill === NO_SKILL) && matchQ(fs.q, o.title, o.skill, o.detail, KINDS[o.kind]));
  for (const o of base) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  const pick = fs.oppKind || null;
  const rows = base.filter((o) => !pick || o.kind === pick);
  return h('div', {},
    h('p', { class: 'fl-note' }, h('b', {}, 'Where the agent works harder than it needs to. '), 'Every model iteration re-reads the whole context (~100k+ tokens) and takes seconds; each card estimates the iterations, time and tokens a change would save per week. These are estimates on stated assumptions — check the runs behind each before acting.'),
    h('div', { class: 'fl-filters' }, h('button', { class: `fbtn${!pick ? ' on' : ''}`, onclick: () => act.set({ oppKind: null }) }, 'All', h('small', {}, base.length)),
      Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => h('button', { class: `fbtn${pick === k ? ' on' : ''}`, onclick: () => act.set({ oppKind: pick === k ? null : k }) }, KINDS[k] || k, h('small', {}, n)))),
    rows.length ? h('div', { class: 'fl-cols' }, rows.map((o) => oppCard(o, view, fs, act))) : h('div', { class: 'fl-empty' }, h('b', {}, 'No opportunities match'), 'Try "All", or turn off "Major skills".'));
}
function oppCard(o, view, fs, act, { full = false } = {}) {
  const dismissed = o.status?.status === 'dismissed';
  return h('section', { class: `fl-card fl-opp${dismissed ? ' dismissed' : ''}`, 'data-sel-kind': 'opp', 'data-sel-key': o.id, onclick: full ? null : () => act.select('opp', o.id), style: { cursor: full ? 'default' : 'pointer', outline: fs.sel?.kind === 'opp' && fs.sel.key === o.id && !full ? '2px solid var(--accent)' : null } },
    h('div', { class: 'kind' }, tag('', KINDS[o.kind] || o.kind), o.skill ? h('span', { class: 'dim', style: { color: 'var(--text-3)', fontSize: '12px' } }, nameOf(o.skill)) : null, tag('meas', o.confidence), statusTag(o.status)),
    h('h4', {}, o.title),
    o.chain ? h('div', { class: 'chain' }, o.chain.flatMap((s, i) => [i ? h('i', {}, '→') : null, h('span', {}, s)]).filter(Boolean)) : null,
    h('p', {}, o.detail),
    o.guard ? h('div', { class: 'guard' }, icon('alert'), o.guard) : null,
    o.evidence?.length ? h('ul', {}, o.evidence.map((e) => h('li', {}, e))) : null,
    h('div', { class: 'save' },
      o.savings.hPerWeek ? h('div', {}, h('b', {}, hrs(o.savings.hPerWeek)), ' ', h('span', {}, 'per week')) : null,
      o.savings.iterationsPerWeek ? h('div', {}, h('b', {}, fmtK(o.savings.iterationsPerWeek)), ' ', h('span', {}, `${o.unit || 'iterations'} / week`)) : null,
      o.savings.tokensPerWeek ? h('div', {}, h('b', {}, fmtK(o.savings.tokensPerWeek)), ' ', h('span', {}, 'input tokens / week')) : null),
    full ? h('div', { class: 'acts' },
      o.skill && o.skill !== NO_SKILL ? h('a', { class: 'btn', href: autopsyLink(o.skill, { days: view.period.days.length }), target: '_blank' }, icon('external'), `Open ${o.skill} runs`) : null,
      o.issue ? h('button', { class: 'btn', onclick: () => act.open('issue', o.issue, 'issues') }, 'Open the issue') : null,
      o.wait ? h('button', { class: 'btn', onclick: () => act.open('wait', o.wait, 'waits') }, 'Open wait times') : null,
      h('button', { class: 'btn', onclick: () => act.saveState('opportunity', o.id, { status: o.status?.status === 'accepted' ? '' : 'accepted' }) }, o.status?.status === 'accepted' ? 'Un-accept' : 'Accept'),
      h('button', { class: 'btn', onclick: () => act.saveState('opportunity', o.id, { status: dismissed ? '' : 'dismissed' }) }, dismissed ? 'Restore' : 'Dismiss')) : null);
}

// ---------- skills ----------
function skillsTab(view, fs, act) {
  const rows = view.skills.filter((s) => (!fs.major || s.major) && matchQ(fs.q, s.skill));
  const s = sorter(fs, 'skills', { kept: (x) => x.keptRate, gpk: (x) => x.gensPerKept, sessions: (x) => x.sessions, fail: (x) => x.failRate, lost: (x) => x.lostHPerWeek, frus: (x) => x.frustration, iter: (x) => x.iterPerTurn, tok: (x) => x.tokensPerIter, think: (x) => x.thinkHPerWeek, hidden: (x) => x.hidden, name: (x) => x.skill }, 'sessions');
  rows.sort(s.fn);
  const pins = view.state?.pins || [];
  return h('div', {},
    h('div', { class: 'fl-cols', style: { marginBottom: '12px' } }, intentsCard(view, fs, act, { all: true })),
    h('p', { class: 'fl-note' }, `${rows.length} skills${fs.major ? ' (major: ≥50 sessions a week, or pinned)' : ''}. A turn belongs to the skill it loads (its helpers stay with it); turns that load no skill belong to "no skill".`),
    h('div', { class: 'fl-tablewrap' }, h('table', { class: 'fl' },
      h('thead', {}, h('tr', {},
        th('Skill', 'skills', 'name', fs, act, { cls: 'l' }),
        th('Sessions', 'skills', 'sessions', fs, act),
        h('th', {}, 'Turns'),
        th('Failing calls', 'skills', 'fail', fs, act, { title: 'Excluding out of credits. ± = 95% interval.' }),
        h('th', {}, 'Failed turns'),
        th('Time lost / wk', 'skills', 'lost', fs, act),
        th('Hidden t/o', 'skills', 'hidden', fs, act),
        th('Frustrated', 'skills', 'frus', fs, act),
        th('Iter. / turn', 'skills', 'iter', fs, act),
        th('Tokens / iter.', 'skills', 'tok', fs, act),
        th('Thinking / wk', 'skills', 'think', fs, act),
        th('Output kept', 'skills', 'kept', fs, act, { title: 'Of the sessions where it wrote an asset, the share downloaded (editor or agent). Session-level.' }),
        th('Gens / kept', 'skills', 'gpk', fs, act, { title: 'Generations per session whose output was kept: how much trial and error a kept result takes.' }),
        h('th', {}, '"Yes" replies'),
        h('th', {}, ''))),
      h('tbody', {}, rows.map((x) => h('tr', { 'data-sel-kind': 'skill', 'data-sel-key': x.skill, class: fs.sel?.kind === 'skill' && fs.sel.key === x.skill ? 'sel' : '', onclick: () => act.select('skill', x.skill) },
        h('td', { class: 'l' }, nameOf(x.skill), pins.includes(x.skill) ? h('span', { class: 'dim' }, ' · pinned') : null),
        h('td', {}, fmtN(x.sessions), ' ', delta(x.sessions, x.prevSessions, { lowerIsBetter: false })),
        h('td', {}, fmtN(x.turns)),
        h('td', {}, pct(x.failRate, 1), h('span', { class: 'dim' }, ` ±${((x.failRateCI[1] - x.failRateCI[0]) * 50).toFixed(1)}`)),
        h('td', {}, pct(x.failedTurnRate, 1)),
        h('td', {}, hrs(x.lostHPerWeek)),
        h('td', {}, x.hidden ? fmtN(x.hidden) : h('span', { class: 'dim' }, '–')),
        h('td', {}, pct(x.frustration, 1)),
        h('td', {}, x.iterPerTurn.toFixed(1)),
        h('td', {}, `${Math.round(x.tokensPerIter / 1000)}k`),
        h('td', {}, hrs(x.thinkHPerWeek)),
        h('td', {}, x.keptRate != null ? [pct(x.keptRate), ' ', delta(x.keptRate, x.prevKeptRate, { asPct: true, lowerIsBetter: false })] : h('span', { class: 'dim' }, '–')),
        h('td', {}, x.gensPerKept != null ? x.gensPerKept.toFixed(1) : h('span', { class: 'dim' }, '–')),
        h('td', {}, pct(x.affirmShare)),
        h('td', {}, x.skill !== NO_SKILL ? h('a', { href: autopsyLink(x.skill, { days: view.period.days.length }), target: '_blank', onclick: (e) => e.stopPropagation(), title: 'Open this skill\'s runs in Autopsy' }, icon('external')) : null)))))));
}

// ---------- data ----------
function dataTab(view, fs, act) {
  const b = view.backfill;
  const rows = view.health;
  return h('div', { class: 'fl-cols' },
    h('section', { class: 'fl-card wide' }, h('h3', {}, 'Days in this period', h('span', { class: 'r' }, `${view.period.have.length}/${view.period.days.length} built · stored in ${b.dir}`)),
      h('p', { class: 'desc' }, 'Each UTC day is built once from Trino — about a minute of queries, one at a time, in the background lane (on-screen work always goes first) — and kept as a small file. A day is final 6 hours after it ends and is never queried again; today refreshes at most every 30 minutes.'),
      h('table', { class: 'fl fl-days' },
        h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Day'), h('th', {}, 'State'), h('th', {}, 'Built'), h('th', {}, 'Took'), h('th', {}, 'Internal accounts'), h('th', {}, 'No-skill sessions'), h('th', {}, 'Calls with timing'), h('th', {}, 'Rare errors folded'), h('th', { class: 'l' }, 'Problems'))),
        h('tbody', {}, rows.map((d) => h('tr', {},
          h('td', { class: 'l' }, d.day),
          h('td', { class: d.present ? '' : 'bad' }, !d.present ? 'missing' : d.final ? 'final' : 'filling in'),
          h('td', {}, d.builtAt ? new Date(d.builtAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'),
          h('td', {}, d.buildMs ? sec(d.buildMs) : '–'),
          h('td', {}, d.internal ? `${fmtN(d.internal.count)}${d.internal.total ? ` of ${fmtN(d.internal.total)}` : ''}${d.internal.source === 'cached' ? ' (cached list)' : ''}` : '–'),
          h('td', {}, pct(d.noSkillShare)),
          h('td', {}, pct(d.timedShare)),
          h('td', {}, d.foldedFailures ? fmtN(d.foldedFailures) : '–'),
          h('td', { class: `l${d.errors && Object.keys(d.errors).length ? ' bad' : ''}` }, d.errors && Object.keys(d.errors).length ? Object.entries(d.errors).map(([k, v]) => `${k}: ${v.slice(0, 80)}`).join(' · ') : ''))))),
      h('div', { class: 'links', style: { marginTop: '10px' } },
        b.readOnly ? h('span', { class: 'dim' }, 'Read-only install (FLEET_READONLY=1): another machine builds the days.') : [30, 60, 90].map((n) => h('button', { class: 'btn', onclick: () => act.build(n) }, `Build the last ${n} days`)),
        h('button', { class: 'btn', onclick: () => act.reload() }, 'Reload'))),
    shiftsCard(view, act, { all: true }),
    h('section', { class: 'fl-card' }, h('h3', {}, 'How it counts'),
      h('ul', { class: 'fl-blind', style: { paddingLeft: '16px', margin: 0, fontSize: '12.5px' } },
        h('li', {}, h('b', {}, 'Skill ownership: '), 'a turn belongs to the first skill it loads — by the skill tool, or preloaded by the platform into the session\'s first message (since 2026-09-30); later turns stay with it until one loads a skill outside its family (helpers like site-content and wix-apis never take over). Turns before any skill: "no skill".'),
        h('li', {}, h('b', {}, 'Failure: '), 'a tool result with an error status, an exception, an error body, or a result synthesized after a restart. "User cancelled" questions (ask_user) are not failures.'),
        h('li', {}, h('b', {}, 'Hidden timeout: '), 'the tool reported success while its job was still IN_PROGRESS / PENDING.'),
        h('li', {}, h('b', {}, 'Time lost: '), 'each failed call\'s own time, plus one recovery per run of consecutive failures: from the first failure until the next successful attempt of that operation was started in the turn (else the turn\'s end). Measured.'),
        h('li', {}, h('b', {}, 'Never recovered: '), 'no later success of that operation in the turn. "Ended the session": never recovered and the user never wrote again.'),
        h('li', {}, h('b', {}, 'Real users: '), 'accounts present in prod.wt_accounts.base and not on the Wixel team list (the vizion rule); looked up per day.'),
        h('li', {}, h('b', {}, 'Signatures: '), 'error text with URLs, ids and numbers blanked, JSON bodies reduced to their error code/message; each day keeps its ~450 most common, the rest fold into one row per skill.'))),
    h('section', { class: 'fl-card' }, h('h3', {}, icon('alert'), 'What this can\'t see'),
      h('ul', { class: 'fl-blind', style: { paddingLeft: '16px', margin: 0, fontSize: '12.5px' } },
        h('li', {}, 'Failures after the agent is done: rendering, exporting and the player in the editor aren\'t in the agent\'s entries.'),
        h('li', {}, 'Whether the output was good: a run with no errors can still disappoint — see each skill\'s Insights (downloads, publishes, thumbs, mood).'),
        h('li', {}, 'Inside a generation graph: the Genix nodes, queues and providers are only read (from Temporal) for a brief\'s examples.'),
        h('li', {}, 'Client-side errors and anything the user saw but the agent didn\'t log.'))),
  );
}

// ---------- detail panels ----------
export function renderDetail(view, fs, act) {
  const { kind, key } = fs.sel;
  if (kind === 'issue') {
    const i = view.issues.find((x) => x.key === key);
    return i ? issueDetail(i, view, fs, act) : null;
  }
  if (kind === 'wait') {
    const w = view.waits.find((x) => x.key === key);
    return w ? waitDetail(w, view, fs, act) : null;
  }
  if (kind === 'opp') {
    const o = view.opportunities.find((x) => x.id === key);
    return o ? panel(KINDS[o.kind] || 'Opportunity', o.skill ? nameOf(o.skill) : '', act, h('div', { class: 'section' }, oppCard(o, view, fs, act, { full: true }))) : null;
  }
  if (kind === 'skill') {
    const s = view.skills.find((x) => x.skill === key);
    return s ? skillDetail(s, view, fs, act) : null;
  }
  return null;
}

function panel(title, sub, act, ...body) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
    h('div', { class: 'insp-head' },
      h('div', { class: 't' }, h('h2', { title }, title), sub ? h('div', { class: 'sub' }, sub) : null),
      h('button', { class: 'icon-btn', title: 'Wider (W)', onclick: () => act.set({ wide: !document.querySelector('.fl-detail.wide') }) }, icon('layers')),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => act.close() }, icon('x'))),
    h('div', { class: 'insp-body' }, ...body));
}
const sect = (title, ...content) => h('div', { class: 'section' }, h('h4', {}, ...[].concat(title)), ...content.flat().filter(Boolean));

const briefs = new Map();
const draftPolls = new Map();

function issueDetail(i, view, fs, act) {
  const days = view.period.days;
  const wf = view.period.weekFactor;
  const st = i.status || {};
  const kv = (v, k, meas) => h('div', {}, h('b', {}, v), h('span', {}, k), meas ? h('span', { class: 'meas' }, meas) : null);
  const ownersMax = Math.max(1, ...i.owners.map((o) => o.n));
  const brief = briefs.get(i.key);
  const qs = `days=${fs.days}&today=${fs.today ? 1 : 0}&aud=${fs.aud}`;
  const loadBrief = async (traces = true) => {
    briefs.set(i.key, { loading: true });
    act.set({});
    try {
      briefs.set(i.key, await getJson(`api/fleet/brief/${i.key}?${qs}&traces=${traces ? 1 : 0}`));
    } catch (err) {
      briefs.set(i.key, { error: err.message });
    }
    act.set({});
  };
  const startDraft = async () => {
    if (!brief?.markdown) return;
    if (!confirm('Send this brief to Claude (your local claude CLI, read-only, in the wixel-agent-codex checkout)?\n\nThe brief is redacted (no emails or phone numbers) but includes users\' requests, shortened. Check this is fine for your data policy.')) return;
    try {
      await fetch(`api/fleet/draft/${i.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: brief.markdown }) }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      });
      brief.draft = { state: 'running', startedAt: Date.now() };
      pollDraft(i.key, act);
      act.set({});
    } catch (err) {
      toast(`Couldn't start Claude: ${err.message}`);
    }
  };
  return panel(i.sig, h('span', {}, fixTag(i.cls.fix), ' ', tag('', i.cls.label), ' ', patternTag(i.pattern), ' ', trendTag(i.trend), ' ', statusTag(i.status), h('span', { style: { marginLeft: '6px' } }, `${opName(i.tool, i.method)} · owner: ${i.cls.owner}`)), act,
    sect('How big', h('div', { class: 'fl-kv' },
      kv(fmtN(i.perWeek), 'per week', `${fmtN(i.n)} in the period`),
      kv(fmtN(i.sessions), 'sessions', `~${fmtN(i.users)} accounts`),
      kv(hrs(i.lostHPerWeek), 'time lost / week', 'measured'),
      kv(sec(i.failedCallMs / Math.max(1, i.n)), 'each failed call', 'average'),
      kv(sec(i.recoverMs / Math.max(1, i.n)), 'to recover', 'average, measured'),
      kv(pct(i.fatal), 'no later success', `same operation, same turn · ${fmtN(i.unrecovered)}×`),
      kv(fmtN(i.abandoned * wf), 'sessions ended / wk', 'unrecovered + no reply'),
      kv(fmtN(i.upsetAfter * wf), 'upset after / wk', 'correlated, not proven'))),
    sect(['Per day', h('span', { class: 'r' }, i.pattern.detail)], spark(days.map((d) => i.perDay[d] || 0), { w: 560, hgt: 40, bad: true, title: days.map((d) => `${d}: ${fmtN(i.perDay[d] || 0)}`).join('\n') }),
      i.trend.prevN != null ? h('p', { class: 'desc', style: { margin: '6px 0 0', color: 'var(--text-3)' } }, `${(i.trend.rate * 1000).toFixed(2)} per 1k turns now vs ${(i.trend.prevRate * 1000).toFixed(2)} in the previous period (${fmtN(i.trend.prevN)} occurrences).`) : null),
    sect('Skills it happens in', h('div', { class: 'bars' }, i.owners.map((o) => h('div', { class: 'bar-row', onclick: () => o.skill !== NO_SKILL && window.open(autopsyLink(o.skill, { days: days.length, filters: { failedStep: [stepKey(i.tool, i.method)] } }), '_blank') },
      h('span', { class: 'lbl' }, nameOf(o.skill), o.skill !== NO_SKILL ? h('small', {}, 'open runs where this step failed ↗') : null),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(o.n / ownersMax) * 100}%`, background: 'var(--viz-crit)' } })),
      h('span', { class: 'val' }, fmtN(o.n)))))),
    i.versions.length ? sect(['By codex version', h('span', { class: 'r' }, 'did a change fix it?')], h('table', { class: 'fl' },
      h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Version'), h('th', {}, 'Occurrences'), h('th', {}, 'Turns on it'), h('th', {}, 'Per 1k turns'))),
      h('tbody', {}, i.versions.map((v) => h('tr', { style: { cursor: 'default' } }, h('td', { class: 'l mono' }, v.ver.slice(0, 14)), h('td', {}, fmtN(v.n)), h('td', {}, fmtN(v.turns)), h('td', {}, v.rate != null ? (v.rate * 1000).toFixed(2) : '–')))))) : null,
    i.models.length && i.models.some(([m]) => m) ? sect('Models', h('div', { class: 'pills' }, i.models.map(([m, n]) => h('span', { class: 'pill' }, `${m || 'no model'} · ${fmtN(n)}`)))) : null,
    sect('Example error', h('div', { class: 'fl-sig' }, i.example || i.sig)),
    sect('Example runs', h('div', { class: 'fl-examples' }, i.examples.map((e) => h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12px' } },
      h('span', { class: 'mono dim', style: { color: 'var(--text-3)' } }, e.at ? new Date(e.at).toISOString().slice(5, 16).replace('T', ' ') : ''),
      h('span', {}, nameOf(e.skill)),
      e.skill !== NO_SKILL ? h('a', { href: autopsyLink(e.skill, { days: daysSince(e.at), selected: e.session }), target: '_blank' }, 'Open in Autopsy ↗') : null,
      h('a', { href: `${ADMIN}${e.session}`, target: '_blank', rel: 'noopener' }, 'Admin ↗'),
      e.job ? h('span', { class: 'dim', style: { color: 'var(--text-3)' } }, 'has a job id') : null)))),
    skillFixSection(i, view, fs, act, qs),
    sect('Issue-wide brief', h('p', { style: { margin: '0 0 8px' } }, i.cls.hint),
      h('div', { class: 'links' },
        h('button', { class: 'btn primary', disabled: brief?.loading || null, onclick: () => loadBrief(true) }, icon('sparkle'), brief?.loading ? 'Building the brief…' : brief?.markdown ? 'Rebuild fix brief' : 'Build fix brief'),
        brief?.markdown ? h('button', { class: 'btn', onclick: () => copyText(brief.markdown, 'Brief') }, icon('copy'), 'Copy (Markdown)') : null,
        brief?.markdown ? h('button', { class: 'btn', onclick: () => mailto({ subject: `[Autopsy Fleet] ${i.cls.label}: ${shortSig(i.sig, 80)}`, body: brief.markdown }) }, 'Email…') : null,
        brief?.markdown && view.backfill ? h('button', { class: 'btn', onclick: startDraft, title: 'Runs your local claude CLI in the codex checkout with read-only tools and asks for the smallest fix as a diff.' }, icon('sparkle'), 'Draft the fix with Claude') : null),
      h('p', { class: 'desc', style: { margin: '6px 0 0', color: 'var(--text-3)', fontSize: '11.5px' } }, 'The brief reads up to 3 example sessions (admin API), the Genix root cause of failed generations (Temporal, if you have a key) and the codex at its latest fetched commit, then says what\'s wrong, where to look, a fix and how to verify it. Cached; only built when you ask.'),
      brief?.error ? h('p', { style: { color: 'var(--err)' } }, brief.error) : null,
      brief?.markdown ? h('div', { class: 'fl-md', style: { marginTop: '10px' } }, md(brief.markdown)) : null,
      h('div', { id: `draft-${i.key}` }, brief?.draft ? draftView(brief.draft) : null)),
    sect('Status', h('div', { class: 'fl-status' },
      h('select', { id: 'stSel' }, ['', 'accepted', 'fixed', 'wontfix', 'duplicate'].map((v) => h('option', { value: v, selected: (st.status || '') === v || null }, { '': 'Open', accepted: 'Accepted (someone\'s on it)', fixed: 'Fixed', wontfix: "Won't fix", duplicate: 'Duplicate' }[v]))),
      h('input', { id: 'stVer', placeholder: 'fixed in codex version…', value: st.version || '', title: 'The codexVersionId the fix shipped in — the Versions table then shows before/after.' }),
      h('input', { id: 'stNote', class: 'note', placeholder: 'note (who, ticket, why)…', value: st.note || '' }),
      h('button', { class: 'btn primary', onclick: () => act.saveState('issue', i.key, { status: document.getElementById('stSel').value, version: document.getElementById('stVer').value, note: document.getElementById('stNote').value }) }, 'Save')),
      st.at ? h('p', { class: 'desc', style: { margin: '6px 0 0', color: 'var(--text-3)', fontSize: '11.5px' } }, `Saved ${new Date(st.at).toLocaleString()} · shared with everyone using this Fleet folder`) : null),
    h('p', { class: 'fl-note', style: { padding: '0 14px' } }, i.basis));
}

// ---------- fix per skill ----------
// One tab per skill the issue happens in; each shows what to change in THAT skill's instructions,
// built from its own failing calls, plus a ready-to-paste prompt for Claude Code (scoped to the
// skill's files). Errors a skill can't fix (timeouts, restarts, providers…) are parked.
const skillFixes = new Map();
const skillPolls = new Map();
function skillFixSection(i, view, fs, act, qs) {
  if (!i.skillFix) {
    return sect('Fix per skill', h('p', { class: 'desc', style: { margin: 0, color: 'var(--text-3)' } }, `${i.cls.label} isn't fixed in a skill — it's ${i.cls.owner.toLowerCase()} work. Parked for later (only skills are in scope for now).`));
  }
  const skills = i.owners.filter((o) => o.skill !== NO_SKILL).slice(0, 6);
  if (!skills.length) return sect('Fix per skill', h('p', { class: 'desc', style: { margin: 0 } }, 'Only happens in sessions with no skill — nothing to change in a skill.'));
  const pick = i.key === fs.fixSkillFor && skills.some((o) => o.skill === fs.fixSkill) ? fs.fixSkill : skills[0].skill;
  const id = `${i.key}|${pick}`;
  const cur = skillFixes.get(id);
  const load = async () => {
    skillFixes.set(id, { loading: true });
    act.set({});
    try {
      skillFixes.set(id, await getJson(`api/fleet/skillfix/${i.key}?${qs}&skill=${encodeURIComponent(pick)}`));
    } catch (err) {
      skillFixes.set(id, { error: err.message });
    }
    act.set({});
  };
  if (!cur) setTimeout(load, 0);
  const tabs = h('div', { class: 'fl-filters', style: { marginBottom: '8px' } }, skills.map((o) => h('button', { class: `fbtn${o.skill === pick ? ' on' : ''}`, onclick: () => act.set({ fixSkill: o.skill, fixSkillFor: i.key }) }, o.skill, h('small', {}, fmtN(o.n)))),
    i.owners.some((o) => o.skill === NO_SKILL) ? h('span', { class: 'dim', style: { color: 'var(--text-3)', fontSize: '11.5px' } }, `+ ${fmtN(i.owners.find((o) => o.skill === NO_SKILL).n)} in sessions with no skill`) : null);
  let body;
  if (!cur || cur.loading) body = h('p', { class: 'desc', style: { color: 'var(--text-3)' } }, `Reading ${pick}'s failing calls and its skill file…`);
  else if (cur.error) body = h('p', { style: { color: 'var(--err)' } }, cur.error);
  else if (cur.parked) body = h('p', { class: 'desc' }, cur.reason);
  else body = skillFixCard(i, cur, qs, act);
  return sect(['Fix per skill', h('span', { class: 'r' }, 'what to change in each skill\'s instructions')], tabs, body);
}

function skillFixCard(i, f, qs, act) {
  const slot = `sfc-${i.key}-${f.skill}`.replace(/[^\w-]/g, '_');
  const ask = async () => {
    if (!confirm(`Ask Claude (your local claude CLI, read-only, in the wixel-agent-codex checkout) for a change to ${f.skill}?\n\nIt reads the codex and this evidence (redacted, but with users' requests shortened). The answer is saved for everyone using this Fleet folder.`)) return;
    try {
      const r = await fetch(`api/fleet/skillfix/${i.key}/claude?${qs}&skill=${encodeURIComponent(f.skill)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      pollSkillClaude(i.key, f.skill, slot, Date.now());
    } catch (err) {
      toast(`Couldn't start Claude: ${err.message}`);
    }
  };
  const saved = f.claude;
  return h('div', {},
    h('p', { class: 'desc', style: { margin: '0 0 8px', color: 'var(--text-3)', fontSize: '11.5px' } },
      `${fmtN(f.n)} of this issue's occurrences (${pct(f.share)}) are in ${f.skill}`, f.skillPath ? [' · ', h('a', { href: f.skillUrl, target: '_blank', rel: 'noopener' }, f.skillPath)] : ' · skill file not found in the codex', f.codexRef ? ` · codex ${f.codexRef}` : ''),
    f.notes.length ? h('div', {}, h('b', { style: { fontWeight: 600, fontSize: '12px' } }, 'What its failing calls show'), h('ul', { style: { margin: '4px 0 8px', paddingLeft: '18px' } }, f.notes.map((x) => h('li', {}, x)))) : null,
    h('div', {}, h('b', { style: { fontWeight: 600, fontSize: '12px' } }, 'Change in the skill'), h('ul', { style: { margin: '4px 0 8px', paddingLeft: '18px' } }, f.fix.map((x) => h('li', {}, md(x)[0]?.childNodes ? [...md(x)[0].childNodes] : x)))),
    f.files.length ? h('div', {}, h('b', { style: { fontWeight: 600, fontSize: '12px' } }, 'Where'), h('ul', { style: { margin: '4px 0 8px', paddingLeft: '18px', fontSize: '12px' } }, f.files.map((x) => h('li', {}, h('a', { href: x.url, target: '_blank', rel: 'noopener', class: 'mono' }, `${x.path}${x.line ? `:${x.line}` : ''}`), ` — ${x.why}`)))) : null,
    f.evidence.length ? h('details', { style: { margin: '0 0 8px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--text-2)' } }, `${f.evidence.length} example${f.evidence.length === 1 ? '' : 's'} from ${f.skill}`),
      f.evidence.map((e) => h('div', { class: 'err-row', style: { marginTop: '6px' } },
        e.found === false ? `${e.session}: ${e.error || 'not found'}` : [
          e.request ? h('div', {}, h('b', {}, 'Asked: '), `"${e.request}"`) : null,
          h('div', { class: 'tip-msg' }, e.error),
          e.next?.length ? h('div', { style: { color: 'var(--text-3)', marginTop: '3px' } }, `Then: ${e.next.join(' → ')}`) : null,
          h('a', { href: e.adminUrl, target: '_blank', rel: 'noopener' }, 'Admin ↗')]))) : null,
    h('div', { class: 'links' },
      h('button', { class: 'btn primary', onclick: () => copyText(f.prompt, 'Prompt for Claude Code') }, icon('copy'), 'Copy prompt for Claude Code'),
      h('button', { class: 'btn', onclick: ask, title: 'Your local claude CLI, read-only, in the codex checkout. Saved for everyone sharing this Fleet folder.' }, icon('sparkle'), saved ? 'Ask Claude again' : 'Ask Claude for a suggestion')),
    h('p', { class: 'desc', style: { margin: '6px 0 0', color: 'var(--text-3)', fontSize: '11.5px' } }, 'The prompt is limited to this skill\'s files: paste it into Claude Code in the wixel-agent-codex checkout. Nothing is changed from here.'),
    h('div', { id: slot }, saved ? savedClaude(saved) : null),
    f.claudeRunning ? (setTimeout(() => pollSkillClaude(i.key, f.skill, slot, Date.now()), 0), null) : null);
}
function savedClaude(s) {
  return h('div', { class: 'fl-draft' },
    h('div', { class: 'state' }, icon('sparkle'), `Claude's suggestion · ${new Date(s.at).toLocaleString()}${s.stale ? ' · written for an older codex commit' : ''}`),
    h('div', { class: 'fl-md' }, md(s.text)));
}
function pollSkillClaude(key, skill, slot, started) {
  const id = `${key}|${skill}`;
  clearTimeout(skillPolls.get(id));
  skillPolls.set(id, setTimeout(async () => {
    const el = document.getElementById(slot);
    try {
      const st = await getJson(`api/fleet/skillfix/${key}/claude?skill=${encodeURIComponent(skill)}`);
      if (st.state === 'running') {
        el?.replaceChildren(h('div', { class: 'fl-draft' }, h('div', { class: 'state' }, icon('sparkle'), `Claude is reading the codex… ${Math.round((Date.now() - started) / 1000)}s`)));
        return pollSkillClaude(key, skill, slot, started);
      }
      if (st.state === 'failed') el?.replaceChildren(h('div', { class: 'fl-draft' }, h('div', { class: 'state' }, icon('alert'), st.hint || `Claude failed: ${st.error || ''}`)));
      else if (st.saved) {
        el?.replaceChildren(savedClaude(st.saved));
        const cur = skillFixes.get(id);
        if (cur && !cur.loading) cur.claude = st.saved;
      }
    } catch {
      pollSkillClaude(key, skill, slot, started);
    }
  }, 2500));
}

function draftView(d) {
  return h('div', { class: 'fl-draft' },
    h('div', { class: 'state' }, icon('sparkle'), d.state === 'running' ? `Claude is reading the codex… ${Math.round((Date.now() - (d.startedAt || Date.now())) / 1000)}s` : d.state === 'done' ? 'Claude\'s draft (review before applying — nothing was changed)' : d.hint || `Claude failed: ${(d.error || d.output || '').slice(-300)}`),
    d.output && d.state !== 'failed' ? h('div', { class: 'fl-md' }, md(d.output)) : null);
}
function pollDraft(key, act) {
  clearTimeout(draftPolls.get(key));
  draftPolls.set(key, setTimeout(async () => {
    const b = briefs.get(key);
    if (!b) return;
    try {
      const d = await getJson(`api/fleet/draft/${key}`);
      b.draft = { ...b.draft, ...d };
      // Update just the draft block: redrawing the panel would reset scroll and the status inputs.
      const slot = document.getElementById(`draft-${key}`);
      if (slot) slot.replaceChildren(draftView(b.draft));
      if (d.state === 'running') pollDraft(key, act);
    } catch {
      pollDraft(key, act);
    }
  }, 2500));
}

function waitDetail(w, view, fs, act) {
  const kv = (v, k, meas) => h('div', {}, h('b', {}, v), h('span', {}, k), meas ? h('span', { class: 'meas' }, meas) : null);
  const curve = eCurve(w, view.edges);
  return panel(opName(w.tool, w.method), h('span', {}, w.model ? `${w.model} · ` : '', w.size ? `${w.size} · ` : '', w.owners.map((o) => `${nameOf(o[0])} (${fmtN(o[1])})`).join(', ')), act,
    sect('Timing', h('div', { class: 'fl-kv' },
      kv(fmtN(w.callsPerWeek), 'calls / week'),
      kv(sec(w.p50), 'p50 (success)'),
      kv(sec(w.p90), 'p90'),
      kv(sec(w.p99), 'p99'),
      kv(sec(w.max), 'longest'),
      kv(pct(w.fails / w.calls, 1), 'fail', `${fmtN(w.fails)} calls`),
      kv(w.hidden ? fmtN(w.hidden) : '0', 'hidden timeouts', w.capRange ? `at ${sec(w.capRange[0])}–${sec(w.capRange[1])}` : null),
      kv(hrs(w.waitHPerWeek), 'spent waiting / wk'))),
    sect(['Durations', h('span', { class: 'r' }, 'blue = succeeded · red = failed or timed out')], histChart(w, view.edges)),
    w.recommend || w.hidden ? sect('Recommendation', w.recommend
      ? h('p', { style: { margin: '0 0 6px' } }, h('b', {}, `Give up after ${sec(w.recommend.tau)}`), ` instead of ${w.cap ? sec(w.cap) : 'waiting as long as it takes'}: the expected time to a success drops from ${sec(w.eCurrent)} to ${sec(w.recommend.e)} — about ${hrs(w.recommend.savedHPerWeek)} a week across ${fmtN(w.callsPerWeek)} calls.`)
      : h('p', { style: { margin: '0 0 6px' } }, 'No shorter cap pays off on these numbers.'),
    w.hidden ? h('p', { style: { margin: '0 0 6px' } }, h('b', {}, 'Re-attach, don\'t restart. '), `${fmtN(w.hidden)} time${w.hidden === 1 ? '' : 's'} the tool returned while the job was still running. When the wait runs out, keep polling the same job id (or hand the agent the id to check later) — a fresh job pays again and may lose a result that's nearly done.`) : null,
    curve ? h('div', {}, h('p', { class: 'desc', style: { margin: '6px 0 2px', color: 'var(--text-3)', fontSize: '11.5px' } }, 'Expected time to a success (y) for each cap (x, log scale). Green = recommended, red = today\'s cap.'), curve) : null) : null,
    sect('Retries', h('p', { style: { margin: 0 } }, w.retries ? `${fmtN(w.retries)} retries after a failure; ${pct(w.retryOk / w.retries)} of them worked. The agent waited ${sec(w.retryGapAvg)} on average before retrying.` : 'No retries after failures in this period.')),
    h('p', { class: 'fl-note', style: { padding: '0 14px' } }, w.basis, ' Caveats: if inputs that hang tend to hang again (too heavy, a provider outage), a shorter cap just fails sooner — check the retry success rate; and a retry that doesn\'t cancel the original pays twice.'));
}

function skillDetail(s, view, fs, act) {
  const issues = view.issues.filter((i) => i.owners.some((o) => o.skill === s.skill)).slice(0, 12);
  const opps = view.opportunities.filter((o) => o.skill === s.skill);
  const pinned = (view.state?.pins || []).includes(s.skill);
  const kv = (v, k) => h('div', {}, h('b', {}, v), h('span', {}, k));
  return panel(nameOf(s.skill), h('span', {}, `${fmtN(s.sessions)} sessions · ${fmtN(s.turns)} turns${s.major ? ' · major' : ''}`), act,
    sect('At a glance', h('div', { class: 'fl-kv' },
      kv(pct(s.failRate, 1), 'tool calls failing'),
      kv(pct(s.failedTurnRate, 1), 'turns failed'),
      kv(hrs(s.lostHPerWeek), 'time lost / wk'),
      kv(fmtN(s.hidden), 'hidden timeouts'),
      kv(pct(s.frustration, 1), 'frustrated turns'),
      kv(s.iterPerTurn.toFixed(1), 'iterations / turn'),
      kv(`${Math.round(s.tokensPerIter / 1000)}k`, 'tokens / iteration'),
      kv(sec(s.thinkMsPerIter), 'per iteration'),
      kv(s.keptRate != null ? pct(s.keptRate) : '–', `outputs kept (${fmtN(s.kept)} of ${fmtN(s.produced)})`),
      kv(s.noOutputRate != null ? pct(s.noOutputRate) : '–', 'tried, no output'),
      kv(s.gensPerKept != null ? s.gensPerKept.toFixed(1) : '–', 'generations per kept output'),
      kv(`${fmtN(s.thumbsUp)} / ${fmtN(s.thumbsDown)}`, 'thumbs up / down'))),
    h('div', { class: 'section links' },
      s.skill !== NO_SKILL ? h('a', { class: 'btn primary', href: autopsyLink(s.skill, { days: view.period.days.length }), target: '_blank' }, icon('external'), 'Open runs in Autopsy') : null,
      s.skill !== NO_SKILL ? h('button', { class: 'btn', onclick: () => act.saveState('pin', s.skill, { pinned: !pinned }) }, icon('pin'), pinned ? 'Unpin' : 'Pin as major') : null,
      h('button', { class: 'btn', onclick: () => act.set({ tab: 'issues', q: s.skill === NO_SKILL ? '' : s.skill }) }, 'Its issues')),
    issues.length ? sect('Top issues', h('div', {}, issues.map((i) => h('div', { class: 'rep', onclick: () => act.open('issue', i.key, 'issues') }, h('span', { class: 't' }, fixTag(i.cls.fix), ' ', i.sig), h('span', { class: 'n' }, `${fmtN(i.owners.find((o) => o.skill === s.skill)?.n)} · ${hrs(i.lostHPerWeek)}/wk`))))) : null,
    s.ops?.length ? sect('Tools it calls', h('table', { class: 'fl' },
      h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Tool'), h('th', {}, 'Calls'), h('th', {}, 'Fail'), h('th', {}, 'Hidden t/o'), h('th', {}, 'Time lost'), h('th', {}, 'Arg. sets / day'))),
      h('tbody', {}, s.ops.map((o) => h('tr', { style: { cursor: 'default' } }, h('td', { class: 'l' }, opName(o.tool, o.method)), h('td', {}, fmtN(o.calls)), h('td', {}, pct(o.fails / Math.max(1, o.calls), 1)), h('td', {}, o.hidden ? fmtN(o.hidden) : '–'), h('td', {}, hrs(o.lostH)), h('td', {}, fmtN(o.maxShapes))))))) : null,
    s.chains?.length ? sect('Most common work chains (per turn)', h('div', {}, s.chains.map((c) => h('div', { style: { marginBottom: '8px' } }, h('div', { class: 'chain' }, c.k.split(' › ').flatMap((x, i) => [i ? h('i', {}, '→') : null, h('span', {}, x)]).filter(Boolean)), h('div', { class: 'dim', style: { color: 'var(--text-3)', fontSize: '11.5px' } }, `${fmtN(c.turns)} turns · ${(c.iterations / Math.max(1, c.turns)).toFixed(1)} iterations each · ${pct(c.withErrors / Math.max(1, c.turns))} hit an error`))))) : null,
    opps.length ? sect('Opportunities', h('div', {}, opps.map((o) => h('div', { class: 'rep', onclick: () => act.open('opp', o.id, 'opps') }, h('span', { class: 't' }, o.title), h('span', { class: 'n' }, o.savings.hPerWeek ? `${hrs(o.savings.hPerWeek)}/wk` : `${fmtK(o.savings.tokensPerWeek)} tok/wk`))))) : null,
    s.versions?.length ? sect('Codex versions in use', h('div', { class: 'pills' }, s.versions.map(([v, n]) => h('span', { class: 'pill mono' }, `${v.slice(0, 12)} · ${fmtN(n)} turns`)))) : null);
}

// ---------- tiny markdown (the brief, Claude's draft) ----------
function md(text) {
  const out = [];
  const lines = String(text).split('\n');
  let list = null;
  let code = null;
  const inline = (s) => {
    const frag = document.createDocumentFragment();
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    for (const m of s.matchAll(re)) {
      frag.append(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('`')) frag.append(h('code', {}, t.slice(1, -1)));
      else if (t.startsWith('**')) frag.append(h('b', {}, t.slice(2, -2)));
      else {
        const [, label, href] = t.match(/\[([^\]]+)\]\(([^)]+)\)/);
        frag.append(/^https?:\/\//.test(href) ? h('a', { href, target: '_blank', rel: 'noopener' }, label) : label);
      }
      last = m.index + t.length;
    }
    frag.append(s.slice(last));
    return frag;
  };
  for (const line of lines) {
    if (code) {
      if (line.startsWith('```')) {
        out.push(h('pre', {}, h('code', {}, code.join('\n'))));
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      list = null;
      code = [];
      continue;
    }
    const li = line.match(/^(\s*)[-*] (.*)$/);
    if (li) {
      if (!list) out.push((list = h('ul', {})));
      list.append(h('li', { style: li[1].length ? { marginLeft: '14px' } : null }, inline(li[2])));
      continue;
    }
    list = null;
    if (/^# /.test(line)) out.push(h('h1', {}, inline(line.slice(2))));
    else if (/^##+ /.test(line)) out.push(h('h2', {}, inline(line.replace(/^##+ /, ''))));
    else if (line.trim()) out.push(h('p', {}, inline(line)));
  }
  if (code) out.push(h('pre', {}, h('code', {}, code.join('\n'))));
  return out;
}

// ---------- text summary (copy / email) ----------
export function fleetSummary(view, fs) {
  const t = view.totals;
  const wf = view.period.weekFactor;
  const lines = [
    `Autopsy Fleet — ${view.period.days[0]} → ${view.period.days.at(-1)} (${view.period.have.length} days), ${fs.aud === 'real' ? 'real users' : fs.aud}`,
    `${fmtN(t.sessions)} sessions · ${fmtN(t.turns)} turns · ${pct((t.fails - t.creditFails) / Math.max(1, t.calls), 1)} of tool calls failing · ${hrs((t.lostMs / 3600000) * wf)}/week lost to failures · ${fmtN(t.hidden)} hidden timeouts · ${pct(t.frustrated / Math.max(1, t.turns), 1)} frustrated turns`,
    '',
    'Do these first (hours a week given back):',
    ...view.actions.map((a, i) => `${i + 1}. ${a.kind === 'issue' ? shortSig(a.title, 110) : a.title} — ${hrs(a.hPerWeek)}/wk · ${a.owner}${a.kind === 'opportunity' ? ' (estimate)' : ''}`),
    '',
    'Top issues:',
    ...view.issues.filter((i) => i.score > 0).slice(0, 8).map((i) => `- [${i.cls.label}, ${i.cls.fix} fix] ${shortSig(i.sig, 110)} — ${fmtN(i.perWeek)}/wk, ${hrs(i.lostHPerWeek)}/wk lost, in ${i.owners.slice(0, 3).map((o) => nameOf(o.skill)).join(', ')}${i.trend.dir !== 'flat' ? ` (${i.trend.dir})` : ''}`),
    '',
    'Wait times:',
    ...view.waits.filter((w) => w.recommend || w.hidden).slice(0, 5).map((w) => `- ${opName(w.tool, w.method)}${w.size ? ` (${w.size})` : ''}: p50 ${sec(w.p50)}, p99 ${sec(w.p99)}${w.hidden ? `, ${w.hidden} hidden timeouts at ${sec(w.cap)}` : ''}${w.recommend ? ` → wait ≤ ${sec(w.recommend.tau)} (~${hrs(w.recommend.savedHPerWeek)}/wk)` : ''}`),
    '',
    'Agent-design opportunities (estimates):',
    ...view.opportunities.slice(0, 6).map((o) => `- ${o.title}${o.savings.hPerWeek ? ` — ~${hrs(o.savings.hPerWeek)}/wk` : ''}${o.savings.tokensPerWeek ? `, ~${fmtK(o.savings.tokensPerWeek)} tokens/wk` : ''}`),
    '',
    'Counts, durations and recoveries are measured from the agent\'s entries; savings are estimates.',
  ];
  return lines.join('\n');
}

// ---------- printable digest ----------
export function renderReport(view, fs, meta) {
  const sec2 = (title, ...c) => h('section', { class: 'fl-rp-sec' }, h('h2', {}, title), ...c);
  const fsView = { ...fs, sel: null, q: '', cls: [], fix: [], status: 'open', major: true };
  const act0 = { select() {}, open() {}, tab() {}, set() {}, sort() {}, toggleIn() {}, saveState() {}, view: () => view };
  const ov = overview(view, fsView, act0);
  const issues = issuesTab(view, fsView, act0);
  issues.querySelectorAll('tbody tr').forEach((tr, i) => i >= 20 && tr.remove());
  issues.querySelector('.fl-filters')?.remove();
  const waits = waitsTab(view, fsView, act0);
  waits.querySelectorAll('tbody tr').forEach((tr, i) => i >= 15 && tr.remove());
  const opps = h('div', { class: 'fl-cols' }, view.opportunities.slice(0, 10).map((o) => oppCard(o, view, fsView, act0)));
  return h('div', {},
    h('div', { class: 'fl-rp-head' }, h('h1', {}, 'Autopsy Fleet'), h('span', { class: 'dim', style: { color: 'var(--text-3)' } }, `${meta.periodText} · ${meta.audLabel} · generated ${new Date().toLocaleString()}`)),
    ov,
    sec2('Top issues', issues),
    sec2('Wait times', waits),
    sec2('Agent-design opportunities', opps));
}
