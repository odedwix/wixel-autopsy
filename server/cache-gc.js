import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Keeps .cache under a size cap (CACHE_MAX_GB, default 3). Evicts least-recently-used entries,
// cheapest-to-rebuild first: review videos (seconds of ffmpeg), session details (one admin call),
// graph traces, … and the day lists last (the slow Trino ones). Reads bump an entry's mtime
// (see cache.js / media.js), so mtime means "last used".

const ORDER = ['media', 'sessions', 'user-sessions', 'graph-runs', 'job-traces', 'bundles', 'runs-index', 'steps-day', 'runs-day'];
const KEEP = new Set(['vendor', 'meta']); // the built player and per-account lookups: tiny and precious
const LOG_MAX = 10 * 1024 * 1024;

const capBytes = () => Math.max(0.2, Number(process.env.CACHE_MAX_GB || 3)) * 1024 ** 3;

async function sizeOf(p) {
  const st = await fs.stat(p).catch(() => null);
  if (!st) return { bytes: 0, mtime: 0 };
  if (!st.isDirectory()) return { bytes: st.size, mtime: st.mtimeMs };
  let bytes = 0;
  let mtime = st.mtimeMs;
  for (const name of await fs.readdir(p).catch(() => [])) {
    const s = await sizeOf(path.join(p, name));
    bytes += s.bytes;
    mtime = Math.max(mtime, s.mtime);
  }
  return { bytes, mtime };
}

// Entries per namespace: files, or (for media) one directory per run.
async function entries(ns) {
  const dir = path.join(config.cacheDir, ns);
  const names = await fs.readdir(dir).catch(() => []);
  return Promise.all(names.map(async (name) => ({ ns, file: path.join(dir, name), ...(await sizeOf(path.join(dir, name))) })));
}

let last = { bytes: 0, cap: capBytes(), evicted: 0, at: 0 };
export const cacheReport = () => ({ ...last, cap: capBytes() });

export async function sweep() {
  // The app log is append-only; keep its tail.
  const log = path.join(config.cacheDir, 'app.log');
  const ls = await fs.stat(log).catch(() => null);
  if (ls && ls.size > LOG_MAX) {
    const buf = await fs.readFile(log);
    await fs.writeFile(log, buf.subarray(buf.length - 2 * 1024 * 1024));
  }
  const all = (await Promise.all(ORDER.map(entries))).flat();
  const other = await Promise.all((await fs.readdir(config.cacheDir).catch(() => []))
    .filter((n) => !ORDER.includes(n) && !KEEP.has(n)).map((n) => sizeOf(path.join(config.cacheDir, n))));
  let total = all.reduce((a, e) => a + e.bytes, 0) + other.reduce((a, e) => a + e.bytes, 0);
  const cap = capBytes();
  let evicted = 0;
  if (total > cap) {
    const target = cap * 0.85; // leave headroom so it doesn't sweep on every write
    for (const ns of ORDER) {
      const list = all.filter((e) => e.ns === ns).sort((a, b) => a.mtime - b.mtime);
      for (const e of list) {
        if (total <= target) break;
        await fs.rm(e.file, { recursive: true, force: true });
        total -= e.bytes;
        evicted++;
      }
      if (total <= target) break;
    }
    console.log(`cache: evicted ${evicted} entries, now ${(total / 1024 ** 3).toFixed(2)} GB of ${(cap / 1024 ** 3).toFixed(1)} GB`);
  }
  last = { bytes: total, cap, evicted, at: Date.now() };
  return last;
}

export function startSweeping() {
  sweep().catch((err) => console.error(`cache sweep: ${err.message}`));
  setInterval(() => sweep().catch(() => {}), 20 * 60000).unref();
}
