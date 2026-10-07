import { getJson } from './util.js';

// Which model a generation used, how long its calls take and what they cost. Media jobs (video,
// music, voice) are named and priced by the Genix graph they ran, from the product's own price
// list (ListCosts: per graph a unit, SECOND or GENERATION, and usdPerUnit); image tools by their
// model, at Wix's average cost per call from the credits log. List prices: failed calls count as free.
let prices = { graphs: {}, images: {} };
export const pricesReady = getJson('/api/prices').then((p) => (prices = p)).catch(() => prices);

const GEN = /^generate|^holdStill|^transformVideo|LogoShot|Animation$|^StartAnimation/;
export const isGeneration = (tool, method) => tool === 'generate_image' || tool === 'edit_image' || (tool === 'invoke_rpc' && GEN.test(method || '') && !/^generateContentByProject/.test(method || ''));

// "Seedance 2 Mini", "gpt-image-2.5-flare", else the method.
export function modelName(tool, method, model, graph) {
  if (graph && prices.graphs?.[graph]?.name) return prices.graphs[graph].name;
  if (model) return model;
  return tool === 'invoke_rpc' ? method : tool;
}

export function kindOf(tool, method) {
  if (tool === 'generate_image' || tool === 'edit_image') return 'image';
  if (/Speech|Voice/.test(method || '')) return 'voice';
  if (/Music/.test(method || '')) return 'music';
  return 'video';
}

// Cost of `ok` successful calls that asked for `seconds` in total; null when the price is unknown.
export function costOf({ tool, model, graph, ok, seconds }) {
  const g = graph && prices.graphs?.[graph];
  if (g) return g.unit === 'SECOND' ? (seconds > 0 ? g.usdPerUnit * seconds : null) : g.usdPerUnit * ok;
  const im = model && prices.images?.[model];
  if (im && (tool === 'generate_image' || tool === 'edit_image')) return im.usd * ok;
  return null;
}

// Per model over a list of step tuples ([tool, method, model, calls, fails, ms, maxMs, err, graph, billedSec]).
export function modelStats(stepLists) {
  const out = new Map();
  for (const steps of stepLists) {
    const seen = new Set();
    for (const [tool, method, model, n, e, ms, maxMs, , graph, billed] of steps || []) {
      if (!isGeneration(tool, method) || !n) continue;
      const name = modelName(tool, method, model, graph);
      let m = out.get(name);
      if (!m) out.set(name, (m = { name, kind: kindOf(tool, method), calls: 0, fails: 0, ms: 0, maxMs: 0, cost: 0, priced: 0, runs: 0, methods: new Set() }));
      m.calls += n;
      m.fails += e;
      m.ms += ms;
      m.maxMs = Math.max(m.maxMs, maxMs);
      m.methods.add(tool === 'invoke_rpc' ? method : tool);
      const c = costOf({ tool, model, graph, ok: n - e, seconds: billed });
      if (c != null) {
        m.cost += c;
        m.priced += n - e;
      }
      if (!seen.has(name)) {
        seen.add(name);
        m.runs++;
      }
    }
  }
  return [...out.values()].map((m) => ({ ...m, methods: [...m.methods], avgMs: m.calls ? m.ms / m.calls : 0, avgCost: m.priced ? m.cost / m.priced : null, failRate: m.calls ? m.fails / m.calls : 0 }));
}

// The same from a run's detail (its steps as objects).
export function detailSteps(d) {
  const map = new Map();
  for (const s of d?.steps || []) {
    if (!isGeneration(s.tool, s.method)) continue;
    const key = [s.tool, s.method || '', s.model || '', s.graphId || ''].join('|');
    const x = map.get(key) || [s.tool, s.method, s.model, 0, 0, 0, 0, null, s.graphId || null, 0];
    x[3]++;
    if (s.status === 'failed') x[4]++;
    x[5] += Number(s.durationMs || 0);
    x[6] = Math.max(x[6], Number(s.durationMs || 0));
    const dur = Number(s.args?.requestJson?.parameters?.duration);
    if (s.status !== 'failed' && dur > 0) x[9] += dur;
    map.set(key, x);
  }
  return [...map.values()];
}

export const money = (x) => (x == null ? '–' : x < 0.01 ? '<$0.01' : x < 10 ? `$${x.toFixed(2)}` : `$${Math.round(x)}`);
