import { h, icon, dur, fmtInt, ago } from './util.js';
import { hasAd, failedRun, attempted, downloaded, worstMood, MOOD, stepKey, getProfile, typeLabel, madeLabel, STOPS } from './filters.js';
import { timeBar, averageTime, TIME_PARTS } from './timebar.js';
import { modelStats, money } from './models.js';

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
export const CAT_COLOR = { video: '#3987e5', image: '#d95926', tts: '#199e70', audio: '#c98500', scrape: '#d55181', analysis: '#9085e9', brand: '#008300', export: '#e66767', assets: '#1fb5c7', lookup: '#6d747d', rpc: '#6d747d', agent: '#6d747d' };
export const CAT_LABEL = { video: 'Video', image: 'Image', tts: 'Voice / TTS', audio: 'Audio', scrape: 'Website scrape', analysis: 'Analysis', brand: 'Brand', export: 'Export', assets: 'Saving assets', lookup: 'Lookups', rpc: 'Other RPC', agent: 'Agent tools' };


// ---------- stats helpers ----------
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const share = (a, b) => (b ? a / b : null);
const pc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

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
  + 'fewest longest budgets budget owns ref2vid test demo sample draft version copy untitled '
  + 'https http www com net org io wix wixel html image images agent provider provider\'s filter session reword refused once stop one not which what when where who how why '
  + 'all any are but can could did does done each few had has have her him his its just may more most much must now only other our out over own same she should some such than then there these they those too very was were will would you').split(' '));
function subjects(runs) {
  const counts = new Map();
  for (const r of runs) {
    const words = new Set(String(r.title || '').toLowerCase().split(/[^\p{L}\p{N}']+/u)
      .filter((w) => w.length > 2 && !STOP.has(w) && !/\d/.test(w) && !/^[0-9a-f]{6,}$/.test(w)));
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
  // "Tried" = called something that makes an asset (media job, image tool, write) — works for any skill.
  const reached = runs.filter(attempted);
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
    modelRows: modelStats(withSteps.map((r) => r.steps)),
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
    profile: getProfile(),
  };
}

// ---------- what we learned: the numbers, read ----------
// Findings worth knowing, each a sentence with its evidence and a click that shows the runs.
// Measured facts only; where a reason is a reading of the data (a pattern, not a cause), it says so.
const P = (x) => `${Math.round(x * 100)}%`;
const enough = (n) => n >= 12;
export function learn(ins, runs) {
  const out = [];
  const add = (score, tone, title, detail, go) => out.push({ score, tone, title, detail, go });
  const n = ins.n;
  if (!n) return out;
  const made = madeLabel();
  // 1. Did it make what it's for?
  const tried = ins.reached.length;
  if (tried >= 5) {
    const rate = ins.finishedOfReached.length / tried;
    add(rate < 0.6 ? 90 : 40, rate < 0.6 ? 'bad' : 'good', [h('b', {}, P(rate)), ` of runs that tried made ${/^[aeiou]/.test(made) ? 'an' : 'a'} ${made}`],
      `${ins.finishedOfReached.length} of ${tried} tried; ${ins.failed.length} tried and made nothing.`, { filter: ['outcome', 'failed'] });
  }
  // 2. Runs that never tried: who they are.
  const never = runs.filter((r) => !hasAd(r) && !attempted(r));
  if (enough(never.length) && never.length / n >= 0.15) {
    // Why, as the cards say it (server/runs.js stopReason): the reasons that cover at least a tenth.
    const kinds = new Map();
    for (const r of never) if (r.stop) kinds.set(r.stop.kind, (kinds.get(r.stop.kind) || 0) + 1);
    const why = [...kinds].filter(([, c]) => c / never.length >= 0.1).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, c]) => `${P(c / never.length)} ${(STOPS[k]?.label || k).toLowerCase()}`);
    add(70 + (never.length / n) * 40, 'bad', [h('b', {}, P(never.length / n)), ' of runs never tried to make anything'], why.length ? `Of those: ${why.join(', ')}.` : `${never.length} runs: they only planned, asked or answered.`, { filter: ['outcome', 'none'] });
  }
  // 3. Models: where the time and the money go.
  const gen = ins.modelRows.filter((m) => m.calls >= 3);
  const totalMs = gen.reduce((a, m) => a + m.ms, 0);
  const slow = [...gen].sort((a, b) => b.ms - a.ms)[0];
  if (slow && totalMs) add(60, 'info', [h('b', {}, slow.name), ` is ${P(slow.ms / totalMs)} of generation time: `, h('b', {}, dur(slow.avgMs)), ' a call', slow.avgCost != null ? [', ', h('b', {}, money(slow.avgCost)), ' a call'] : ''],
    `${slow.calls} calls in ${slow.runs} runs${slow.fails ? `, ${P(slow.failRate)} failed` : ''}. See Models for every model.`, { section: 'models' });
  const priced = gen.filter((m) => m.cost > 0);
  const totalCost = priced.reduce((a, m) => a + m.cost, 0);
  const dear = [...priced].sort((a, b) => b.cost - a.cost)[0];
  if (dear && dear !== slow && totalCost) add(50, 'info', [h('b', {}, dear.name), ` is ${P(dear.cost / totalCost)} of generation spend (`, h('b', {}, money(dear.avgCost)), ' a call)'], `${money(totalCost)} at list price across ${priced.length} priced models in view.`, { section: 'models' });
  // 4. The failure that costs the most output: runs it hit vs runs it didn't.
  const hit = [...ins.tools].filter((t) => t.failRuns >= 5 && t.fails >= 5).sort((a, b) => b.failRuns - a.failRuns)[0];
  if (hit) {
    const withF = runs.filter((r) => r.steps?.some((x) => stepKey(x[0], x[1]) === hit.key && x[4] > 0));
    const without = runs.filter((r) => r.steps && !withF.includes(r) && attempted(r));
    const rw = withF.filter(hasAd).length / Math.max(1, withF.length);
    const ro = without.filter(hasAd).length / Math.max(1, without.length);
    const hurts = enough(withF.length) && enough(without.length) && ro - rw >= 0.1;
    add(hurts ? 80 : 45, 'bad', [h('b', {}, hit.key), ` fails in ${hit.failRuns} runs (${P(hit.fails / hit.calls)} of its calls)`], hurts ? `Runs where it failed made ${/^[aeiou]/.test(made) ? 'an' : 'a'} ${made} ${P(rw)} of the time, against ${P(ro)} for the rest.` : 'The runs it hit made their output about as often as the rest: a retry usually gets past it.', { filterStep: hit.key });
  }
  // 5. Problems and the user's mood.
  const err = runs.filter((r) => r.errors > 0);
  const clean = runs.filter((r) => !r.errors);
  const fr = (xs) => xs.filter((r) => r.sentiments?.includes('frustrated')).length / Math.max(1, xs.length);
  if (enough(err.length) && enough(clean.length) && fr(err) >= 0.08 && fr(err) >= 1.5 * fr(clean)) add(55, 'bad', ['Users are ', h('b', {}, `${(fr(err) / Math.max(0.005, fr(clean))).toFixed(1)}×`), ' as likely to be frustrated when a tool fails'], `${P(fr(err))} frustrated in runs with tool errors, ${P(fr(clean))} without.`, { filter: ['issues', 'errors'] });
  // 6. The credit wall. Agents check the price and stop, mostly without an OUT_OF_FUNDS event, so the
  // runs that stopped there (stop.kind 'credits') count too. Some need more than the plan's daily limit:
  // for those, waiting until tomorrow wouldn't help either.
  const walled = (r) => r.outOfFunds > 0 || r.stop?.kind === 'credits';
  const broke = runs.filter(walled);
  if (enough(broke.length) && broke.length / n >= 0.08) {
    const capped = broke.filter((r) => r.stop?.dayCap);
    const cap = capped.length ? [...capped.reduce((m, r) => m.set(r.stop.dayCap, (m.get(r.stop.dayCap) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0] : null;
    const need = broke.map((r) => r.stop?.needed).filter(Boolean).sort((a, b) => a - b);
    const still = broke.filter(hasAd).length;
    add(65 + (broke.length / n) * 30, 'bad', [h('b', {}, P(broke.length / n)), ' of runs hit the credit wall'], [
      capped.length >= 3 ? `${P(capped.length / broke.length)} needed more than the plan's ${cap}-credit daily limit, so waiting a day wouldn't help.` : null,
      need.length >= 3 ? `They needed ${need[Math.floor(need.length / 2)]} credits (median).` : null,
      still ? `${still / broke.length < 0.05 ? `Only ${still}` : P(still / broke.length)} still made ${/^[aeiou]/.test(made) ? 'an' : 'a'} ${made} (often a cut-down one).` : 'None of them made anything.',
    ].filter(Boolean).join(' '), { filter: ['issues', 'credits'] });
  }
  // 7. Stalled on the request (the chat review's tested rule: ≥3 user messages, nothing made, no
  // credit wall, no tool error — about 7 in 10 of those were the request itself: beyond what the
  // skill can do, missing material, content policy, undecided).
  const stalled = runs.filter((r) => (r.userMessages || 0) >= 3 && !hasAd(r) && !walled(r) && !r.errors);
  if (stalled.length >= 3) add(45, 'info', [h('b', {}, String(stalled.length)), ` runs went ${Math.round(stalled.reduce((a, r) => a + r.userMessages, 0) / stalled.length)} messages without making anything, with no error or credit wall`], 'Usually the request itself (asks beyond the skill, missing material, content policy, undecided users) — about 7 in 10 such runs in a review of 18. Open them to read the conversation.', { search: null, ids: stalled.map((r) => r.id) });
  // 7b. Where the time goes: the biggest part beyond the agent's own work, when it's a big one.
  const avgTime = averageTime(runs);
  if (avgTime && avgTime.n >= 5) {
    const PHRASE = { errors: 'lost to failed calls and calls that gave up', waiting: 'spent waiting on the user', subagents: 'spent waiting on sub-agents', video: 'video generation', image: 'image generation', music: 'music generation', audio: 'voice generation', text: 'image and video analysis' };
    const ranked = Object.entries(avgTime.shares).filter(([k, v]) => k !== 'agent' && v > 0).sort((a, b) => b[1] - a[1]);
    const [k, v] = ranked[0] || [];
    if (k && v >= 0.15) {
      const bad = k === 'errors' || k === 'waiting';
      add(bad ? 62 + v * 30 : 38, bad ? 'bad' : 'info', [h('b', {}, P(v)), ` of a run's time is ${PHRASE[k]}`],
        `Across ${avgTime.n} runs (median ${dur(avgTime.medianSec * 1000)}): ${ranked.slice(0, 3).map(([x, y]) => `${TIME_PARTS[x].label.toLowerCase()} ${P(y)}`).join(', ')}, the agent itself ${P(avgTime.shares.agent || 0)}.`, { section: 'time' });
    }
  }
  // 8. Used or not.
  if (enough(ins.finished.length)) {
    const used = ins.finished.filter((r) => downloaded(r) || r.publishedUrl).length / ins.finished.length;
    add(35, used < 0.3 ? 'bad' : 'info', [h('b', {}, P(used)), ` of the ${madeLabel(true)} made were downloaded or published`], `${ins.dl.length} downloaded, ${ins.pub.length} published, of ${ins.finished.length}.`, { filter: ['delivery', 'neither'] });
  }
  // 9. How long it takes.
  if (ins.toFinal.length >= 5) add(30, 'info', ['Request → final result takes ', h('b', {}, dur(pct(ins.toFinal, 50))), ' (median)'], `The slowest 10% take over ${dur(pct(ins.toFinal, 90))}. First generation starts after ${dur(pct(ins.toFirst, 50))}.`, { section: 'timing' });
  // 10. A newer skill version doing better or worse.
  const vs = ins.versions.filter((v) => v.runs.length >= 25).sort((a, b) => b.first - a.first);
  if (vs.length >= 2) {
    const rate = (v) => v.runs.filter(attempted).filter(hasAd).length / Math.max(1, v.runs.filter(attempted).length);
    const d = rate(vs[0]) - rate(vs[1]);
    if (Math.abs(d) >= 0.1) add(60, d > 0 ? 'good' : 'bad', [`The newest skill version (${vs[0].v.slice(0, 8)}) makes output `, h('b', {}, `${d > 0 ? '+' : ''}${Math.round(d * 100)} pts`), ` ${d > 0 ? 'more' : 'less'} often`], `${P(rate(vs[0]))} vs ${P(rate(vs[1]))} for ${vs[1].v.slice(0, 8)} (${vs[0].runs.length} and ${vs[1].runs.length} runs).`, { section: 'versions' });
  }
  return out.sort((a, b) => b.score - a.score);
}

// The top finding, above the grid.
export function headlines(ins, go, runs) {
  if (!ins.n) return [];
  const top = learn(ins, runs || [])[0];
  if (!top) return [];
  return [h('button', { class: `headline ${top.tone}`, title: 'Insights: what the numbers say', onclick: () => go(top.go?.section || 'learned') }, icon('sparkle'), h('span', {}, ...[].concat(top.title)))];
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

// A run reference: a real link to the Wixel admin page (clicks in a PDF; anyone with BO access),
// which in the app opens the run here instead.
const ADMIN = 'https://wix-bo.com/wixel-agent/admin/#/sessions/';
function runLink(act, id, ...content) {
  return h('a', { class: 'run-link', href: ADMIN + id, target: '_blank', rel: 'noopener', onclick: (e) => { if (!act.print && !e.metaKey && !e.ctrlKey) { e.preventDefault(); act.open(id); } } }, ...content);
}

const errSearch = (e) => e.sig.replace(/<\w+>|N/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(' ');

// On paper (the PDF) what's clickable on screen becomes a real link into Autopsy: act.href(kind, …)
// (share.js) builds the view link — a search, a filter, a failing step, a finding's runs.
const paperHref = (act, ...args) => (act.print && act.href ? act.href(...args) : null);
const paperLink = (href, ...content) => (href ? h('a', { class: 'rp-go', href, target: '_blank', rel: 'noopener' }, ...content) : content);

function card(id, title, desc, ...body) {
  return h('section', { class: 'ins-card', id: `ins-${id}` }, h('h3', {}, title), desc ? h('p', { class: 'desc' }, desc) : null, ...body.filter(Boolean));
}

function tile(v, k, x) {
  return h('div', { class: 'tile' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k), x ? h('div', { class: 'x' }, x) : null);
}

// `href(r)`: on paper, the row's label links there; `r.links`: more links after it (runs it hit).
function barList(rows, { max, fmt = fmtInt, onClick, tipText, href }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'bars' }, rows.map((r) => tooltip(h('div', { class: 'bar-row', onclick: () => onClick?.(r) },
    h('span', { class: 'lbl', title: r.label }, paperLink(href?.(r), r.label), r.sub ? h('small', {}, r.sub) : null, r.note ? h('span', { class: 'rp-note' }, r.note) : null, r.links?.length ? h('span', { class: 'rp-runs' }, r.links) : null),
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
      h('td', { title: t.key }, h('span', { class: 'cat', style: { background: CAT_COLOR[t.cat] } }), paperLink(paperHref(act, 'step', t.key, t.fails > 0), t.key)),
      h('td', {}, fmtInt(t.calls)),
      h('td', {}, t.fails ? fmtInt(t.fails) : '–'),
      h('td', {}, h('span', { class: 'minibar' }, t.fails ? h('i', { style: { width: `${Math.max(2, t.rate * 60)}px`, background: 'var(--viz-crit)' } }) : null, pc(t.rate))),
      h('td', {}, h('span', { class: 'minibar' }, h('i', { style: { width: `${Math.max(2, (t.avg / maxAvg) * 60)}px`, background: 'var(--viz-seq)' } }), dur(t.avg))),
      h('td', {}, dur(t.maxMs)),
      h('td', {}, fmtInt(t.failRuns))),
    `${t.key} (${CAT_LABEL[t.cat]})\n${fmtInt(t.calls)} calls in ${fmtInt(t.runs)} runs\n${fmtInt(t.fails)} failures (${pc(t.rate)}) in ${fmtInt(t.failRuns)} runs\navg ${dur(t.avg)} · slowest ${dur(t.maxMs)}\nClick to see the runs${t.fails ? ' where it failed' : ''}`))),
  );
  const legend = h('div', { class: 'legend', style: { marginTop: '10px' } }, Object.entries(CAT_LABEL).filter(([c]) => rows.some((r) => r.cat === c)).map(([c, l]) => h('span', {}, h('i', { style: { background: CAT_COLOR[c] } }), l)));
  const more = rows.length > 14 && !act.print ? h('button', { class: 'linkish', onclick: () => { act.expanded.tools = !act.expanded.tools; act.rerender(); } }, act.expanded.tools ? 'Show fewer' : `Show all ${rows.length}`) : null;
  return [table, more, legend];
}

export function renderInsights(root, ins, act) {
  if (!ins.n) {
    root.replaceChildren(h('div', { class: 'ins-empty' }, h('h2', {}, 'No runs in view'), h('p', {}, 'Insights follow the skill, window, filters and search.')));
    return;
  }
  const p50 = (a) => dur(pct(a, 50));
  const p90 = (a) => dur(pct(a, 90));
  const partial = ins.withSteps < ins.n ? ` Step data covers ${fmtInt(ins.withSteps)} of ${fmtInt(ins.n)} runs so far.` : '';

  // Overview tiles
  const overview = card('overview', 'Overview', `${fmtInt(ins.n)} runs in view — every number follows the skill, window, filters and search.${partial}`,
    h('div', { class: 'tiles' }, ...[
      tile(pc(share(ins.finishedOfReached.length, ins.reached.length)), 'Output rate', `${fmtInt(ins.finishedOfReached.length)} of ${fmtInt(ins.reached.length)} that tried`),
      tile(p50(ins.toFinal), 'Request → final output', `median · p90 ${p90(ins.toFinal)}`),
      tile(p50(ins.toFirst), 'Request → first generation', `median · p90 ${p90(ins.toFirst)}`),
      tile(ins.genCalls ? dur(ins.genMs / ins.genCalls) : '–', 'Avg generation call', `${fmtInt(ins.genCalls)} calls`),
      tile(pc(share(ins.dl.length, ins.finished.length)), 'Downloaded', `${fmtInt(ins.dl.length)} of ${fmtInt(ins.finished.length)} with output`),
      tile(pc(share(ins.pub.length, ins.finished.length)), 'Published', `${fmtInt(ins.pub.length)} of ${fmtInt(ins.finished.length)} with output`),
      tile(pc(share(ins.moodCounts.frustrated, ins.n)), 'Had a frustrated turn', `${fmtInt(ins.moodCounts.frustrated)} runs`),
      tile(money(ins.costPerFinished), 'Cost per run with output', `${money(ins.cost)} total`),
      ins.profile.length ? tile(typeLabel(ins.profile[0].type), 'Main output', ins.profile.slice(0, 3).map((p) => `${typeLabel(p.type)} ${pc(p.share)}`).join(' · ')) : null,
    ].filter(Boolean)));

  // Funnel (ordinal blue ramp)
  const steps = [
    ['Loaded the skill', ins.n, null],
    ['Tried to make something', ins.reached.length, null],
    ['Produced output', ins.finishedOfReached.length, ['outcome', 'video']],
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
      tile(p50(ins.toFirst), 'Until first generation', `median · p90 ${p90(ins.toFirst)}`),
      tile(p50(ins.toFinal), 'Until final output', `median · p90 ${p90(ins.toFinal)}`)));

  // Tools table (wide)
  const tools = card('tools', 'Tools & methods', 'Every tool call in these runs. Sort by any column; click a row to see the runs where it failed.', ...toolsTable(ins, act));

  // Models: time and cost per call, each model against the slowest / most expensive.
  const mrows = ins.modelRows.filter((m) => m.calls > 0).sort((a, b) => b.ms - a.ms).slice(0, act.expanded?.models || act.print ? 60 : 12);
  const maxAvg = Math.max(1, ...mrows.map((m) => m.avgMs));
  const maxCost = Math.max(0.0001, ...mrows.map((m) => m.avgCost || 0));
  const totMs = ins.modelRows.reduce((a, m) => a + m.ms, 0);
  const totCost = ins.modelRows.reduce((a, m) => a + m.cost, 0);
  const modelsCard = card('models', 'Models: time and cost', `Every generation model in these runs: how long one call takes and what it costs at the product's list price (per second of video asked for, or per generation; failed calls free). ${dur(totMs)} of generation and ${money(totCost)} in view.`,
    mrows.length ? h('div', { class: 'models' },
      h('div', { class: 'model-row head' }, h('span', {}, 'Model'), h('span', {}, 'Time a call'), h('span', {}), h('span', {}, 'Cost a call'), h('span', {})),
      ...mrows.map((m) => tooltip(h('div', { class: 'model-row', style: { cursor: 'pointer' }, onclick: () => act.filter('model', m.name) },
        h('span', { class: 'mn' }, h('i', { class: `mk ${m.kind}` }), h('b', {}, paperLink(paperHref(act, 'filter', 'model', m.name), m.name)), h('small', {}, `${fmtInt(m.calls)}×${m.fails ? ` · ${pc(m.failRate)} fail` : ''}`)),
        h('span', { class: 'mbar' }, h('i', { style: { width: `${(m.avgMs / maxAvg) * 100}%` } })),
        h('span', { class: 'mv' }, dur(m.avgMs), h('small', {}, `${pc(share(m.ms, totMs))} of time`)),
        h('span', { class: 'mbar cost' }, h('i', { style: { width: `${((m.avgCost || 0) / maxCost) * 100}%` } })),
        h('span', { class: 'mv' }, money(m.avgCost), h('small', {}, m.cost ? `${pc(share(m.cost, totCost))} of spend` : 'no price'))),
      `${m.name} (${m.methods.join(', ')})\n${fmtInt(m.calls)} calls in ${fmtInt(m.runs)} runs · ${fmtInt(m.fails)} failed\n${dur(m.avgMs)} a call on average, slowest ${dur(m.maxMs)}\n${m.avgCost != null ? `${money(m.avgCost)} a successful call · ${money(m.cost)} in total` : 'Not in the price list'}\nClick to see these runs`)),
      ins.modelRows.length > 12 && !act.print ? h('button', { class: 'linkish', onclick: () => { act.expanded.models = !act.expanded.models; act.rerender(); } }, act.expanded.models ? 'Show fewer' : `Show all ${ins.modelRows.length}`) : null)
      : h('p', { class: 'desc' }, 'No generation calls in these runs.'));

  // Where a run's time goes (server/time-split.js), every run counting the same.
  const avgTime = averageTime(act.runs?.() || []);
  const timeCard = card('time', 'Where a run’s time goes', avgTime
    ? `From the first message to the end of the last turn, every moment counted once (two videos generating at the same time are one stretch of video time). The average of ${fmtInt(avgTime.n)} runs, each counting the same; the median run takes ${dur(avgTime.medianSec * 1000)}.`
    : null,
    avgTime ? timeBar(avgTime.shares) : h('p', { class: 'desc' }, 'No step data for these runs yet: the steps query can time out while Trino is busy. Refresh a little later.'));

  // What we learned: the numbers, read.
  const found = learn(ins, act.runs?.() || []);
  const learned = card('learned', 'What the numbers say', 'The findings worth knowing in these runs, each with its evidence. Click one to see the runs behind it.',
    found.length ? h('div', { class: 'learned' }, found.slice(0, act.print ? 20 : 8).map((f) => h(paperHref(act, 'go', f.go) ? 'a' : 'button', { class: `finding ${f.tone}`, href: paperHref(act, 'go', f.go), target: act.print ? '_blank' : null, onclick: () => act.go(f.go) },
      h('div', { class: 't' }, ...[].concat(f.title)), h('div', { class: 'd' }, f.detail)))) : h('p', { class: 'desc' }, 'Nothing stands out in these runs.'));

  // Errors
  const errors = card('errors', 'Top errors', 'Failures grouped by message (ids and numbers masked), by how many runs they hit.',
    ins.errs.length ? barList(ins.errs.slice(0, act.print ? 30 : 10).map((e) => ({
      // On paper the whole message (an example of the group) rather than its masked, shortened signature.
      label: act.print && e.example && String(e.example).length > e.sig.length ? String(e.example) : e.sig, sub: e.step, value: e.runs.size, color: 'var(--viz-crit)', e,
      // On paper, each error also links to a few of the runs it hit.
      links: act.print ? [...e.runs].slice(0, 3).map((id, i) => runLink(act, id, `run ${i + 1}`)) : null,
    })), {
      onClick: (r) => act.search(errSearch(r.e)),
      href: (r) => paperHref(act, 'search', errSearch(r.e)),
      tipText: (r) => `${r.e.step}\n${r.e.example}\n\n${fmtInt(r.e.count)} failures in ${fmtInt(r.e.runs.size)} runs · click to search`,
    }) : h('p', { class: 'desc' }, 'No tool errors in these runs.'));

  // What users asked for
  const asks = card('asks', 'What users asked for', 'Classified intent of the first turn, and the most common subjects in session titles.',
    ins.intents.length ? barList(ins.intents.slice(0, act.print ? 40 : 8).map(([label, value]) => ({ label, value })), { onClick: (r) => act.search(r.label), href: (r) => paperHref(act, 'search', r.label) }) : h('p', { class: 'desc' }, 'No intent data.'),
    ins.subjects.length ? h('div', { style: { marginTop: '12px' } }, h('p', { class: 'desc' }, 'Subjects (click to search)'),
      h('div', { class: 'chips-cloud' }, ins.subjects.map(([w, n]) => (act.print && act.href
        ? h('a', { class: 'chip', href: act.href('search', w), target: '_blank', rel: 'noopener' }, w, h('small', {}, n))
        : h('button', { onclick: () => act.search(w) }, w, h('small', {}, n)))))) : null);

  // Repeated requests
  const rep = card('repeats', 'Most repeated requests', 'Identical prompts. Many users = a template or API caller; one user = retrying.',
    ins.repeated.length ? h('div', {}, ins.repeated.slice(0, act.print ? 20 : 6).map((g) => tooltip(h('div', { class: 'rep', onclick: () => act.search(normPrompt(g.prompt).split(' ').slice(0, 6).join(' ')) },
      h('span', { class: 't' }, paperLink(paperHref(act, 'search', normPrompt(g.prompt).split(' ').slice(0, 6).join(' ')), g.prompt.replace(/<HIDDEN>[\s\S]*/i, '').trim() || g.prompt)),
      h('span', { class: 'n' }, `${g.runs.length}× · ${g.users.size} user${g.users.size > 1 ? 's' : ''}`),
      act.print ? runLink(act, g.runs[0].id, 'open a run') : null),
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
      ...ins.tags.slice(0, act.print ? 40 : 6).map(([t, n]) => h('span', { class: 'pill' }, `${t} ×${n}`)),
      ins.outOfFunds ? h('span', { class: 'pill warn' }, icon('card', 'sm'), `${fmtInt(ins.outOfFunds)} runs out of credits`) : null),
    ins.quotes.length ? h('div', { class: 'quotes' }, ins.quotes.slice(0, act.print ? 60 : 4).map((r) => runLink(act, r.id, h('div', { class: 'quote' }, `“${r.sentimentDetail}”`,
      h('small', {}, `${r.title || 'Untitled'} · ${ago(r.createdAt)} · ${r.sentiments.includes('frustrated') ? 'frustrated' : 'confused'}`))))) : null);

  // Daily trend: stacked columns (status colors carry state, legend + tooltip carry labels)
  const maxDay = Math.max(1, ...ins.days.map((d) => d.finished + d.failed + d.none));
  const trend = card('trend', 'Runs per day', 'Stacked by outcome. Hover a day for the numbers.',
    h('div', { class: 'cols' }, ins.days.map((d) => tooltip(h('div', { class: 'col' },
      h('span', { style: { height: `${(d.finished / maxDay) * 100}%`, background: 'var(--viz-good)' } }),
      h('span', { style: { height: `${(d.failed / maxDay) * 100}%`, background: 'var(--viz-crit)' } }),
      h('span', { style: { height: `${(d.none / maxDay) * 100}%`, background: 'var(--viz-none)' } })),
    `${d.day}\n${fmtInt(d.finished + d.failed + d.none)} runs\n${fmtInt(d.finished)} with output · ${fmtInt(d.failed)} tried, no output · ${fmtInt(d.none)} never tried`))),
    h('div', { class: 'col-axis' }, ins.days.map((d, i) => h('span', {}, i === 0 || i === ins.days.length - 1 || ins.days.length < 10 ? d.day.slice(5) : ''))),
    h('div', { class: 'legend', style: { marginTop: '8px' } }, h('span', {}, h('i', { style: { background: 'var(--viz-good)' } }), 'Produced output'), h('span', {}, h('i', { style: { background: 'var(--viz-crit)' } }), 'Tried, no output'), h('span', {}, h('i', { style: { background: 'var(--viz-none)' } }), 'Never tried')));

  // Skill versions
  const vers = card('versions', 'Skill versions', 'Outcomes by the skill (codex) version each run used — did a change help?',
    ins.versions.length ? h('table', { class: 'ins' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'Runs'), h('th', {}, 'Output rate'), h('th', {}, 'Frustrated'), h('th', {}, 'Median to final'))),
      h('tbody', {}, ins.versions.slice(0, act.print ? 30 : 6).map((v) => {
        const gen = v.runs.filter(attempted);
        const fin = gen.filter(hasAd);
        const tf = fin.filter((r) => r.requestAt && r.finalAt).map((r) => r.finalAt - r.requestAt);
        return h('tr', { onclick: () => act.search(v.v) },
          h('td', { title: v.v, class: 'mono' }, paperLink(paperHref(act, 'search', v.v), `${v.v.slice(0, 8)} · ${new Date(v.first).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)),
          h('td', {}, fmtInt(v.runs.length)), h('td', {}, pc(share(fin.length, gen.length))),
          h('td', {}, pc(share(v.runs.filter((r) => r.sentiments?.includes('frustrated')).length, v.runs.length))), h('td', {}, dur(pct(tf, 50))));
      }))) : h('p', { class: 'desc' }, 'No version data.'));

  // The findings and the models first; the few cards that explain them; every other number folded
  // away under "All the numbers" (on paper, everything is printed).
  const all = [overview, tools, timing, rep, trend, vers];
  root.replaceChildren(h('div', { class: 'ins-top' }, h('p', { class: 'ins-note' }, `Insights for ${act.label()}. Click anything to see the runs.`),
      h('button', { class: 'btn', onclick: (e) => act.share(e.currentTarget) }, icon('external'), 'Share insights')),
    h('div', { class: 'ins-wide' }, learned, modelsCard),
    h('div', { class: 'ins-masonry' }, timeCard, funnel, errors, mood, asks),
    act.print ? h('div', { class: 'ins-masonry' }, ...all)
      : h('details', { class: 'ins-all', open: Boolean(act.expanded?.all) || ['tools', 'timing', 'repeats', 'trend', 'versions', 'overview'].includes(act.scrollTo), ontoggle: (e) => { act.expanded.all = e.target.open; } },
        h('summary', {}, 'All the numbers', h('small', {}, 'overview tiles, every tool, where the time goes, repeated requests, runs per day, skill versions')),
        h('div', { class: 'ins-wide' }, overview, tools), h('div', { class: 'ins-masonry' }, timing, rep, trend, vers)));
  if (act.scrollTo) root.querySelector(`#ins-${act.scrollTo}`)?.scrollIntoView({ block: 'start' });
}
