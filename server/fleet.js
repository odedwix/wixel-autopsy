// Fleet: every major skill at once — what fails most, what it costs, what's easy to fix, where
// the agent works harder than it needs to, and how long each operation really takes.
//
// Built from daily rollups (fleet-queries.js): a few small Trino queries per UTC day for all
// skills together, stored as one file per day in FLEET_DIR (default .fleet/, can be a shared
// folder so one producer serves a whole team). Closed days are final and never re-queried; today
// refreshes at most every 30 minutes. Periods (day / week / month) are sums of day files.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sql } from './admin.js';
import { config } from './config.js';
import { cached } from './cache.js';
import { inBackground } from './context.js';
import { backoffRemaining } from './limits.js';
import { redact } from './redact.js';
import { skillPairs, familyFor, resolveUserTypes } from './runs.js';
import { FLEET_QUERY_VERSION, usageQuery, timingQuery, failuresQuery, chainsQuery, outcomesQuery, dayAccountsQuery, modelsQuery, readsQuery, followupsQuery } from './fleet-queries.js';

const DAY = 86400000;
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const hash = (x) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 10);

export const fleetDir = () => path.resolve(config.root, process.env.FLEET_DIR || '.fleet');

// ---- attribution context: which skills are helpers, and each skill's family ----
// Helpers never lead a turn: hubs, utilities co-loaded with many skills and relied on by many
// (site-content, wix-apis). Sub-steps don't need to be helpers: a turn's lead is the FIRST skill it
// loads (the product loads before its engine: business-card, then single-page-design), and a turn
// that loads only a sub-step (video-plan-approval) stays with the session's root when it's in the
// root's family. Pinned for 30 days, like families, so day files stay comparable; each day file
// records the context it was built with.
export function attributionContext() {
  return cached('meta', 'fleet-ctx-v2', 30 * DAY, async () => {
    const pairs = await skillPairs();
    const of = new Map();
    for (const p of pairs) {
      const list = of.get(p.a) || [];
      list.push({ skill: p.b, share: Number(p.together) / Number(p.a_turns), turns: Number(p.a_turns) });
      of.set(p.a, list);
    }
    const turnsOf = (x) => of.get(x)?.[0]?.turns || 0;
    const shareOf = (x, y) => (of.get(x) || []).find((p) => p.skill === y)?.share || 0;
    const partners = (x, min) => (of.get(x) || []).filter((p) => p.share >= min);
    const reliedOn = (x) => [...of.keys()].filter((y) => y !== x && turnsOf(y) >= 100 && shareOf(y, x) >= 0.03).length;
    const hubs = [...of.keys()].filter((x) => partners(x, 0.03).length >= 5 && reliedOn(x) >= 8);
    const helpers = [...hubs].sort();
    const famPairs = [];
    const families = {};
    for (const s of [...of.keys()].filter((x) => !helpers.includes(x)).sort()) {
      const fam = (await familyFor(s)).family.filter((m) => !helpers.includes(m));
      families[s] = fam;
      for (const m of fam) famPairs.push(`${s}>${m}`);
    }
    const value = { helpers, famPairs, families, computedAt: Date.now() };
    value.id = hash(JSON.stringify([helpers, famPairs]));
    return { value, ttlMs: 30 * DAY };
  });
}

// ---- day files ----
// One JSON per UTC day: { day, version, ctxId, builtAt, final, internal, usage, timing, failures,
// chains }. A day is final 6 hours after it ends (entries are written live; the margin covers late
// ingestion). Writes are atomic (temp + rename) so a shared folder never shows half a file.
const FINAL_AFTER_MS = 6 * 3600000;
const REFRESH_MS = 30 * 60000;
const readOnly = () => process.env.FLEET_READONLY === '1';
const dayFile = (day) => path.join(fleetDir(), 'days', `${day}.json`);
export const isFinal = (day) => Date.parse(`${day}T00:00:00Z`) + DAY + FINAL_AFTER_MS < Date.now();

export async function readDay(day) {
  try {
    const d = JSON.parse(await fs.readFile(dayFile(day), 'utf8'));
    return d.version === FLEET_QUERY_VERSION ? d : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

// Each part of a day file (one query) has its own version, so a new or changed query only re-runs
// that query on days already built. Files from before part versions carry the first four at v1.
const PARTS = {
  usage: { make: usageQuery, v: 2, keys: ['owner', 'aud', 'tool', 'method'] },
  timing: { make: timingQuery, v: 1, keys: ['tool', 'method', 'model', 'size'] },
  failures: { make: failuresQuery, v: 2, keys: ['owner', 'aud', 'tool', 'method', 'sig'] },
  chains: { make: chainsQuery, v: 1, keys: ['owner', 'aud', 'kind', 'k'] },
  outcomes: { make: outcomesQuery, v: 3, keys: ['owner', 'intent', 'aud'], wholeDay: true },
  // Efficiency: which model runs each skill, what the agent reads, and what it does around a failure.
  models: { make: modelsQuery, v: 1, keys: ['owner', 'aud', 'model', 'purpose'] },
  reads: { make: readsQuery, v: 1, keys: ['owner', 'aud', 'tool', 'file'] },
  followups: { make: followupsQuery, v: 1, keys: ['owner', 'aud', 'kind', 'tool', 'method', 'prev', 'next'] },
};
const partsOf = (d) => d.parts || { usage: 1, timing: 1, failures: 1, chains: 1 };
const staleParts = (d) => Object.keys(PARTS).filter((k) => partsOf(d)[k] !== PARTS[k].v);
// A day file is usable as-is when every part is current and it's final (or fresh enough for a day
// still filling up).
const usable = (d) => d && !staleParts(d).length && (d.final || Date.now() - d.builtAt < REFRESH_MS);
export const dayNeedsWork = (d) => staleParts(d).length > 0;

// Rows from hour windows of the same query merge by key: numbers add, histograms add per bucket,
// example lists concatenate (capped), anything else keeps the first value.
// Extremes keep the extreme; distinct counts from separate windows can only be bounded, so keep the
// larger (an undercount, never a double count).
const MERGE_MAX = new Set(['max_ms', 'hidden_max_ms', 'shapes', 'vals', 'accounts', 'users', 'max_in']);
const MERGE_MIN = new Set(['hidden_min_ms']);
export function mergeInto(target, row, keyFields) {
  for (const [k, v] of Object.entries(row)) {
    if (keyFields.includes(k)) continue;
    const cur = target[k];
    if (v == null) continue;
    if (cur == null) target[k] = Array.isArray(v) ? [...v] : typeof v === 'object' ? { ...v } : v;
    else if (MERGE_MAX.has(k)) target[k] = Math.max(Number(cur), Number(v));
    else if (MERGE_MIN.has(k)) target[k] = Math.min(Number(cur), Number(v));
    else if (typeof v === 'number' && typeof cur === 'number') target[k] = cur + v;
    else if (Array.isArray(v)) target[k] = [...cur, ...v].slice(0, 8);
    else if (typeof v === 'object') for (const [b, c] of Object.entries(v)) cur[b] = (cur[b] || 0) + Number(c);
  }
  return target;
}
export function mergeRows(rows, keyFields) {
  const m = new Map();
  for (const r of rows) {
    const key = keyFields.map((k) => r[k] ?? '').join('\u0001');
    if (!m.has(key)) m.set(key, Object.fromEntries(keyFields.map((k) => [k, r[k] ?? ''])));
    mergeInto(m.get(key), r, keyFields);
  }
  return [...m.values()];
}

// A query too heavy for the endpoint's 30s is split into hour windows (halving down to 3h).
async function sliced(make, keyFields, hours = [0, 24]) {
  try {
    return await sql(make(hours), { maxRows: 1500 });
  } catch (err) {
    if (!/timed out/.test(err.message) || hours[1] - hours[0] <= 3) throw err;
    const mid = Math.floor((hours[0] + hours[1]) / 2);
    const [a, b] = await Promise.all([sliced(make, keyFields, [hours[0], mid]), sliced(make, keyFields, [mid, hours[1]])]);
    return mergeRows([...a, ...b], keyFields);
  }
}

// Internal accounts active on a day (employees, Wixel team): the day's accounts from one cheap
// query, classified with the shared per-account cache (only accounts never seen before are looked
// up, in batches saved as they land). If some can't be classified now, the day says so and isn't
// final; what's resolved so far is kept for the next try.
async function internalFor(day) {
  return cached('fleet-internal', `v2__${day}`, isFinal(day) ? Infinity : REFRESH_MS, async () => {
    const [row] = await sql(dayAccountsQuery({ day }), { maxRows: 500 });
    const accounts = String(row?.accounts || '').split(',').filter(Boolean);
    let typeOf;
    let error = null;
    try {
      typeOf = await resolveUserTypes(accounts);
    } catch (err) {
      error = String(err.message || err).slice(0, 200);
      typeOf = await resolveUserTypes([]); // what the cache knows
    }
    const kinds = {};
    let unknown = 0;
    for (const a of accounts) {
      const t = typeOf(a);
      if (t === 'employee' || t === 'wixel-team') kinds[a] = t;
      else if (t === 'unknown') unknown++;
    }
    const value = { accounts: Object.keys(kinds), kinds, total: accounts.length, unknown, source: unknown ? 'partial' : 'lookup', error };
    // A partial result is never reused: the next build looks up the rest (resolved ones are cached).
    return { value, ttlMs: unknown ? 0 : isFinal(day) ? Infinity : REFRESH_MS };
  });
}

const inflight = new Map();

// Build (or rebuild) one day. Queries run one after another, so a day costs one Trino slot at a
// time. A final day whose file is current except for some parts only re-runs those parts.
export function buildDay(day, { force = false } = {}) {
  if (inflight.has(day)) return inflight.get(day);
  const p = (async () => {
    const t0 = Date.now();
    const final = isFinal(day);
    const ctx = await attributionContext();
    const have = force ? null : await readDay(day);
    const patch = have && have.final && have.ctxId === ctx.id;
    const todo = patch ? staleParts(have) : Object.keys(PARTS);
    const internal = await internalFor(day);
    const qctx = { ...ctx, internal: internal.accounts.slice(0, 1500) };
    const out = patch
      ? { ...have, errors: { ...have.errors }, parts: { ...partsOf(have) } }
      : { day, version: FLEET_QUERY_VERSION, ctxId: ctx.id, final, internal: { count: internal.accounts.length, total: internal.total, source: internal.source }, errors: {}, parts: {} };
    let busy = false;
    for (const name of todo) {
      const part = PARTS[name];
      // Trino timed out on an earlier part: don't add more load now; the day is retried later.
      if (busy) {
        out[name] ??= [];
        out.errors[name] = 'skipped: Trino was busy';
        continue;
      }
      const q0 = Date.now();
      try {
        // Whole-day parts can't be split into hours (their joins span the day): one retry after a
        // pause, since a timeout on the shared cluster is usually load, not the query.
        out[name] = part.wholeDay
          ? await sql(part.make({ day, ctx: qctx }), { maxRows: 1500 }).catch(async (err) => {
            if (!/timed out/.test(err.message)) throw err;
            await new Promise((r) => setTimeout(r, 15000));
            return sql(part.make({ day, ctx: qctx }), { maxRows: 1500 });
          })
          : await sliced((hours) => part.make({ day, hours, ctx: qctx }), part.keys);
        out.parts[name] = part.v;
        delete out.errors[name];
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (!patch || !Array.isArray(have?.[name])) out[name] = [];
        delete out.parts[name];
        out.errors[name] = String(err.message || err).slice(0, 300);
        // A timeout or a 5xx from the endpoint means the cluster (or its gateway) is struggling.
        if (/timed out|^5\d\d /.test(err.message)) busy = true;
      }
      out[`${name}Ms`] = Date.now() - q0;
    }
    // Day files are committed: example error texts lose emails, phone numbers and URL query strings.
    for (const r of [...(out.failures || []), ...(out.reads || [])]) if (r.example) r.example = redact(r.example);
    out.busy = busy;
    out.builtAt = Date.now();
    out.patchedAt = patch ? Date.now() : undefined;
    out.buildMs = (patch ? have.buildMs || 0 : 0) + (Date.now() - t0);
    // A day with a failed query (or whose internal-accounts lookup fell back to a cached list) isn't
    // stored as final: the next request tries again.
    if (internal.source !== 'lookup') out.errors.internal = `${internal.unknown} of ${internal.total} accounts not classified yet (${internal.error || 'lookup pending'}); counted as real users for now`;
    else delete out.errors.internal;
    out.final = final && !Object.keys(out.errors).length;
    await writeJsonAtomic(dayFile(day), out);
    return out;
  })().finally(() => inflight.delete(day));
  inflight.set(day, p);
  return p;
}

// ---- backfill: missing or stale days, newest first, one at a time in the background lane ----
const queue = { want: [], building: null, done: 0, failed: [], lastError: null, startedAt: null };
let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.want.length) {
      const wait = backoffRemaining('trino');
      if (wait > 0) {
        queue.waiting = Date.now() + wait;
        await new Promise((r) => setTimeout(r, wait + 30000));
        queue.waiting = null;
      }
      const day = queue.want.shift();
      queue.building = day;
      queue.startedAt ??= Date.now();
      try {
        const existing = await readDay(day);
        if (!usable(existing)) await inBackground(() => buildDay(day));
        queue.done++;
      } catch (err) {
        queue.failed.push(day);
        queue.lastError = String(err.message || err).slice(0, 200);
        console.error(`fleet: building ${day} failed: ${queue.lastError}`);
      }
    }
  } finally {
    queue.building = null;
    pumping = false;
  }
}

export function requestDays(days) {
  if (readOnly()) return;
  const sorted = [...new Set(days)].sort().reverse();
  for (const d of sorted) if (d !== queue.building && !queue.want.includes(d)) queue.want.push(d);
  queue.want.sort().reverse();
  pump();
}

export const backfillStatus = () => ({ queued: queue.want.length, building: queue.building, waitingForTrinoUntil: queue.waiting || null, done: queue.done, failed: queue.failed.slice(-10), lastError: queue.lastError, readOnly: readOnly(), dir: fleetDir() });

// Days of a period: `days` complete UTC days ending `end` (default yesterday), or today so far.
export function periodDays({ days = 7, end, today = false }) {
  if (today) return [utcDay(Date.now())];
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const last = end ? Date.parse(`${end}T00:00:00Z`) : Date.parse(`${utcDay(Date.now() - DAY)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => utcDay(last - i * DAY)).reverse();
}

// Load what's on disk for these days; queue the rest (and stale ones) for building.
export async function loadDays(days) {
  const files = await Promise.all(days.map(readDay));
  const need = days.filter((d, i) => !usable(files[i]));
  if (need.length) requestDays(need);
  return { files: files.filter(Boolean), missing: days.filter((d, i) => !files[i]), stale: days.filter((d, i) => files[i] && !usable(files[i])) };
}

// ---- the Fleet view: a period (and the one before it, for trends), analyzed ----
const views = new Map();
export async function fleetView({ days = 7, end, today = false, aud = 'real', compare = true }) {
  const { analyze } = await import('./fleet-analyze.js');
  const { readState } = await import('./fleet-brief.js');
  const { skillSizes } = await import('./codex.js');
  const cur = periodDays({ days, end, today });
  const prevEnd = utcDay(Date.parse(`${cur[0]}T00:00:00Z`) - DAY);
  const prev = compare ? periodDays({ days: cur.length, end: prevEnd }) : [];
  const a = await loadDays(cur);
  const b = compare ? await loadDays(prev) : { files: [], missing: [], stale: [] };
  const [state, pairs, sizes] = await Promise.all([readState(), skillPairs().catch(() => []), skillSizes().catch(() => ({}))]);
  const stamp = (f) => `${f.builtAt}:${JSON.stringify(f.parts || {})}`;
  const sig = JSON.stringify([aud, cur, prev, a.files.map(stamp), b.files.map(stamp), state]);
  const key = `${aud}|${cur[0]}|${cur.at(-1)}|${compare}`;
  const hit = views.get(key);
  let view;
  if (hit?.sig === sig) view = hit.view;
  else {
    view = analyze({ files: a.files, prevFiles: b.files, days: cur, prevDays: prev, aud, state, pairs, codex: { skillSize: sizes } });
    views.set(key, { sig, view });
    if (views.size > 20) views.delete(views.keys().next().value);
  }
  return { ...view, coverage: { missing: a.missing, stale: a.stale, prevMissing: b.missing }, backfill: backfillStatus(), state };
}

export async function fleetIssue(key, params) {
  const v = await fleetView(params);
  const issue = v.issues.find((i) => i.key === key);
  if (!issue) throw Object.assign(new Error('issue not in this period'), { status: 404 });
  return { issue, period: v.period, aud: v.aud };
}
