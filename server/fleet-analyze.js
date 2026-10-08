// Fleet analysis: day files (fleet.js) → what the Fleet view shows. Pure functions over the
// rollup rows; nothing here calls upstream systems.
//
// What's measured vs inferred is kept explicit: counts, durations and recoveries are measured
// from the agent's own entries; "time lost", savings and the recommended timeouts are estimates
// built on stated assumptions (each carries its `basis`).

import { EDGES, PLUMBING } from './fleet-queries.js';

const H = 3600000;
const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const sumBy = (xs, f) => xs.reduce((a, x) => a + num(f(x)), 0);
const addMap = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + num(v);
  return out;
};
const topEntries = (m, n = 5) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
const keyOf = (...xs) => xs.map((x) => x ?? '').join('\u0001');
const audOk = (aud) => (r) => aud === 'all' || r.aud === aud;
export const NO_SKILL = '(none)';

// ---- statistics ----
// Wilson interval for a rate (95%).
export function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
// Two Poisson rates (events per exposure): z-score of the change.
function rateZ(k1, t1, k0, t0) {
  if (!t1 || !t0) return 0;
  const r1 = k1 / t1;
  const r0 = k0 / t0;
  const se = Math.sqrt(k1 / (t1 * t1) + k0 / (t0 * t0)) || 1e-9;
  return (r1 - r0) / se;
}

// ---- duration histograms (bucket i: [EDGES[i-1], EDGES[i]) seconds) ----
const lo = (i) => (i === 0 ? 0 : EDGES[i - 1] * 1000);
const hi = (i) => (i >= EDGES.length ? EDGES.at(-1) * 2000 : EDGES[i] * 1000);
const histN = (h) => Object.values(h || {}).reduce((a, b) => a + num(b), 0);
export function quantile(h, q) {
  const n = histN(h);
  if (!n) return null;
  let acc = 0;
  for (const i of Object.keys(h).map(Number).sort((a, b) => a - b)) {
    const c = num(h[i]);
    if (acc + c >= q * n) return lo(i) + ((q * n - acc) / c) * (hi(i) - lo(i));
    acc += c;
  }
  return hi(EDGES.length);
}
// Cost of all attempts and number of successes if every attempt were cut at `tau` ms:
// successes past tau become timeouts (cost tau, no success); fail-fast attempts cost what they
// took; jobs that hung (hidden timeouts) cost tau.
function attemptCost(okHist, failHist, hung, tau) {
  let cost = 0;
  let succ = 0;
  for (const [k, c0] of Object.entries(okHist || {})) {
    const i = Number(k);
    const c = num(c0);
    const a = lo(i);
    const b = hi(i);
    if (b <= tau) {
      cost += c * (a + b) / 2;
      succ += c;
    } else if (a >= tau) cost += c * tau;
    else {
      const f = (tau - a) / (b - a);
      cost += c * f * (a + tau) / 2 + c * (1 - f) * tau;
      succ += c * f;
    }
  }
  for (const [k, c0] of Object.entries(failHist || {})) cost += num(c0) * Math.min((lo(Number(k)) + hi(Number(k))) / 2, tau);
  cost += hung * tau;
  return { cost, succ };
}
// E(τ) = E[min(T, τ)] / P(T ≤ τ): expected time to a success when attempts past τ are cut and
// retried, assuming a retry is an independent fresh try. Returns ms per success.
const expectedWait = (okHist, failHist, hung, tau) => {
  const { cost, succ } = attemptCost(okHist, failHist, hung, tau);
  return succ ? cost / succ : Infinity;
};

// ---- failure classes: what kind of problem, who'd fix it, how easy ----
const CLASSES = [
  { id: 'credits', re: /insufficient credits|enough credits|out of credits|not enough credit/i, label: 'Out of credits', owner: 'Not a bug', fix: 'none', hint: 'The user ran out of credits. Not a defect; counted separately.' },
  { id: 'hidden-timeout', re: /^Tool returned while its job was still/i, label: 'Hidden timeout', owner: 'Platform (tool timeouts)', fix: 'medium', hint: 'The tool gave up waiting while the job was still running and reported success. Set the wait from measured timing (Wait times) and re-attach to the same job instead of starting a new one.' },
  { id: 'interrupted', re: /^Interrupted:|interrupted by a service restart|interrupted while waiting/i, label: 'Interrupted by restart', owner: 'Platform (deploys)', fix: 'medium', hint: 'A deploy or restart cut the tool off. Drain before restarts, or make the tool resumable / idempotent so the agent can re-attach.' },
  { id: 'missing-resource', re: /Error loading Codex resource|Skill ".*" not found|No such file|ENOENT|not found in (?:the )?(?:codex|resources)/i, label: 'Missing file or skill', owner: 'Skill author (codex)', fix: 'easy', hint: 'The agent asks for a file or skill that isn\'t there. Fix the path in the instructions, or publish the file where the agent reads it.' },
  { id: 'agent-misuse', re: /unknown tool|not available in this session|is not an earlier step|is required|must be provided|must be a valid|Provide exactly one|Invalid JSON|Expected ',' or|unsupported op|not a top-level asset field|requires the existing asset|expects an unsuffixed|malformed|do not match any URL|was not found\. Available|must be provided together|path or name is required/i, label: 'Agent misuse of a tool', owner: 'Skill author (instructions)', fix: 'easy', hint: 'The agent called a tool wrongly. Spell out the correct call in the skill (with an example), and have the tool validate or auto-correct the common slip.' },
  { id: 'validation', re: /validation failed|Schema validation|Validation error|_VALIDATION|VIDEO_TERMINAL|STORY_PAGE|not allowed on asset/i, label: 'Output failed validation', owner: 'Skill author / data model', fix: 'medium', hint: 'What the agent wrote was rejected. Show the valid shape in the skill and validate before writing.' },
  { id: 'content-policy', re: /content_policy|moderation|flagged|CONTENT_MODERATION|safety|nsfw/i, label: 'Content filter', owner: 'Skill author (prompting)', fix: 'medium', hint: 'A provider\'s content filter refused the prompt. Rewrite risky prompts before sending, and tell the user plainly when it\'s their content.' },
  { id: 'provider-params', re: /INVALID_ARGUMENT|\[400\]|\b422\b|does not accept|Bad Request|Unexpected value|invalid parameter|Input should be/i, label: 'Rejected parameters', owner: 'Model catalog / tool owner', fix: 'easy', hint: 'The provider rejected the request\'s parameters. Check the model\'s live schema (/catalog-drift) and the RPC schema; validate before calling.' },
  { id: 'permission', re: /permission|forbidden|\b403\b|unauthori[sz]ed|method is not allowed/i, label: 'Permission / access', owner: 'Product (permissions)', fix: 'medium', hint: 'The call wasn\'t allowed. Don\'t offer the action to users without the permission; check before calling.' },
  { id: 'transient', re: /timed? ?out|timeout|INTERNAL|UNAVAILABLE|\b50[234]\b|rate limit|\b429\b|Upstream exception|ECONNRESET|DEADLINE|empty response|temporarily/i, label: 'Transient / upstream', owner: 'Platform / provider', fix: 'hard', hint: 'An upstream service failed. Retry with backoff in the tool (not the agent), and track the provider\'s error rate.' },
];
export function classify(sig, tool) {
  const c = CLASSES.find((x) => x.re.test(sig || '')) || { id: 'unclassified', label: 'Unclassified', owner: 'Triage', fix: 'medium', hint: 'No rule matched. Open the examples and classify it.' };
  const { re, ...rest } = c;
  return { ...rest, tool };
}
const FIX_WEIGHT = { easy: 1, medium: 0.6, hard: 0.35, none: 0 };
const CREDITS_RE = CLASSES[0].re;
// Kinds of error a skill's own instructions can fix (the rest are platform / tool / provider work).
const SKILL_FIX = new Set(['missing-resource', 'agent-misuse', 'validation', 'content-policy', 'provider-params', 'unclassified']);

// ---- per-period aggregation ----
function collect(files, aud) {
  const ok = audOk(aud);
  const usage = new Map();
  const summary = new Map();
  const timing = new Map();
  const failures = new Map();
  const chains = new Map();
  const outcomes = new Map();
  const intents = new Map();
  const opDayVals = new Map();
  const models = new Map();
  const reads = new Map();
  const followups = new Map();
  let effDays = 0;
  const perDay = [];
  for (const f of files) {
    const day = { day: f.day, final: f.final, sessions: 0, turns: 0, calls: 0, fails: 0, hidden: 0, lostMs: 0, frustrated: 0 };
    for (const r of f.usage || []) {
      if (!ok(r)) continue;
      if (r.tool == null || r.tool === '') {
        const s = summary.get(r.owner) || { owner: r.owner, days: new Set() };
        mergeNum(s, r);
        s.versions = addMap(s.versions, r.versions);
        s.days.add(f.day);
        summary.set(r.owner, s);
        day.sessions += num(r.sessions);
        day.turns += num(r.turns);
        day.frustrated += num(r.frustrated);
        day.iterations = (day.iterations || 0) + num(r.iterations);
        day.inTokens = (day.inTokens || 0) + num(r.in_tokens);
        if (r.owner === NO_SKILL) day.noSkill = (day.noSkill || 0) + num(r.sessions);
        day.versions = addMap(day.versions, r.versions);
      } else {
        const k = keyOf(r.owner, r.tool, r.method);
        const u = usage.get(k) || { owner: r.owner, tool: r.tool, method: r.method, maxShapes: 0 };
        mergeNum(u, r);
        u.maxShapes = Math.max(u.maxShapes, num(r.shapes));
        usage.set(k, u);
        day.calls += num(r.calls);
        day.fails += num(r.fails);
        day.hidden += num(r.hidden);
        day.lostMs += num(r.lost_ms);
      }
    }
    // Timing is across audiences (it's the system's speed, not the user's).
    for (const r of f.timing || []) {
      const k = keyOf(r.tool, r.method, r.model, r.size);
      const t = timing.get(k) || { tool: r.tool, method: r.method, model: r.model, size: r.size, maxShapes: 0, days: 0 };
      // Extremes and distinct-counts are per day: never summed across days.
      mergeNum(t, r, ['ok_hist', 'bad_hist', 'owners', 'max_ms', 'hidden_min_ms', 'hidden_max_ms', 'shapes', 'vals']);
      t.ok_hist = addMap(t.ok_hist, r.ok_hist);
      t.bad_hist = addMap(t.bad_hist, r.bad_hist);
      t.owners = addMap(t.owners, r.owners);
      t.maxShapes = Math.max(t.maxShapes, num(r.shapes));
      t.maxVals = Math.max(t.maxVals || 0, num(r.vals));
      t.hidden_min_ms = r.hidden_min_ms != null ? Math.min(t.hidden_min_ms ?? Infinity, num(r.hidden_min_ms)) : t.hidden_min_ms;
      t.hidden_max_ms = Math.max(t.hidden_max_ms || 0, num(r.hidden_max_ms));
      t.max_ms = Math.max(t.max_ms || 0, num(r.max_ms));
      t.days++;
      timing.set(k, t);
      const ok2 = keyOf(r.tool, r.method);
      const od = opDayVals.get(ok2) || {};
      od[f.day] = (od[f.day] || 0) + num(r.vals);
      opDayVals.set(ok2, od);
    }
    for (const r of f.failures || []) {
      if (!ok(r)) continue;
      const k = keyOf(r.tool, r.method, r.sig);
      const x = failures.get(k) || { tool: r.tool, method: r.method, sig: r.sig, owners: {}, perDay: {}, dayHours: {}, examples: [], models: {}, versions: {}, folded: 0 };
      mergeNum(x, r, ['models', 'versions', 'hours', 'examples', 'example', 'folded']);
      x.owners[r.owner] = (x.owners[r.owner] || 0) + num(r.n);
      x.perDay[f.day] = (x.perDay[f.day] || 0) + num(r.n);
      if (CREDITS_RE.test(r.sig || '')) day.creditFails = (day.creditFails || 0) + num(r.n);
      for (const [h, c] of Object.entries(r.hours || {})) x.dayHours[`${f.day}T${String(h).padStart(2, '0')}`] = (x.dayHours[`${f.day}T${String(h).padStart(2, '0')}`] || 0) + num(c);
      x.models = addMap(x.models, r.models);
      x.versions = addMap(x.versions, r.versions);
      x.example ??= r.example;
      x.folded += num(r.folded) > 1 ? num(r.folded) : 0;
      for (const e of r.examples || []) x.examples.push({ owner: r.owner, raw: e });
      failures.set(k, x);
    }
    for (const r of f.outcomes || []) {
      if (!ok(r)) continue;
      // Intent rows (what users asked for) sit next to the per-skill rows in the same part.
      if (r.intent != null && r.owner == null) {
        const it = intents.get(r.intent) || { intent: r.intent, owners: {} };
        mergeNum(it, r, ['owners']);
        it.owners = addMap(it.owners, r.owners);
        intents.set(r.intent, it);
        continue;
      }
      if (r.owner == null) continue;
      const o = outcomes.get(r.owner) || { owner: r.owner, days: 0 };
      mergeNum(o, r);
      o.days++;
      outcomes.set(r.owner, o);
      day.produced = (day.produced || 0) + num(r.produced);
      day.kept = (day.kept || 0) + num(r.kept);
    }
    for (const r of f.chains || []) {
      if (!ok(r)) continue;
      const k = keyOf(r.owner, r.kind, r.k);
      const c = chains.get(k) || { owner: r.owner, kind: r.kind, k: r.k };
      mergeNum(c, r);
      chains.set(k, c);
    }
    // Efficiency parts (models, reads, follow-ups): days built before they existed have none.
    if (f.models) {
      effDays++;
      for (const r of f.models) {
        if (!ok(r)) continue;
        const k = keyOf(r.owner, r.model);
        const m = models.get(k) || { owner: r.owner, model: r.model, max_in: 0 };
        mergeNum(m, r, ['max_in', 'purpose']);
        m.max_in = Math.max(m.max_in, num(r.max_in));
        models.set(k, m);
      }
      for (const r of f.reads || []) {
        if (!ok(r)) continue;
        const k = keyOf(r.owner, r.tool, r.file);
        const x = reads.get(k) || { owner: r.owner, tool: r.tool, file: r.file };
        mergeNum(x, r, ['file', 'example']);
        x.example ??= r.example || undefined;
        reads.set(k, x);
      }
      for (const r of f.followups || []) {
        if (!ok(r)) continue;
        const k = keyOf(r.owner, r.kind, r.tool, r.method, r.prev, r.next);
        const x = followups.get(k) || { owner: r.owner, kind: r.kind, tool: r.tool, method: r.method, prev: r.prev, next: r.next };
        mergeNum(x, r, ['prev', 'next']);
        followups.set(k, x);
      }
    }
    perDay.push(day);
  }
  return { usage, summary, timing, failures, chains, outcomes, intents, opDayVals, perDay, outcomeDays: files.filter((f) => f.outcomes?.length).length, models, reads, followups, effDays };
}
const SKIP = new Set(['owner', 'aud', 'tool', 'method', 'model', 'size', 'sig', 'kind', 'k', 'days']);
function mergeNum(target, row, skip = []) {
  for (const [k, v] of Object.entries(row)) {
    if (SKIP.has(k) || skip.includes(k) || v == null || typeof v === 'object') continue;
    if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(v)) target[k] = (target[k] || 0) + Number(v);
  }
}

function totalsOf(c) {
  const s = [...c.summary.values()];
  const u = [...c.usage.values()];
  const credits = [...c.failures.values()].filter((f) => classify(f.sig).id === 'credits').reduce((a, f) => a + num(f.n), 0);
  const noSkill = c.summary.get(NO_SKILL);
  return {
    sessions: sumBy(s, (x) => x.sessions),
    turns: sumBy(s, (x) => x.turns),
    failedTurns: sumBy(s, (x) => x.failed_turns),
    calls: sumBy(u, (x) => x.calls),
    fails: sumBy(u, (x) => x.fails),
    creditFails: credits,
    hidden: sumBy(u, (x) => x.hidden),
    interrupted: sumBy(u, (x) => x.interrupted),
    lostMs: sumBy(u, (x) => x.lost_ms),
    iterations: sumBy(s, (x) => x.iterations),
    inTokens: sumBy(s, (x) => x.in_tokens),
    cachedTokens: sumBy(s, (x) => x.cached_tokens),
    outTokens: sumBy(s, (x) => x.out_tokens),
    thinkMs: sumBy(s, (x) => x.think_ms),
    frustrated: sumBy(s, (x) => x.frustrated),
    confused: sumBy(s, (x) => x.confused),
    userMsgs: sumBy(s, (x) => x.user_msgs),
    noSkillSessions: num(noSkill?.sessions),
    // Outcomes (session-level; only days whose outcomes part is built).
    outcomeDays: c.outcomeDays,
    outSessions: sumBy([...c.outcomes.values()], (x) => x.sessions),
    produced: sumBy([...c.outcomes.values()], (x) => x.produced),
    kept: sumBy([...c.outcomes.values()], (x) => x.kept),
    triedNoOutput: sumBy([...c.outcomes.values()], (x) => x.tried_no_output),
    generations: sumBy([...c.outcomes.values()], (x) => x.generations),
    keptGenerations: sumBy([...c.outcomes.values()], (x) => x.kept_generations),
    thumbsUp: sumBy([...c.outcomes.values()], (x) => x.thumbs_up),
    thumbsDown: sumBy([...c.outcomes.values()], (x) => x.thumbs_down),
  };
}

// ---- skills ----
function skillRows(c, prev, issuesBySkill, weekF, opts) {
  const out = [];
  for (const s of c.summary.values()) {
    const ops = [...c.usage.values()].filter((u) => u.owner === s.owner);
    const calls = sumBy(ops, (o) => o.calls);
    const fails = sumBy(ops, (o) => o.fails);
    const credits = sumBy([...c.failures.values()].filter((f) => classify(f.sig).id === 'credits'), (f) => f.owners[s.owner]);
    const p = prev?.summary.get(s.owner);
    const pOps = prev ? [...prev.usage.values()].filter((u) => u.owner === s.owner) : [];
    const pCalls = sumBy(pOps, (o) => o.calls);
    const pFails = sumBy(pOps, (o) => o.fails);
    const top = (issuesBySkill.get(s.owner) || [])[0];
    const failRate = calls ? (fails - credits) / calls : 0;
    const oc = c.outcomes.get(s.owner);
    const poc = prev?.outcomes.get(s.owner);
    out.push({
      produced: num(oc?.produced),
      kept: num(oc?.kept),
      keptRate: num(oc?.produced) ? num(oc.kept) / num(oc.produced) : null,
      prevKeptRate: num(poc?.produced) ? num(poc.kept) / num(poc.produced) : null,
      noOutputRate: num(oc?.sessions) ? num(oc.tried_no_output) / num(oc.sessions) : null,
      gensPerKept: num(oc?.kept) ? num(oc.kept_generations) / num(oc.kept) : null,
      gensPerSession: num(oc?.sessions) ? num(oc.generations) / num(oc.sessions) : null,
      thumbsUp: num(oc?.thumbs_up),
      thumbsDown: num(oc?.thumbs_down),
      skill: s.owner,
      sessions: num(s.sessions),
      sessionsPerWeek: num(s.sessions) * weekF,
      accountsDaily: num(s.accounts) / Math.max(1, s.days.size),
      turns: num(s.turns),
      failedTurnRate: num(s.turns) ? num(s.failed_turns) / num(s.turns) : 0,
      calls,
      fails,
      creditFails: credits,
      failRate,
      failRateCI: wilson(fails - credits, calls),
      prevFailRate: pCalls ? pFails / pCalls : null,
      hidden: sumBy(ops, (o) => o.hidden),
      lostMs: sumBy(ops, (o) => o.lost_ms),
      lostHPerWeek: (sumBy(ops, (o) => o.lost_ms) / H) * weekF,
      frustration: num(s.turns) ? num(s.frustrated) / num(s.turns) : 0,
      prevFrustration: p && num(p.turns) ? num(p.frustrated) / num(p.turns) : null,
      iterPerTurn: num(s.turns) ? num(s.iterations) / num(s.turns) : 0,
      tokensPerIter: num(s.iterations) ? num(s.in_tokens) / num(s.iterations) : 0,
      thinkMsPerIter: num(s.iterations) ? num(s.think_ms) / num(s.iterations) : 0,
      thinkHPerWeek: (num(s.think_ms) / H) * weekF,
      affirmShare: num(s.user_msgs) ? num(s.affirm_msgs) / num(s.user_msgs) : 0,
      prevSessions: p ? num(p.sessions) * (opts.prevScale || 1) : null,
      versions: topEntries(s.versions, 4),
      topIssue: top ? { key: top.key, label: top.sig, hPerWeek: top.lostHPerWeek } : null,
      major: s.owner !== NO_SKILL && (num(s.sessions) * weekF >= opts.majorPerWeek || opts.pins.includes(s.owner)),
    });
  }
  return out.sort((a, b) => b.sessions - a.sessions);
}

// ---- issues ----
// The newest few example sessions per skill (fix-per-skill reads that skill's own failures).
function examplesBySkill(x, owners) {
  const out = {};
  for (const { skill } of owners.slice(0, 6)) {
    const seen = new Set();
    out[skill] = x.examples.filter((e) => e.owner === skill).map((e) => {
      const [session, at, job] = String(e.raw).split('|');
      return { session, at: Number(at) || null, job: job || null, skill };
    }).filter((e) => e.session && !seen.has(e.session) && seen.add(e.session)).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 3);
  }
  return out;
}

function exampleList(x) {
  const seen = new Set();
  const out = [];
  for (const e of x.examples) {
    const [session, at, job] = String(e.raw).split('|');
    if (!session || seen.has(session)) continue;
    seen.add(session);
    out.push({ session, at: Number(at) || null, job: job || null, skill: e.owner });
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 6);
}

function pattern(x, coveredDays) {
  const total = num(x.n);
  const dh = Object.entries(x.dayHours).sort((a, b) => a[0].localeCompare(b[0]));
  // The busiest 3-hour stretch: an incident if it holds most of the period's occurrences.
  let peak = 0;
  let peakAt = null;
  for (let i = 0; i < dh.length; i++) {
    const start = Date.parse(`${dh[i][0]}:00:00Z`);
    let s = 0;
    for (let j = i; j < dh.length && Date.parse(`${dh[j][0]}:00:00Z`) < start + 3 * H; j++) s += dh[j][1];
    if (s > peak) [peak, peakAt] = [s, dh[i][0]];
  }
  const daysSeen = Object.keys(x.perDay).length;
  if (total >= 10 && peak / total >= 0.6 && coveredDays > 0) return { kind: 'incident', label: 'Spike', detail: `${Math.round((peak / total) * 100)}% within 3 hours from ${peakAt}:00 UTC`, peakAt };
  if (coveredDays >= 3 && daysSeen / coveredDays >= 0.7) return { kind: 'chronic', label: 'Every day', detail: `on ${daysSeen} of ${coveredDays} days` };
  return { kind: 'sporadic', label: 'Some days', detail: `on ${daysSeen} of ${coveredDays} days` };
}

function issueRows(c, prev, totals, prevTotals, weekF, coveredDays, prevCovered, state, summaryTurnsByVer) {
  const avgIterMs = totals.iterations ? totals.thinkMs / totals.iterations : 0;
  const rows = [];
  for (const [k, x] of c.failures) {
    if (x.sig === '(other errors)') continue;
    const cls = classify(x.sig, x.tool);
    const key = hashKey(k);
    const n = num(x.n);
    const lostMs = num(x.ms) + num(x.recover_ms);
    const p = prev?.failures.get(k);
    const pn = num(p?.n);
    const comparable = prev && prevCovered >= Math.max(1, Math.ceil(coveredDays * 0.7));
    // Rates per turn; the previous period's count is raw, so it's compared with its raw turns.
    const z = comparable ? rateZ(n, totals.turns, pn, prevTotals.rawTurns) : 0;
    const r1 = totals.turns ? n / totals.turns : 0;
    const r0 = prevTotals?.rawTurns ? pn / prevTotals.rawTurns : 0;
    let trend = 'flat';
    if (comparable) {
      if (pn === 0 && n >= 5) trend = 'new';
      else if (z > 2 && r1 > r0 * 1.25) trend = 'rising';
      else if (z < -2 && r1 < r0 * 0.8) trend = 'falling';
    }
    const owners = topEntries(x.owners, 8).map(([skill, cnt]) => ({ skill, n: cnt }));
    const conc = n ? owners[0].n / n : 0;
    const fatal = n ? num(x.unrecovered) / n : 0;
    const st = state.issues?.[key] || null;
    // Ranking impact in hours per week: time lost (measured), plus a nominal cost for sessions it
    // ended (never recovered, user never wrote again: 10 min) and users upset after it (5 min).
    const impactH = (lostMs / H + num(x.abandoned) / 6 + num(x.upset_after) / 12) * weekF;
    const boost = trend === 'new' || trend === 'rising' ? 1.4 : trend === 'falling' ? 0.8 : 1;
    const score = cls.id === 'credits' || ['wontfix', 'duplicate'].includes(st?.status) ? 0 : impactH * FIX_WEIGHT[cls.fix] * (0.7 + 0.3 * conc) * boost;
    // Issue rate per version of the skill instructions (codexVersionId), against that version's turns.
    const versions = topEntries(x.versions, 6).map(([ver, cnt]) => ({ ver, n: cnt, turns: summaryTurnsByVer[ver] || 0, rate: summaryTurnsByVer[ver] ? cnt / summaryTurnsByVer[ver] : null }));
    rows.push({
      key,
      tool: x.tool,
      method: x.method || '',
      sig: x.sig,
      cls,
      n,
      perWeek: n * weekF,
      sessions: num(x.sessions),
      users: num(x.users),
      hidden: num(x.hidden),
      lostMs,
      lostHPerWeek: (lostMs / H) * weekF,
      failedCallMs: num(x.ms),
      recoverMs: num(x.recover_ms),
      unrecovered: num(x.unrecovered),
      fatal,
      turnFailed: num(x.turn_failed),
      abandoned: num(x.abandoned),
      upsetAfter: num(x.upset_after),
      owners,
      concentration: conc,
      models: topEntries(x.models, 4),
      versions,
      perDay: x.perDay,
      dayHours: x.dayHours,
      daysSeen: Object.keys(x.perDay).length,
      firstSeen: Object.keys(x.perDay).sort()[0],
      lastSeen: Object.keys(x.perDay).sort().at(-1),
      pattern: pattern(x, coveredDays),
      trend: { dir: trend, z, prevN: comparable ? pn : null, rate: r1, prevRate: comparable ? r0 : null },
      example: x.example,
      examples: exampleList(x),
      examplesBySkill: examplesBySkill(x, owners),
      skillFix: SKILL_FIX.has(cls.id),
      impactHPerWeek: impactH,
      // What fixing it gives back, counting measured time only.
      savedHPerWeek: (lostMs / H) * weekF * FIX_WEIGHT[cls.fix],
      iterationsPerWeek: n * weekF,
      avgIterMs,
      score,
      status: st,
      basis: 'Time lost = each failed call\'s own time, plus one recovery per run of consecutive failures: from the first failure until the next successful attempt of that operation was started in the turn (else the turn\'s end) — measured. Ranking also adds 10 min per session it ended and 5 min per user upset afterwards, times how fixable the class is.',
    });
  }
  return rows.sort((a, b) => b.score - a.score || b.n - a.n);
}
const hashKey = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

// ---- wait times ----
function waitRows(c, weekF) {
  const out = [];
  for (const t of c.timing.values()) {
    const calls = num(t.calls);
    const okN = histN(t.ok_hist);
    if (calls < 5 || !okN) continue;
    const hidden = num(t.hidden);
    const failHist = { ...t.bad_hist };
    // Hidden timeouts sit in the failure histogram at the cap; take them out of fail-fast.
    let toRemove = hidden;
    for (const b of Object.keys(failHist).map(Number).sort((a, b) => b - a)) {
      if (!toRemove) break;
      const take = Math.min(num(failHist[b]), toRemove);
      failHist[b] = num(failHist[b]) - take;
      toRemove -= take;
    }
    const p50 = quantile(t.ok_hist, 0.5);
    const p90 = quantile(t.ok_hist, 0.9);
    const p95 = quantile(t.ok_hist, 0.95);
    const p99 = quantile(t.ok_hist, 0.99);
    // The cap the hidden timeouts hit (some synthesized results carry no duration: no cap known).
    const cap = hidden && num(t.hidden_max_ms) > 0 ? num(t.hidden_max_ms) : null;
    const current = cap || Math.max(num(t.max_ms), hi(EDGES.length));
    const eCur = expectedWait(t.ok_hist, failHist, hidden, current);
    let best = null;
    // Candidates: bucket edges at or above 1.5× p95 (never cut normal slow successes) and ≥ 5 s.
    for (const e of EDGES.map((x) => x * 1000).filter((x) => x >= Math.max(5000, 1.5 * (p95 || 0)) && x < current)) {
      const ew = expectedWait(t.ok_hist, failHist, hidden, e);
      if (!best || ew < best.e) best = { tau: e, e: ew };
    }
    const succPerWeek = okN * weekF;
    const savedMs = best && Number.isFinite(eCur) && best.e < eCur * 0.95 ? (eCur - best.e) * succPerWeek : 0;
    const heavyTail = p50 && p99 / p50 > 5 && okN >= 30;
    out.push({
      key: hashKey(keyOf(t.tool, t.method, t.model, t.size)),
      tool: t.tool,
      method: t.method || '',
      model: t.model || '',
      size: t.size || '',
      calls,
      callsPerWeek: calls * weekF,
      fails: num(t.fails),
      hidden,
      interrupted: num(t.interrupted),
      p50,
      p90,
      p95,
      p99,
      max: num(t.max_ms),
      okHist: t.ok_hist,
      failHist,
      cap,
      capRange: cap ? [num(t.hidden_min_ms) || cap, cap] : null,
      eCurrent: Number.isFinite(eCur) ? eCur : null,
      recommend: savedMs > 0 && (hidden > 0 || (heavyTail && p50 >= 2000 && savedMs / H >= 0.5)) ? { tau: best.tau, e: best.e, savedHPerWeek: savedMs / H } : null,
      retries: num(t.retries),
      retryOk: num(t.retry_ok),
      retryGapAvg: num(t.retries) ? num(t.retry_gap_ms) / num(t.retries) : null,
      unrecovered: num(t.unrecovered),
      waitHPerWeek: (num(t.ok_ms) + num(t.bad_ms)) / H * weekF,
      owners: topEntries(t.owners, 5),
      maxShapes: t.maxShapes,
      heavyTail,
      reattach: hidden > 0,
      basis: 'Recommended wait minimizes E(τ) = E[min(T, τ)] ÷ P(T ≤ τ) over measured durations, treating a retry as an independent fresh try and hidden timeouts as jobs that would not have finished. Never below 1.5× the p95 of successes.',
    });
  }
  return out.sort((a, b) => (b.recommend?.savedHPerWeek || 0) - (a.recommend?.savedHPerWeek || 0) || b.hidden - a.hidden || b.waitHPerWeek - a.waitHPerWeek);
}

// ---- opportunities: where the agent works harder than it needs to ----
// Observations only. An audit against the codex and the raw calls (2026-10-07) found the saving
// estimates unproven and several premises wrong, so these kinds were removed: "same call every
// time" (identical arguments, different answers: ListCosts returns each user's credits), "file
// busywork" (most re-reads are project state that must be re-read), "let the tool fix it" (the
// agent's retries changed the inputs, it didn't repeat a slip), "re-attach" (the agent already
// re-polls the same job) and "always loaded together" (co-loads changed with preloading). What's
// left states what was measured and what would prove a change helps; no hours are claimed.
function opportunities(c, skills, waits, issues, totals, weekF, pairs, codex) {
  const out = [];
  const turnsRow = (skill) => c.chains.get(keyOf(skill, 'turns', ''));

  // 1. Fixed chains → a scripted pipeline / macro tool.
  for (const ch of [...c.chains.values()].filter((x) => x.kind === 'chain')) {
    const steps = ch.k.split(' › ');
    const all = turnsRow(ch.owner);
    const share = all && num(all.turns) ? num(ch.turns) / num(all.turns) : 0;
    if (steps.length < 3 || num(ch.turns) * weekF < 20 || share < 0.15 || ch.owner === NO_SKILL) continue;
    // A chain that waits on the user or a sub-agent can't be one scripted step.
    if (steps.some((x) => /ask_user|\btask\b/.test(x))) continue;
    const iterPerTurn = num(ch.iterations) / num(ch.turns);
    // A macro tool still needs ~2 model iterations: decide the inputs, then answer.
    const errRate = num(ch.with_errors) / num(ch.turns);
    out.push({
      id: `chain:${ch.owner}:${hashKey(ch.k)}`,
      kind: 'fixed-chain',
      title: `Make "${steps.slice(0, 4).join(' → ')}${steps.length > 4 ? ' → …' : ''}" one deterministic step`,
      skill: ch.owner,
      detail: `${Math.round(share * 100)}% of ${ch.owner}'s turns run this exact chain of ${steps.length} steps, taking ${iterPerTurn.toFixed(1)} model iterations each (measured).`,
      unproven: 'How many iterations one step would save isn\'t measured: turns that already use `sequence` save about 1.6, not the ~' + Math.max(0, iterPerTurn - 2).toFixed(1) + ' a naive count suggests. Compare this chain\'s turns with and without `sequence` before changing the skill.',
      evidence: [`${Math.round(num(ch.turns) * weekF)} turns/week · ${num(ch.sessions)} sessions in the period`, `chain: ${ch.k}`, `${(num(ch.in_tokens) / Math.max(1, num(ch.iterations)) / 1000).toFixed(0)}k input tokens per iteration`],
      savings: { iterationsPerWeek: 0, hPerWeek: 0, tokensPerWeek: 0, turnsPerWeek: num(ch.turns) * weekF },
      confidence: 'observation',
      guard: errRate > 0.2 ? `${Math.round(errRate * 100)}% of these turns hit an error — fix the failing step first, then script it.` : null,
      chain: steps,
    });
  }

  // 6. Rubber-stamp turns: the user only says "yes / ok" after the agent asks.
  for (const s of skills.filter((x) => x.major)) {
    const rows = [...c.chains.values()].filter((x) => x.kind === 'affirm' && x.owner === s.skill);
    const n = sumBy(rows, (x) => x.turns);
    const asked = sumBy(rows, (x) => x.plumbing); // prev_asked count (see chainsQuery)
    const tr = turnsRow(s.skill);
    if (!tr || n * weekF < 10 || n / num(tr.turns) < 0.05) continue;
    const after = rows.sort((a, b) => num(b.turns) - num(a.turns))[0];
    const turnMs = sumBy(rows, (x) => x.turn_ms) / Math.max(1, n);
    out.push({
      id: `approve:${s.skill}`,
      kind: 'rubber-stamp',
      title: `${Math.round((n / num(tr.turns)) * 100)}% of ${s.skill}'s turns are just the user saying "yes"`,
      skill: s.skill,
      detail: `${asked ? `${Math.round((asked / n) * 100)}% follow an explicit question. ` : ''}Most often after ${after?.k || 'a plan'}. If the answer is nearly always yes, proceed by default and let users opt in to approve.`,
      evidence: [`${Math.round(n * weekF)} turns/week`, `each costs a user round trip plus ${(turnMs / 1000).toFixed(0)} s of agent time`],
      savings: { iterationsPerWeek: 0, hPerWeek: 0, tokensPerWeek: 0 },
      confidence: 'observation',
      unproven: 'How often users say yes when asked isn\'t measured, nor whether the next step spends credits. Proceeding by default is only safe when the answer is nearly always yes and the step is free.',
      guard: 'Approvals protect spend (credits) — keep them where the next step is expensive.',
    });
  }

  // 7. Heavy context: tokens per iteration well above the fleet's.
  const tpis = skills.filter((x) => x.major && x.tokensPerIter).map((x) => x.tokensPerIter).sort((a, b) => a - b);
  const median = tpis[Math.floor(tpis.length / 2)] || 0;
  for (const s of skills.filter((x) => x.major && x.tokensPerIter > median * 1.4)) {
    const iters = s.iterPerTurn * s.turns * weekF;
    const extra = (s.tokensPerIter - median) * iters;
    out.push({
      id: `context:${s.skill}`,
      kind: 'context',
      title: `${s.skill} carries ${Math.round(s.tokensPerIter / 1000)}k tokens into every iteration (fleet median ${Math.round(median / 1000)}k)`,
      skill: s.skill,
      detail: 'Every model iteration re-reads the whole context. Trim the skill and resources it loads, move rarely-needed sections to files read on demand, and summarize long tool results.',
      evidence: [`${Math.round(iters).toLocaleString()} iterations a week`, codex?.skillSize?.[s.skill] ? `skill file ~${Math.round(codex.skillSize[s.skill] / 4 / 1000)}k tokens` : null].filter(Boolean),
      savings: { iterationsPerWeek: 0, hPerWeek: 0, tokensPerWeek: extra },
      confidence: 'observation',
      unproven: 'Which part of the context could go isn\'t known from these numbers; read the skill and its resources first.',
      guard: 'Most of it is cached input; the saving is mostly latency and cache misses, not list price.',
    });
  }

  // 8. Trial and error: many more generations per kept output than the fleet's norm.
  const gpk = skills.filter((x) => x.major && x.gensPerKept != null && x.kept * weekF >= 20).map((x) => x.gensPerKept).sort((a, b) => a - b);
  const gpkMedian = gpk[Math.floor(gpk.length / 2)] || 0;
  for (const s of skills.filter((x) => x.major && x.gensPerKept != null && x.kept * weekF >= 20 && x.gensPerKept >= gpkMedian * 1.8 && x.gensPerKept >= 4)) {
    const extra = (s.gensPerKept - gpkMedian) * s.kept * weekF;
    out.push({
      id: `churn:${s.skill}`,
      kind: 'trial-and-error',
      title: `${s.skill} takes ${s.gensPerKept.toFixed(1)} generations per kept output (fleet median ${gpkMedian.toFixed(1)})`,
      skill: s.skill,
      detail: 'Users regenerate a lot before they keep something. Look at what the first results miss (Autopsy → the skill\'s runs with many generations): offer variations up front, ask the one question that matters before generating, or fix the prompt the skill writes.',
      evidence: [`${pct(s.keptRate)} of sessions with output are kept`, `${Math.round(s.kept * weekF)} kept outputs a week`],
      savings: { iterationsPerWeek: extra, hPerWeek: 0, tokensPerWeek: 0 },
      confidence: 'observation',
      unproven: 'Why users regenerate isn\'t in these numbers; open the runs with many generations first.',
      guard: 'Some skills are exploratory by design (variations are the product) — compare with thumbs and frustration first.',
      unit: 'generations',
    });
  }

  return out.sort((a, b) => (b.savings.turnsPerWeek || b.savings.iterationsPerWeek || 0) - (a.savings.turnsPerWeek || a.savings.iterationsPerWeek || 0) || b.savings.tokensPerWeek - a.savings.tokensPerWeek);
}
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

// ---- data health ----
function health(files, days, c) {
  return days.map((day) => {
    const f = files.find((x) => x.day === day);
    if (!f) return { day, present: false };
    const none = (f.usage || []).find((r) => r.owner === NO_SKILL && !r.tool && r.aud === 'real');
    const all = (f.usage || []).filter((r) => !r.tool && r.aud === 'real');
    const sessions = sumBy(all, (r) => r.sessions);
    const tCalls = sumBy(f.timing || [], (r) => r.calls);
    const timed = sumBy(f.timing || [], (r) => histN(r.ok_hist) + histN(r.bad_hist));
    return {
      day,
      present: true,
      final: f.final,
      builtAt: f.builtAt,
      buildMs: f.buildMs,
      ctxId: f.ctxId,
      errors: f.errors,
      internal: f.internal,
      noSkillShare: sessions ? num(none?.sessions) / sessions : null,
      timedShare: tCalls ? timed / tCalls : null,
      rows: { usage: f.usage?.length, timing: f.timing?.length, failures: f.failures?.length, chains: f.chains?.length },
      foldedFailures: sumBy((f.failures || []).filter((r) => r.sig === '(other errors)'), (r) => r.n),
    };
  });
}

// ---- what users ask for, and how it ends ----
// Skills whose result isn't an asset in the project (a website, a site API call, an answer) look
// like "no output" by this measure; they're marked so nobody reads that as failure.
const NON_ASSET = ['website-create', 'wix-explorer', 'wix-apis', 'publish-social-post', 'social-media-audit'];
function intentRows(c, totals, weekF) {
  const fleetKept = totals.produced ? totals.kept / totals.produced : 0;
  const fleetUpset = sumBy([...c.intents.values()], (x) => x.upset) / Math.max(1, sumBy([...c.intents.values()], (x) => x.sessions));
  return [...c.intents.values()].filter((x) => num(x.sessions) * weekF >= 7).map((x) => {
    const owners = topEntries(x.owners, 3);
    const sessions = num(x.sessions);
    const keptRate = num(x.produced) ? num(x.kept) / num(x.produced) : null;
    const upsetRate = sessions ? num(x.upset) / sessions : 0;
    const nonAsset = owners.length && NON_ASSET.includes(owners[0][0]);
    const flags = [];
    if (!nonAsset && keptRate != null && num(x.produced) * weekF >= 20 && keptRate < fleetKept * 0.6) flags.push('few outputs kept');
    if (sessions * weekF >= 20 && upsetRate > fleetUpset * 1.5) flags.push('users upset');
    if (!nonAsset && sessions * weekF >= 20 && num(x.tried_no_output) / sessions > 0.25) flags.push('tried, no output');
    return {
      intent: x.intent,
      sessions,
      perWeek: sessions * weekF,
      producedRate: sessions ? num(x.produced) / sessions : null,
      keptRate,
      noOutputRate: sessions ? num(x.tried_no_output) / sessions : null,
      upsetRate,
      gensPerSession: sessions ? num(x.generations) / sessions : null,
      owners,
      nonAsset,
      flags,
    };
  }).sort((a, b) => b.sessions - a.sessions);
}

// ---- what changed: day-over-day shifts against the days before, and the codex versions that
// went live that day (the in-app version of "alert me after a deploy") ----
function shifts(perDay) {
  const days = perDay.filter((d) => d.turns > 0).sort((a, b) => a.day.localeCompare(b.day));
  const metric = {
    'Failing tool calls': { f: (d) => (d.calls ? (d.fails - (d.creditFails || 0)) / d.calls : null), fmt: 'pct', worse: 'up', min: 0.01 },
    'Sessions with no skill': { f: (d) => (d.sessions ? (d.noSkill || 0) / d.sessions : null), fmt: 'pct', worse: 'up', min: 0.05, note: 'attribution: check how skills reach the agent (tool call vs preload)' },
    'Input tokens / iteration': { f: (d) => (d.iterations ? d.inTokens / d.iterations : null), fmt: 'k', worse: 'up', min: 5000 },
    'Model iterations / turn': { f: (d) => (d.turns ? d.iterations / d.turns : null), fmt: 'x', worse: 'up', min: 0.5 },
    'Hidden timeouts / 1k turns': { f: (d) => (d.turns ? (d.hidden / d.turns) * 1000 : null), fmt: 'x', worse: 'up', min: 1 },
    'Frustrated turns': { f: (d) => (d.turns ? d.frustrated / d.turns : null), fmt: 'pct', worse: 'up', min: 0.01 },
    'Outputs kept': { f: (d) => (d.produced ? d.kept / d.produced : null), fmt: 'pct', worse: 'down', min: 0.04 },
    Sessions: { f: (d) => d.sessions, fmt: 'n', worse: 'down', min: 200 },
  };
  const out = [];
  for (let i = 3; i < days.length; i++) {
    const d = days[i];
    if (d.final === false) continue;
    const before = days.slice(Math.max(0, i - 7), i);
    const vBefore = new Set(before.flatMap((b) => Object.keys(b.versions || {}).filter((v) => (b.versions[v] || 0) / Math.max(1, b.turns) >= 0.05)));
    const newVersions = Object.entries(d.versions || {}).filter(([v, n]) => n / Math.max(1, d.turns) >= 0.2 && !vBefore.has(v)).map(([v, n]) => ({ ver: v, share: n / Math.max(1, d.turns) }));
    for (const [name, m] of Object.entries(metric)) {
      const cur = m.f(d);
      const prev = before.map(m.f).filter((x) => x != null).sort((a, b) => a - b);
      if (cur == null || prev.length < 3) continue;
      const med = prev[Math.floor(prev.length / 2)];
      const spread = Math.max(m.min, (prev.at(-1) - prev[0]) / 2);
      const rel = med ? (cur - med) / med : 0;
      if (Math.abs(cur - med) < 2 * spread || Math.abs(rel) < 0.3) continue;
      out.push({ day: d.day, metric: name, from: med, to: cur, fmt: m.fmt, worse: (m.worse === 'up') === cur > med, note: m.note || null, newVersions });
    }
    if (newVersions.length && !out.some((x) => x.day === d.day)) out.push({ day: d.day, metric: 'New codex version', from: null, to: null, fmt: null, worse: false, newVersions, note: 'no metric moved beyond its normal range' });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}

// ---- the whole view ----
// ---- efficiency: models, context, reads, and what the agent does around failures ----
// Per skill, from the models / reads / follow-ups parts (only the days that have them, scaled to a
// week). Tokens from characters are estimates (≈4 characters a token); model tokens are measured.
const CHARS_PER_TOKEN = 4;
function efficiency(c, skills, codex) {
  const wf = c.effDays ? 7 / c.effDays : 0;
  const byOwner = (map) => {
    const g = new Map();
    for (const x of map.values()) {
      if (!g.has(x.owner)) g.set(x.owner, []);
      g.get(x.owner).push(x);
    }
    return g;
  };
  const sum = (xs, k) => xs.reduce((a, x) => a + num(x[k]), 0);
  const tally = (xs, k) => Object.fromEntries([...xs.reduce((m, x) => m.set(x[k], (m.get(x[k]) || 0) + num(x.n)), new Map())].sort((a, b) => b[1] - a[1]));
  const M = byOwner(c.models);
  const R = byOwner(c.reads);
  const F = byOwner(c.followups);
  const fleet = new Map();
  const rows = [];
  for (const s of skills) {
    const ms = M.get(s.skill) || [];
    const rs = R.get(s.skill) || [];
    const fu = F.get(s.skill) || [];
    if (!ms.length && !rs.length && !fu.length) continue;
    const it = sum(ms, 'iterations');
    const turns = sum(ms, 'turns');
    for (const m of ms) {
      const f = fleet.get(m.model) || { model: m.model, iterations: 0, in_tokens: 0, out_tokens: 0, think_ms: 0, fails: 0, skills: 0 };
      for (const k of ['iterations', 'in_tokens', 'out_tokens', 'think_ms', 'fails']) f[k] += num(m[k]);
      f.skills++;
      fleet.set(m.model, f);
    }
    const models = ms.map((m) => {
      const n = Math.max(1, num(m.iterations));
      return { model: m.model, iterations: num(m.iterations) * wf, share: num(m.iterations) / Math.max(1, it), tokPerIter: num(m.in_tokens) / n, outPerIter: num(m.out_tokens) / n, thinkPerIter: num(m.think_ms) / n, failRate: num(m.fails) / n, maxIn: num(m.max_in) };
    }).sort((a, b) => b.iterations - a.iterations);
    const pre = rs.find((r) => r.tool === 'preload');
    const files = rs.filter((r) => r.tool !== 'preload').map((r) => ({
      tool: r.tool, file: r.file, reads: num(r.reads) * wf, tokens: (num(r.chars) / CHARS_PER_TOKEN) * wf, perRead: num(r.chars) / CHARS_PER_TOKEN / Math.max(1, num(r.reads)),
      rereads: num(r.rereads) * wf, rereadTokens: (num(r.reread_chars) / CHARS_PER_TOKEN) * wf, fails: num(r.fails) * wf, example: r.example || null,
    })).sort((a, b) => b.tokens - a.tokens);
    const fails = fu.filter((x) => x.kind === 'fail');
    const byOp = new Map();
    for (const x of fails) {
      const k = keyOf(x.tool, x.method);
      const o = byOp.get(k) || { tool: x.tool, method: x.method, n: 0, ms: 0, next: {}, prev: {} };
      o.n += num(x.n) * wf;
      o.ms += num(x.ms) * wf;
      o.next[x.next] = (o.next[x.next] || 0) + num(x.n) * wf;
      o.prev[x.prev] = (o.prev[x.prev] || 0) + num(x.n) * wf;
      byOp.set(k, o);
    }
    const kindRows = (kind) => fu.filter((x) => x.kind === kind).map((x) => ({ tool: x.tool, method: x.method, n: num(x.n) * wf, ms: num(x.ms) * wf, gapMs: num(x.gap_ms) * wf })).sort((a, b) => b.n - a.n);
    const repeats = kindRows('repeat');
    const polls = kindRows('poll');
    const readTokens = sum(files, 'tokens');
    const rereadTokens = sum(files, 'rereadTokens');
    const tokPerIter = it ? sum(ms, 'in_tokens') / it : null;
    const preloadTokens = pre ? num(pre.chars) / CHARS_PER_TOKEN / Math.max(1, num(pre.reads)) : null;
    rows.push({
      skill: s.skill, major: s.major, sessions: s.sessions,
      iterationsPerWeek: it * wf, iterPerTurn: turns ? it / turns : null,
      tokPerIter, cachedShare: sum(ms, 'in_tokens') ? sum(ms, 'cached_tokens') / sum(ms, 'in_tokens') : null,
      outPerIter: it ? sum(ms, 'out_tokens') / it : null, thinkPerIter: it ? sum(ms, 'think_ms') / it : null,
      inTokensPerWeek: sum(ms, 'in_tokens') * wf, modelFails: sum(ms, 'fails') * wf,
      models, mainModel: models[0]?.model || null,
      preloadTokens, preloadShare: preloadTokens && tokPerIter ? preloadTokens / tokPerIter : null, preloadsPerWeek: pre ? num(pre.reads) * wf : 0,
      skillFileTokens: codex?.skillSize?.[s.skill] ? codex.skillSize[s.skill] / CHARS_PER_TOKEN : null,
      files: files.slice(0, 60), readsPerWeek: sum(files, 'reads'), readTokensPerWeek: readTokens, readTokensPerTurn: turns ? (readTokens / wf) / turns : null,
      rereadShare: readTokens ? rereadTokens / readTokens : null, rereadTokensPerWeek: rereadTokens, rereadsPerWeek: sum(files, 'rereads'), readFailsPerWeek: sum(files, 'fails'),
      failuresPerWeek: sum(fails, 'n') * wf, failNext: Object.fromEntries(Object.entries(tally(fails, 'next')).map(([k, v]) => [k, v * wf])), failPrev: Object.fromEntries(Object.entries(tally(fails, 'prev')).map(([k, v]) => [k, v * wf])),
      failOps: [...byOp.values()].sort((a, b) => b.n - a.n).slice(0, 15),
      repeats: repeats.slice(0, 12), repeatCallsPerWeek: repeats.reduce((a, x) => a + x.n, 0), repeatHPerWeek: repeats.reduce((a, x) => a + x.ms, 0) / H,
      polls: polls.slice(0, 8), pollsPerWeek: polls.reduce((a, x) => a + x.n, 0), pollWaitHPerWeek: polls.reduce((a, x) => a + x.gapMs, 0) / H,
    });
  }
  const totalIt = [...fleet.values()].reduce((a, m) => a + m.iterations, 0);
  const models = [...fleet.values()].map((m) => ({ model: m.model, iterations: m.iterations * wf, share: m.iterations / Math.max(1, totalIt), tokPerIter: m.in_tokens / Math.max(1, m.iterations), outPerIter: m.out_tokens / Math.max(1, m.iterations), thinkPerIter: m.think_ms / Math.max(1, m.iterations), failRate: m.fails / Math.max(1, m.iterations), skills: m.skills })).sort((a, b) => b.iterations - a.iterations);
  return { days: c.effDays, models, skills: rows };
}

export function analyze({ files, prevFiles, days, prevDays, aud = 'real', state = {}, pairs = [], codex = null, majorPerWeek = 50 }) {
  const c = collect(files, aud);
  const prev = prevFiles?.length ? collect(prevFiles, aud) : null;
  const coveredDays = files.length;
  const weekF = coveredDays ? 7 / coveredDays : 0;
  const totals = totalsOf(c);
  // The previous period only counts when it's mostly built; its totals are scaled to the same
  // number of days so a half-built comparison never reads as a 300% jump.
  const prevCovered = prevFiles?.length || 0;
  const comparable = Boolean(prev) && prevCovered >= Math.max(1, Math.ceil(coveredDays * 0.7));
  const scale = comparable ? coveredDays / prevCovered : 0;
  const prevRaw = comparable ? totalsOf(prev) : null;
  const prevTotals = comparable ? { ...Object.fromEntries(Object.entries(prevRaw).map(([k, v]) => [k, v * scale])), rawTurns: prevRaw.turns } : null;
  const turnsByVer = {};
  for (const s of c.summary.values()) for (const [v, n] of Object.entries(s.versions || {})) turnsByVer[v] = (turnsByVer[v] || 0) + num(n);
  const issues = issueRows(c, prev, totals, prevTotals, weekF, coveredDays, prevCovered, state, turnsByVer);
  const issuesBySkill = new Map();
  for (const i of issues) for (const o of i.owners) {
    if (!issuesBySkill.has(o.skill)) issuesBySkill.set(o.skill, []);
    issuesBySkill.get(o.skill).push(i);
  }
  const skills = skillRows(comparable ? c : c, comparable ? prev : null, issuesBySkill, weekF, { majorPerWeek, pins: state.pins || [], prevScale: scale });
  // Per skill: the tools it calls and its most common work chains (for the skill panel).
  for (const s of skills) {
    s.ops = [...c.usage.values()].filter((u) => u.owner === s.skill && u.tool !== '(other)').sort((a, b) => num(b.calls) - num(a.calls)).slice(0, 18)
      .map((u) => ({ tool: u.tool, method: u.method, calls: num(u.calls), fails: num(u.fails), hidden: num(u.hidden), lostH: (num(u.lost_ms) / H) * weekF, maxShapes: u.maxShapes }));
    s.chains = [...c.chains.values()].filter((x) => x.kind === 'chain' && x.owner === s.skill).sort((a, b) => num(b.turns) - num(a.turns)).slice(0, 6)
      .map((x) => ({ k: x.k, turns: num(x.turns), iterations: num(x.iterations), withErrors: num(x.with_errors) }));
  }
  const waits = waitRows(c, weekF);
  const opps = opportunities(c, skills, waits, issues, totals, weekF, pairs, codex);
  for (const o of opps) o.status = state.opportunities?.[o.id] || null;

  // The biggest problems by measured time lost (not "hours given back": whether a fix gives the
  // time back is only known once a fix is proven, per skill — see fleet-skillfix.js).
  const actions = issues
    .filter((i) => i.cls.id !== 'credits' && i.cls.id !== 'hidden-timeout' && !['fixed', 'wontfix', 'duplicate'].includes(i.status?.status))
    .sort((a, b) => b.lostHPerWeek - a.lostHPerWeek).slice(0, 10)
    .map((i) => ({ kind: 'issue', ref: i.key, title: i.sig, sub: `${i.cls.label} · ${i.method || i.tool} · ${i.owners.slice(0, 2).map((o) => o.skill).join(', ')}`, hPerWeek: i.lostHPerWeek, fix: i.cls.fix, owner: i.cls.owner }));

  return {
    aud,
    period: { days, have: files.map((f) => f.day).sort(), prevDays, prevHave: (prevFiles || []).map((f) => f.day).sort(), weekFactor: weekF, comparable },
    totals,
    prevTotals,
    daily: c.perDay.sort((a, b) => a.day.localeCompare(b.day)),
    skills,
    issues: issues.slice(0, 300),
    otherErrors: [...c.failures.values()].filter((x) => x.sig === '(other errors)').reduce((a, x) => a + num(x.n), 0),
    waits: waits.slice(0, 200),
    opportunities: opps,
    actions,
    health: health(files, days, c),
    shifts: shifts(c.perDay),
    intents: intentRows(c, totals, weekF).slice(0, 80),
    efficiency: efficiency(c, skills, codex),
    edges: EDGES,
  };
}
