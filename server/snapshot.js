// The daily build: every skill's runs, made once a day by one producer (scripts/build-data.js) and
// read by any number of people. With AUTOPSY_SNAPSHOT=1 the server answers the grid, insights,
// families, skill list and user mode from these files only and never queries Trino.
//
//   DATA_DIR/manifest.json              { through, from, days, builtAt, skills: [{ skill, sessions, last_at }] }
//   DATA_DIR/skills/<skill>/index.json  { skill, family, dayList: [{ day, sessions, runs }], lastSeen, missingDays }
//   DATA_DIR/skills/<skill>/<day>.json  { skill, day, sessions, sampleRate, final, version, famId, runs }
//   DATA_DIR/sessions/<day>.json        { sessionId: [skill, …] } (user mode)
//   DATA_DIR/meta/skill-pairs.json      skills loaded in the same turn (Fleet's co-loads)
//
// Days end at `through` (the last complete UTC day). Values are written atomically and the manifest
// last, so a reader never sees half a build. They live in a store (store.js): DATA_DIR by default, or
// a key-value store a hosted copy sets with useStore().

import crypto from 'node:crypto';
import { config } from './config.js';
import { RUNS_QUERY_VERSION, STEPS_QUERY_VERSION } from './queries.js';
import { folderStore } from './store.js';

let store = folderStore(config.dataDir);
export const useStore = (s) => {
  store = s;
};
export const storeKind = () => store.kind;

const DAY = 86400000;
export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
// Bumps when a day file's runs would come out differently (either query, or the run shape).
export const DATA_VERSION = `r${RUNS_QUERY_VERSION}s${STEPS_QUERY_VERSION}`;
export const famId = (family) => (Array.isArray(family) ? crypto.createHash('sha1').update([...family].sort().join(',')).digest('hex').slice(0, 10) : 'all');

// Store keys.
const safe = (s) => String(s).replace(/[^\w.-]/g, '_');
export const files = {
  manifest: () => 'manifest.json',
  skillIndex: (skill) => `skills/${safe(skill)}/index.json`,
  skillDay: (skill, day) => `skills/${safe(skill)}/${day}.json`,
  skillDir: (skill) => `skills/${safe(skill)}`,
  sessions: (day) => `sessions/${day}.json`,
  sessionsDir: () => 'sessions',
  meta: (name) => `meta/${name}.json`,
};

export const writeJsonAtomic = (key, value) => store.put(key, value);
export const readJson = async (key) => (await store.get(key).catch(() => null))?.value ?? null;
export const listKeys = (prefix) => store.list(prefix);
export const deleteKey = (key) => store.del(key);

const notBuilt = (what) => Object.assign(new Error(`${what} isn't in the daily build`), { status: 404 });

// ---- reading (AUTOPSY_SNAPSHOT=1) ----
// Parsed values are kept while unchanged in the store: a new build replaces them, and the next read
// (at most CHECK_MS later) picks the new one up. Capped by size (a busy skill's day is ~5MB),
// least recently used out first.
const CHECK_MS = 30000;
const memo = new Map(); // key → { at, version, size, value }
const MEMO_BYTES = Number(process.env.SNAPSHOT_MEMORY_MB || 400) * 1e6;
let memoBytes = 0;

function forget(file) {
  const hit = memo.get(file);
  if (!hit) return;
  memoBytes -= hit.size;
  memo.delete(file);
}

async function readMemo(file) {
  const hit = memo.get(file);
  // Most recently used last, so eviction takes the oldest.
  if (hit) {
    memo.delete(file);
    memo.set(file, hit);
  }
  if (hit && Date.now() - hit.at < CHECK_MS) return hit.value;
  const stat = await store.stat(file).catch(() => null);
  if (!stat) {
    forget(file);
    return null;
  }
  if (hit && hit.version === stat.version) {
    hit.at = Date.now();
    return hit.value;
  }
  const got = await store.get(file).catch(() => null);
  forget(file);
  if (!got) return null;
  memo.set(file, { at: Date.now(), version: got.version, size: got.size, value: got.value });
  memoBytes += got.size;
  while (memoBytes > MEMO_BYTES && memo.size > 1) forget(memo.keys().next().value);
  return got.value;
}

export async function manifest() {
  const m = await readMemo(files.manifest());
  if (!m) throw Object.assign(new Error(`No daily build yet in the ${store.kind} — run npm run build:data`), { status: 503 });
  return m;
}

// What /api/health tells the UI: the build's last day, so time windows end there.
export async function snapshotInfo() {
  if (!config.snapshot) return null;
  const m = await readMemo(files.manifest());
  return m ? { through: m.through, from: m.from, days: m.days, builtAt: m.builtAt, skills: m.skills.length } : { missing: true };
}

export async function snapSkills() {
  return (await manifest()).skills;
}

async function skillIndex(skill) {
  const idx = await readMemo(files.skillIndex(skill));
  if (!idx) throw notBuilt(skill);
  return idx;
}

// The `days` complete days ending at the build's last day.
const windowDays = (m, days) => {
  const n = Math.max(1, Math.min(m.days, Math.ceil(Number(days) || 7)));
  const end = Date.parse(`${m.through}T00:00:00Z`);
  return { n, from: utcDay(end - (n - 1) * DAY) };
};

export async function snapIndex({ skill, days }) {
  const m = await manifest();
  const idx = await skillIndex(skill);
  const { n, from } = windowDays(m, days);
  const dayList = idx.dayList.filter((d) => d.day >= from && d.day <= m.through).map(({ day, sessions }) => ({ day, sessions }));
  return { skill, days: n, dayList, total: dayList.reduce((a, d) => a + d.sessions, 0), lastSeen: dayList.length ? null : idx.lastSeen, through: m.through };
}

export async function snapDay({ skill, day }) {
  const d = await readMemo(files.skillDay(skill, day));
  if (!d) throw notBuilt(`${skill} on ${day}`);
  return d.runs;
}

export async function snapFamily(skill) {
  return (await skillIndex(skill)).family;
}

// The build counts each skill with its computed helpers; other choices need a live copy.
export async function snapResolveFamily(skill, fam) {
  if (fam && fam !== 'default') throw Object.assign(new Error(`This copy is built once a day with each skill's computed helpers; counting ${fam === 'all' ? 'whole sessions' : 'other helpers'} needs Autopsy running locally`), { status: 400 });
  return (await snapFamily(skill)).family;
}

export async function snapSkillPairs() {
  return (await readMemo(files.meta('skill-pairs'))) || [];
}

// User mode: `sessions` (the user's, from the admin API: { id, createdAt, email }) found in the
// build, one row each. Runs are built per skill, so a session that ran several skills shows its
// first skill's row (every skill it loaded is listed on it). A run is filed under the day its skill
// first loaded: the session's creation day or, past midnight, the next. Busy skills are sampled per
// day, so some of a user's sessions in those may be missing.
export async function snapUserRuns({ userId, days, sessions }) {
  const m = await manifest();
  const { n, from } = windowDays(m, days);
  const best = new Map();
  for (const s of sessions) {
    for (const day of [utcDay(s.createdAt), utcDay(s.createdAt + DAY)]) {
      if (day < from || day > m.through) continue;
      for (const skill of (await readMemo(files.sessions(day)))?.[s.id] || []) {
        const run = (await readMemo(files.skillDay(skill, day)))?.runs?.find((r) => r.id === s.id);
        const have = best.get(s.id);
        if (run && (!have || (run.skillAt || run.createdAt) < (have.skillAt || have.createdAt))) best.set(s.id, { ...run, userId });
      }
    }
  }
  const runs = [...best.values()].sort((a, b) => b.createdAt - a.createdAt);
  const inWindow = sessions.filter((s) => utcDay(s.createdAt) >= from && utcDay(s.createdAt) <= m.through).length;
  return { user: { id: userId, email: sessions.find((x) => x.email)?.email || null }, runs, missingDays: [], sessions: inWindow, days: n, through: m.through };
}
