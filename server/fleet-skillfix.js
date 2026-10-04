// Fix per skill: for one Fleet issue and one skill it happens in, what to change in THAT skill.
// Scope is the skill's own instructions — its file in the codex and the references / resources it
// points the agent at. Fixes that live outside skills (tool code, timeouts, restarts, providers,
// permissions) are parked: no suggestion, no prompt.
//
// Built from that skill's own failing calls (≤2 sessions from the admin API, cached), patterns in
// the arguments it passed, and the lines of its skill file that talk about the tool. A Claude-written
// suggestion is optional and stored in FLEET_DIR/suggestions (shared, keyed by the codex commit).

import fs from 'node:fs/promises';
import path from 'node:path';
import { getSessionBundle } from './admin.js';
import { fleetDir } from './fleet.js';
import { sessionEvidence, codexFindings, redact, startDraft, draftStatus } from './fleet-brief.js';
import { codexIndex, linesMentioning, codexWebUrl, evalSetsFor } from './codex.js';

// Error kinds a skill's instructions can fix.
export const SKILL_FIXABLE = new Set(['missing-resource', 'agent-misuse', 'validation', 'content-policy', 'provider-params', 'unclassified']);

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};
// Every URL in the call's arguments (including inside requestJson / steps), by host.
function urlHosts(evidence) {
  const hosts = {};
  for (const e of evidence.filter((x) => x.found)) {
    const text = Object.values(e.args || {}).join(' ');
    for (const m of text.matchAll(/https?:\/\/[^\s"'\\)]+/g)) {
      const h = hostOf(m[0]);
      if (h) hosts[h] = (hosts[h] || 0) + 1;
    }
  }
  return Object.entries(hosts).sort((a, b) => b[1] - a[1]);
}
const WIX_HOSTS = /(^|\.)(wixstatic\.com|wixmp\.com|wix\.com|wixel\.com|parastorage\.com)$/;
const CLOUD_HOSTS = /(^|\.)(storage\.googleapis\.com|googleusercontent\.com|amazonaws\.com|cloudfront\.net|blob\.core\.windows\.net|r2\.dev)$/;

// What the evidence says, in plain words, plus what to change in the skill.
function diagnose(issue, skill, evidence, codex, skillLines) {
  const notes = [];
  const fix = [];
  const sig = `${issue.sig}\n${issue.example || ''}`;
  const name = issue.method || issue.tool;
  const hosts = urlHosts(evidence);
  const external = hosts.filter(([h]) => !WIX_HOSTS.test(h));
  const wixShare = hosts.length ? hosts.filter(([h]) => WIX_HOSTS.test(h)).reduce((a, [, n]) => a + n, 0) / hosts.reduce((a, [, n]) => a + n, 0) : null;

  if (/fetch content from the provided URL|downloading file|failedToTransferImage|failed to download the source image|403/i.test(sig)) {
    const cloud = external.filter(([h]) => CLOUD_HOSTS.test(h));
    const sites = external.filter(([h]) => !CLOUD_HOSTS.test(h));
    if (cloud.length) {
      notes.push(`The failing calls pass cloud-storage links: ${cloud.slice(0, 3).map(([h, n]) => `${h} (${n})`).join(', ')}. These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.`);
      fix.push(`In ${skill}'s instructions, don't hand \`${name}\` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call \`${name}\` right after the step that produced it.`);
    }
    if (sites.length) {
      notes.push(`The failing calls pass images straight from other websites: ${sites.slice(0, 4).map(([h, n]) => `${h} (${n})`).join(', ')}. Sites often block hotlinking, so the model provider can't fetch them.`);
      fix.push(`In ${skill}'s instructions, before calling \`${name}\` with a site image, re-host it on Wix (the upload / convert step the skill already uses for site assets) and pass the wixstatic URL.`);
    }
    if (wixShare != null && wixShare > 0.5) {
      notes.push('Most failing URLs are on Wix media hosts, so the link itself is wrong or expired: a URL copied with a transformation suffix, a temporary link, or one retyped instead of copied.');
      fix.push(`Tell the agent to pass media URLs exactly as a previous tool returned them (no editing, no /v1/ transform suffixes), and to re-fetch a fresh URL instead of reusing one from earlier in a long session.`);
    }
    if (!hosts.length) fix.push(`Tell the agent which image URL to pass to \`${name}\` and where it comes from (the asset's own URL, not a page or thumbnail link).`);
  }
  const unknownTool = sig.match(/unknown tool "([\w.]+)"/);
  if (unknownTool) {
    const bare = unknownTool[1].replace(/^functions\./, '');
    notes.push(`The agent wrote the tool name as \`${unknownTool[1]}\`. Inside a sequence, step tools are bare names.`);
    fix.push(`Where ${skill} describes the sequence, add one literal example step with \`"tool": "${bare}"\` and say plainly: no \`functions.\` prefix.`);
  }
  if (/Invalid JSON|Expected ',' or|Expected double-quoted/i.test(sig)) {
    notes.push('The agent wrote JSON that doesn\'t parse — usually a long content string with an unescaped quote or a trailing comma.');
    fix.push(`Have ${skill} prefer small \`edits\` over rewriting the whole file, and show one valid edit example; long free text belongs in fields the agent copies, not retypes.`);
  }
  if (/path or name is required|Provide exactly one of content, edits|unsupported op|requires the existing asset|expects an unsuffixed/i.test(sig)) {
    notes.push('The agent called `write` without a required part (path / name / one of content, edits, patch) or with the wrong intent.');
    fix.push(`Add the exact \`write\` call shape ${skill} needs (with path and intent) next to where it tells the agent to save, for both create and update.`);
  }
  if (issue.cls.id === 'missing-resource') {
    for (const f of codex.findings || []) notes.push(f.replace(/`/g, ''));
    fix.push(`Reword ${skill}'s mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.`);
  }
  if (issue.cls.id === 'validation') {
    const codes = [...new Set([...sig.matchAll(/"code"\s*:\s*"([A-Z_]{5,})"/g)].map((m) => m[1]))];
    if (codes.length) notes.push(`The asset was rejected with ${codes.map((c) => `\`${c}\``).join(', ')}.`);
    fix.push(`State the rule behind ${codes[0] ? `\`${codes[0]}\`` : 'the validation error'} in ${skill} where it builds the asset, and have the agent check it before writing.`);
  }
  if (issue.cls.id === 'content-policy') fix.push(`Give ${skill} a short list of what the provider refuses and how to phrase around it (no real people's names, brands, violence…), and tell the user plainly when it's their content.`);
  if (issue.cls.id === 'provider-params' && !fix.length) fix.push(`Check the parameters ${skill} tells the agent to pass to \`${name}\` against the model's live schema; spell out the allowed values in the skill.`);
  if (!fix.length) fix.push(issue.cls.hint);
  if (!skillLines.length) notes.push(`${skill}'s file doesn't mention \`${name}\` by name; the call likely comes from a reference it includes, or from the agent improvising.`);
  return { notes, fix };
}

const fileFor = (key, skill) => path.join(fleetDir(), 'suggestions', `${key}__${skill.replace(/[^\w.-]+/g, '_')}.json`);
async function readSaved(key, skill) {
  try {
    return JSON.parse(await fs.readFile(fileFor(key, skill), 'utf8'));
  } catch {
    return null;
  }
}
async function save(key, skill, value) {
  const f = fileFor(key, skill);
  await fs.mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 1));
  await fs.rename(tmp, f);
}

export async function skillFix(issue, skill, { period } = {}) {
  if (!SKILL_FIXABLE.has(issue.cls.id)) return { skill, parked: true, reason: `${issue.cls.label} isn't fixed in a skill (${issue.cls.owner}) — parked for later.` };
  const ix = await codexIndex();
  const s = ix.available ? ix.skills[skill] : null;
  const examples = (issue.examplesBySkill?.[skill] || []).slice(0, 2);
  const evidence = await Promise.all(examples.map(async (ex) => {
    try {
      return sessionEvidence(await getSessionBundle(ex.session), ex, issue);
    } catch (err) {
      return { session: ex.session, found: false, error: String(err.message || err).slice(0, 160) };
    }
  }));
  const codex = await codexFindings(issue);
  const terms = [issue.method, issue.tool === 'invoke_rpc' ? null : issue.tool].filter(Boolean);
  const skillLines = s ? await linesMentioning(s.path, terms) : [];
  const { notes, fix } = diagnose(issue, skill, evidence, codex, skillLines);
  const evals = s ? await evalSetsFor(s.path) : [];
  const n = issue.owners.find((o) => o.skill === skill)?.n || 0;
  const share = issue.n ? n / issue.n : 0;
  const files = [
    s ? { path: s.path, why: `the ${skill} skill`, url: codexWebUrl(s.path) } : null,
    ...skillLines.slice(0, 4).map((l) => ({ path: s.path, line: l.line, why: `mentions ${terms.join(' / ')}: "${l.text.slice(0, 90)}"`, url: codexWebUrl(s.path, l.line) })),
    ...(codex.files || []).filter((f) => !f.path.startsWith('skills/') || f.path === s?.path).slice(0, 4),
  ].filter(Boolean);

  // The prompt: Claude Code in the codex repo, limited to this skill.
  const ev = evidence.find((e) => e.found);
  const prompt = [
    `Fix a recurring failure in the \`${skill}\` skill of the Wixel agent (repo wix-private/wixel-agent-codex).`,
    '',
    `Problem: \`${issue.method || issue.tool}\` fails with: ${issue.sig}`,
    `Size: ${n.toLocaleString()} times in ${skill} in the last ${period?.have?.length || '?'} days (${Math.round(share * 100)}% of this error across skills); the same operation never succeeded later in the turn ${Math.round(issue.fatal * 100)}% of the time.`,
    '',
    'What the evidence shows:',
    ...notes.map((x) => `- ${x}`),
    '',
    'Change to make:',
    ...fix.map((x) => `- ${x}`),
    '',
    `Scope: edit only ${s ? `\`${s.path}\`` : `the ${skill} skill file`}${(codex.files || []).some((f) => !f.path.startsWith('skills/')) ? ' and the references/resources it points the agent at' : ''}. Don't change tools, agent configs or system prompts. Keep the skill's behaviour everywhere else the same; prefer the smallest wording change.`,
    skillLines.length ? `Start from these lines: ${skillLines.slice(0, 4).map((l) => `${s.path}:${l.line}`).join(', ')}.` : null,
    ev ? `\nA failing call (redacted):\n\`\`\`json\n${JSON.stringify({ tool: issue.tool, arguments: ev.args }, null, 2).slice(0, 1500)}\n\`\`\`\nError: ${ev.error.slice(0, 300)}` : null,
    '',
    `Then: add a case for this to the skill's eval set${evals.length ? ` (${evals.slice(0, 3).join(', ')})` : ''} built from the failing call above, and show me the diff before committing.`,
  ].filter((x) => x != null).join('\n');

  const saved = await readSaved(issue.key, skill);
  return {
    skill,
    parked: false,
    n,
    share,
    skillPath: s?.path || null,
    skillUrl: s ? codexWebUrl(s.path) : null,
    codexRef: ix.available ? `${ix.ref} @ ${ix.sha}` : null,
    hosts: urlHosts(evidence).slice(0, 6),
    notes,
    fix,
    files,
    evals,
    evidence: evidence.map((e) => (e.found ? { session: e.session, at: e.at, request: e.request, error: e.error.slice(0, 300), next: e.next, adminUrl: e.adminUrl } : e)),
    prompt,
    claude: saved && saved.sha === ix.sha ? saved : saved ? { ...saved, stale: true } : null,
    claudeRunning: draftStatus(`${issue.key}:${skill}`).state === 'running',
  };
}

// Ask Claude (local CLI, read-only, in the codex checkout) for a suggestion limited to the skill.
// The answer is stored for everyone sharing the Fleet folder, tagged with the codex commit it read.
export async function askClaude(issue, skill, prompt) {
  const ix = await codexIndex();
  const key = `${issue.key}:${skill}`;
  return startDraft(key, redact(prompt), {
    instruction: `Suggest the change to the ${skill} skill only (its file and the references/resources it points to). Do NOT edit any files. Reply with: 1) the cause in two sentences, 2) the exact wording change as a unified diff against origin/HEAD, 3) one eval case (input + what a pass looks like). If no change to the skill can fix it, say so and why.`,
    onDone: async (d) => {
      if (d.state === 'done' && d.output.trim()) await save(issue.key, skill, { skill, key: issue.key, sha: ix.sha, at: Date.now(), text: d.output });
    },
  });
}
export async function skillClaudeStatus(key, skill) {
  const d = draftStatus(`${key}:${skill}`);
  return { state: d.state, startedAt: d.startedAt || null, hint: d.hint || null, error: d.state === 'failed' ? (d.error || d.output || '').slice(-400) : null, saved: await readSaved(key, skill) };
}
