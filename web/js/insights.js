import { h, icon, dur, fmtInt, ago } from './util.js';
import { hasAd, failedRun, downloaded, worstMood, MOOD, stepKey } from './filters.js';

// Insights over the runs in view (skill + window + filters + search). Everything is computed in
// the browser from data the list already carries — no extra load on any upstream system.

// ---------- categories (mirrors server/normalize.js) ----------
const METHOD_CATEGORY = [
  [/^generateVideo|^holdStillAsVideo|^transformVideo|^generateAvatarTake|LogoShot|^StartAnimation|^EndAnimation|^GenerateSlideAnimation/, 'video'],
  // audio before tts: mergeVoiceIntoVideo is a mix step, not speech generation
  [/^generateMusic|^trimAudioClip|^mergeVoiceIntoVideo/, 'audio'],
  [/Speech|Voice|^TranscribeVoiceover/, 'tts'],
  [/Image|Cover|^upscale|^enhance|^generateHDR|^removeImageBackground|^smartBreakdown|^composeImage|^extractFirstFrame|Icon|Logo/, 'image'],
  [/Brand|^GetSiteBrand/, 'brand'],
  [/^DescribeVideoUrls|^probeMediaDuration|^getSubjectBounds/, 'analysis'],
  [/^ListCosts|^GetMax|^Eligible|^ListVoices|^list_rpc_methods/, 'lookup'],
];
const TOOL_CATEGORY = { generate_image: 'image', edit_image: 'image', convert_image_format: 'image', scrape_url: 'scrape', call_wix_site_api: 'scrape', analyze_image: 'analysis', analyze_video: 'analysis', download: 'export' };
export function category(tool, method) {
  if (tool === 'invoke_rpc' && method) {
    for (const [re, c] of METHOD_CATEGORY) if (re.test(method)) return c;
    return 'rpc';
  }
  return TOOL_CATEGORY[tool] || 'agent';
}
// Steps that call a generative model (not utilities like trim / merge / convert / probe).
const isModelStep = (tool, method) => tool === 'generate_image' || tool === 'edit_image'
  || (tool === 'invoke_rpc' && /^generate|^holdStill|LogoShot|^transformVideo|Speech|^CloneVoice|^upscale|^enhance|Animation$/.test(method || '') && !/^generateContentByProject/.test(method || ''));
// Category marks carry identity in a table next to a text label, so they take the palette's
// categorical order (never status colors).
export const CAT_COLOR = { video: '#3987e5', image: '#d95926', tts: '#199e70', audio: '#c98500', scrape: '#d55181', analysis: '#9085e9', brand: '#008300', export: '#e66767', lookup: '#6d747d', rpc: '#6d747d', agent: '#6d747d' };
export const CAT_LABEL = { video: 'Video', image: 'Image', tts: 'Voice / TTS', audio: 'Audio', scrape: 'Website scrape', analysis: 'Analysis', brand: 'Brand', export: 'Export', lookup: 'Lookups', rpc: 'Other RPC', agent: 'Agent tools' };


// ---------- stats helpers ----------
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const share = (a, b) => (b ? a / b : null);
const pc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const money = (x) => (x == null ? '–' : x < 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(x < 10 ? 2 : 0)}`);

// Error text → signature, so the same failure groups across runs.
export function signature(msg) {
  return String(msg || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

// Subject words from session titles (generated per session, short, mostly English).
const STOP = new Set(('video videos ad ads promo promotional promotion commercial create creation make new for the a an of and or to in on with my your our at by from about is this that it be as '
  + 'website site web page reel reels clip clips spot short shorts social media post story stories teaser trailer launch showcase highlight highlights intro overview animated animation '
  + 'second seconds sec s min vertical horizontal square instagram tiktok youtube facebook business brand service services product products company marketing campaign content '
  + 'werbevideo vidéo vídeo video-ad promo-video — - – & | : / 1 2 3 4 5 6 7 8 9 10 15 20 30 45 60 9:16 16:9 '
  // common non-English title words (pt / es / fr / de / it / tr / he / pl / nl)
  + 'criar crear crea cria criação creación promocional promocionais promotionnelle promotionnel promozionale promosyon tanıtım videosu videos videó '
  + 'erstellen erstelle werbe für und mit para con per pour avec sur del los las les des une ein eine der die das el la le di da do dos das em um uma een voor '
  + 'plan format scenes scene maker style new-video שיווקי סרטון תדמית choose créer creer sito sitesi site-web edit project generator '
  + 'fewest longest budgets budget owns ref2vid test demo sample draft version copy untitled').split(' '));
function subjects(runs) {
  const counts = new Map();
  for (const r of runs) {
    const words = new Set(String(r.title || '').toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 2 && !STOP.has(w)));
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  }
  // A subject has to come from at least 3 runs; digits-only and single-script noise are dropped.
  return [...counts.entries()].filter(([w, n]) => n > 2 && !/^\d+$/.test(w)).sort((a, b) => b[1] - a[1]).slice(0, 24);
}

function normPrompt(p) {
  return String(p || '')
    .replace(/<hidden>[\s\S]*?(<\/hidden>|$)/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// ---------- compute ----------
export function computeInsights(runs) {
  const withSteps = runs.filter((r) => r.steps);
  const reached = runs.filter((r) => r.generations > 0);
  const finished = runs.filter(hasAd);
  const finishedOfReached = reached.filter(hasAd);
  const failed = runs.filter(failedRun);
  const dl = finished.filter(downloaded);
  const pub = finished.filter((r) => r.publishedUrl);

  const toFirst = runs.filter((r) => r.requestAt && r.firstGenAt).map((r) => r.firstGenAt - r.requestAt).filter((x) => x >= 0);
  const toFinal = finished.filter((r) => r.requestAt && r.finalAt).map((r) => r.finalAt - r.requestAt).filter((x) => x >= 0);
  const firstTurn = runs.filter((r) => r.requestAt && r.firstTurnDoneAt).map((r) => r.firstTurnDoneAt - r.requestAt).filter((x) => x >= 0);

  // Tools / methods / models
  const tools = new Map();
  const models = new Map();
  const catTime = new Map();
  const errs = new Map();
  for (const r of withSteps) {
    const runKeys = new Set();
    const runCat = new Map();
    for (const [tool, method, model, n, e, ms, maxMs, err] of r.steps) {
      const key = stepKey(tool, method);
      const cat = category(tool, method);
      let t = tools.get(key);
      if (!t) tools.set(key, (t = { key, tool, method, cat, calls: 0, fails: 0, ms: 0, maxMs: 0, runs: 0, failRuns: 0, samples: [] }));
      t.calls += n;
      t.fails += e;
      t.ms += ms;
      t.maxMs = Math.max(t.maxMs, maxMs);
      if (!runKeys.has(key)) {
        runKeys.add(key);
        t.runs++;
        if (e) t.failRuns++;
      }
      runCat.set(cat, (runCat.get(cat) || 0) + ms);
      if (isModelStep(tool, method)) {
        // Failed image calls never report a model; don't let that read as "this model always fails".
        const mkey = model ? `${key} · ${model}` : tool === 'invoke_rpc' ? key : `${key} · model not reported${e === n ? ' (failed calls)' : ''}`;
        let m = models.get(mkey);
        if (!m) models.set(mkey, (m = { key: mkey, step: key, cat, calls: 0, fails: 0, ms: 0, perCall: [] }));
        m.calls += n;
        m.fails += e;
        m.ms += ms;
        if (n) m.perCall.push(ms / n);
      }
      if (e && err) {
        const sig = signature(err);
        let s = errs.get(sig);
        if (!s) errs.set(sig, (s = { sig, example: err, step: key, count: 0, runs: new Set() }));
        s.count += e;
        s.runs.add(r.id);
      }
    }
    for (const [c, ms] of runCat) {
      if (!catTime.has(c)) catTime.set(c, []);
      catTime.get(c).push(ms);
    }
  }
  const genCalls = [...models.values()].reduce((a, m) => a + m.calls, 0);
  const genMs = [...models.values()].reduce((a, m) => a + m.ms, 0);

  // Intents and subjects
  const intents = new Map();
  for (const r of runs) if (r.intent) intents.set(r.intent, (intents.get(r.intent) || 0) + 1);

  // Repeated requests: same normalized prompt; distinct users tells retry vs template/API.
  const reps = new Map();
  for (const r of runs) {
    const k = normPrompt(r.prompt);
    if (k.length < 12) continue;
    let g = reps.get(k);
    if (!g) reps.set(k, (g = { key: k, prompt: r.prompt, runs: [], users: new Set() }));
    g.runs.push(r);
    g.users.add(r.userId || r.accountId);
  }
  const repeated = [...reps.values()].filter((g) => g.runs.length > 1).sort((a, b) => b.runs.length - a.runs.length);

  // Mood + feedback
  const moodCounts = { frustrated: 0, confused: 0, positive: 0, neutral: 0, none: 0 };
  for (const r of runs) moodCounts[worstMood(r) || 'none']++;
  const tags = new Map();
  for (const r of runs) for (const t of r.feedbackTags || []) for (const x of String(t).split(',')) tags.set(x.trim(), (tags.get(x.trim()) || 0) + 1);
  const quotes = runs.filter((r) => r.sentimentDetail && (r.sentiments || []).some((s) => s === 'frustrated' || s === 'confused')).sort((a, b) => b.createdAt - a.createdAt);

  // Daily trend
  const byDay = new Map();
  for (const r of runs) {
    const d = new Date(r.createdAt).toISOString().slice(0, 10);
    const x = byDay.get(d) || { day: d, finished: 0, failed: 0, none: 0 };
    if (hasAd(r)) x.finished++;
    else if (failedRun(r)) x.failed++;
    else x.none++;
    byDay.set(d, x);
  }

  // Skill versions (the last codex version a run used)
  const versions = new Map();
  for (const r of runs) {
    const v = (r.codexVersions || []).at(-1);
    if (!v) continue;
    const x = versions.get(v) || { v, runs: [], first: Infinity };
    x.runs.push(r);
    x.first = Math.min(x.first, r.createdAt);
    versions.set(v, x);
  }

  const cost = runs.reduce((a, r) => a + (r.costUsd || 0), 0);
  return {
    n: runs.length, withSteps: withSteps.length, reached, finished, finishedOfReached, failed, dl, pub,
    toFirst, toFinal, firstTurn,
    tools: [...tools.values()], models: [...models.values()], genCalls, genMs,
    catTime, errs: [...errs.values()].sort((a, b) => b.runs.size - a.runs.size),
    intents: [...intents.entries()].sort((a, b) => b[1] - a[1]), subjects: subjects(runs),
    repeated, moodCounts, tags: [...tags.entries()].sort((a, b) => b[1] - a[1]), quotes,
    thumbsUp: runs.reduce((a, r) => a + (r.thumbsUp || 0), 0), thumbsDown: runs.reduce((a, r) => a + (r.thumbsDown || 0), 0),
    outOfFunds: runs.filter((r) => r.outOfFunds).length, streamErr: runs.filter((r) => r.streamErrors || r.llmErrors).length,
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    versions: [...versions.values()].sort((a, b) => b.runs.length - a.runs.length),
    cost, costPerFinished: finished.length ? cost / finished.length : null,
    employees: runs.filter((r) => r.userType === 'employee' || r.userType === 'wixel-team').length,
  };
}

// ---------- headline strip (above the grid) ----------
export function headlines(ins, go) {
  if (!ins.n) return [];
  const out = [];
  const worstTool = [...ins.tools].filter((t) => t.fails >= 3).sort((a, b) => b.fails - a.fails)[0];
  if (worstTool) out.push(h('button', { class: 'headline', onclick: () => go('tools') }, icon('alert'), 'Most failures', h('b', {}, worstTool.key), `${fmtInt(worstTool.fails)} of ${fmtInt(worstTool.calls)}`));
  if (ins.toFinal.length) out.push(h('button', { class: 'headline', onclick: () => go('timing') }, icon('film'), 'Request → final', h('b', {}, dur(pct(ins.toFinal, 50))), 'median'));
  if (ins.genCalls) out.push(h('button', { class: 'headline', onclick: () => go('models') }, icon('sparkle'), 'Avg generation', h('b', {}, dur(ins.genMs / ins.genCalls)), 'per call'));
  if (ins.intents[0]) out.push(h('button', { class: 'headline', onclick: () => go('asks') }, icon('user'), 'Top ask', h('b', {}, ins.intents[0][0]), pc(share(ins.intents[0][1], ins.n))));
  const fr = ins.moodCounts.frustrated;
  if (fr) out.push(h('button', { class: 'headline', onclick: () => go('mood') }, icon('frustrated'), h('b', {}, pc(share(fr, ins.n))), 'frustrated'));
  if (ins.finished.length) out.push(h('button', { class: 'headline', onclick: () => go('funnel') }, icon('download'), h('b', {}, pc(share(ins.dl.length + ins.pub.filter((r) => !downloaded(r)).length, ins.finished.length))), 'of finished videos were used'));
  return out;
}

// ---------- render ----------
let tip;
function tooltip(el, text) {
  el.addEventListener('pointerenter', () => {
    tip ??= document.body.appendChild(h('div', { class: 'tip', hidden: true }));
    tip.textContent = typeof text === 'function' ? text() : text;
    tip.hidden = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (!tip) return;
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  el.addEventListener('pointerleave', () => tip && (tip.hidden = true));
  return el;
}

function card(id, title, desc, ...body) {
  return h('section', { class: `ins-card${id === 'overview' || id === 'tools' ? ' wide' : ''}`, id: `ins-${id}` }, h('h3', {}, title), desc ? h('p', { class: 'desc' }, desc) : null, ...body);
}

function tile(v, k, x) {
  return h('div', { class: 'tile' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k), x ? h('div', { class: 'x' }, x) : null);
}

function barList(rows, { max, fmt = fmtInt, onClick, tipText }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'bars' }, rows.map((r) => tooltip(h('div', { class: 'bar-row', onclick: () => onClick?.(r) },
    h('span', { class: 'lbl', title: r.label }, r.label, r.sub ? h('small', {}, r.sub) : null),
    h('span', { class: 'track' }, h('span', { class: 'fill', style: { width: `${(r.value / top) * 100}%`, background: r.color || 'var(--viz-seq)' } })),
    h('span', { class: 'val' }, fmt(r.value))), tipText ? tipText(r) : `${r.label}: ${fmt(r.value)}`)));
}

const toolSort = { key: 'fails' };
function toolsTable(ins, act) {
  const cols = [
    ['key', 'Tool / method'], ['calls', 'Calls'], ['fails', 'Failures'], ['rate', 'Fail rate'], ['avg', 'Avg time'], ['maxMs', 'Slowest'], ['failRuns', 'Runs hit'],
  ];
  const rows = ins.tools.map((t) => ({ ...t, rate: t.calls ? t.fails / t.calls : 0, avg: t.calls ? t.ms / t.calls : 0 }));
  // Name sorts A→Z; every numeric column sorts biggest first.
  rows.sort((a, b) => (toolSort.key === 'key' ? a.key.localeCompare(b.key) : b[toolSort.key] - a[toolSort.key] || b.calls - a.calls));
  const maxAvg = Math.max(1, ...rows.map((r) => r.avg));
  const table = h('table', { class: 'ins' },
    h('thead', {}, h('tr', {}, cols.map(([k, label]) => h('th', { class: toolSort.key === k ? 'on' : '', onclick: () => { toolSort.key = k; act.rerender(); } }, label)))),
    h('tbody', {}, rows.slice(0, act.expanded?.tools ? 200 : 14).map((t) => tooltip(h('tr', { onclick: () => act.filterStep(t.key, t.fails > 0) },
      h('td', { title: t.key }, h('span', { class: 'cat', style: { background: CAT_COLOR[t.cat] } }), t.key),
      h('td', {}, fmtInt(t.calls)),
      h('td', {}, t.fails ? fmtInt(t.fails) : '–'),
      h('td', {}, h('span', { class: 'minibar' }, t.fails ? h('i', { style: { width: `${Math.max(2, t.rate * 60)}px`, background: 'var(--viz-crit)' } }) : null, pc(t.rate))),
      h('td', {}, h('span', { class: 'minibar' }, h('i', { style: { width: `${Math.max(2, (t.avg / maxAvg) * 60)}px`, background: 'var(--viz-seq)' } }), dur(t.avg))),
      h('td', {}, dur(t.maxMs)),
      h('td', {}, fmtInt(t.failRuns))),
    `${t.key} (${CAT_LABEL[t.cat]})\n${fmtInt(t.calls)} calls in ${fmtInt(t.runs)} runs\n${fmtInt(t.fails)} failures (${pc(t.rate)}) in ${fmtInt(t.failRuns)} runs\navg ${dur(t.avg)} · slowest ${dur(t.maxMs)}\nClick to see the runs${t.fails ? ' where it failed' : ''}`))),
  );
  const legend = h('div', { class: 'legend', style: { marginTop: '10px' } }, Object.entries(CAT_LABEL).filter(([c]) => rows.some((r) => r.cat === c)).map(([c, l]) => h('span', {}, h('i', { style: { background: CAT_COLOR[c] } }), l)));
  const more = rows.length > 14 ? h('button', { class: 'linkish', onclick: () => { act.expanded.tools = !act.expanded.tools; act.rerender(); } }, act.expanded.tools ? 'Show fewer' : `Show all ${rows.length}`) : null;
  return [table, more, legend];
}

export function renderInsights(root, ins, act) {
  if (!ins.n) {
    root.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'No runs in view'), h('p', {}, 'Insights follow the skill, window, filters and search.')));
    return;
  }
  const p50 = (a) => dur(pct(a, 50));
  const p90 = (a) => dur(pct(a, 90));
  const partial = ins.withSteps < ins.n ? ` Step data covers ${fmtInt(ins.withSteps)} of ${fmtInt(ins.n)} runs so far.` : '';

  // Overview tiles
  const overview = card('overview', 'Overview', `${fmtInt(ins.n)} runs in view — every number follows the skill, window, filters and search.${partial}`,
    h('div', { class: 'tiles' },
      tile(pc(share(ins.finishedOfReached.length, ins.reached.length)), 'Finished-video rate', `${fmtInt(ins.finishedOfReached.length)} of ${fmtInt(ins.reached.length)} that generated`),
      tile(p50(ins.toFinal), 'Request → final video', `median · p90 ${p90(ins.toFinal)}`),
      tile(p50(ins.toFirst), 'Request → first clip', `median · p90 ${p90(ins.toFirst)}`),
      tile(ins.genCalls ? dur(ins.genMs / ins.genCalls) : '–', 'Avg generation call', `${fmtInt(ins.genCalls)} calls`),
      tile(pc(share(ins.dl.length, ins.finished.length)), 'Downloaded', `${fmtInt(ins.dl.length)} of ${fmtInt(ins.finished.length)} finished`),
      tile(pc(share(ins.pub.length, ins.finished.length)), 'Published', `${fmtInt(ins.pub.length)} of ${fmtInt(ins.finished.length)} finished`),
      tile(pc(share(ins.moodCounts.frustrated, ins.n)), 'Had a frustrated turn', `${fmtInt(ins.moodCounts.frustrated)} runs`),
      tile(money(ins.costPerFinished), 'Cost per finished video', `${money(ins.cost)} total`),
    ));

  // Funnel (ordinal blue ramp)
  const steps = [
    ['Loaded the skill', ins.n, null],
    ['Reached generation', ins.reached.length, ['outcome', 'video']],
    ['Finished video', ins.finishedOfReached.length, ['outcome', 'video']],
    ['Downloaded', ins.dl.length, ['delivery', 'downloaded']],
    ['Published', ins.pub.length, ['delivery', 'published']],
  ];
  const ramp = ['#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
  const funnel = card('funnel', 'Funnel', 'Where runs drop off. Each step is a share of the one before it.',
    barList(steps.map(([label, value, f], i) => ({ label, value, f, color: ramp[i], sub: i ? pc(share(value, steps[i - 1][1])) : null })), {
      max: ins.n, onClick: (r) => r.f && act.filter(...r.f), tipText: (r) => `${r.label}: ${fmtInt(r.value)} (${pc(share(r.value, ins.n))} of all runs)`,
    }));

  // Timing
  const cats = [...ins.catTime.entries()].map(([c, arr]) => ({ label: CAT_LABEL[c] || c, value: pct(arr, 50), color: CAT_COLOR[c], n: arr.length })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const timing = card('timing', 'Where the time goes', 'Median time per run spent in each kind of step (tool time; model thinking time not included).',
    barList(cats, { fmt: dur, tipText: (r) => `${r.label}: median ${dur(r.value)} per run (in ${fmtInt(r.n)} runs)` }),
    h('div', { class: 'tiles', style: { marginTop: '12px' } },
      tile(p50(ins.firstTurn), 'First turn', `median · p90 ${p90(ins.firstTurn)}`),
      tile(p50(ins.toFirst), 'Until first clip', `median · p90 ${p90(ins.toFirst)}`),
      tile(p50(ins.toFinal), 'Until final video', `median · p90 ${p90(ins.toFinal)}`)));

  // Tools table (wide)
  const tools = card('tools', 'Tools & methods', 'Every tool call in these runs. Sort by any column; click a row to see the runs where it failed.', ...toolsTable(ins, act));

  // Generation models
  const models = [...ins.models].map((m) => ({ ...m, rate: m.calls ? m.fails / m.calls : 0, avg: m.calls ? m.ms / m.calls : 0 })).sort((a, b) => b.calls - a.calls).slice(0, 12);
  const modelsCard = card('models', 'Generation models', 'Media generation calls by method / model: how long each call takes, and how often it fails.',
    h('table', { class: 'ins' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Model / method'), h('th', {}, 'Calls'), h('th', {}, 'Avg'), h('th', {}, 'p90'), h('th', {}, 'Fail rate'))),
      h('tbody', {}, models.map((m) => tooltip(h('tr', { onclick: () => act.filterStep(m.step, m.fails > 0) },
        h('td', { title: m.key }, h('span', { class: 'cat', style: { background: CAT_COLOR[m.cat] } }), m.key),
        h('td', {}, fmtInt(m.calls)), h('td', {}, dur(m.avg)), h('td', {}, dur(pct(m.perCall, 90))),
        h('td', {}, h('span', { class: 'minibar' }, m.fails ? h('i', { style: { width: `${Math.max(2, m.rate * 60)}px`, background: 'var(--viz-crit)' } }) : null, m.fails ? `${pc(m.rate)} (${m.fails})` : '0%'))),
      `${m.key}\n${fmtInt(m.calls)} calls · avg ${dur(m.avg)} · p90 ${dur(pct(m.perCall, 90))}\n${fmtInt(m.fails)} failed`)))));

  // Errors
  const errors = card('errors', 'Top errors', 'Failures grouped by message (ids and numbers masked), by how many runs they hit.',
    ins.errs.length ? barList(ins.errs.slice(0, 10).map((e) => ({ label: e.sig, sub: e.step, value: e.runs.size, color: 'var(--viz-crit)', e })), {
      onClick: (r) => act.search(r.e.sig.replace(/<\w+>|N/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(' ')),
      tipText: (r) => `${r.e.step}\n${r.e.example}\n\n${fmtInt(r.e.count)} failures in ${fmtInt(r.e.runs.size)} runs · click to search`,
    }) : h('p', { class: 'desc' }, 'No tool errors in these runs.'));

  // What users asked for
  const asks = card('asks', 'What users asked for', 'Classified intent of the first turn, and the most common subjects in session titles.',
    ins.intents.length ? barList(ins.intents.slice(0, 8).map(([label, value]) => ({ label, value })), { onClick: (r) => act.search(r.label) }) : h('p', { class: 'desc' }, 'No intent data.'),
    ins.subjects.length ? h('div', { style: { marginTop: '12px' } }, h('p', { class: 'desc' }, 'Subjects (click to search)'),
      h('div', { class: 'chips-cloud' }, ins.subjects.map(([w, n]) => h('button', { onclick: () => act.search(w) }, w, h('small', {}, n))))) : null);

  // Repeated requests
  const rep = card('repeats', 'Most repeated requests', 'Identical prompts. Many users = a template or API caller; one user = retrying.',
    ins.repeated.length ? h('div', {}, ins.repeated.slice(0, 7).map((g) => tooltip(h('div', { class: 'rep', onclick: () => act.search(normPrompt(g.prompt).split(' ').slice(0, 6).join(' ')) },
      h('span', { class: 't' }, g.prompt.replace(/<HIDDEN>[\s\S]*/i, '').trim() || g.prompt),
      h('span', { class: 'n' }, `${g.runs.length}× · ${g.users.size} user${g.users.size > 1 ? 's' : ''}`)),
    `${g.runs.length} runs, ${g.users.size} distinct users\n${g.runs.filter(hasAd).length} finished · ${g.runs.filter(failedRun).length} failed\nlast ${ago(Math.max(...g.runs.map((r) => r.createdAt)))} · click to search`))) : h('p', { class: 'desc' }, 'No repeated prompts.'));

  // Mood & feedback
  const moodOrder = ['frustrated', 'confused', 'neutral', 'positive', 'none'];
  const moodColor = { frustrated: 'var(--viz-crit)', confused: 'var(--viz-warn)', neutral: 'var(--viz-none)', positive: 'var(--viz-good)', none: 'var(--surface-3)' };
  const moodLabel = { ...Object.fromEntries(Object.entries(MOOD).map(([k, v]) => [k, v.label])), none: 'No analysis' };
  const mood = card('mood', 'User mood & feedback', 'Worst mood across each run’s turns, explicit thumbs, and why users were unhappy.',
    h('div', { class: 'stack' }, moodOrder.filter((m) => ins.moodCounts[m]).map((m) => tooltip(h('span', { style: { flex: ins.moodCounts[m], background: moodColor[m], cursor: m === 'none' ? 'default' : 'pointer' }, onclick: () => m !== 'none' && act.filter('mood', m) }),
      `${moodLabel[m]}: ${fmtInt(ins.moodCounts[m])} runs (${pc(share(ins.moodCounts[m], ins.n))})`))),
    h('div', { class: 'legend' }, moodOrder.filter((m) => ins.moodCounts[m]).map((m) => h('span', {}, h('i', { style: { background: moodColor[m] } }), `${moodLabel[m]} ${pc(share(ins.moodCounts[m], ins.n))}`))),
    h('div', { class: 'pills', style: { margin: '12px 0' } },
      h('span', { class: 'pill ok' }, icon('up', 'sm'), `${fmtInt(ins.thumbsUp)} thumbs up`),
      h('span', { class: 'pill err' }, icon('down', 'sm'), `${fmtInt(ins.thumbsDown)} thumbs down`),
      ...ins.tags.slice(0, 6).map(([t, n]) => h('span', { class: 'pill' }, `${t} ×${n}`)),
      ins.outOfFunds ? h('span', { class: 'pill warn' }, icon('card', 'sm'), `${fmtInt(ins.outOfFunds)} runs out of credits`) : null),
    ins.quotes.length ? h('div', { class: 'quotes' }, ins.quotes.slice(0, 6).map((r) => h('div', { class: 'quote', onclick: () => act.open(r.id) }, `“${r.sentimentDetail}”`,
      h('small', {}, `${r.title || 'Untitled'} · ${ago(r.createdAt)} · ${r.sentiments.includes('frustrated') ? 'frustrated' : 'confused'}`)))) : null);

  // Daily trend: stacked columns (status colors carry state, legend + tooltip carry labels)
  const maxDay = Math.max(1, ...ins.days.map((d) => d.finished + d.failed + d.none));
  const trend = card('trend', 'Runs per day', 'Stacked by outcome. Hover a day for the numbers.',
    h('div', { class: 'cols' }, ins.days.map((d) => tooltip(h('div', { class: 'col' },
      h('span', { style: { height: `${(d.finished / maxDay) * 100}%`, background: 'var(--viz-good)' } }),
      h('span', { style: { height: `${(d.failed / maxDay) * 100}%`, background: 'var(--viz-crit)' } }),
      h('span', { style: { height: `${(d.none / maxDay) * 100}%`, background: 'var(--viz-none)' } })),
    `${d.day}\n${fmtInt(d.finished + d.failed + d.none)} runs\n${fmtInt(d.finished)} finished · ${fmtInt(d.failed)} generated, no video · ${fmtInt(d.none)} never generated`))),
    h('div', { class: 'col-axis' }, ins.days.map((d, i) => h('span', {}, i === 0 || i === ins.days.length - 1 || ins.days.length < 10 ? d.day.slice(5) : ''))),
    h('div', { class: 'legend', style: { marginTop: '8px' } }, h('span', {}, h('i', { style: { background: 'var(--viz-good)' } }), 'Finished video'), h('span', {}, h('i', { style: { background: 'var(--viz-crit)' } }), 'Generated, no video'), h('span', {}, h('i', { style: { background: 'var(--viz-none)' } }), 'Never generated')));

  // Skill versions
  const vers = card('versions', 'Skill versions', 'Outcomes by the skill (codex) version each run used — did a change help?',
    ins.versions.length ? h('table', { class: 'ins' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'Runs'), h('th', {}, 'Finished'), h('th', {}, 'Frustrated'), h('th', {}, 'Median to final'))),
      h('tbody', {}, ins.versions.slice(0, 6).map((v) => {
        const gen = v.runs.filter((r) => r.generations > 0);
        const fin = v.runs.filter(hasAd);
        const tf = fin.filter((r) => r.requestAt && r.finalAt).map((r) => r.finalAt - r.requestAt);
        return h('tr', { onclick: () => act.search(v.v) },
          h('td', { title: v.v, class: 'mono' }, `${v.v.slice(0, 8)} · ${new Date(v.first).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`),
          h('td', {}, fmtInt(v.runs.length)), h('td', {}, pc(share(fin.length, gen.length))),
          h('td', {}, pc(share(v.runs.filter((r) => r.sentiments?.includes('frustrated')).length, v.runs.length))), h('td', {}, dur(pct(tf, 50))));
      }))) : h('p', { class: 'desc' }, 'No version data.'));

  root.replaceChildren(h('p', { class: 'ins-note' }, `Insights for ${act.label()}. Click anything to filter the videos.`),
    h('div', { class: 'ins-grid' }, overview, tools, funnel, timing, modelsCard, errors, asks, rep, mood, trend, vers));
  if (act.scrollTo) root.querySelector(`#ins-${act.scrollTo}`)?.scrollIntoView({ block: 'start' });
}
