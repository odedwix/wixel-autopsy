// Fix briefs: for one Fleet issue, gather the evidence (a few example sessions from the admin
// API, the Genix root cause for failed generations, the codex files involved) and write a brief
// someone can act on — what's wrong, how often, where to look, a suggested fix, and how to verify
// it. Plus the shared Fleet state (issue status, fixed-in version, dismissed ideas, pinned skills)
// and an optional "draft the fix with Claude" runner (the local `claude` CLI, read-only, in the
// codex checkout).
//
// Upstream load: only when someone opens a brief — ≤3 session bundles (admin API, cached forever
// once settled) and ≤2 job traces (Temporal, cached forever), all through the usual limiters.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getSessionBundle } from './admin.js';
import { getJobTrace } from './temporal.js';
import { config } from './config.js';
import { fleetDir } from './fleet.js';
import { codexIndex, findByName, grepCodex, agentsListing, evalSetsFor, rpcSchemaPath, codexWebUrl, codexDir } from './codex.js';

// ---- shared state (FLEET_DIR/state.json) ----
const stateFile = () => path.join(fleetDir(), 'state.json');
export async function readState() {
  try {
    return JSON.parse(await fs.readFile(stateFile(), 'utf8'));
  } catch {
    return { issues: {}, opportunities: {}, pins: [] };
  }
}
// Read-modify-write of one entry, so people sharing a folder don't overwrite each other's edits.
let stateChain = Promise.resolve();
export function updateState(args) {
  // One write at a time in this process (the read-modify-write must not interleave).
  const run = stateChain.then(() => writeState(args));
  stateChain = run.catch(() => {});
  return run;
}
async function writeState({ kind, id, patch }) {
  if (!['issue', 'opportunity', 'pin'].includes(kind) || !id || String(id).length > 200) throw Object.assign(new Error('bad state update'), { status: 400 });
  const s = await readState();
  s.issues ??= {};
  s.opportunities ??= {};
  s.pins ??= [];
  if (kind === 'pin') s.pins = patch?.pinned ? [...new Set([...s.pins, id])] : s.pins.filter((x) => x !== id);
  else {
    const bag = kind === 'issue' ? s.issues : s.opportunities;
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => ['status', 'note', 'version', 'label'].includes(k)).map(([k, v]) => [k, String(v ?? '').slice(0, 500)]));
    if (clean.status === '') delete bag[id];
    else bag[id] = { ...bag[id], ...clean, at: Date.now() };
  }
  await fs.mkdir(path.dirname(stateFile()), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 1));
  await fs.rename(tmp, stateFile());
  return s;
}

export { redact } from './redact.js';
import { redact } from './redact.js';

// ---- evidence from one example session ----
const out = (r) => {
  const o = r?.result?.output;
  return typeof o === 'string' ? o : o == null ? '' : JSON.stringify(o);
};
export function sessionEvidence(bundle, ex, issue) {
  const entries = [...(bundle.entries || [])].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const at = ex.at || 0;
  // The failing result: same tool, closest to the recorded time.
  const cands = entries.filter((e) => e.entryType === 'TOOL_RESULT' && e.toolResult?.toolName === issue.tool);
  const hit = cands.sort((a, b) => Math.abs(Date.parse(a.createdDate) - at) - Math.abs(Date.parse(b.createdDate) - at))[0];
  if (!hit) return { session: ex.session, found: false };
  const cid = hit.toolResult.toolCallId;
  const call = entries.find((e) => e.entryType === 'TOOL_CALL' && e.toolCall?.toolCallId === cid);
  const idx = entries.indexOf(hit);
  const turn = hit.turnId;
  const userMsg = entries.filter((e) => e.turnId === turn && e.entryType === 'USER_MESSAGE')[0]?.userMessage?.text || '';
  const skills = entries.filter((e) => e.entryType === 'TOOL_CALL' && e.toolCall?.toolName === 'skill').map((e) => e.toolCall.arguments?.name).filter(Boolean);
  // What the agent did next: the following tool calls in the same turn.
  const next = entries.slice(idx + 1).filter((e) => e.turnId === turn && (e.entryType === 'TOOL_CALL' || e.entryType === 'ASSISTANT_MESSAGE')).slice(0, 5).map((e) => (e.entryType === 'TOOL_CALL'
    ? `${e.toolCall.toolName}${e.toolCall.arguments?.method ? ` ${e.toolCall.arguments.method}` : ''}${e.toolCall.arguments?.path ? ` ${e.toolCall.arguments.path}` : ''}`
    : `says: "${redact(e.assistantMessage?.text || '').slice(0, 140)}"`));
  const args = { ...(call?.toolCall?.arguments || {}) };
  for (const [k, v] of Object.entries(args)) args[k] = redact(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, k === 'requestJson' || k === 'steps' ? 1500 : 600);
  return {
    session: ex.session,
    found: true,
    at: hit.createdDate,
    skill: ex.skill,
    // The product appends hidden context (<HIDDEN>…) to the user's words; keep only what they typed.
    request: redact(userMsg.replace(/<HIDDEN>[\s\S]*/i, '').trim()).slice(0, 300),
    skillsLoaded: [...new Set(skills)],
    args,
    error: redact(hit.toolResult.errorMessage || out(hit.toolResult)).slice(0, 700),
    durationMs: Number(hit.metadata?.durationMs) || null,
    next,
    job: ex.job || null,
    adminUrl: `${config.adminUi}${ex.session}`,
  };
}

async function jobRootCause(job, at) {
  try {
    const t = await getJobTrace(job, at);
    const nodes = (t.graphRuns || []).flatMap((g) => g.children || []);
    const failed = nodes.filter((n) => n.rootCause);
    return {
      job,
      found: !t.notFound,
      rootCauses: [...new Set(failed.map((n) => `${n.workflowType || 'node'}: ${n.rootCause}`))].slice(0, 3),
      wrapper: (t.wrapperErrors || []).map((e) => e.message).slice(-1)[0] || null,
      slowestQueueMs: Math.max(0, ...nodes.map((n) => n.queueMs || 0)),
      temporalUrl: t.chain?.[0]?.temporalUrl || null,
    };
  } catch (err) {
    return { job, found: false, error: String(err.message || err).slice(0, 160) };
  }
}

// ---- what the codex says about it ----
export async function codexFindings(issue) {
  const ix = await codexIndex();
  if (!ix.available) return { available: false, findings: [], files: [] };
  const findings = [];
  const files = [];
  const add = (p, why, line) => files.push({ path: p, why, url: codexWebUrl(p, line) });
  const text = `${issue.sig}\n${issue.example || ''}`;

  // A resource the agent couldn't load: where does that file actually live?
  for (const p of new Set([...text.matchAll(/(?:resource|file|path)\s*"([\w./-]+\.(?:md|json|txt))"/gi)].map((m) => m[1]))) {
    if (ix.files.has(p)) {
      findings.push(`\`${p}\` exists in the codex (${ix.ref}), so loading it failed for another reason — check that it's published as a runtime resource.`);
      add(p, 'the file it tried to read');
    } else {
      const elsewhere = await findByName(path.basename(p));
      if (elsewhere.length) {
        findings.push(`\`${p}\` is not in the codex, but \`${elsewhere.join('`, `')}\` is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.`);
        for (const e of elsewhere) add(e, 'where the file really is');
        const refs = await grepCodex(path.basename(p), { max: 12 });
        if (refs.length) findings.push(`It's referred to by bare name in ${new Set(refs.map((r) => r.path)).size} file(s), e.g. ${refs.slice(0, 3).map((r) => `\`${r.path}:${r.line}\``).join(', ')} — that wording is what sends the agent looking.`);
        for (const r of refs.slice(0, 4)) add(r.path, `mentions ${path.basename(p)}`, r.line);
      } else findings.push(`\`${p}\` doesn't exist anywhere in the codex (${ix.ref}).`);
    }
  }
  // A skill the agent couldn't load.
  for (const m of new Map([...text.matchAll(/Skill "([\w-]+)" not found/g)].map((x) => [x[1], x])).values()) {
    const s = ix.skills[m[1]];
    if (s) {
      const agents = await agentsListing(s.path);
      findings.push(`Skill \`${m[1]}\` exists (\`${s.path}\`) and is listed in ${agents.length ? agents.map((a) => `\`${a}\``).join(', ') : 'no agent config'} — the failing agent's config is likely missing it (or it was loaded before being added).`);
      add(s.path, 'the skill');
    } else findings.push(`No skill is named \`${m[1]}\` in the codex.`);
  }
  // A tool name the agent made up (e.g. "functions.edit_image").
  for (const m of new Map([...text.matchAll(/unknown tool "([\w.]+)"/g)].map((x) => [x[1], x])).values()) {
    const hits = await grepCodex(m[1], { max: 8 });
    findings.push(hits.length
      ? `The codex itself writes \`${m[1]}\` in ${hits.slice(0, 3).map((h) => `\`${h.path}:${h.line}\``).join(', ')} — the agent copies it.`
      : `\`${m[1]}\` appears nowhere in the codex: the agent adds the \`functions.\` prefix on its own. Say in the sequence instructions that step tools are bare names (\`${m[1].replace(/^functions\./, '')}\`), with an example.`);
    for (const h of hits.slice(0, 3)) add(h.path, 'uses the tool name', h.line);
  }
  // The RPC method's schema (parameter problems) and the skills involved.
  if (issue.tool === 'invoke_rpc' && issue.method) {
    const p = await rpcSchemaPath(issue.method);
    if (p) add(p, `${issue.method} input schema`);
  }
  for (const o of issue.owners.slice(0, 3)) {
    const s = ix.skills[o.skill];
    if (s) add(s.path, `skill ${o.skill} (${o.n} occurrences)`);
  }
  const evals = [];
  for (const f of files.filter((x) => x.path.startsWith('skills/')).slice(0, 2)) evals.push(...(await evalSetsFor(f.path)));
  const seen = new Set();
  return { available: true, ref: ix.ref, sha: ix.sha, date: ix.date, findings: [...new Set(findings)], files: files.filter((f) => !seen.has(f.path + f.why) && seen.add(f.path + f.why)), evals: [...new Set(evals)].slice(0, 6) };
}

// ---- the brief ----
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const hrs = (h) => (h >= 10 ? `${Math.round(h)} h` : `${(h || 0).toFixed(1)} h`);
const sec = (ms) => (ms == null ? '–' : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`);

export async function buildBrief(issue, { period, withTraces = true } = {}) {
  const examples = issue.examples.slice(0, 3);
  const evidence = await Promise.all(examples.map(async (ex) => {
    try {
      return sessionEvidence(await getSessionBundle(ex.session), ex, issue);
    } catch (err) {
      return { session: ex.session, found: false, error: String(err.message || err).slice(0, 160) };
    }
  }));
  const traces = withTraces && config.temporal.apiKey
    ? await Promise.all(examples.filter((e) => e.job).slice(0, 2).map((e) => jobRootCause(e.job, e.at)))
    : [];
  const codex = await codexFindings(issue);

  const name = issue.method ? `${issue.tool} ${issue.method}` : issue.tool;
  const lines = [];
  lines.push(`# ${issue.cls.label}: ${issue.sig}`);
  lines.push('');
  lines.push(`**Where:** \`${name}\` · skills: ${issue.owners.map((o) => `${o.skill} (${o.n})`).join(', ')}`);
  lines.push(`**Owner:** ${issue.cls.owner} · **Fix difficulty:** ${issue.cls.fix} · **Pattern:** ${issue.pattern.label} (${issue.pattern.detail}) · **Trend:** ${issue.trend.dir}`);
  lines.push('');
  lines.push(`## How big (${period?.have?.[0] || ''} → ${period?.have?.at(-1) || ''}, ${period?.have?.length || '?'} days, ${issue.audLabel || 'real users'})`);
  lines.push(`- ${issue.n.toLocaleString()} occurrences (${Math.round(issue.perWeek).toLocaleString()}/week) in ${issue.sessions.toLocaleString()} sessions, ~${issue.users.toLocaleString()} accounts`);
  lines.push(`- Time lost: ${hrs(issue.lostHPerWeek)}/week (failed calls ${sec(issue.failedCallMs / Math.max(1, issue.n))} each on average, plus one recovery per run of failures until the next successful attempt started, or the turn ended) — measured`);
  lines.push(`- The same operation never succeeded later in that turn: ${pct(issue.fatal)} (the agent may have worked around it another way) · turn failed: ${issue.turnFailed} · ended the session (no later success, user never wrote again): ${issue.abandoned} · user upset afterwards: ${issue.upsetAfter} (correlated, not proven caused)`);
  if (issue.models.length) lines.push(`- Models: ${issue.models.map(([m, n]) => `${m || '–'} (${n})`).join(', ')}`);
  if (issue.versions.length) lines.push(`- By codex version: ${issue.versions.map((v) => `${v.ver.slice(0, 10)}: ${v.n}${v.rate != null ? ` (${(v.rate * 1000).toFixed(1)}/1k turns)` : ''}`).join(' · ')}`);
  lines.push('');
  lines.push('## Example error');
  lines.push('```');
  lines.push(redact(issue.example || issue.sig).slice(0, 600));
  lines.push('```');
  if (codex.findings?.length) {
    lines.push('');
    lines.push(`## What the codex shows (${codex.ref} @ ${codex.sha}, ${String(codex.date).slice(0, 10)})`);
    for (const f of codex.findings) lines.push(`- ${f}`);
  }
  if (traces.some((t) => t.rootCauses?.length || t.wrapper)) {
    lines.push('');
    lines.push('## Genix root cause (Temporal)');
    for (const t of traces) {
      if (t.rootCauses?.length) for (const r of t.rootCauses) lines.push(`- ${r}${t.temporalUrl ? ` ([trace](${t.temporalUrl}))` : ''}`);
      else if (t.wrapper) lines.push(`- ${t.wrapper}`);
    }
  }
  lines.push('');
  lines.push('## Evidence (examples, redacted)');
  for (const e of evidence) {
    if (!e.found) {
      lines.push(`- ${e.session}: ${e.error || 'the failing call was not found in the session'}`);
      continue;
    }
    lines.push(`- **${e.skill || 'session'}** ${e.at} — [admin](${e.adminUrl})`);
    if (e.request) lines.push(`  - Request: "${e.request}"`);
    lines.push(`  - Skills loaded: ${e.skillsLoaded.join(', ') || 'none'}`);
    lines.push(`  - Call: \`${JSON.stringify(e.args).slice(0, 400)}\``);
    lines.push(`  - Error: ${e.error.slice(0, 300).replace(/\n/g, ' ')}`);
    if (e.next.length) lines.push(`  - Then: ${e.next.join(' → ')}`);
  }
  lines.push('');
  lines.push('## Suggested fix');
  lines.push(`- ${issue.cls.hint}`);
  if (issue.cls.id === 'missing-resource' && codex.findings?.some((f) => f.includes('inlined into skills'))) lines.push('- Either publish the file under resources/ (where the agent reads at runtime), or reword the bare-name references to point at the section already inlined above ("see *Data model* above"), so the agent stops looking for a file.');
  if (issue.cls.id === 'hidden-timeout') lines.push('- See Wait times for this operation: the measured success distribution, the current cap and the recommended wait.');
  if (codex.files?.length) {
    lines.push('');
    lines.push('## Files to look at');
    for (const f of codex.files.slice(0, 10)) lines.push(`- [${f.path}](${f.url}) — ${f.why}`);
  }
  lines.push('');
  lines.push('## Verify');
  lines.push('- After the change ships, Autopsy Fleet shows this issue\'s rate per codex version (Versions). Mark it *Fixed in version …* to track before/after.');
  if (codex.evals?.length) lines.push(`- Re-run the eval sets mapped to the skill: ${codex.evals.map((t) => `\`${t}\``).join(', ')}`);
  const ev = evidence.find((e) => e.found);
  if (ev) {
    lines.push('- Repro (the failing call, redacted):');
    lines.push('```json');
    lines.push(JSON.stringify({ tool: issue.tool, arguments: ev.args }, null, 2).slice(0, 1800));
    lines.push('```');
  }
  return { key: issue.key, markdown: lines.join('\n'), evidence, traces, codex, builtAt: Date.now() };
}

// ---- optional: draft the fix with Claude (local CLI, read-only tools, in the codex checkout) ----
const drafts = new Map();
let claudeOk;
export const claudeAvailable = () => (claudeOk ??= spawnSync('claude', ['--version'], { timeout: 5000 }).status === 0);

const CODEX_READING = 'You are in a checkout of wix-private/wixel-agent-codex (the Wixel agent\'s skills and configs). The working tree may be stale: read the latest files with `git show origin/HEAD:<path>` and search with `git grep <text> origin/HEAD`.';
const DRAFT_ASK = 'Propose the smallest change to the codex that fixes the issue above. Do NOT edit any files. Reply with: 1) the root cause in two sentences, 2) the change as a unified diff against origin/HEAD, 3) how to verify it (which eval set or a manual check). If the fix is outside the codex (platform, tool code, provider), say who should change what instead.';

// `instruction` replaces the default ask; `onDone(d)` runs when it finishes (e.g. to store it).
export function startDraft(key, brief, { instruction = DRAFT_ASK, onDone } = {}) {
  const cur = drafts.get(key);
  if (cur?.state === 'running') return cur;
  const d = { key, state: 'running', startedAt: Date.now(), output: '', error: null };
  drafts.set(key, d);
  const prompt = `${brief}\n\n---\n${CODEX_READING}\n${instruction}`;
  // Read-only for real: only these tools exist in the session (--tools), edits are refused even if
  // the user's settings would allow them, and permission prompts can't be auto-accepted.
  const child = spawn('claude', ['-p', '--output-format', 'text', '--permission-mode', 'default',
    '--tools', 'Read', 'Grep', 'Glob', 'Bash',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git show:*)', 'Bash(git grep:*)', 'Bash(git log:*)', 'Bash(git ls-tree:*)',
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit'], { cwd: codexDir(), stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 6 * 60000);
  child.stdout.on('data', (b) => (d.output += b.toString()));
  child.stderr.on('data', (b) => (d.error = ((d.error || '') + b.toString()).slice(-2000)));
  child.on('close', (code) => {
    clearTimeout(timer);
    d.state = code === 0 ? 'done' : 'failed';
    d.finishedAt = Date.now();
    const why = `${d.output}\n${d.error || ''}`;
    if (code !== 0 && /authenticat|log ?in|OAuth|credentials/i.test(why)) d.hint = 'The claude CLI isn\'t signed in. Run `claude` once in a terminal and sign in, then try again.';
    if (onDone) Promise.resolve(onDone(d)).catch((err) => console.error(`draft ${key}: ${err.message}`));
  });
  child.on('error', (err) => {
    d.state = 'failed';
    d.error = String(err.message || err);
  });
  child.stdin.end(prompt);
  return d;
}
export const draftStatus = (key) => drafts.get(key) || { key, state: 'none' };
