// Write what Fleet knows into the repo as a readable snapshot: knowledge/README.md (the findings,
// in plain words) plus trimmed JSON of the last 7 and 30 days and the fix per skill for the top
// issues. Built from the day files in FLEET_DIR (no Trino); fixes per skill read a few example
// sessions (admin API, cached) and the codex checkout (git, read-only).
//
//   npm run fleet:snapshot                # 7 and 30 days ending yesterday, real users
//   npm run fleet:snapshot -- --no-fixes  # skip the per-skill fixes (no admin API calls)

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { fleetView } from '../server/fleet.js';
import { skillFix } from '../server/fleet-skillfix.js';
import { codexSummary } from '../server/codex.js';

process.env.FLEET_READONLY = '1'; // a snapshot never queries Trino
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
  L.push('- **Skills are preloaded since 2026-09-30.** The platform puts skills into the session\'s first message (`metadata.preloadedSkillBodies`) instead of the agent calling the `skill` tool: sessions with a skill-tool call fell from ~85% to ~40% overnight, across every agent. Fleet counts both; Autopsy\'s per-skill views only counted tool calls (being fixed separately).');
  L.push('- **`TURN_UPDATED_ASSETS` was only logged 2026-09-16 → 09-28.** Asset writes are in `WRITE_METERING` (path, asset type, outcome) and handed-over assets in `AGENT_MENTIONED_ASSETS`.');
  L.push('- **Hidden timeouts:** several tools (`generateMusic`, `poll_process_job`, `Generate*Async`, `BuildPresentation`) report success after ~15 minutes while the job is still `IN_PROGRESS`.');
  L.push('- **`ask_user` "User cancelled the question"** is how questions normally resolve — not a failure.');
  L.push('- **The admin SQL endpoint** re-runs a query for every 500-row page and can repeat rows across pages: every Fleet query stays under 500 rows.');
  if (v30.shifts?.length) {
    L.push('');
    L.push('## What changed (last 30 days)');
    for (const x of v30.shifts.slice(0, 15)) {
      const fmt = (y) => (x.fmt === 'pct' ? P(y, 1) : x.fmt === 'k' ? `${Math.round(y / 1000)}k` : x.fmt === 'n' ? N(y) : y?.toFixed(1));
      L.push(`- ${x.day}: **${x.metric}**${x.from != null ? ` ${fmt(x.from)} → ${fmt(x.to)}` : ''}${x.newVersions?.length ? ` · new codex version ${x.newVersions.map((n) => `${n.ver.slice(0, 10)} (${P(n.share)} of turns)`).join(', ')}` : ''}`);
    }
  }
  L.push('');
  L.push('## Do these first (hours a week given back)');
  v7.actions.forEach((a, k) => L.push(`${k + 1}. ${a.title.slice(0, 160)} — **${H(a.hPerWeek)}/week** · ${a.owner}${a.kind === 'opportunity' ? ' (estimate)' : ''}`));
  L.push('');
  L.push('## Top issues and how to fix them in the skills');
  for (const i of v7.issues.filter((x) => x.score > 0).slice(0, 15)) {
    const st = state.issues?.[i.key];
    L.push('');
    L.push(`### ${i.sig.slice(0, 150)}`);
    L.push(`\`${op(i)}\` · ${i.cls.label} · ${i.cls.fix} fix · owner: ${i.cls.owner} · ${N(i.perWeek)}/week in ${N(i.sessions)} sessions · ${H(i.lostHPerWeek)}/week lost · ${i.pattern.label}${i.trend.dir !== 'flat' ? ` · ${i.trend.dir}` : ''}${st?.status ? ` · **${st.status}${st.version ? ` in ${st.version}` : ''}**${st.note ? ` (${st.note})` : ''}` : ''}`);
    L.push(`Skills: ${i.owners.slice(0, 6).map((o) => `${skillName(o.skill)} (${N(o.n)})`).join(', ')}`);
    const fx = fixes.filter((f) => f.issue === i.key);
    if (!i.skillFix) L.push(`- Not a skill fix (${i.cls.owner}) — parked. ${i.cls.hint}`);
    for (const f of fx) {
      if (f.parked || f.error) continue;
      L.push(`- **${f.skill}** (${N(f.n)}, ${P(f.share)}) — ${f.skillPath ? `\`${f.skillPath}\`` : 'skill file not found'}${f.files.filter((x) => x.line).length ? ` lines ${f.files.filter((x) => x.line).map((x) => x.line).join(', ')}` : ''}`);
      for (const n of f.notes) L.push(`  - Seen: ${n}`);
      for (const c of f.fix) L.push(`  - Change: ${c}`);
    }
    if (i.skillFix && !fx.length) L.push(`- ${i.cls.hint}`);
  }
  L.push('');
  L.push('## Wait times');
  for (const w of v7.waits.filter((x) => x.recommend || x.hidden).slice(0, 12)) {
    L.push(`- \`${op(w)}\`${w.size ? ` (${w.size})` : ''}: p50 ${S(w.p50)}, p99 ${S(w.p99)}${w.hidden ? `, ${w.hidden} hidden timeouts${w.cap ? ` at ${S(w.cap)}` : ''}` : ''}${w.recommend ? ` → wait at most **${S(w.recommend.tau)}** (~${H(w.recommend.savedHPerWeek)}/week)` : ''}${w.hidden ? '; re-attach to the job instead of restarting' : ''}`);
  }
  L.push('');
  L.push('## Where the agent works harder than it needs to (estimates)');
  for (const o of v7.opportunities.slice(0, 12)) L.push(`- ${o.title}${o.savings.hPerWeek ? ` — ~${H(o.savings.hPerWeek)}/week` : ''}${o.savings.tokensPerWeek ? `, ~${N(o.savings.tokensPerWeek / 1e6)}M input tokens/week` : ''}${o.guard ? ` (caution: ${o.guard})` : ''}`);
  if (v7.intents?.some((x) => x.flags.length)) {
    L.push('');
    L.push('## Asks that end badly');
    for (const x of v7.intents.filter((y) => y.flags.length).slice(0, 10)) L.push(`- "${x.intent}" — ${N(x.perWeek)}/week, kept ${P(x.keptRate)}, upset ${P(x.upsetRate)} (${x.flags.join(', ')}); served by ${x.owners.map(([o, n]) => `${skillName(o)} (${N(n)})`).join(', ')}`);
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
