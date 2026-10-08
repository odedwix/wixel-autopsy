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
// Each skill-day is a handful of Trino queries, one or two days at a time; the steps (and which days
// are skipped) are in server/build.js, shared with the hosted copy's nightly tasks. A day not final
// yet is kept if it was built in the last 12 hours (--fresh-hours). The manifest is updated after
// every skill: a stopped run still publishes what it finished.
// Fleet's day files are built at the end (FLEET_DIR, default .fleet/) unless --no-fleet.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../server/config.js';
import { setConcurrency, isBusyError } from '../server/limits.js';
import { storeKind, readJson, files } from '../server/snapshot.js';
import { produce, buildWindow, skillsToBuild, buildSkill, publish } from '../server/build.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const only = opt('skills', '').split(',').map((s) => s.trim()).filter(Boolean);
const win = buildWindow(opt('days', 30));
const options = { force: args.includes('--force'), freshMs: Number(opt('fresh-hours', 12)) * 3600000, parallelDays: Math.max(1, Number(opt('parallel', 2))) };
// One producer on a shared cluster: fewer queries at once than the interactive app (it ran into
// QUERY_QUEUE_FULL at 4).
setConcurrency('trino', Math.max(1, Number(opt('trino', 2))));
const t0 = Date.now();

async function main() {
  console.log(`build:data: ${win.from} → ${win.through} (${win.days} day(s)) into the ${storeKind()}`);
  const minSessions = Number(opt('min-sessions', 10));
  const skills = await skillsToBuild({ minSessions, only });
  console.log(`  ${skills.length} skill(s)${only.length ? '' : ` with ≥${minSessions} sessions in 30 days`}`);
  const done = new Map(); // skill → { skill, sessions, last_at } for every skill readers can see
  const failedSkills = new Set();
  const listed = () => [...done.values()];
  // Trino overloaded (timeouts, the shared account's queue full): skills fail in seconds, one after
  // another. Rather than march through the rest adding load, pause and retry them; give up after a
  // few pauses (the next run picks up where this one stopped).
  const BUSY_STREAK = 3;
  const BUSY_PAUSES = 3;
  const BUSY_PAUSE_MS = 10 * 60000;
  let streak = 0;
  let pauses = 0;
  let stopped = false;
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    let busy = false;
    try {
      const r = await buildSkill(s.skill, win, options);
      busy = r.busy;
      if (r.ok) failedSkills.delete(s.skill);
      else failedSkills.add(s.skill);
      done.set(s.skill, s);
    } catch (err) {
      busy = isBusyError(err);
      failedSkills.add(s.skill);
      console.log(`  ${s.skill}: failed — ${err.message}`);
      // Keep serving the previous build of it, if there is one.
      if (await readJson(files.skillIndex(s.skill))) done.set(s.skill, s);
    }
    await publish(win, { done: listed(), finished: false, only, startedAt: t0 });
    streak = busy ? streak + 1 : 0;
    if (streak < BUSY_STREAK) continue;
    if (pauses >= BUSY_PAUSES) {
      console.log(`build:data: Trino stayed overloaded after ${pauses} pauses — stopping here; run it again later (finished skills are kept)`);
      stopped = true;
      break;
    }
    pauses++;
    console.log(`  ${streak} skills in a row failed because Trino is overloaded — pausing ${BUSY_PAUSE_MS / 60000} min, then retrying them`);
    await new Promise((r) => setTimeout(r, BUSY_PAUSE_MS));
    i -= streak;
    streak = 0;
  }
  // A stopped run leaves the previous build's other skills listed; only a clean full run is complete.
  await publish(win, { done: listed(), finished: !stopped, only, startedAt: t0, complete: !stopped && !failedSkills.size });
  console.log(`build:data: ${done.size} skill(s) in ${Math.round((Date.now() - t0) / 1000)}s${failedSkills.size ? `, ${failedSkills.size} with failed days (kept the previous copy where there was one): ${[...failedSkills].join(', ')}` : ''}`);
}

await produce(main);

if (!args.includes('--no-fleet')) {
  console.log('fleet: building day rollups');
  const r = spawnSync(process.execPath, [path.join(config.root, 'scripts/fleet-rollup.js'), '--days', String(win.days), '--no-today'], { stdio: 'inherit', env: process.env });
  if (r.status) console.log(`fleet: exited with ${r.status}`);
}
process.exit(0);
