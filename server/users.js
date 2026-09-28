import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getJson } from './admin.js';
import { limited } from './limits.js';
import { readCache, writeCache } from './cache.js';

// Email → user id, for user mode. The admin API lists sessions by user id only and no warehouse
// table this app reads carries emails, so the index is built from session details Autopsy has
// fetched (cached bundles, then every session opened). Local only, like the session cache itself.

let index = null; // email (lowercase) → { id, email, at }
let saveTimer;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function load() {
  if (index) return index;
  index = (await readCache('meta', 'users-index', Infinity)) || {};
  // First run: pick emails out of cached session bundles. The meta sits at the start of each
  // file, so reading 4KB apiece is enough (the bundles themselves are ~1MB).
  if (!Object.keys(index).length) {
    const dir = path.join(config.cacheDir, 'sessions');
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const fh = await fs.open(path.join(dir, name)).catch(() => null);
      if (!fh) continue;
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0).catch(() => ({ bytesRead: 0 }));
      await fh.close();
      const head = buffer?.subarray(0, bytesRead).toString('utf8') || '';
      const email = head.match(/"userEmail":"([^"]+)"/)?.[1];
      const id = head.match(/"userId":"([0-9a-f-]{36})"/)?.[1];
      if (email && id) index[email.toLowerCase()] = { id, email, at: 0 };
    }
    save();
  }
  return index;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeCache('meta', 'users-index', index, Infinity).catch(() => {}), 2000);
}

export async function rememberUser(meta) {
  if (!meta?.userEmail || !meta?.userId) return;
  await load();
  const key = meta.userEmail.toLowerCase();
  if (index[key]?.id === meta.userId) return;
  index[key] = { id: meta.userId, email: meta.userEmail, at: Date.now() };
  save();
}

export async function emailOf(userId) {
  await load();
  return Object.values(index).find((u) => u.id === userId)?.email || null;
}

// An email, a user id, a session id, or a link containing one → { id, email }.
export async function resolveUser(q) {
  const s = String(q || '').trim();
  if (!s) throw Object.assign(new Error('Enter an email, user id or session link'), { status: 400 });
  await load();
  if (s.includes('@') && !UUID.test(s)) {
    const hit = index[s.toLowerCase()];
    if (hit) return { id: hit.id, email: hit.email };
    throw Object.assign(new Error(`Autopsy hasn't seen ${s} yet. Open any run of theirs once (their email is in the run header), or paste their user id or a session link.`), { status: 404 });
  }
  const id = s.match(UUID)?.[0]?.toLowerCase();
  if (!id) throw Object.assign(new Error('Not an email, user id or session link'), { status: 400 });
  // A session id resolves to its user; otherwise treat it as a user id if they have sessions.
  const bySession = await limited('admin', () => getJson(`${config.adminBase}/sessions?sessionId=${id}`)).catch(() => null);
  const meta = bySession?.sessions?.find((x) => x.id === id);
  if (meta?.userId) {
    await rememberUser(meta);
    return { id: meta.userId, email: meta.userEmail || null };
  }
  const byUser = await limited('admin', () => getJson(`${config.adminBase}/sessions?userId=${id}`)).catch(() => null);
  const first = byUser?.sessions?.find((x) => x.userId === id);
  if (first) {
    await rememberUser(first);
    return { id, email: first.userEmail || null };
  }
  throw Object.assign(new Error('No sessions found for that id'), { status: 404 });
}
