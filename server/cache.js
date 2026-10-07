import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { inBackground, wantFresh } from './context.js';
import { laneBusy } from './limits.js';

// Disk cache: one JSON file per key. `ttlMs: Infinity` for immutable data (finished runs).
const inflight = new Map();

function fileFor(ns, key) {
  return path.join(config.cacheDir, ns, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

// A hosted copy keeps some namespaces in its shared store instead (its instances share no disk):
// the slow lookups, like which accounts are employees, families, and the email index.
let shared = null;
export function useSharedCache(store, namespaces) {
  shared = { store, namespaces: new Set(namespaces) };
}
const sharedKey = (ns, key) => (shared?.namespaces.has(ns) ? `cache/${ns}/${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json` : null);
async function readRaw(ns, key) {
  const sk = sharedKey(ns, key);
  if (sk) return (await shared.store.get(sk).catch(() => null))?.value;
  // Disk entries go through the in-memory copy (mem, below).
  const f = fileFor(ns, key);
  let raw = mem.get(f);
  if (raw) remember(f, raw);
  else remember(f, (raw = JSON.parse(await fs.readFile(f, 'utf8'))));
  return raw;
}

// A hit bumps the file's mtime so the size-cap sweep (cache-gc.js) treats it as recently used.
// Freshness uses savedAt inside the file, not mtime, so this doesn't extend any TTL.
const touched = new Map();
function touch(f) {
  const now = Date.now();
  if (now - (touched.get(f) || 0) < 60000) return;
  touched.set(f, now);
  fs.utimes(f, new Date(), new Date()).catch(() => {});
}

// The most recently used entries stay parsed in memory: a warm view (a skill's days, a run's
// session) then skips reading and parsing multi-MB JSON files on every request.
const MEM_MAX = 150;
const mem = new Map(); // file → { savedAt, ttlMs, value }
function remember(f, raw) {
  mem.delete(f);
  mem.set(f, raw);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

// An entry saved with ttlMs=null is immutable and always served. Otherwise it's served
// while younger than both its own ttl and the caller's maxAgeMs.
export async function readCache(ns, key, maxAgeMs) {
  try {
    const raw = await readRaw(ns, key);
    const age = Date.now() - raw.savedAt;
    if (raw.ttlMs === null || (age < raw.ttlMs && age < maxAgeMs)) {
      if (!sharedKey(ns, key)) touch(fileFor(ns, key));
      return raw.value;
    }
  } catch {}
  return undefined;
}

export async function writeCache(ns, key, value, ttlMs) {
  // JSON has no Infinity; store null to mean "forever".
  const raw = { savedAt: Date.now(), ttlMs: ttlMs === Infinity ? null : ttlMs, value };
  const sk = sharedKey(ns, key);
  if (sk) return shared.store.put(sk, raw);
  const f = fileFor(ns, key);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify(raw));
  remember(f, raw);
}

// The cache GC evicted a file: forget it here too.
export const forget = (file) => mem.delete(file);

// Read-through cache that also dedupes concurrent requests for the same key.
// `produce` returns { value, ttlMs }. With `staleWhileRevalidate`, an expired entry is returned
// at once and refreshed in the background, so a page load never waits on a slow query it has
// already seen once. Those refreshes run at background priority (after anything on screen) and
// are skipped while Trino is busy or backing off; the next view of that data tries again.
// maxAgeMs 0 means "fresh": always produce anew, even over an immutable entry (the Refresh button).
export async function cached(ns, key, maxAgeMs, produce, { staleWhileRevalidate = false } = {}) {
  const hit = maxAgeMs > 0 ? await readCache(ns, key, maxAgeMs) : undefined;
  if (hit !== undefined) return hit;
  const id = `${ns}/${key}`;
  if (staleWhileRevalidate && maxAgeMs > 0 && !wantFresh()) {
    const stale = await readStale(ns, key);
    if (stale !== undefined) {
      if (!inflight.has(id) && !laneBusy('trino')) inBackground(() => refresh(ns, key, id, produce)).catch((err) => console.error(`refresh ${id}: ${err.message}`));
      return stale;
    }
  }
  // Joining another caller's work: if that caller was cancelled, redo it for this one.
  if (inflight.has(id)) return inflight.get(id).catch((err) => (err?.name === 'AbortError' ? cached(ns, key, maxAgeMs, produce, { staleWhileRevalidate }) : Promise.reject(err)));
  return refresh(ns, key, id, produce);
}

// Whatever is cached under the key, however old (the Refresh top-up merges into it).
export async function readStale(ns, key) {
  try {
    return (await readRaw(ns, key)).value;
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
