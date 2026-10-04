// The daily build: one producer queries Trino once a day and writes every skill's runs, ready to
// show, into DATA_DIR (default .data/). A copy started with AUTOPSY_SNAPSHOT=1 serves only these
// files, so any number of people can read them without adding load. See server/snapshot.js.
//
//   npm run build:data                          # every skill, the last 30 complete UTC days
//   npm run build:data -- --days 7              # a shorter window (older day files are removed)
//   npm run build:data -- --skills wixel-ads,doc --no-fleet
//   npm run build:data -- --min-sessions 50     # skip skills with fewer sessions in 30 days (default 10)
//   npm run build:data -- --force               # rebuild days that are already final
//   npm run build:data -- --trino 1             # Trino queries at once (default 2; the cluster is shared)
//
// Each skill-day is a handful of Trino queries, one or two days at a time. A day is final 3 days
// after it ends (its sessions are read up to 2 days past the skill load); final days are never
// re-queried, so a nightly run only builds yesterday and refreshes the two days before it. A day not
// final yet is kept if it was built in the last 12 hours (--fresh-hours), so a rerun after a stop
// or a failure only queries what's missing. The manifest is updated after every skill: a stopped
// run still publishes what it finished.
// Fleet's day files are built at the end (FLEET_DIR, default .fleet/) unless --no-fleet.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../server/config.js';
import { requestContext } from '../server/context.js';
import { backoffRemaining, setConcurrency } from '../server/limits.js';
import { listSkills, familyFor, runsIndex, runsForDay, sampleFor, skillPairs } from '../server/runs.js';
import { DATA_VERSION, famId, files, readJson, writeJsonAtomic, utcDay } from '../server/snapshot.js';

if (config.snapshot) {
  console.error('build:data queries Trino; unset AUTOPSY_SNAPSHOT for the producer');
  process.exit(1);
}

const DAY = 86400000;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const force = args.includes('--force');
const days = Math.max(1, Math.min(90, Number(opt('days', 30))));
const minSessions = Number(opt('min-sessions', 10));
const only = opt('skills', '').split(',').map((s) => s.trim()).filter(Boolean);
const parallelDays = Math.max(1, Number(opt('parallel', 2)));
const freshMs = Number(opt('fresh-hours', 12)) * 3600000;
// One producer on a shared cluster: fewer queries at once than the interactive app (it ran into
// QUERY_QUEUE_FULL at 4).
setConcurrency('trino', Math.max(1, Number(opt('trino', 2))));

const through = utcDay(Date.now() - DAY);
const end = Date.parse(`${through}T00:00:00Z`);
const from = utcDay(end - (days - 1) * DAY);
const isFinal = (day) => Date.parse(`${day}T00:00:00Z`) + 3 * DAY < Date.now();
const t0 = Date.now();
const secs = (t) => `${Math.round((Date.now() - t) / 1000)}s`;

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// The shared cluster is timing out: wait it out rather than add load.
async function calm() {
  const wait = backoffRemaining('trino');
  if (wait <= 0) return;
  console.log(`  Trino is busy — waiting ${Math.round(wait / 1000) + 30}s`);
  await new Promise((r) => setTimeout(r, wait + 30000));
}

const touchedDays = new Set();

async function buildSkill(skill) {
  const ts = Date.now();
  const fam = await familyFor(skill);
  const id = famId(fam.family);
  // One more day than the window: the index query counts back from today, which is left out.
  const index = await runsIndex({ skill, days: days + 1 });
  const want = index.dayList.filter((d) => d.day >= from && d.day <= through);
  const dayList = [];
  const missingDays = [];
  let built = 0;
  await mapLimit(want, parallelDays, async ({ day, sessions }) => {
    const file = files.skillDay(skill, day);
    const have = await readJson(file);
    const current = have?.version === DATA_VERSION && have.famId === id;
    if (!force && current && (have.final || Date.now() - have.builtAt < freshMs)) {
      dayList.push({ day, sessions: have.sessions, runs: have.runs.length });
      return;
    }
    await calm();
    try {
      const sample = sampleFor(sessions);
      const runs = await runsForDay({ skill, family: fam.family, day, sessions });
      await writeJsonAtomic(file, { skill, day, sessions, sampleRate: sample ? sample.length / 16 : 1, final: isFinal(day), version: DATA_VERSION, famId: id, builtAt: Date.now(), runs });
      dayList.push({ day, sessions, runs: runs.length });
      touchedDays.add(day);
      built++;
    } catch (err) {
      missingDays.push({ day, error: String(err.message || err).slice(0, 200) });
      // An older copy of the day still beats a gap.
      if (have?.runs) dayList.push({ day, sessions: have.sessions, runs: have.runs.length, stale: true });
    }
  });
  dayList.sort((a, b) => (a.day < b.day ? 1 : -1));
  // When it hasn't run in the window: when it last ran (the index only says so for an empty window).
  const lastSeen = dayList.length ? null : index.lastSeen;
  await writeJsonAtomic(files.skillIndex(skill), { skill, family: fam, dayList, lastSeen, missingDays, from, through, builtAt: Date.now() });
  // Days that fell out of the window.
  for (const name of await fs.readdir(files.skillDir(skill)).catch(() => [])) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && m[1] < from) await fs.rm(path.join(files.skillDir(skill), name), { force: true });
  }
  const runs = dayList.reduce((a, d) => a + d.runs, 0);
  console.log(`  ${skill}: ${dayList.length} day(s), ${runs} runs — ${built} built in ${secs(ts)}${missingDays.length ? `; FAILED ${missingDays.map((d) => d.day).join(', ')} (${missingDays[0].error})` : ''}`);
  return { ok: !missingDays.length };
}

// User mode: which built skills each session is in, per day. (Run rows carry no user id — the
// admin API lists a user's sessions, and these say where to find them.)
async function buildSessions(skills) {
  const allDays = Array.from({ length: days }, (_, i) => utcDay(end - i * DAY));
  for (const day of allDays) {
    if (!touchedDays.has(day) && (await readJson(files.sessions(day)))) continue;
    const sessions = {};
    for (const skill of skills) {
      const d = await readJson(files.skillDay(skill, day));
      for (const r of d?.runs || []) (sessions[r.id] ||= []).push(skill);
    }
    await writeJsonAtomic(files.sessions(day), sessions);
  }
  for (const name of await fs.readdir(path.join(config.dataDir, 'sessions')).catch(() => [])) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && m[1] < from) await fs.rm(path.join(config.dataDir, 'sessions', name), { force: true });
  }
}

async function main() {
  console.log(`build:data: ${from} → ${through} (${days} day(s)) into ${config.dataDir}`);
  const all = await listSkills({ days: 30 });
  const skills = all.filter((s) => (only.length ? only.includes(s.skill) : Number(s.sessions) >= minSessions));
  console.log(`  ${skills.length} skill(s)${only.length ? '' : ` with ≥${minSessions} sessions in 30 days`}`);
  const done = [];
  let failed = 0;
  const prev = (await readJson(files.manifest()))?.skills || [];
  // The skills listed for readers: this run's, plus the previous build's not reached yet. A finished
  // full run drops skills that no longer make the cut; a partial one (--skills) keeps the rest.
  const publish = async ({ finished }) => {
    const keep = prev.filter((p) => !done.some((d) => d.skill === p.skill) && (only.length || !finished));
    const listed = [...done, ...keep].sort((a, b) => Number(b.sessions) - Number(a.sessions));
    if (finished) await buildSessions(listed.map((x) => x.skill));
    await writeJsonAtomic(files.manifest(), { version: DATA_VERSION, through, from, days, builtAt: Date.now(), buildMs: Date.now() - t0, complete: finished, skills: listed.map(({ skill, sessions, last_at }) => ({ skill, sessions, last_at })) });
  };
  for (const s of skills) {
    try {
      const r = await buildSkill(s.skill);
      if (!r.ok) failed++;
      done.push(s);
    } catch (err) {
      failed++;
      console.log(`  ${s.skill}: failed — ${err.message}`);
      // Keep serving yesterday's build of it, if there is one.
      if (await readJson(files.skillIndex(s.skill))) done.push(s);
    }
    await publish({ finished: false });
  }
  // Co-loads for Fleet's opportunities (the shared copy can't query them).
  await writeJsonAtomic(files.meta('skill-pairs'), await skillPairs().catch(() => []));
  await publish({ finished: true });
  console.log(`build:data: ${done.length} skill(s) in ${secs(t0)}${failed ? `, ${failed} with failed days (kept the previous copy where there was one)` : ''}`);
}

// One producer, current data: cached copies are only used while still fresh (never stale-while-revalidate).
await requestContext.run({ signal: undefined, priority: 'interactive', fresh: true }, main);

if (!args.includes('--no-fleet')) {
  console.log('fleet: building day rollups');
  const r = spawnSync(process.execPath, [path.join(config.root, 'scripts/fleet-rollup.js'), '--days', String(days), '--no-today'], { stdio: 'inherit', env: process.env });
  if (r.status) console.log(`fleet: exited with ${r.status}`);
}
process.exit(0);
