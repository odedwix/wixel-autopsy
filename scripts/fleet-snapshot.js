// Write what Fleet knows into the repo as a readable snapshot: knowledge/README.md (the findings,
// in plain words) plus trimmed JSON of the last 7 and 30 days and the fix per skill for the top
// issues. Built from the day files in FLEET_DIR (no Trino for the days); fixes per skill read a few
// example sessions (admin API, cached) and the codex checkout (git, read-only), and proving an
// image-fetch fix runs one small host-comparison query per such issue (cached 6 h).
//
//   npm run fleet:snapshot                # 7 and 30 days ending yesterday, real users
//   npm run fleet:snapshot -- --no-fixes  # skip the per-skill fixes (no admin API calls)

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { fleetView } from '../server/fleet.js';
import { skillFix } from '../server/fleet-skillfix.js';
import { codexSummary } from '../server/codex.js';

process.env.FLEET_READONLY = '1'; // a snapshot never builds days
const args = process.argv.slice(2);
const withFixes = !args.includes('--no-fixes');
const OUT = path.join(config.root, 'knowledge');
const H = (x) => (x == null ? '–' : x >= 10 ? `${Math.round(x)} h` : x >= 1 ? `${x.toFixed(1)} h` : `${Math.round(x * 60)} min`);
const N = (x) => (x == null ? '–' : Math.round(x).toLocaleString('en-US'));
const P = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const S = (ms) => (ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`);
const skillName = (s) => (s === '(none)' ? 'no skill' : s);
const op = (i) => (i.method ? `${i.tool} · ${i.method}` : i.tool);

// The analysis without what's bulky or per-session (day-hour maps, example ids, histograms).
function trim(v) {
  return {
    period: v.period,
    aud: v.aud,
    totals: v.totals,
    prevTotals: v.prevTotals,
    daily: v.daily.map(({ versions, ...d }) => d),
    actions: v.actions,
    shifts: v.shifts,
    skills: v.skills.map(({ versions, ...s }) => s),
    issues: v.issues.slice(0, 120).map(({ dayHours, examples, examplesBySkill, ...i }) => i),
    waits: v.waits.filter((w) => w.recommend || w.hidden || w.calls * v.period.weekFactor >= 200).map(({ okHist, failHist, ...w }) => w),
    opportunities: v.opportunities,
    intents: v.intents,
    health: v.health,
    // Efficiency (models / reads / follow-ups parts): the model mix and each skill's numbers, with its
    // 15 biggest files and 8 most frequent failing calls.
    efficiency: v.efficiency ? { days: v.efficiency.days, models: v.efficiency.models, skills: v.efficiency.skills.map((s) => ({ ...s, files: s.files.slice(0, 15), failOps: s.failOps.slice(0, 8) })) } : null,
  };
}

function digest(v7, v30, fixes, codex, state) {
  const t = v7.totals;
  const wf = v7.period.weekFactor;
  const L = [];
  L.push('# Autopsy Fleet — what we know');
  L.push('');
  L.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from the Fleet day rollups (\`.fleet/days\`). Last 7 days: ${v7.period.have[0]} → ${v7.period.have.at(-1)} (${v7.period.have.length} days built); last 30 days: ${v30.period.have.length} days built. Real users only. Codex: ${codex.available ? `${codex.ref} @ ${codex.sha} (${String(codex.date).slice(0, 10)})` : 'not available'}.`);
  L.push('');
  L.push('Counts, durations, recoveries, tokens and outcomes are measured from the agent\'s own entries. "Time lost" = each failed call\'s time plus one recovery per run of consecutive failures (until the next successful attempt started, else the turn\'s end). Savings and recommended timeouts are estimates. Definitions: README → Fleet.');
  L.push('');
  L.push('## The week in numbers');
  L.push(`- ${N(t.sessions)} sessions, ${N(t.turns)} turns, ${N(t.calls)} tool calls`);
  L.push(`- ${P((t.fails - t.creditFails) / Math.max(1, t.calls), 1)} of tool calls fail (out of credits excluded); ${H((t.lostMs / 3600000) * wf)} a week lost to failures`);
  L.push(`- ${N(t.hidden)} hidden timeouts (the tool returned while its job was still running)`);
  L.push(`- ${P(t.frustrated / Math.max(1, t.turns), 1)} of turns frustrated; ${(t.iterations / Math.max(1, t.turns)).toFixed(1)} model iterations per turn; ${Math.round(t.inTokens / Math.max(1, t.iterations) / 1000)}k input tokens per iteration`);
  if (t.outcomeDays) L.push(`- Outputs kept (downloaded): ${P(t.kept / Math.max(1, t.produced))} of sessions that produced one; ${P(t.triedNoOutput / Math.max(1, t.outSessions))} generated but wrote nothing`);
  L.push(`- ${P(t.noSkillSessions / Math.max(1, t.sessions), 1)} of sessions used no skill`);
  L.push('');
  L.push('## Things we learned about the data');
  L.push('- **Skills are preloaded since 2026-09-30.** The platform puts skills into the session\'s first message (`metadata.preloadedSkillBodies`) instead of the agent calling the `skill` tool: sessions with a skill-tool call fell from ~85% to ~40% overnight, across every agent. Fleet and Autopsy\'s per-skill views count both.');
  L.push('- **What a session made:** `TURN_UPDATED_ASSETS` was logged 2026-09-16 → 09-28 and again from 10-05. Main sessions\' writes are in `WRITE_METERING`; sub-agents (campaigns: `session_type` SUB) don\'t log it, so the `write` tool\'s own results (they name the asset id) are the reliable record. Assets that merely appear in a shared project are not a session\'s output.');
  L.push('- **Fix suggestions are shown only when proven** (an audit on 2026-10-07 found most generated ones were guesses): a missing file traced in the codex, or an image host failing ≥5× the Wix rate across every call. "Same call every time" was wrong for ListCosts (it returns each user\'s credits: 313 calls, 50 different answers).');
  L.push('- **Hidden timeouts:** several tools (`generateMusic`, `poll_process_job`, `Generate*Async`, `BuildPresentation`) report success after ~15 minutes while the job is still `IN_PROGRESS`.');
  L.push('- **`ask_user` "User cancelled the question"** is how questions normally resolve — not a failure.');
  L.push('- **The admin SQL endpoint** now answers the whole result at once and ignores `limit` / `offset` (seen 2026-10-08). Autopsy stops at the first page that holds more than it asked for; before that, every query over 500 rows ran again for each 500-row page and repeated its rows.');
  L.push('- **Agent models:** iterations run on gpt-6-luna, gpt-6.1-sol, gemini-3.8-flash and gemini-3.0-flash (main turns) and claude-sonnet-5-5 (sub-agents); the mix changes by skill and by day. Every iteration re-reads the whole context — typically 80–320k input tokens, 85–97% cached — to write a few hundred tokens.');
  L.push('- **Preloaded skills** put the skill body into the first message (4k–132k tokens), and every file the agent reads stays in the context for the rest of the session.');
  L.push('- **Paying users:** Wixel\'s own plans per account are in `prod.wixel.accounts_dim` (Basic / Pro / Max / Top-Up; ~1,058 paying of ~554k accounts on 2026-10-08).');
  if (v30.shifts?.length) {
    L.push('');
    L.push('## What changed (last 30 days)');
    for (const x of v30.shifts.slice(0, 15)) {
      const fmt = (y) => (x.fmt === 'pct' ? P(y, 1) : x.fmt === 'k' ? `${Math.round(y / 1000)}k` : x.fmt === 'n' ? N(y) : y?.toFixed(1));
      L.push(`- ${x.day}: **${x.metric}**${x.from != null ? ` ${fmt(x.from)} → ${fmt(x.to)}` : ''}${x.newVersions?.length ? ` · new codex version ${x.newVersions.map((n) => `${n.ver.slice(0, 10)} (${P(n.share)} of turns)`).join(', ')}` : ''}`);
    }
  }
  L.push('');
  L.push('## Biggest problems (measured time lost a week)');
  L.push('A fix is suggested only where the cause is proven (see "Top issues"); time lost is measured, not time a fix would give back.');
  v7.actions.forEach((a, k) => L.push(`${k + 1}. ${a.title.slice(0, 160)} — **${H(a.hPerWeek)}/week lost** · ${a.owner}`));
  L.push('');
  L.push('## Top issues, and the fixes that are proven');
  L.push('A "Change" is listed only where the cause is proven (a missing file traced in the codex, a failing image host that fails ≥5× the Wix rate…). Otherwise the issue shows what was observed and what would prove a fix.');
  for (const i of v7.issues.filter((x) => x.score > 0).slice(0, 15)) {
    const st = state.issues?.[i.key];
    L.push('');
    L.push(`### ${i.sig.slice(0, 150)}`);
    L.push(`\`${op(i)}\` · ${i.cls.label} · ${i.cls.fix} fix · owner: ${i.cls.owner} · ${N(i.perWeek)}/week in ${N(i.sessions)} sessions · ${H(i.lostHPerWeek)}/week lost · ${i.pattern.label}${i.trend.dir !== 'flat' ? ` · ${i.trend.dir}` : ''}${st?.status ? ` · **${st.status}${st.version ? ` in ${st.version}` : ''}**${st.note ? ` (${st.note})` : ''}` : ''}`);
    L.push(`Skills: ${i.owners.slice(0, 6).map((o) => `${skillName(o.skill)} (${N(o.n)})`).join(', ')}`);
    const fx = fixes.filter((f) => f.issue === i.key);
    if (!i.skillFix) L.push(`- Not a skill fix (${i.cls.owner}) — parked. ${i.cls.hint}`);
    for (const f of fx) {
      if (f.error) continue;
      if (f.unproven) {
        L.push(`- **${f.skill}** (${N(f.n)}, ${P(f.share)}) — no proven fix: ${f.reason}${f.prove ? ` What would prove one: ${f.prove}` : ''}`);
        continue;
      }
      if (f.parked) continue;
      L.push(`- **${f.skill}** (${N(f.n)}, ${P(f.share)}) — ${f.skillPath ? `\`${f.skillPath}\`` : 'skill file not found'}${f.files.filter((x) => x.line).length ? ` lines ${f.files.filter((x) => x.line).map((x) => x.line).join(', ')}` : ''}`);
      for (const n of f.notes) L.push(`  - Seen: ${n}`);
      for (const c of f.fix) L.push(`  - Change: ${c}`);
    }
    if (i.skillFix && !fx.length) L.push('- Not checked per skill yet.');
  }
  L.push('');
  L.push('## Wait times');
  for (const w of v7.waits.filter((x) => x.recommend || x.hidden).slice(0, 12)) {
    L.push(`- \`${op(w)}\`${w.size ? ` (${w.size})` : ''}: p50 ${S(w.p50)}, p99 ${S(w.p99)}${w.hidden ? `, ${w.hidden} hidden timeouts${w.cap ? ` at ${S(w.cap)}` : ''}` : ''}${w.recommend ? ` → model estimate: wait at most ${S(w.recommend.tau)} (unproven: assumes a free, independent restart)` : ''}`);
  }
  L.push('');
  L.push('## Patterns worth a look (observations, not proven fixes)');
  for (const o of v7.opportunities.slice(0, 12)) L.push(`- ${o.title}${o.unproven ? ` — not proven: ${o.unproven}` : ''}`);
  const asks = (v7.intents || []).filter((y) => y.flags.length && y.intent !== '(unknown)');
  if (asks.length) {
    L.push('');
    L.push('## Asks that end badly');
    for (const x of asks.slice(0, 10)) L.push(`- "${x.intent}" — ${N(x.perWeek)}/week, kept ${P(x.keptRate)}, upset ${P(x.upsetRate)} (${x.flags.join(', ')}); served by ${x.owners.map(([o, n]) => `${skillName(o)} (${N(n)})`).join(', ')}`);
  }
  const eff = v7.efficiency;
  if (eff?.days) {
    const K = (n) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`);
    L.push('');
    L.push(`## Efficiency (${eff.days} of the last 7 days measured)`);
    L.push('Where the agent spends tokens and time beyond the work itself. Model tokens are measured; tokens read from files are estimated (characters / 4). Fleet → Efficiency has the details per skill.');
    L.push('');
    L.push('| Model | Share of iterations | Tokens in / iteration | Out / iteration | Model time / iteration | Failed |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const m of eff.models.slice(0, 8)) L.push(`| ${m.model} | ${P(m.share)} | ${K(m.tokPerIter)} | ${N(m.outPerIter)} | ${S(m.thinkPerIter)} | ${P(m.failRate, 1)} |`);
    const major = eff.skills.filter((s) => s.major);
    const tpi = major.map((s) => s.tokPerIter).filter(Boolean).sort((a, b) => a - b);
    const med = tpi[Math.floor(tpi.length / 2)] || 0;
    const looks = [];
    for (const s of major) {
      if (med && s.tokPerIter > med * 1.5) looks.push([(s.tokPerIter - med) * s.iterationsPerWeek, `**${s.skill}** carries ${K(s.tokPerIter)} tokens into every iteration (median ${K(med)})${s.preloadTokens ? `; the preloaded skill alone is ${K(s.preloadTokens)} (${P(s.preloadShare)})` : ''}`]);
      for (const f of s.files.slice(0, 3)) if (f.perRead >= 8000 && f.reads >= 20) looks.push([f.tokens, `**${s.skill}** reads \`${f.file}\` at ${K(f.perRead)} tokens a read, ${N(f.reads)} times a week${f.fails >= 1 ? ` (${N(f.fails)} failed)` : ''}`]);
      if (s.repeats[0]?.n >= 30) looks.push([s.repeats[0].n * 30000, `**${s.skill}** repeats \`${s.repeats[0].method ? `${s.repeats[0].tool} · ${s.repeats[0].method}` : s.repeats[0].tool}\` with identical arguments ${N(s.repeats[0].n)} times a week, after it already succeeded`]);
      if (s.pollWaitHPerWeek >= 2) looks.push([s.pollWaitHPerWeek * 3600000 * 10, `**${s.skill}** spends ${H(s.pollWaitHPerWeek)} a week between status polls of running jobs`]);
    }
    if (looks.length) {
      L.push('');
      L.push('Worth a look (observations, not proven fixes):');
      for (const [, t] of looks.sort((a, b) => b[0] - a[0]).slice(0, 12)) L.push(`- ${t}`);
    }
    L.push('');
    L.push('| Skill | Main model | Tokens / iteration | Cached | Iterations / turn | Preloaded skill | Read / turn | Repeated calls / wk | Polling wait / wk | After a failure, most often |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const s of major.sort((a, b) => (b.tokPerIter || 0) - (a.tokPerIter || 0)).slice(0, 30)) {
      const nx = Object.entries(s.failNext || {}).sort((a, b) => b[1] - a[1])[0];
      L.push(`| ${skillName(s.skill)} | ${s.mainModel || '–'} | ${K(s.tokPerIter)} | ${P(s.cachedShare)} | ${s.iterPerTurn != null ? s.iterPerTurn.toFixed(1) : '–'} | ${s.preloadTokens ? K(s.preloadTokens) : '–'} | ${K(s.readTokensPerTurn)} | ${N(s.repeatCallsPerWeek)} | ${s.pollWaitHPerWeek > 0.01 ? H(s.pollWaitHPerWeek) : '–'} | ${nx ? `${nx[0]} (${P(nx[1] / Math.max(1, s.failuresPerWeek))})` : '–'} |`);
    }
  }
  L.push('');
  L.push('## Major skills (last 7 days)');
  L.push('| Skill | Sessions/wk | Failing calls | Time lost/wk | Frustrated | Kept | Iter./turn | Top issue |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const s of v7.skills.filter((x) => x.major).slice(0, 30)) L.push(`| ${s.skill} | ${N(s.sessionsPerWeek)} | ${P(s.failRate, 1)} | ${H(s.lostHPerWeek)} | ${P(s.frustration, 1)} | ${s.keptRate != null ? P(s.keptRate) : '–'} | ${s.iterPerTurn.toFixed(1)} | ${(s.topIssue?.label || '–').slice(0, 70).replace(/\|/g, '/')} |`);
  const decided = Object.entries(state.issues || {});
  if (decided.length) {
    L.push('');
    L.push('## Decisions');
    for (const [k, d] of decided) {
      const i = v30.issues.find((x) => x.key === k);
      L.push(`- ${d.status}${d.version ? ` in ${d.version}` : ''}: ${i ? i.sig.slice(0, 120) : k}${d.note ? ` — ${d.note}` : ''}`);
    }
  }
  L.push('');
  return L.join('\n');
}

const v7 = await fleetView({ days: 7, aud: 'real' });
const v30 = await fleetView({ days: 30, aud: 'real' });
const codex = await codexSummary();
const fixes = [];
if (withFixes) {
  for (const i of v7.issues.filter((x) => x.score > 0 && x.skillFix).slice(0, 8)) {
    for (const o of i.owners.filter((x) => x.skill !== '(none)').slice(0, 3)) {
      try {
        const f = await skillFix(i, o.skill, { period: v7.period });
        fixes.push({ issue: i.key, sig: i.sig, ...f, evidence: undefined, claude: f.claude ? { at: f.claude.at, sha: f.claude.sha, text: f.claude.text } : null });
      } catch (err) {
        fixes.push({ issue: i.key, skill: o.skill, error: String(err.message || err).slice(0, 200) });
      }
    }
  }
}
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'fleet-7d.json'), `${JSON.stringify(trim(v7), null, 1)}\n`);
await fs.writeFile(path.join(OUT, 'fleet-30d.json'), `${JSON.stringify(trim(v30), null, 1)}\n`);
await fs.writeFile(path.join(OUT, 'skill-fixes.json'), `${JSON.stringify(fixes, null, 1)}\n`);
await fs.writeFile(path.join(OUT, 'README.md'), digest(v7, v30, fixes, codex, v7.state || {}));
console.log(`knowledge/: README.md, fleet-7d.json (${v7.period.have.length} days), fleet-30d.json (${v30.period.have.length} days), skill-fixes.json (${fixes.length} skill fixes)`);
process.exit(0);
