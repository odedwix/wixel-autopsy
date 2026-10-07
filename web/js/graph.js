import { h, icon, dur, getJson, copy } from './util.js';

// Level 3: one Genix graph run, drawn. Layered left→right layout (longest-path layers + barycenter
// ordering), per-node overlay from Temporal (status, when it ran inside the graph, time, cost,
// output), critical path, and a node inspector with resolved inputs vs static params.

const NODE_W = 232;
const NODE_H = 88;
const IO_W = 168;
const IO_H = 46;
const X_GAP = 64;
const Y_GAP = 18;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MEDIA_RE = /https?:\/\/[^\s"'\\]+?\.(?:mp4|mov|webm|mp3|wav|m4a|png|jpe?g|webp|gif)(?:\?[^\s"'\\]*)?/i;
const kindOf = (u) => (/\.(mp4|mov|webm)/i.test(u) ? 'video' : /\.(mp3|wav|m4a)/i.test(u) ? 'audio' : 'image');
const firstMedia = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\\\//g, '/').match(MEDIA_RE)?.[0] || null);
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const clip = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));

const STATUS = {
  COMPLETED: { color: 'var(--viz-good)', label: 'Completed' },
  FAILED: { color: 'var(--viz-crit)', label: 'Failed' },
  TIMED_OUT: { color: 'var(--viz-crit)', label: 'Timed out' },
  TERMINATED: { color: 'var(--viz-crit)', label: 'Terminated' },
  CANCELED: { color: 'var(--viz-serious)', label: 'Canceled' },
  RUNNING: { color: 'var(--info)', label: 'Running' },
  PENDING: { color: 'var(--info)', label: 'Pending' },
  NOT_RUN: { color: 'var(--viz-none)', label: 'Not run' },
};

// ---------- model ----------
function buildModel(run) {
  const g = run.graph;
  const t0 = run.startedAt || Math.min(...run.children.map((c) => c.initiatedAt || Infinity));
  const t1 = run.closedAt || Math.max(...run.children.map((c) => c.closedAt || 0));
  const span = Math.max(1, t1 - t0);
  const exec = new Map();
  for (const c of run.children) if (c.nodeId) (exec.get(c.nodeId) || exec.set(c.nodeId, []).get(c.nodeId)).push(c);
  const nodes = new Map();
  for (const n of g.nodes) {
    const attempts = exec.get(n.id) || [];
    const last = attempts.at(-1) || null;
    nodes.set(n.id, { id: n.id, kind: 'node', spec: n, run: last, attempts, status: last ? last.status : 'NOT_RUN', w: NODE_W, h: NODE_H });
  }
  const usedInputs = new Set(g.edges.filter((e) => e.source === 'inputs').map((e) => e.sourceHandle));
  for (const i of g.inputs) if (usedInputs.has(i.id)) nodes.set(`in:${i.id}`, { id: `in:${i.id}`, kind: 'input', spec: i, value: run.inputs?.[i.id], status: 'INPUT', w: IO_W, h: IO_H });
  const edges = [];
  for (const e of g.edges) {
    const from = e.source === 'inputs' ? `in:${e.sourceHandle}` : e.source;
    if (nodes.has(from) && nodes.has(e.target)) edges.push({ from, to: e.target, fromHandle: e.sourceHandle, toHandle: e.targetHandle });
  }
  for (const o of g.outputs) {
    const ref = o.valueMapping?.ref || '';
    const src = ref.match(/\$\.nodes\.([^.]+)\./)?.[1];
    const id = `out:${o.id}`;
    nodes.set(id, { id, kind: 'output', spec: o, value: run.outputs?.[o.id]?.result ?? null, status: 'OUTPUT', w: IO_W, h: IO_H });
    if (src && nodes.has(src)) edges.push({ from: src, to: id, fromHandle: ref.split('.').slice(3).join('.'), toHandle: o.id });
  }
  const unmatched = run.children.filter((c) => !c.nodeId);
  return { nodes, edges, t0, span, unmatched };
}

// Longest-path layering, then barycenter sweeps to cut crossings. Inputs pinned left, outputs right.
function layout(m) {
  const preds = new Map([...m.nodes.keys()].map((k) => [k, []]));
  const succs = new Map([...m.nodes.keys()].map((k) => [k, []]));
  for (const e of m.edges) {
    preds.get(e.to).push(e.from);
    succs.get(e.from).push(e.to);
  }
  const layer = new Map();
  const visit = (id, stack = new Set()) => {
    if (layer.has(id)) return layer.get(id);
    if (stack.has(id)) return 0; // cycle guard (specs are DAGs, but never hang on bad data)
    stack.add(id);
    const node = m.nodes.get(id);
    const l = node.kind === 'input' ? 0 : Math.max(0, ...preds.get(id).map((p) => visit(p, stack) + 1));
    layer.set(id, node.kind === 'input' ? 0 : Math.max(1, l));
    return layer.get(id);
  };
  for (const id of m.nodes.keys()) visit(id);
  const maxL = Math.max(...layer.values());
  for (const [id, n] of m.nodes) if (n.kind === 'output') layer.set(id, maxL + (maxL === layer.get(id) ? 0 : 0));
  const outL = Math.max(...[...m.nodes.values()].filter((n) => n.kind !== 'output').map((n) => layer.get(n.id))) + 1;
  for (const [id, n] of m.nodes) if (n.kind === 'output') layer.set(id, outL);
  const layers = [];
  for (const [id, l] of layer) (layers[l] ||= []).push(id);
  for (let i = 0; i < layers.length; i++) layers[i] ||= [];
  const pos = new Map();
  const index = () => layers.forEach((ids) => ids.forEach((id, i) => pos.set(id, i)));
  index();
  const bary = (id, nbrs) => {
    const xs = nbrs.map((n) => pos.get(n)).filter((x) => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : pos.get(id);
  };
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 0;
    const order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const ids of order) {
      ids.sort((a, b) => bary(a, down ? preds.get(a) : succs.get(a)) - bary(b, down ? preds.get(b) : succs.get(b)));
      ids.forEach((id, i) => pos.set(id, i));
    }
  }
  // Coordinates: column per layer, nodes stacked and centered on the tallest column.
  const colW = layers.map((ids) => Math.max(IO_W, ...ids.map((id) => m.nodes.get(id).w)));
  const colH = layers.map((ids) => ids.reduce((a, id) => a + m.nodes.get(id).h + Y_GAP, -Y_GAP));
  const H = Math.max(...colH, NODE_H);
  let x = 0;
  layers.forEach((ids, l) => {
    let y = (H - colH[l]) / 2;
    for (const id of ids) {
      const n = m.nodes.get(id);
      n.x = x + (colW[l] - n.w) / 2;
      n.y = y;
      y += n.h + Y_GAP;
    }
    x += colW[l] + X_GAP;
  });
  m.width = x - X_GAP;
  m.height = H;
  m.preds = preds;
  m.succs = succs;
}

// The chain of nodes that set the graph's end time: from the latest-finishing node, step back to
// the predecessor that finished last.
function criticalPath(m) {
  const done = [...m.nodes.values()].filter((n) => n.run?.closedAt);
  if (!done.length) return new Set();
  let cur = done.reduce((a, b) => (b.run.closedAt > a.run.closedAt ? b : a));
  const path = new Set([cur.id]);
  for (let guard = 0; guard < 200; guard++) {
    const prev = m.preds.get(cur.id).map((p) => m.nodes.get(p)).filter((p) => p.run?.closedAt).sort((a, b) => b.run.closedAt - a.run.closedAt)[0];
    if (!prev) break;
    path.add(prev.id);
    cur = prev;
  }
  return path;
}

// ---------- rendering ----------
function edgePath(a, b) {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(30, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

function nodeGroup(n, m, crit) {
  const g = s('g', { class: `gn gn-${n.kind}${crit.has(n.id) ? ' crit' : ''}${n.status === 'NOT_RUN' ? ' notrun' : ''}`, transform: `translate(${n.x},${n.y})`, 'data-id': n.id });
  if (n.kind !== 'node') {
    const label = n.kind === 'input' ? `in · ${n.spec.id}` : `out · ${n.spec.id}`;
    const val = n.value == null ? '—' : typeof n.value === 'string' ? n.value : JSON.stringify(n.value);
    g.append(
      s('rect', { class: 'gn-box', width: n.w, height: n.h, rx: 8 }),
      s('text', { class: 'gn-t1', x: 12, y: 19 }, clip(label, 24)),
      s('text', { class: 'gn-t2', x: 12, y: 35 }, clip(val.replace(/^https?:\/\/[^/]+\//, '…/'), 26)),
    );
    return g;
  }
  const r = n.run;
  const st = STATUS[n.status] || STATUS.PENDING;
  const media = firstMedia(r?.output);
  const textW = media ? n.w - 70 : n.w - 20;
  g.append(
    s('rect', { class: 'gn-box', width: n.w, height: n.h, rx: 8 }),
    s('rect', { class: 'gn-stripe', width: 4, height: n.h - 16, x: 0, y: 8, rx: 2, fill: st.color }),
    s('text', { class: 'gn-t1', x: 14, y: 21 }, clip(n.id, Math.floor(textW / 7.2))),
    s('text', { class: 'gn-t2', x: 14, y: 37 }, clip(n.spec.workflow || n.spec.kind || '', Math.floor(textW / 6.4))),
  );
  // When it ran inside the graph: queue (faint) then run, on the graph's own time axis.
  const barW = textW - 4;
  g.append(s('rect', { class: 'gn-track', x: 14, y: 50, width: barW, height: 5, rx: 2.5 }));
  if (r?.initiatedAt) {
    const a = (r.initiatedAt - m.t0) / m.span;
    const b = ((r.startedAt || r.initiatedAt) - m.t0) / m.span;
    const c = ((r.closedAt || r.startedAt || r.initiatedAt) - m.t0) / m.span;
    g.append(s('rect', { class: 'gn-queue', x: 14 + a * barW, y: 50, width: Math.max(0, (b - a) * barW), height: 5 }),
      s('rect', { x: 14 + b * barW, y: 50, width: Math.max(2, (c - b) * barW), height: 5, rx: 2.5, fill: st.color }));
  }
  const meta = [r?.durationMs != null ? dur(r.durationMs) : st.label, r?.costMicrocents ? `$${(r.costMicrocents / 1e8).toFixed(3)}` : null, r?.provider || null, n.attempts.length > 1 ? `${n.attempts.length} attempts` : null].filter(Boolean).join(' · ');
  g.append(s('text', { class: `gn-t3${n.status === 'FAILED' ? ' err' : ''}`, x: 14, y: 73 }, clip(meta, Math.floor(textW / 6.2))));
  if (media) {
    const k = kindOf(media);
    if (k === 'image') g.append(s('image', { href: media, x: n.w - 58, y: 14, width: 48, height: 60, preserveAspectRatio: 'xMidYMid slice', class: 'gn-img' }));
    else g.append(s('rect', { x: n.w - 58, y: 14, width: 48, height: 60, rx: 5, class: 'gn-mediabox' }), s('text', { class: 'gn-mediaicon', x: n.w - 34, y: 49, 'text-anchor': 'middle' }, k === 'video' ? '▶' : '♪'));
  }
  if (crit.has(n.id)) g.append(s('rect', { class: 'gn-critring', width: n.w, height: n.h, rx: 8 }));
  return g;
}

// ---------- overlay ----------
let overlay = null;

export async function openGraphView({ title, step }) {
  closeGraphView();
  overlay = h('div', { class: 'gv', role: 'dialog', 'aria-label': 'Graph run' });
  overlay.append(h('div', { class: 'gv-head' }, h('div', { class: 'loading-line' }, 'Reading the graph run from Temporal…')));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  try {
    const tr = step.workflowId ? await getJson(`api/trace/${step.workflowId}`) : await getJson(`api/trace-job/${step.jobId}?at=${step.startedAt}`);
    if (!overlay) return;
    const runs = (tr.graphRuns || []).filter((g) => g.graph);
    if (!runs.length) {
      overlay.replaceChildren(head(title, step, tr, null, runs), h('div', { class: 'empty-state' }, h('h2', {}, tr.notFound ? 'No matching workflow in Temporal' : 'This generation has no Genix graph run'),
        tr.wrapperErrors?.length ? h('pre', { class: 'tl-pre', style: { maxWidth: '700px', margin: '0 auto', textAlign: 'left' } }, tr.wrapperErrors.map((e) => e.message).join('\n')) : null));
      return;
    }
    showRun({ title, step, tr, runs, index: 0 });
  } catch (err) {
    overlay?.replaceChildren(head(title, step, null, null, []), h('div', { class: 'empty-state' }, h('h2', {}, 'Couldn’t read the graph run'), h('p', {}, err.message)));
  }
}

export function closeGraphView() {
  if (!overlay) return;
  document.removeEventListener('keydown', onKey, true);
  overlay.remove();
  overlay = null;
}

const view = { mode: 'graph', ctx: null };

function onKey(e) {
  if (!overlay) return;
  const k = e.key;
  if (k === 'Escape') closeGraphView();
  else if (k === 'f' || k === 'F') view.ctx?.fit();
  else if (k === 'v' || k === 'V') view.ctx?.toggleMode();
  else if (k === ']' || k === '[') view.ctx?.step(k === ']' ? 1 : -1);
  else {
    // The overlay owns the keyboard while open; the grid behind it must not react.
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

function head(title, step, tr, run, runs, ctx) {
  // The Temporal workflow can complete while the graph itself failed (a node failed and Genix
  // recorded it); lead with the graph's outcome.
  const graphFailed = run && run.genixStatus && !/succeeded/i.test(run.genixStatus);
  const st = run ? (graphFailed ? { color: 'var(--viz-crit)', label: `Graph ${run.genixStatus}` } : STATUS[run.status] || STATUS.PENDING) : null;
  return h('div', { class: 'gv-head' },
    h('div', { class: 'gv-crumbs' }, h('span', {}, title || 'Run'), h('span', { class: 'sep' }, '›'), h('span', {}, step.method || step.tool), run ? [h('span', { class: 'sep' }, '›'), h('b', {}, run.graph?.name || run.graphId)] : null),
    run ? h('span', { class: 'pill', style: { color: st.color, borderColor: 'currentColor' }, title: `Temporal workflow: ${run.status}${run.genixStatus ? ` · Genix: ${run.genixStatus}` : ''}` }, st.label) : null,
    run ? h('span', { class: 'gv-meta' }, `${dur(run.durationMs)}${run.cost?.totalUsd != null ? ` · $${run.cost.totalUsd.toFixed(3)}` : ''}${run.cost?.byProvider ? ` (${Object.entries(run.cost.byProvider).map(([p, mc]) => `${p} $${(mc / 1e8).toFixed(2)}`).join(', ')})` : ''} · ${run.graph.nodes.length} nodes`) : null,
    runs.length > 1 ? h('div', { class: 'seg' }, runs.map((r, i) => h('button', { 'aria-checked': String(ctx?.index === i), onclick: () => showRun({ ...ctx, index: i }) }, `Graph ${i + 1}`))) : null,
    h('span', { style: { flex: 1 } }),
    run ? h('div', { class: 'seg' }, h('button', { 'aria-checked': String(view.mode === 'graph'), onclick: () => view.ctx?.setMode('graph'), title: 'Graph (V)' }, 'Graph'), h('button', { 'aria-checked': String(view.mode === 'waterfall'), onclick: () => view.ctx?.setMode('waterfall'), title: 'Waterfall (V)' }, 'Waterfall')) : null,
    run ? h('button', { class: 'btn', onclick: () => view.ctx?.fit(), title: 'Fit (F)' }, 'Fit') : null,
    run?.temporalUrl ? h('a', { class: 'btn', href: run.temporalUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'Temporal') : null,
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: closeGraphView }, icon('x')));
}

function showRun(ctx) {
  const run = ctx.runs[ctx.index];
  const m = buildModel(run);
  layout(m);
  const crit = criticalPath(m);
  let selected = null;

  const svg = s('svg', { class: 'gv-svg' });
  const world = s('g');
  const defs = s('defs', {}, s('marker', { id: 'gv-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L8,4 L0,8 z', class: 'gv-arrowhead' })));
  const edgeEls = m.edges.map((e) => {
    const a = m.nodes.get(e.from);
    const b = m.nodes.get(e.to);
    const onCrit = crit.has(e.from) && crit.has(e.to);
    const el = s('path', { class: `ge${onCrit ? ' crit' : ''}${b.status === 'FAILED' || b.status === 'NOT_RUN' ? ` to-${b.status.toLowerCase()}` : ''}`, d: edgePath(a, b), 'marker-end': 'url(#gv-arrow)' });
    el.append(s('title', {}, `${e.from}.${e.fromHandle} → ${e.to}.${e.toHandle}`));
    el._e = e;
    return el;
  });
  const nodeEls = [...m.nodes.values()].map((n) => {
    const el = nodeGroup(n, m, crit);
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      select(n.id);
    });
    el.addEventListener('pointerenter', () => highlight(n.id));
    el.addEventListener('pointerleave', () => highlight(selected));
    return el;
  });
  world.append(...edgeEls, ...nodeEls);
  svg.append(defs, world);

  // Hover/selection: light up everything upstream and downstream of a node.
  function highlight(id) {
    if (!id) {
      svg.classList.remove('dim');
      return;
    }
    const keep = new Set([id]);
    const walk = (start, next) => {
      const q = [start];
      while (q.length) for (const x of next.get(q.shift()) || []) if (!keep.has(x)) keep.add(x), q.push(x);
    };
    walk(id, m.preds);
    walk(id, m.succs);
    svg.classList.add('dim');
    for (const el of nodeEls) el.classList.toggle('lit', keep.has(el.dataset.id));
    for (const el of edgeEls) el.classList.toggle('lit', keep.has(el._e.from) && keep.has(el._e.to));
  }

  // Pan & zoom on the viewBox. Wheel pans, pinch / ⌘-wheel zooms, drag the background to pan.
  const vb = { x: 0, y: 0, w: 1, h: 1 };
  const apply = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  // Fit the whole graph if it stays readable; a long serial pipeline instead opens at a readable
  // zoom anchored on its start, and you pan along it.
  const MIN_READABLE = 0.62;
  const fit = () => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const pad = 40;
    const full = Math.min((r.width - pad * 2) / m.width, (r.height - pad * 2) / m.height, 1.3);
    const scale = Math.max(full, Math.min(MIN_READABLE, (r.height - pad * 2) / m.height));
    vb.w = r.width / scale;
    vb.h = r.height / scale;
    vb.x = scale > full ? -pad / scale : m.width / 2 - vb.w / 2;
    vb.y = m.height / 2 - vb.h / 2;
    apply();
  };
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const k = Math.exp(e.deltaY * 0.01);
      const px = vb.x + ((e.clientX - r.left) / r.width) * vb.w;
      const py = vb.y + ((e.clientY - r.top) / r.height) * vb.h;
      vb.w = Math.min(Math.max(vb.w * k, 200), 20000);
      vb.h = vb.w * (r.height / r.width);
      vb.x = px - ((e.clientX - r.left) / r.width) * vb.w;
      vb.y = py - ((e.clientY - r.top) / r.height) * vb.h;
    } else {
      vb.x += (e.deltaX * vb.w) / r.width;
      vb.y += (e.deltaY * vb.h) / r.height;
    }
    apply();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.gn')) return;
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    vb.x = drag.vx - ((e.clientX - drag.x) * vb.w) / r.width;
    vb.y = drag.vy - ((e.clientY - drag.y) * vb.h) / r.height;
    apply();
  });
  svg.addEventListener('pointerup', () => (drag = null));
  svg.addEventListener('click', () => select(null));

  const side = h('aside', { class: 'gv-side' });
  const canvas = h('div', { class: 'gv-canvas' }, svg);
  const waterfall = h('div', { class: 'gv-waterfall' });
  const body = h('div', { class: 'gv-body' }, canvas, waterfall, side);

  const order = [...m.nodes.values()].filter((n) => n.kind === 'node').sort((a, b) => (a.run?.initiatedAt || Infinity) - (b.run?.initiatedAt || Infinity) || a.x - b.x);
  function select(id) {
    selected = id;
    for (const el of nodeEls) el.classList.toggle('sel', el.dataset.id === id);
    for (const el of waterfall.querySelectorAll('.gw-row')) el.classList.toggle('sel', el.dataset.id === id);
    highlight(id);
    // replaceChildren stringifies nulls and nested arrays; flatten and drop empties first.
    side.replaceChildren(...(id ? nodeDetail(m.nodes.get(id), m, crit, run) : graphSummary(run, m, crit, select)).flat(Infinity).filter(Boolean));
  }

  function renderWaterfall() {
    const W = 560;
    waterfall.replaceChildren(h('div', { class: 'gw-head' }, h('span', {}, 'Node'), h('span', {}, `Graph time → ${dur(m.span)}`)),
      ...order.map((n) => {
        const r = n.run;
        const st = STATUS[n.status] || STATUS.PENDING;
        const x = (t) => ((t - m.t0) / m.span) * W;
        return h('div', { class: `gw-row${crit.has(n.id) ? ' crit' : ''}`, 'data-id': n.id, onclick: () => select(n.id) },
          h('span', { class: 'gw-l' }, h('i', { style: { background: st.color } }), clip(n.id, 30), h('small', {}, n.spec.workflow)),
          h('span', { class: 'gw-t', style: { width: `${W}px` } },
            r?.initiatedAt ? [
              h('span', { class: 'gw-q', style: { left: `${x(r.initiatedAt)}px`, width: `${Math.max(0, x(r.startedAt || r.initiatedAt) - x(r.initiatedAt))}px` } }),
              h('span', { class: 'gw-b', title: `${n.id}: queued ${dur(r.queueMs)}, ran ${dur(r.durationMs)}`, style: { left: `${x(r.startedAt || r.initiatedAt)}px`, width: `${Math.max(2, x(r.closedAt || r.startedAt) - x(r.startedAt || r.initiatedAt))}px`, background: st.color } }),
            ] : h('span', { class: 'gw-none' }, 'not run')),
          h('span', { class: 'gw-d' }, r?.durationMs != null ? dur(r.durationMs) : '–'));
      }));
  }

  view.mode = view.mode || 'graph';
  const setMode = (mode) => {
    view.mode = mode;
    canvas.hidden = mode !== 'graph';
    waterfall.hidden = mode !== 'waterfall';
    overlay.querySelector('.gv-head').replaceWith(head(ctx.title, ctx.step, ctx.tr, run, ctx.runs, ctx));
    if (mode === 'graph') requestAnimationFrame(fit);
  };
  view.ctx = {
    fit,
    setMode,
    toggleMode: () => setMode(view.mode === 'graph' ? 'waterfall' : 'graph'),
    step: (d) => {
      const i = order.findIndex((n) => n.id === selected);
      const next = order[Math.max(0, Math.min(order.length - 1, i + d))];
      if (next) select(next.id);
    },
  };

  overlay.replaceChildren(head(ctx.title, ctx.step, ctx.tr, run, ctx.runs, ctx), body);
  renderWaterfall();
  select(null);
  setMode(view.mode);
  new ResizeObserver(() => view.mode === 'graph' && fit()).observe(canvas);
}

// ---------- side panel ----------
function valueView(v) {
  if (v == null) return h('span', { class: 'desc' }, '—');
  const url = typeof v === 'string' && MEDIA_RE.test(v) ? v.match(MEDIA_RE)[0] : null;
  if (url) {
    const k = kindOf(url);
    return h('div', { class: 'gv-val' },
      k === 'image' ? h('img', { src: url, class: 'gv-media', loading: 'lazy' }) : k === 'video' ? h('video', { src: url, class: 'gv-media', controls: true, muted: true, preload: 'metadata' }) : h('audio', { src: url, controls: true, preload: 'none' }),
      h('a', { href: url, target: '_blank', rel: 'noopener', class: 'mono gv-url' }, clip(url.replace(/^https?:\/\//, ''), 60)));
  }
  const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return text.length > 140 || text.includes('\n')
    ? h('details', { class: 'gv-long' }, h('summary', {}, clip(text.replace(/\s+/g, ' '), 90)), h('pre', { class: 'tl-pre' }, text.slice(0, 12000)))
    : h('span', { class: 'mono gv-short' }, text);
}

function nodeDetail(n, m, crit, run) {
  if (n.kind !== 'node') {
    return [h('h3', { class: 'gv-h' }, n.kind === 'input' ? `Graph input · ${n.spec.id}` : `Graph output · ${n.spec.id}`),
      n.spec.description ? h('p', { class: 'desc' }, n.spec.description) : null, valueView(n.value)];
  }
  const r = n.run;
  const st = STATUS[n.status] || STATUS.PENDING;
  // Where each input came from: an upstream node, a graph input, or a static param in the spec.
  const incoming = new Map(m.edges.filter((e) => e.to === n.id).map((e) => [e.toHandle, e]));
  const params = n.spec.params || {};
  const input = r?.input && typeof r.input === 'object' ? r.input : {};
  const keys = [...new Set([...Object.keys(input), ...Object.keys(params), ...incoming.keys()])];
  const srcLabel = (k) => {
    const e = incoming.get(k);
    if (e) return e.from.startsWith('in:') ? `graph input ${e.from.slice(3)}` : `← ${e.from}.${e.fromHandle}`;
    return k in params ? 'static param' : 'resolved';
  };
  const out = [
    h('h3', { class: 'gv-h' }, n.id),
    h('div', { class: 'pills' },
      h('span', { class: 'pill', style: { color: st.color, borderColor: 'currentColor' } }, st.label),
      h('span', { class: 'pill' }, n.spec.workflow),
      crit.has(n.id) ? h('span', { class: 'pill info' }, 'On the critical path') : null,
      n.attempts.length > 1 ? h('span', { class: 'pill warn' }, `${n.attempts.length} attempts`) : null),
    r ? h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'Queued at'), h('dd', {}, `+${dur(r.initiatedAt - m.t0)} (waited ${dur(r.queueMs)})`),
      h('dt', {}, 'Ran for'), h('dd', {}, `${dur(r.durationMs)} (ended +${dur((r.closedAt || 0) - m.t0)})`),
      r.costMicrocents ? [h('dt', {}, 'Cost'), h('dd', {}, `$${(r.costMicrocents / 1e8).toFixed(4)} · ${r.provider || ''} ${r.endpoint || ''}`)] : null,
      n.spec.taskQueue ? [h('dt', {}, 'Task queue'), h('dd', { class: 'mono' }, n.spec.taskQueue)] : null,
      n.spec.when ? [h('dt', {}, 'Runs when'), h('dd', { class: 'mono' }, n.spec.when)] : null,
      r.workflowId ? [h('dt', {}, 'Workflow'), h('dd', { class: 'mono', style: { cursor: 'copy' }, onclick: () => copy(r.workflowId) }, r.workflowId)] : null)
      : h('p', { class: 'desc' }, n.spec.when ? `Didn’t run — condition: ${n.spec.when}` : 'Didn’t run (an upstream node failed or the graph stopped first).'),
    r?.errors?.length ? h('div', { class: 'err-row', style: { marginTop: '10px' } }, h('div', { class: 'h' }, 'Why it failed'), h('pre', {}, r.rootCause || ''),
      r.errors.length > 1 ? h('details', {}, h('summary', {}, 'Full cause chain'), h('pre', {}, r.errors.map((e, i) => `${'  '.repeat(i)}${e.type ? `[${e.type}] ` : ''}${e.message}`).join('\n'))) : null) : null,
    h('h5', { class: 'gv-sub' }, 'Inputs'),
    h('div', { class: 'gv-io' }, keys.map((k) => h('div', { class: 'gv-io-row' },
      h('div', { class: 'gv-io-k' }, h('b', {}, k), h('small', {}, srcLabel(k))),
      valueView(k in input ? input[k] : params[k])))),
    h('h5', { class: 'gv-sub' }, 'Output'),
    r?.output && typeof r.output === 'object' && !Array.isArray(r.output)
      ? h('div', { class: 'gv-io' }, Object.entries(r.output).map(([k, v]) => h('div', { class: 'gv-io-row' }, h('div', { class: 'gv-io-k' }, h('b', {}, k)), valueView(v))))
      : valueView(r?.output),
    r?.temporalUrl ? h('div', { class: 'links', style: { marginTop: '12px' } }, h('a', { class: 'btn', href: r.temporalUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'Open node in Temporal')) : null,
  ];
  return out;
}

function graphSummary(run, m, crit, select) {
  const nodes = [...m.nodes.values()].filter((n) => n.kind === 'node');
  const slow = nodes.filter((n) => n.run?.durationMs).sort((a, b) => b.run.durationMs - a.run.durationMs).slice(0, 6);
  const pricey = nodes.filter((n) => n.run?.costMicrocents).sort((a, b) => b.run.costMicrocents - a.run.costMicrocents).slice(0, 6);
  const failed = nodes.filter((n) => ['FAILED', 'TIMED_OUT', 'TERMINATED'].includes(n.status));
  const notRun = nodes.filter((n) => n.status === 'NOT_RUN');
  const row = (n, val) => h('div', { class: 'gv-list-row', onclick: () => select(n.id) }, h('span', {}, h('i', { style: { background: (STATUS[n.status] || STATUS.PENDING).color } }), n.id), h('span', { class: 'mono' }, val));
  const critMs = [...crit].map((id) => m.nodes.get(id)?.run?.durationMs || 0).reduce((a, b) => a + b, 0);
  return [
    h('h3', { class: 'gv-h' }, run.graph.name || run.graphId),
    h('p', { class: 'desc' }, `${nodes.length} nodes · ${nodes.length - notRun.length} ran · ${failed.length} failed · graph ${run.graphId || ''}`),
    failed.length ? h('div', { class: 'err-row' }, h('div', { class: 'h' }, `${failed.length} node${failed.length > 1 ? 's' : ''} failed`), ...failed.map((n) => h('div', { class: 'gv-fail', onclick: () => select(n.id) }, h('b', {}, n.id), h('pre', {}, n.run?.rootCause || '')))) : null,
    h('h5', { class: 'gv-sub' }, `Critical path · ${crit.size} nodes · ${dur(critMs)} of ${dur(m.span)}`),
    h('div', { class: 'gv-list' }, [...crit].reverse().map((id) => row(m.nodes.get(id), dur(m.nodes.get(id)?.run?.durationMs)))),
    h('h5', { class: 'gv-sub' }, 'Slowest nodes'),
    h('div', { class: 'gv-list' }, slow.map((n) => row(n, dur(n.run.durationMs)))),
    pricey.length ? [h('h5', { class: 'gv-sub' }, 'Cost by node'), h('div', { class: 'gv-list' }, pricey.map((n) => row(n, `$${(n.run.costMicrocents / 1e8).toFixed(3)}`)))] : null,
    h('h5', { class: 'gv-sub' }, 'Graph inputs'),
    h('div', { class: 'gv-io' }, Object.entries(run.inputs || {}).map(([k, v]) => h('div', { class: 'gv-io-row' }, h('div', { class: 'gv-io-k' }, h('b', {}, k)), valueView(v)))),
    h('h5', { class: 'gv-sub' }, 'Graph outputs'),
    h('div', { class: 'gv-io' }, Object.entries(run.outputs || {}).map(([k, v]) => h('div', { class: 'gv-io-row' }, h('div', { class: 'gv-io-k' }, h('b', {}, k)), valueView(v?.result ?? v)))),
    m.unmatched.length ? h('p', { class: 'desc' }, `${m.unmatched.length} child workflow(s) couldn’t be matched to a node: ${m.unmatched.map((c) => c.workflowType).join(', ')}`) : null,
    h('p', { class: 'desc', style: { marginTop: '14px' } }, 'Click a node for its inputs and output · hover to trace up/downstream · ⌘/pinch to zoom · F fit · V waterfall · [ ] step · Esc close'),
  ];
}
