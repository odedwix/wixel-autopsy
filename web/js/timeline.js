import { h, icon, dur, getJson, copy } from './util.js';
import { CAT_COLOR, CAT_LABEL } from './insights.js';
import { openGraphView } from './graph.js';
import { caps, HINT } from './caps.js';

// Step waterfall for one run. Idle gaps (the user away between turns) are compressed to a
// fixed-width break, so an hour-long session with 12 minutes of work still reads at a glance.

const LABEL_W = 210;
const GAP_MS = 45000; // longer idle stretches get compressed
const GAP_PX = 22;
const PLUMBING = new Set(['read', 'list', 'skill', 'write', 'send_feedback', 'task_status', 'poll_process_job']);

const media = (url, kind, cls = 'tl-media', poster) => {
  if (!url) return null;
  if (kind === 'video') return h('video', { class: cls, src: `${url}#t=0.5`, poster, muted: true, loop: true, playsinline: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => e.target.pause() });
  if (kind === 'audio') return h('audio', { class: 'tl-audio', src: url, controls: true, preload: 'none' });
  return h('img', { class: cls, src: url, loading: 'lazy', alt: '' });
};
export const mediaKind = (url) => (/\.(mp4|mov|webm)(\?|$)/i.test(url || '') ? 'video' : /\.(mp3|wav|m4a|aac)(\?|$)/i.test(url || '') ? 'audio' : 'image');

// Piecewise time → x map: active spans keep their duration, idle gaps shrink to GAP_PX.
function timeScale(spans, width) {
  const sorted = spans.filter(([a, b]) => a && b).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a <= last[1] + GAP_MS) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const active = merged.reduce((n, [a, b]) => n + Math.max(1, b - a), 0);
  const gaps = Math.max(0, merged.length - 1);
  const pxPerMs = Math.max(0.00001, (width - gaps * GAP_PX) / active);
  const segs = [];
  let x = 0;
  merged.forEach(([a, b], i) => {
    segs.push({ a, b, x });
    x += (b - a) * pxPerMs;
    if (i < merged.length - 1) x += GAP_PX;
  });
  const toX = (t) => {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (t <= s.b || i === segs.length - 1) return s.x + Math.max(0, Math.min(t, s.b) - s.a) * pxPerMs;
      if (t < segs[i + 1].a) return s.x + (s.b - s.a) * pxPerMs + GAP_PX / 2;
    }
    return 0;
  };
  const breaks = segs.slice(1).map((s, i) => ({ x: s.x - GAP_PX, idle: s.a - segs[i].b }));
  return { toX, breaks, start: merged[0]?.[0] || 0, pxPerMs, width, segs };
}

// Axis ticks: every active segment starts with a labelled tick, then round-number ticks
// (1s … 1h steps, ~80px apart) inside it, all as elapsed time since the run began.
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);
const tickLabel = (ms) => (ms && ms % 3600000 === 0 ? `${ms / 3600000}h` : ms && ms % 60000 === 0 ? `${ms / 60000}m` : dur(ms));
function axisTicks(sc, t0) {
  const step = STEPS.find((s) => s * sc.pxPerMs >= 80) || STEPS.at(-1);
  const ticks = [];
  const room = (x) => ticks.every((t) => Math.abs(t.x - x) >= 52) && x <= sc.width - 56; // clear of neighbours and the end label
  for (const seg of sc.segs) {
    const x0 = seg.x;
    if (room(x0) || !ticks.length) ticks.push({ x: x0, label: `+${dur(seg.a - t0)}`, major: true });
    for (let t = Math.ceil((seg.a - t0) / step) * step; t0 + t < seg.b; t += step) {
      const x = seg.x + (t0 + t - seg.a) * sc.pxPerMs;
      if (room(x)) ticks.push({ x, label: tickLabel(t) });
    }
  }
  return ticks;
}

function tip(el, text) {
  el.title = text;
  return el;
}

let currentTitle = '';
export function renderTimeline(root, d, { onSeekScene } = {}) {
  currentTitle = d.outputs?.name || d.title || 'Run';
  const opts = { hidePlumbing: true, only: 'all' };
  let openId = null;

  const draw = () => {
    const width = Math.max(240, root.clientWidth - LABEL_W - 24);
    const steps = d.steps.filter((s) => {
      if (opts.only === 'failed') return s.status === 'failed';
      if (opts.only === 'gen') return ['video', 'image', 'tts', 'audio'].includes(s.category);
      return !(opts.hidePlumbing && PLUMBING.has(s.tool) && s.status !== 'failed');
    });
    const model = (d.modelCalls || []).filter((m) => m.startedAt && m.at);
    const spans = [...d.steps.map((s) => [s.startedAt, s.endedAt || s.startedAt + (s.durationMs || 0)]), ...model.map((m) => [m.startedAt, m.at]), ...(d.userMessages || []).map((m) => [m.at, m.at + 1])];
    const sc = timeScale(spans, width);
    const t0 = sc.start;

    const axis = h('div', { class: 'tl-axis', style: { marginLeft: `${LABEL_W}px`, width: `${width}px` } });
    const ticks = axisTicks(sc, t0);
    for (const t of ticks) axis.append(h('span', { class: `tick${t.major ? ' major' : ''}`, style: { left: `${t.x}px` } }, t.label));
    const endMs = (sc.segs.at(-1)?.b ?? t0) - t0;
    axis.append(h('span', { class: 'tick end', title: 'Time from the first step to the last' }, dur(endMs)));
    for (const b of sc.breaks) axis.append(h('span', { class: 'brk', style: { left: `${b.x}px`, width: `${GAP_PX}px` }, title: `${dur(b.idle)} idle` }, '⋯'));

    const overlay = h('div', { class: 'tl-overlay', style: { left: `${LABEL_W}px`, width: `${width}px` } },
      ...ticks.filter((t) => t.x > 0).map((t) => h('div', { class: 'tl-grid', style: { left: `${t.x}px` } })),
      ...sc.breaks.map((b) => h('div', { class: 'tl-gap', style: { left: `${b.x}px`, width: `${GAP_PX}px` }, title: `${dur(b.idle)} idle` })),
      ...(d.userMessages || []).map((m, i) => tip(h('div', { class: 'tl-user', style: { left: `${sc.toX(m.at)}px` } }), `User message ${i + 1} at +${dur(m.at - t0)}\n${String(m.text).slice(0, 200)}`)));

    const rows = [];
    // Agent thinking: model calls on one row.
    rows.push(h('div', { class: 'tl-row' },
      h('div', { class: 'tl-label' }, h('span', { class: 'cat', style: { background: 'var(--text-3)' } }), h('span', { class: 'n' }, 'Agent thinking'), h('span', { class: 'd' }, dur(model.reduce((a, m) => a + (m.latencyMs || 0), 0)))),
      h('div', { class: 'tl-track', style: { width: `${width}px` } }, model.map((m) => tip(h('div', { class: `tl-bar think${m.status && m.status !== 'SUCCESS' ? ' fail' : ''}`, style: { left: `${sc.toX(m.startedAt)}px`, width: `${Math.max(2, sc.toX(m.at) - sc.toX(m.startedAt))}px` } }),
        `${m.model} · ${m.purpose || 'model call'}\n+${dur(m.startedAt - t0)} · ${dur(m.latencyMs)}\n${m.inputTokens.toLocaleString()} in (${m.cachedInputTokens.toLocaleString()} cached) · ${m.outputTokens.toLocaleString()} out`)))));

    for (const s of steps) {
      const end = s.endedAt || (s.durationMs ? s.startedAt + s.durationMs : s.startedAt);
      const x = sc.toX(s.startedAt);
      const w = Math.max(3, sc.toX(end) - x);
      const color = CAT_COLOR[s.category] || 'var(--text-3)';
      const row = h('div', { class: `tl-row${openId === s.id ? ' open' : ''}${s.status === 'failed' ? ' failed' : ''}`, onclick: () => { openId = openId === s.id ? null : s.id; draw(); } },
        h('div', { class: 'tl-label', title: s.label },
          h('span', { class: 'cat', style: { background: color } }),
          h('span', { class: 'n' }, s.label),
          s.status === 'failed' ? icon('alert', 'sm err-i') : null,
          h('span', { class: 'd' }, dur(s.durationMs))),
        h('div', { class: 'tl-track', style: { width: `${width}px` } },
          tip(h('div', { class: `tl-bar${s.status === 'failed' ? ' fail' : ''}${s.status === 'running' ? ' running' : ''}`, style: { left: `${x}px`, width: `${w}px`, background: s.status === 'failed' ? undefined : color } }),
            `${s.label}${s.model ? ` · ${s.model}` : ''}\n${CAT_LABEL[s.category] || s.category} · ${s.status}\nstarts +${dur(s.startedAt - t0)} · takes ${dur(s.durationMs)}${s.prompt ? `\n\n${String(s.prompt).slice(0, 240)}` : ''}`)));
      rows.push(row);
      if (openId === s.id) rows.push(stepDetail(s, t0));
    }

    const filters = h('div', { class: 'tl-filters' },
      ...[['all', 'All steps'], ['gen', 'Generation'], ['failed', `Failed (${d.steps.filter((s) => s.status === 'failed').length})`]].map(([k, l]) =>
        h('button', { class: `seg-btn${opts.only === k ? ' on' : ''}`, onclick: () => { opts.only = k; draw(); } }, l)),
      h('label', { class: 'tl-check' }, h('input', { type: 'checkbox', checked: opts.hidePlumbing, onchange: (e) => { opts.hidePlumbing = e.target.checked; draw(); } }), 'Hide agent plumbing (read / write / list)'),
      h('span', { class: 'tl-sum' }, `${d.steps.length} steps · ${dur(d.timing?.wallMs)} wall · idle gaps compressed`));

    const legend = h('div', { class: 'legend', style: { marginTop: '8px' } },
      h('span', {}, h('i', { style: { background: 'var(--text-3)' } }), 'Agent thinking'),
      ...Object.entries(CAT_LABEL).filter(([c]) => d.steps.some((s) => s.category === c)).map(([c, l]) => h('span', {}, h('i', { style: { background: CAT_COLOR[c] } }), l)),
      h('span', {}, h('i', { style: { background: 'var(--viz-crit)' } }), 'Failed'),
      h('span', {}, h('i', { class: 'user-mark' }), 'User message'));

    root.replaceChildren(filters, h('div', { class: 'tl' }, axis, h('div', { class: 'tl-body' }, overlay, ...rows)), legend);
  };

  draw();
  // Redraw on width changes only: content growing taller (an opened trace) must not re-render.
  let lastW = root.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(root.clientWidth - lastW) < 2) return;
    lastW = root.clientWidth;
    draw();
  }).observe(root);
}

// Loaded graph-run traces survive redraws (filter changes, resizes).
const traces = new Map();

function stepDetail(s, t0) {
  const out = s.output;
  const outText = out == null ? '' : typeof out === 'string' ? out : out.text ? `${out.text}\n… (${out.truncated.toLocaleString()} chars)` : JSON.stringify(out, null, 2);
  const inMedia = (s.mediaIn || []).slice(0, 6);
  const outMedia = (s.mediaOut || []).filter((m) => !/captions\.json/.test(m.url)).slice(0, 4);
  const trace = h('div', { class: 'tl-trace' });
  if (traces.has(s.id)) showTrace(traces.get(s.id), trace);
  const canTrace = s.workflowId || (s.status === 'failed' && s.jobId);
  const box = h('div', { class: 'tl-detail', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'kv' },
      h('dt', {}, 'Step'), h('dd', {}, `${s.tool}${s.method ? ` · ${s.method}` : ''}${s.model ? ` · ${s.model}` : ''}`),
      h('dt', {}, 'Timing'), h('dd', {}, `starts +${dur(s.startedAt - t0)} · takes ${dur(s.durationMs)}`),
      s.graphId ? [h('dt', {}, 'Genix graph'), h('dd', { class: 'mono' }, s.graphId)] : null,
      s.jobId ? [h('dt', {}, 'Job'), h('dd', { class: 'mono', style: { cursor: 'copy' }, onclick: () => copy(s.jobId) }, s.jobId)] : null,
      s.resultValue && !s.resultUrl ? [h('dt', {}, 'Result'), h('dd', { class: 'mono' }, s.resultValue)] : null),
    s.prompt ? h('div', { class: 'tl-prompt' }, h('h5', {}, 'Prompt'), h('div', {}, String(s.prompt))) : null,
    inMedia.length ? h('div', {}, h('h5', {}, 'Inputs'), h('div', { class: 'tl-medias' }, inMedia.map((m) => media(m.url, m.kind)))) : null,
    outMedia.length ? h('div', {}, h('h5', {}, 'Output'), h('div', { class: 'tl-medias' }, outMedia.map((m) => media(m.url, m.kind, 'tl-media', m.kind === 'video' ? inMedia.find((x) => x.kind === 'image')?.url : undefined)))) : null,
    s.error ? h('div', { class: 'err-row' }, h('div', { class: 'h' }, 'Error'), h('pre', {}, s.error)) : null,
    outText && !outMedia.length ? h('details', {}, h('summary', {}, 'Raw output'), h('pre', { class: 'tl-pre' }, outText.slice(0, 6000))) : null,
    h('details', {}, h('summary', {}, 'Arguments'), h('pre', { class: 'tl-pre' }, JSON.stringify(s.args, null, 2).slice(0, 6000))),
    canTrace ? h('div', { class: 'links' },
      h('button', { class: 'btn primary', disabled: !caps.temporalKey, title: caps.temporalKey ? '' : HINT.temporalKey, onclick: () => openGraphView({ title: currentTitle, step: s }) }, icon('sparkle'), 'Open graph run'),
      h('button', { class: 'btn', disabled: !caps.temporalKey, onclick: () => loadTrace(s, trace) }, 'Nodes table'),
      h('span', { class: 'desc', style: { alignSelf: 'center' } }, caps.temporalKey ? 'Reads Temporal (prod) — only when you click' : HINT.temporalKey)) : null,
    trace);
  return box;
}

// Per-node view of the graph run behind a generation (Temporal, on demand). Phase 3 draws it.
async function loadTrace(s, el) {
  el.replaceChildren(h('div', { class: 'loading-line' }, 'Reading the graph run from Temporal…'));
  try {
    const tr = s.workflowId ? await getJson(`/api/trace/${s.workflowId}`) : await getJson(`/api/trace-job/${s.jobId}?at=${s.startedAt}`);
    traces.set(s.id, tr);
    showTrace(tr, el);
  } catch (err) {
    el.replaceChildren(h('div', { class: 'loading-line' }, `Couldn’t read the trace: ${err.message}`));
  }
}

function showTrace(tr, el) {
  {
    if (tr.notFound) return el.replaceChildren(h('div', { class: 'loading-line' }, 'No matching workflow found in Temporal.'));
    const blocks = (tr.graphRuns || []).map((g) => h('div', { class: 'tl-graph' },
      h('div', { class: 'h' }, h('b', {}, g.graph?.name || g.graphId || 'graph'), h('span', {}, ` · ${g.status}${g.genixStatus ? ` / ${g.genixStatus}` : ''} · ${dur(g.durationMs)}${g.cost?.totalUsd != null ? ` · $${g.cost.totalUsd.toFixed(3)}` : ''}`),
        g.temporalUrl ? h('a', { href: g.temporalUrl, target: '_blank', rel: 'noopener', style: { marginLeft: 'auto' } }, 'Temporal ↗') : null),
      h('table', { class: 'ins' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Workflow'), h('th', {}, 'Status'), h('th', {}, 'Queue'), h('th', {}, 'Time'), h('th', {}, 'Cost'))),
        h('tbody', {}, (g.children || []).map((c) => h('tr', { class: c.status !== 'COMPLETED' ? 'fail-row' : '' },
          h('td', { title: c.rootCause || '' }, c.nodeId || '?'), h('td', {}, c.workflowType), h('td', {}, c.status),
          h('td', {}, dur(c.queueMs)), h('td', {}, dur(c.durationMs)), h('td', {}, c.costMicrocents ? `$${(c.costMicrocents / 1e8).toFixed(3)}` : '–'))))),
      ...(g.children || []).filter((c) => c.rootCause).map((c) => h('div', { class: 'err-row', style: { marginTop: '6px' } }, h('div', { class: 'h' }, `${c.nodeId} failed`), h('pre', {}, c.rootCause)))));
    el.replaceChildren(...(tr.wrapperErrors?.length ? [h('div', { class: 'err-row' }, h('div', { class: 'h' }, 'Wrapper workflow failed'), h('pre', {}, tr.wrapperErrors.map((e) => e.message).join('\n')))] : []), ...blocks);
  }
}
