// The Wixel agent's own source of instructions (wix-private/wixel-agent-codex): skills, the
// references inlined into them, runtime resources, invoke_rpc schemas and eval mappings. Fleet
// reads it to point a fix at the exact file. Read-only and git-only: everything is read from the
// latest fetched commit (origin/HEAD, else HEAD) with `git show / grep / ls-tree`, so the
// checkout's working tree is never touched, and a stale checkout still reads the newest fetch.
//
// CODEX_DIR overrides the default ~/dev/wixel-agent-codex. Missing → features switch off.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const codexDir = () => process.env.CODEX_DIR || path.join(os.homedir(), 'dev/wixel-agent-codex');

function git(args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', codexDir(), ...args], { maxBuffer, timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

let index = null;
let indexAt = 0;

// Skills by their frontmatter name, every file path, file sizes, the commit read and its date.
export async function codexIndex() {
  if (index && Date.now() - indexAt < 3600000) return index;
  if (!existsSync(path.join(codexDir(), '.git'))) return (index = { available: false, dir: codexDir() });
  try {
    const ref = (await git(['rev-parse', '--verify', '-q', 'origin/HEAD']).catch(() => '')).trim() ? 'origin/HEAD' : 'HEAD';
    const [sha, date, tree, names] = await Promise.all([
      git(['rev-parse', '--short', ref]),
      git(['log', '-1', '--format=%cI', ref]),
      git(['ls-tree', '-r', '-l', ref]),
      git(['grep', '-n', '-E', '^name:', ref, '--', 'skills']).catch(() => ''),
    ]);
    const files = new Map();
    for (const line of tree.split('\n')) {
      const m = line.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/);
      if (m) files.set(m[2], Number(m[1]));
    }
    const skills = {};
    for (const line of names.split('\n')) {
      // origin/HEAD:skills/video/wixel-ads.md:2:name: wixel-ads
      const m = line.match(/^[^:]+:(skills\/[^:]+\.md):\d+:name:\s*["']?([^"'\s]+)/);
      if (m && !skills[m[2]]) skills[m[2]] = { path: m[1], bytes: files.get(m[1]) || 0 };
    }
    index = { available: true, dir: codexDir(), ref, sha: sha.trim(), date: date.trim(), files, skills };
  } catch (err) {
    index = { available: false, dir: codexDir(), error: String(err.message || err).slice(0, 200) };
  }
  indexAt = Date.now();
  return index;
}

export async function codexSummary() {
  const ix = await codexIndex();
  if (!ix.available) return { available: false, dir: ix.dir, error: ix.error || null };
  return { available: true, dir: ix.dir, ref: ix.ref, sha: ix.sha, date: ix.date, skills: Object.keys(ix.skills).length, files: ix.files.size };
}

// Skill name → approximate size in bytes (for "preload it" / "heavy context" estimates).
export async function skillSizes() {
  const ix = await codexIndex();
  if (!ix.available) return {};
  return Object.fromEntries(Object.entries(ix.skills).map(([k, v]) => [k, v.bytes]));
}

export async function showFile(p, max = 200000) {
  const ix = await codexIndex();
  if (!ix.available || !ix.files.has(p)) return null;
  const text = await git(['show', `${ix.ref}:${p}`]).catch(() => null);
  return text == null ? null : text.slice(0, max);
}

// Where a file name lives (any folder), e.g. a resource the agent couldn't load.
export async function findByName(base) {
  const ix = await codexIndex();
  if (!ix.available) return [];
  return [...ix.files.keys()].filter((p) => p === base || p.endsWith(`/${base}`));
}

// Fixed-string search across instructions; returns { path, line, text } (capped).
export async function grepCodex(text, { dirs = ['skills', 'references', 'system_prompts', 'resources', 'agents'], max = 20 } = {}) {
  const ix = await codexIndex();
  if (!ix.available || !text) return [];
  const out = await git(['grep', '-n', '-F', '-e', text, ix.ref, '--', ...dirs]).catch(() => '');
  return out.split('\n').filter(Boolean).slice(0, max).map((l) => {
    const m = l.match(/^[^:]+:([^:]+):(\d+):(.*)$/);
    return m ? { path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 240) } : null;
  }).filter(Boolean);
}

// Which agent configs list a skill file (a skill missing from them is invisible to that agent).
export async function agentsListing(skillPath) {
  const ix = await codexIndex();
  if (!ix.available) return [];
  const agents = [...ix.files.keys()].filter((p) => /^agents\/[^/]+\.json$/.test(p));
  const out = [];
  for (const a of agents) {
    const txt = await showFile(a);
    if (txt && txt.includes(skillPath)) out.push(a);
  }
  return out;
}

// Eval test sets mapped to a file (configurations/eval-mapping.json), to re-run after a fix.
export async function evalSetsFor(p) {
  const raw = await showFile('configurations/eval-mapping.json');
  if (!raw) return [];
  try {
    const map = JSON.parse(raw);
    const hit = map[p] || map.mappings?.[p] || null;
    return Array.isArray(hit) ? hit : hit ? [hit] : [];
  } catch {
    return [];
  }
}

export const rpcSchemaPath = async (method) => {
  const ix = await codexIndex();
  const p = `configurations/rpc/${method}.json`;
  return ix.available && ix.files.has(p) ? p : null;
};

export const codexWebUrl = (p, line) => `https://github.com/wix-private/wixel-agent-codex/blob/master/${p}${line ? `#L${line}` : ''}`; // origin/HEAD is master

// Lines of one file that mention any of `terms` (where a skill talks about a tool or method).
export async function linesMentioning(p, terms, max = 8) {
  const text = await showFile(p);
  if (!text) return [];
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (out.length < max && terms.some((t) => t && line.includes(t))) out.push({ line: i + 1, text: line.trim().slice(0, 220) });
  });
  return out;
}
