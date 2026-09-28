// Phase 0 check: pull a sample of real runs end to end (list → session → Temporal graph runs),
// warm the cache, and report how much of each field we can actually fill.
//   node scripts/pull-sample.js [skill] [days] [count]
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { listRuns } from '../server/runs.js';
import { getSessionBundle } from '../server/admin.js';
import { normalizeSession } from '../server/normalize.js';
import { getGenerationTrace } from '../server/temporal.js';

const [skill = 'wixel-ads', days = '7', count = '50'] = process.argv.slice(2);
const N = Number(count);

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]).catch((err) => ({ error: String(err.message || err) }));
    }
  }));
  return out;
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const t0 = Date.now();

const { runs } = await listRuns({ skill, days: Number(days) });
console.log(`list: ${runs.length} ${skill} runs in ${days}d (${Date.now() - t0}ms)`);

// Mostly runs that generated something, spread over the window, plus some that didn't.
const withGen = runs.filter((r) => r.generations > 0 && Date.now() - r.lastAt > 30 * 60000);
const without = runs.filter((r) => !r.generations);
const pick = (arr, k) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / k)) === 0).slice(0, k);
const sample = [...pick(withGen, Math.round(N * 0.8)), ...pick(without, N - Math.round(N * 0.8))];
console.log(`sample: ${sample.length} (${withGen.length} with generations available, ${without.length} without)`);

let t = Date.now();
const records = await mapLimit(sample, 4, async (r) => normalizeSession(await getSessionBundle(r.id)));
console.log(`sessions: ${records.length} fetched in ${Date.now() - t}ms`);

t = Date.now();
const gens = records.flatMap((rec) => (rec.steps || []).filter((s) => s.workflowId).map((s) => ({ rec: rec.id, step: s })));
const traces = await mapLimit(gens, 3, async (g) => ({ ...g, trace: await getGenerationTrace(g.step.workflowId) }));
console.log(`traces: ${traces.length} generations traced in ${Date.now() - t}ms`);

// ---- coverage ----
const ok = records.filter((r) => !r.error);
const gen = ok.filter((r) => r.generations > 0);
const has = (f) => ok.filter(f).length;
const hasG = (f) => gen.filter(f).length;
const lines = [
  ['sessions fetched', ok.length, sample.length],
  ['prompt', has((r) => r.prompt), ok.length],
  ['user email', has((r) => r.user?.email), ok.length],
  ['codex version', has((r) => r.codexVersionIds.length), ok.length],
  ['scraped website', has((r) => r.scraped), ok.length],
  ['  scraped colours', has((r) => r.scraped?.colors.length), has((r) => r.scraped)],
  ['  scraped fonts', has((r) => r.scraped?.fonts.length), has((r) => r.scraped)],
  ['  scraped screenshot', has((r) => r.scraped?.screenshot), has((r) => r.scraped)],
  ['brief (ask_user)', has((r) => r.brief), ok.length],
  ['errors (any)', has((r) => r.errors.length), ok.length],
  ['— with generations —', gen.length, ok.length],
  ['root ad asset', hasG((r) => r.outputs), gen.length],
  ['  scenes with clip', hasG((r) => r.outputs?.scenes.some((s) => s.clipUrl)), gen.length],
  ['  thumbnails', hasG((r) => r.outputs?.thumbnailUrl), gen.length],
  ['generated images', hasG((r) => r.images.length), gen.length],
];
const trOk = traces.filter((x) => x.trace && !x.trace.error);
const runsAll = trOk.flatMap((x) => x.trace.graphRuns || []);
const children = runsAll.flatMap((g) => g.children || []);
const conf = children.reduce((m, c) => ((m[c.matchConfidence || 'unmatched'] = (m[c.matchConfidence || 'unmatched'] || 0) + 1), m), {});
lines.push(
  ['— Temporal —', traces.length, traces.length],
  ['trace fetched', trOk.length, traces.length],
  ['  chain found', trOk.filter((x) => x.trace.chain.length).length, trOk.length],
  ['  graph spec present', runsAll.filter((g) => g.graph?.nodes?.length).length, runsAll.length],
  ['  node timings', children.filter((c) => c.durationMs != null).length, children.length],
  ['  node matched to spec', children.filter((c) => c.nodeId).length, children.length],
  ['  generations failed', trOk.filter((x) => x.trace.graphRuns.some((g) => g.status !== 'COMPLETED') || x.trace.wrapperErrors).length, trOk.length],
);
console.log('\ncoverage');
for (const [k, a, b] of lines) console.log(`  ${k.padEnd(26)} ${String(a).padStart(4)} / ${String(b).padEnd(4)} ${pct(a, b)}`);
console.log(`  node match confidence      ${JSON.stringify(conf)}`);

// Where the time goes, across the sample.
const cat = {};
for (const r of gen) for (const [k, v] of Object.entries(r.timing.byCategory)) (cat[k] ??= []).push(v);
const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('\nmedian time per category per run (s)');
for (const [k, v] of Object.entries(cat).sort((a, b) => median(b[1]) - median(a[1]))) console.log(`  ${k.padEnd(10)} ${(median(v) / 1000).toFixed(1)}`);

const byType = {};
for (const c of children) (byType[c.workflowType] ??= []).push(c.durationMs || 0);
console.log('\nslowest graph node types (median s, n)');
for (const [k, v] of Object.entries(byType).sort((a, b) => median(b[1]) - median(a[1])).slice(0, 10)) console.log(`  ${k.padEnd(36)} ${(median(v) / 1000).toFixed(1).padStart(6)}  ${v.length}`);

const errs = {};
for (const r of ok) for (const e of r.errors) {
  const sig = `${e.tool || e.source}${e.method ? `:${e.method}` : ''} — ${String(e.message).replace(/[0-9a-f-]{8,}/gi, '…').slice(0, 70)}`;
  errs[sig] = (errs[sig] || 0) + 1;
}
console.log('\ntop error signatures');
for (const [k, v] of Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v).padStart(3)}  ${k}`);

await fs.writeFile(path.join(config.cacheDir, 'sample.json'), JSON.stringify({ skill, days, ids: sample.map((r) => r.id) }, null, 2));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s; sample ids in .cache/sample.json`);
process.exit(0);
