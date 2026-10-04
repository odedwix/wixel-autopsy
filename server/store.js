// Where the daily build lives. Keys are slash paths (manifest.json, skills/<skill>/<day>.json, …);
// values are JSON. Two backends with the same five calls:
//
//   folderStore(dir)  — files under DATA_DIR (local copies; atomic temp + rename writes)
//   kvStore(kv)       — a key-value store such as Wix Serverless cloudStore.keyValueStore, for a
//                       hosted copy whose instances share no disk. Values are gzipped and split into
//                       chunks; a small head item names the current chunks, and is written last, so a
//                       reader never mixes two versions of a value.
//
//   get(key)     → { value, version, size } | null
//   stat(key)    → { version, size } | null      (cheap: for "has it changed?")
//   put(key, v)
//   list(prefix) → keys directly under prefix/   (e.g. list('skills/doc') → ['skills/doc/2026-10-01.json', …])
//   del(key)

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export function folderStore(dir) {
  const file = (key) => path.join(dir, ...key.split('/'));
  return {
    kind: `folder ${dir}`,
    async stat(key) {
      const st = await fs.stat(file(key)).catch(() => null);
      return st ? { version: String(st.mtimeMs), size: st.size } : null;
    },
    async get(key) {
      const f = file(key);
      try {
        const [st, raw] = await Promise.all([fs.stat(f), fs.readFile(f, 'utf8')]);
        return { value: JSON.parse(raw), version: String(st.mtimeMs), size: st.size };
      } catch {
        return null;
      }
    },
    async put(key, value) {
      const f = file(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, f);
    },
    async list(prefix) {
      const names = await fs.readdir(file(prefix)).catch(() => []);
      return names.filter((n) => !n.endsWith('.tmp')).map((n) => `${prefix}/${n}`);
    },
    async del(key) {
      await fs.rm(file(key), { force: true });
    },
  };
}

// `kv`: get / set / batchGet / batchSet / batchDelete / getAndUpdate over items { key, … }.
// Item keys: `h:<key>` head { version, size, chunks }, `c:<key>:<version>:<i>` chunk { data } (base64
// of the gzipped JSON), `d:<prefix>` directory { keys } (the store has no listing of its own).
export function kvStore(kv, { chunkBytes = 256 * 1024 } = {}) {
  const head = (key) => kv.get(`h:${key}`);
  const chunkKeys = (key, h) => Array.from({ length: h.chunks }, (_, i) => `c:${key}:${h.version}:${i}`);
  const dirOf = (key) => key.slice(0, key.lastIndexOf('/'));
  const editDir = (prefix, fn) => kv.getAndUpdate(`d:${prefix}`, (cur) => ({ keys: fn(new Set(cur?.keys || [])) }));
  return {
    kind: 'key-value store',
    async stat(key) {
      const h = await head(key);
      return h ? { version: h.version, size: h.size } : null;
    },
    async get(key) {
      const h = await head(key);
      if (!h) return null;
      const items = await kv.batchGet(chunkKeys(key, h));
      const byKey = new Map(items.map((x) => [x.key, x.data]));
      const parts = chunkKeys(key, h).map((k) => byKey.get(k));
      // A writer replaced it between the head and the chunks: read the new version.
      if (parts.some((p) => p == null)) return this.get(key);
      const buf = await gunzip(Buffer.from(parts.join(''), 'base64'));
      return { value: JSON.parse(buf.toString('utf8')), version: h.version, size: h.size };
    },
    async put(key, value) {
      const raw = Buffer.from(JSON.stringify(value));
      const data = (await gzip(raw)).toString('base64');
      const old = await head(key);
      const h = { key: `h:${key}`, version: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, size: raw.length, chunks: Math.max(1, Math.ceil(data.length / chunkBytes)) };
      const keys = chunkKeys(key, h);
      for (let i = 0; i < keys.length; i += 25) {
        await kv.batchSet(keys.slice(i, i + 25).map((k, j) => ({ key: k, data: data.slice((i + j) * chunkBytes, (i + j + 1) * chunkBytes) })));
      }
      await kv.set(h);
      if (!old) await editDir(dirOf(key), (s) => [...s.add(key)]);
      // The old version's chunks, once nothing points at them (a reader mid-get retries on a miss).
      else await kv.batchDelete(chunkKeys(key, old)).catch(() => {});
    },
    async list(prefix) {
      return (await kv.get(`d:${prefix}`))?.keys || [];
    },
    async del(key) {
      const h = await head(key);
      if (!h) return;
      await kv.batchDelete([`h:${key}`, ...chunkKeys(key, h)]);
      await editDir(dirOf(key), (s) => (s.delete(key), [...s]));
    },
  };
}
