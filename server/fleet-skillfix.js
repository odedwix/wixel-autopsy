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
import { sql } from './admin.js';
import { cached } from './cache.js';
import { wilson } from './fleet-analyze.js';

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
      notes.push(`The sampled failing calls pass cloud-storage links: ${cloud.slice(0, 3).map(([h, n]) => `${h} (${n})`).join(', ')}.`);
      fix.push(`In ${skill}'s instructions, don't hand \`${name}\` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call \`${name}\` right after the step that produced it.`);
    }
    if (sites.length) {
      notes.push(`The sampled failing calls pass images from other websites: ${sites.slice(0, 4).map(([h, n]) => `${h} (${n})`).join(', ')}.`);
      fix.push(`In ${skill}'s instructions, before calling \`${name}\` with a site image, re-host it on Wix (the upload / convert step the skill already uses for site assets) and pass the wixstatic URL.`);
    }
    if (wixShare != null && wixShare > 0.5) {
      notes.push('Most of the sampled failing URLs are on Wix media hosts.');
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
    notes.push('The agent wrote JSON that doesn\'t parse.');
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

// ---- proof: a change is suggested only when the cause is proven and the change removes it ----
// (An audit on 2026-10-07 found most generated fixes were guesses: "rejected parameters" is the
// gateway's wrapper on every provider error, "invalid JSON" follows content length, a host seen in
// two failing calls says nothing without the successful calls.) Unproven issues show what was
// observed and what would prove a fix, and no change.
const FETCH_ERR = [/fetch content from the provided URL/i, /Error while downloading file/i, /failedToTransferImage/i, /failed to download the source image/i];
const isWixHost = (h) => WIX_HOSTS.test(h || '');

// Every call of the operation over the last day, failures of this error by the first input URL's
// host: is a host class the cause? (≥20 failures, ≥5× the Wix-hosted rate with non-overlapping 95%
// intervals, and ≥70% of the failures.) One Trino query, cached 6 h.
async function hostProof(issue) {
  const frag = FETCH_ERR.map((re) => re.source.replace(/\\/g, '')).find((x) => new RegExp(x, 'i').test(`${issue.sig}\n${issue.example || ''}`));
  if (!frag || !/^[\w ]+$/.test(frag)) return null;
  const tool = String(issue.tool || '').replace(/[^\w]/g, '');
  const method = issue.method ? String(issue.method).replace(/[^\w]/g, '') : null;
  return cached('fleet-proof', `host__${tool}__${method || ''}__${frag.replace(/\W+/g, '_')}`, 6 * 3600000, async () => {
    const ENTRIES = 'domain_events.www_wixel_agent.v1_session_entry_crud';
    const since = "created_date >= current_timestamp - INTERVAL '1' DAY";
    const rows = await sql(`
WITH c AS (
  SELECT session_id, tool_call.tool_call_id AS cid, lower(regexp_extract(json_format(CAST(tool_call.arguments AS json)), 'https?://([^/"\\\\?:]+)', 1)) AS host
  FROM ${ENTRIES} WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = '${tool}'${method ? ` AND element_at(tool_call.arguments, 'method') = '${method}'` : ''} AND ${since}
),
r AS (
  SELECT session_id, tool_result.tool_call_id AS cid, lower(coalesce(tool_result.error_message, element_at(tool_result.result, 'output'))) LIKE '%${frag.toLowerCase()}%' AS hit
  FROM ${ENTRIES} WHERE entry_type = 'TOOL_RESULT' AND tool_result.tool_name = '${tool}' AND ${since}
)
SELECT coalesce(c.host, '(no url)') AS host, count(*) AS calls, count_if(r.hit) AS fails
FROM c JOIN r ON r.session_id = c.session_id AND r.cid = c.cid
GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 300`, { maxRows: 300 });
    return { value: rows.map((x) => ({ host: x.host, calls: Number(x.calls), fails: Number(x.fails) })), ttlMs: 6 * 3600000 };
  });
}

function judgeHosts(rows) {
  const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
  const wix = rows.filter((x) => isWixHost(x.host));
  const other = rows.filter((x) => !isWixHost(x.host) && x.host !== '(no url)');
  const fails = sum(rows, 'fails');
  const wixRate = sum(wix, 'fails') / Math.max(1, sum(wix, 'calls'));
  const wixCi = wilson(sum(wix, 'fails'), sum(wix, 'calls'));
  // Suspect hosts: each failing ≥5× the Wix rate.
  const suspects = other.filter((x) => x.calls >= 5 && x.fails / x.calls >= 5 * Math.max(wixRate, 0.002));
  const sf = sum(suspects, 'fails');
  const sc = sum(suspects, 'calls');
  const ci = wilson(sf, sc);
  const of = suspects.length ? suspects : other;
  const of_f = sum(of, 'fails');
  const of_c = sum(of, 'calls');
  const pctOf = (f, c) => `${((f / Math.max(1, c)) * 100).toFixed(1)}%`;
  const facts = `${of_f} of ${of_c} calls with ${suspects.length ? suspects.slice(0, 3).map((x) => x.host).join(', ') : 'non-Wix'} image URLs failed this way (${pctOf(of_f, of_c)}), against ${sum(wix, 'fails')} of ${sum(wix, 'calls')} with Wix-hosted ones (${pctOf(sum(wix, 'fails'), sum(wix, 'calls'))}), over the last day.`;
  const ok = fails >= 20 && sf >= 0.7 * fails && sc && sf / sc >= 5 * wixRate && ci.lo > wixCi.hi;
  return { ok, facts, hosts: suspects.slice(0, 5).map((x) => x.host), fails };
}

async function proveFix(issue, skill, codex, skillLines) {
  const sig = `${issue.sig}\n${issue.example || ''}`;
  const name = issue.method || issue.tool;
  // A missing file: absent at the runtime path, present only under references/ (inlined at build
  // time), and named bare in the codex text the skill uses.
  if (issue.cls.id === 'missing-resource') {
    if (/Skill ".*" not found/.test(sig)) return { ok: false, why: 'The skill exists; the failing agent\'s config doesn\'t list it (an agent-config change, outside the skill).', prove: 'Check agents/<agent>.json for the failing sessions.' };
    if (codex.proof?.missingFile?.refs?.length) return { ok: true, why: `${codex.proof.missingFile.path} isn't readable at runtime and the codex names it bare in ${codex.proof.missingFile.refs.length} place(s).` };
    return { ok: false, why: 'The missing path wasn\'t traced to wording in the codex.', prove: 'Find where the agent gets the path from (grep the codex for the file name).' };
  }
  if (FETCH_ERR.some((re) => re.test(sig))) {
    const rows = await hostProof(issue).catch(() => null);
    if (!rows) return { ok: false, why: 'The host comparison couldn\'t run (Trino busy).', prove: 'Open this again later.' };
    const j = judgeHosts(rows);
    if (j.ok) return { ok: true, why: j.facts, hosts: j.hosts, fix: `In ${skill}'s instructions, re-host images from ${j.hosts.join(', ')} on Wix (convert_image_format, as the skill does for site assets) before passing them to \`${name}\`, and pass the wixstatic URL.` };
    return { ok: false, why: `Not tied to where the image comes from: ${j.facts}`, prove: 'A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it\'s the provider or a transient fetch.' };
  }
  const unknownTool = sig.match(/unknown tool "([\w.]+)"/);
  if (unknownTool) {
    if (codex.proof?.codexWritesTool) return { ok: true, why: `The codex itself writes \`${unknownTool[1]}\`, and the agent copies it.` };
    return { ok: false, why: `The codex never writes \`${unknownTool[1]}\`: the agent adds the prefix itself, and a skill that already shows the right call still gets it.`, prove: 'The sure fix is in the tool (accept the prefix) — outside the skills.' };
  }
  const why = {
    'provider-params': ['The error doesn\'t name a parameter (INVALID_ARGUMENT / [400] wraps every provider error).', 'Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.'],
    'content-policy': ['Mostly the user\'s own content.', 'A skill change helps only if the agent added the words the filter flags — check the prompts it wrote.'],
    validation: ['The agent fixes most of these on its own next try.', 'Show the rule in the skill only if the skill\'s own example breaks it.'],
    'agent-misuse': ['The agent called the tool wrongly, but whether the skill\'s text causes it isn\'t checked.', 'Proven if most failing calls miss the same field and the skill\'s own example leaves it out (or, for invalid JSON, if failures track content length on updates).'],
    unclassified: ['No rule matched this error.', 'Classify it from the examples first.'],
  }[issue.cls.id] || ['Not a skill fix.', ''];
  return { ok: false, why: why[0], prove: why[1] };
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
  const { notes, fix: guesses } = diagnose(issue, skill, evidence, codex, skillLines);
  const proof = await proveFix(issue, skill, codex, skillLines);
  const fix = proof.ok ? (proof.fix ? [proof.fix] : guesses) : [];
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
  if (!proof.ok) {
    // Observed, not proven: the evidence, what would prove a fix — no change, no prompt.
    return { skill, parked: true, unproven: true, reason: proof.why, prove: proof.prove, n, share, skillPath: s?.path || null, skillUrl: s ? codexWebUrl(s.path) : null, notes, files, evidence: evidence.map((e) => (e.found ? { session: e.session, at: e.at, request: e.request, error: e.error.slice(0, 300), next: e.next, adminUrl: e.adminUrl } : e)) };
  }
  return {
    skill,
    parked: false,
    proof: proof.why,
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
