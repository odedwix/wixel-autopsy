import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Disk cache: one JSON file per key. `ttlMs: Infinity` for immutable data (finished runs).
const inflight = new Map();

function fileFor(ns, key) {
  return path.join(config.cacheDir, ns, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

// An entry saved with ttlMs=null is immutable and always served. Otherwise it's served
// while younger than both its own ttl and the caller's maxAgeMs.
export async function readCache(ns, key, maxAgeMs) {
  try {
    const raw = JSON.parse(await fs.readFile(fileFor(ns, key), 'utf8'));
    const age = Date.now() - raw.savedAt;
    if (raw.ttlMs === null || (age < raw.ttlMs && age < maxAgeMs)) return raw.value;
  } catch {}
  return undefined;
}

export async function writeCache(ns, key, value, ttlMs) {
  const f = fileFor(ns, key);
  await fs.mkdir(path.dirname(f), { recursive: true });
  // JSON has no Infinity; store null to mean "forever".
  await fs.writeFile(f, JSON.stringify({ savedAt: Date.now(), ttlMs: ttlMs === Infinity ? null : ttlMs, value }));
}

// Read-through cache that also dedupes concurrent requests for the same key.
// `produce` returns { value, ttlMs }. With `staleWhileRevalidate`, an expired entry is returned
// at once and refreshed in the background, so a page load never waits on a slow query it has
// already seen once.
export async function cached(ns, key, maxAgeMs, produce, { staleWhileRevalidate = false } = {}) {
  const hit = await readCache(ns, key, maxAgeMs);
  if (hit !== undefined) return hit;
  const id = `${ns}/${key}`;
  if (staleWhileRevalidate) {
    const stale = await readStale(ns, key);
    if (stale !== undefined) {
      if (!inflight.has(id)) refresh(ns, key, id, produce).catch((err) => console.error(`refresh ${id}: ${err.message}`));
      return stale;
    }
  }
  // Joining another caller's work: if that caller was cancelled, redo it for this one.
  if (inflight.has(id)) return inflight.get(id).catch((err) => (err?.name === 'AbortError' ? cached(ns, key, maxAgeMs, produce, { staleWhileRevalidate }) : Promise.reject(err)));
  return refresh(ns, key, id, produce);
}

async function readStale(ns, key) {
  try {
    return JSON.parse(await fs.readFile(fileFor(ns, key), 'utf8')).value;
  } catch {
    return undefined;
  }
}

function refresh(ns, key, id, produce) {
  const p = (async () => {
    const { value, ttlMs } = await produce();
    await writeCache(ns, key, value, ttlMs);
    return value;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
