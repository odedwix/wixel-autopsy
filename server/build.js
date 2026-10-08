// The daily build's steps, shared by the command line (scripts/build-data.js) and the hosted copy's
// nightly tasks (serverless/index.js). Run inside produce() so queries go to Trino even in a copy
// that otherwise reads the build only. See server/snapshot.js for what's written where.
//
// A day is final 3 days after it ends (its sessions are read up to 2 days past the skill load);
// final days are never re-queried, so a nightly run builds yesterday and refreshes the two days
// before it. A day not final yet is kept if it was built in the last `freshMs`, so a rerun after a
// stop or a failure only queries what's missing.

import { requestContext } from './context.js';
import { backoffRemaining, isBusyError } from './limits.js';
import { listSkills, familyFor, runsIndex, runsForDay, sampleFor, skillPairs } from './runs.js';
import { prices } from './prices.js';
import { DATA_VERSION, famId, files, readJson, writeJsonAtomic, listKeys, deleteKey, utcDay } from './snapshot.js';

const DAY = 86400000;
export const FRESH_MS = 12 * 3600000;

// Current data from Trino: never a stale cached copy, and allowed in a read-only copy.
export const produce = (fn) => requestContext.run({ signal: undefined, priority: 'interactive', fresh: true, produce: true }, fn);

// `days` complete UTC days ending yesterday.
export function buildWindow(days, now = Date.now()) {
  const n = Math.max(1, Math.min(90, Number(days) || 30));
  const through = utcDay(now - DAY);
  const end = Date.parse(`${through}T00:00:00Z`);
  return { days: n, through, end, from: utcDay(end - (n - 1) * DAY) };
}

const isFinal = (day) => Date.parse(`${day}T00:00:00Z`) + 3 * DAY < Date.now();

// Skills worth building: ≥ minSessions in 30 days, or exactly `only`.
export async function skillsToBuild({ minSessions = 10, only = [] } = {}) {
  const all = await listSkills({ days: 30 });
  return all.filter((s) => (only.length ? only.includes(s.skill) : Number(s.sessions) >= minSessions));
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// The shared cluster is timing out (or its queue is full): wait it out rather than add load.
export async function calm(log = console.log) {
  const wait = backoffRemaining('trino');
  if (wait <= 0) return;
  log(`  Trino is busy — waiting ${Math.round(wait / 1000) + 30}s`);
  await new Promise((r) => setTimeout(r, wait + 30000));
}

// User mode: which built skills each session is in, per day (run rows carry no user id; the admin
// API lists a user's sessions and this says where to find them). Updated for one skill-day at a time.
async function indexSessions(skill, day, runs) {
  const key = files.sessions(day);
  const map = (await readJson(key)) || {};
  for (const [id, skills] of Object.entries(map)) {
    const rest = skills.filter((s) => s !== skill);
    if (rest.length) map[id] = rest;
    else delete map[id];
  }
  for (const r of runs) (map[r.id] ||= []).push(skill);
  await writeJsonAtomic(key, map);
}

// One skill: every day in the window that's missing, stale or not final (and not freshly built).
// `deadline` (ms timestamp): stop starting new days after it and report `done: false`, so a hosted
// task can hand the rest to its next run. The skill's index is written once every day is handled.
export async function buildSkill(skill, win, { force = false, freshMs = FRESH_MS, parallelDays = 2, deadline = Infinity, log = console.log } = {}) {
  const ts = Date.now();
  await calm(log);
  // The family the skill's days were built with, while it's pinned (30 days): a new instance or
  // machine recomputing it must not invalidate every built day.
  const prevFam = (await readJson(files.skillIndex(skill)))?.family;
  const fam = prevFam?.computedAt && Date.now() - prevFam.computedAt < 30 * DAY ? prevFam : await familyFor(skill);
  const id = famId(fam.family);
  // One more day than the window: the index query counts back from today, which is left out.
  const index = await runsIndex({ skill, days: win.days + 1 });
  const want = index.dayList.filter((d) => d.day >= win.from && d.day <= win.through);
  const dayList = [];
  const missingDays = [];
  let built = 0;
  let left = 0;
  await mapLimit(want, parallelDays, async ({ day, sessions }) => {
    const key = files.skillDay(skill, day);
    const have = await readJson(key);
    const current = have?.version === DATA_VERSION && have.famId === id;
    if (!force && current && (have.final || Date.now() - have.builtAt < freshMs)) {
      dayList.push({ day, sessions: have.sessions, runs: have.runs.length });
      return;
    }
    if (Date.now() > deadline) {
      left++;
      return;
    }
    await calm(log);
    try {
      const sample = sampleFor(sessions);
      const runs = await runsForDay({ skill, family: fam.family, day, sessions });
      await writeJsonAtomic(key, { skill, day, sessions, sampleRate: sample ? sample.length / 16 : 1, final: isFinal(day), version: DATA_VERSION, famId: id, builtAt: Date.now(), runs });
      await indexSessions(skill, day, runs);
      dayList.push({ day, sessions, runs: runs.length });
      built++;
    } catch (err) {
      missingDays.push({ day, error: String(err.message || err).slice(0, 200) });
      // An older copy of the day still beats a gap.
      if (have?.runs) dayList.push({ day, sessions: have.sessions, runs: have.runs.length, stale: true });
    }
  });
  // Every failed day failed because Trino was overloaded (not the query): worth retrying later.
  const busy = missingDays.length > 0 && missingDays.every((d) => isBusyError(d.error));
  if (left) {
    log(`  ${skill}: ${built} day(s) built in ${Math.round((Date.now() - ts) / 1000)}s, ${left} left for the next run`);
    return { ok: !missingDays.length, done: false, built, busy };
  }
  dayList.sort((a, b) => (a.day < b.day ? 1 : -1));
  // When it hasn't run in the window: when it last ran (the index only says so for an empty window).
  const lastSeen = dayList.length ? null : index.lastSeen;
  await writeJsonAtomic(files.skillIndex(skill), { skill, family: fam, dayList, lastSeen, missingDays, from: win.from, through: win.through, builtAt: Date.now() });
  // Days that fell out of the window.
  for (const key of await listKeys(files.skillDir(skill)).catch(() => [])) {
    const m = key.match(/\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && m[1] < win.from) await deleteKey(key);
  }
  const runs = dayList.reduce((a, d) => a + d.runs, 0);
  log(`  ${skill}: ${dayList.length} day(s), ${runs} runs — ${built} built in ${Math.round((Date.now() - ts) / 1000)}s${missingDays.length ? `; FAILED ${missingDays.map((d) => d.day).join(', ')} (${missingDays[0].error})` : ''}`);
  return { ok: !missingDays.length, done: true, built, busy };
}

// The skills readers see. `done`: skills handled by this run ({ skill, sessions, last_at }); skills
// from the previous build not reached yet stay listed until the run finishes (a partial run, with
// `only`, keeps them for good). Finishing also stores the co-loads Fleet reads and drops old days
// from the session index.
// `complete`: every skill was built (default: finished).
export async function publish(win, { done, finished, only = [], startedAt = Date.now(), complete = finished }) {
  const prev = (await readJson(files.manifest()))?.skills || [];
  const keep = prev.filter((p) => !done.some((d) => d.skill === p.skill) && (only.length || !finished));
  const listed = [...done, ...keep].sort((a, b) => Number(b.sessions) - Number(a.sessions));
  if (finished) {
    await writeJsonAtomic(files.meta('skill-pairs'), await skillPairs().catch(() => []));
    // Model prices for cost figures (the shared copy can't query them either).
    const p = await prices().catch(() => null);
    if (p) await writeJsonAtomic(files.meta('prices'), p);
    for (const key of await listKeys(files.sessionsDir()).catch(() => [])) {
      const m = key.match(/\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && m[1] < win.from) await deleteKey(key);
    }
  }
  await writeJsonAtomic(files.manifest(), { version: DATA_VERSION, through: win.through, from: win.from, days: win.days, builtAt: Date.now(), buildMs: Date.now() - startedAt, complete, skills: listed.map(({ skill, sessions, last_at }) => ({ skill, sessions, last_at })) });
  return listed.length;
}
