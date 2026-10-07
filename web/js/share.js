import { h, icon, dur, fmtInt, dateTime } from './util.js';
import { state } from './state.js';
import { popover, closePopover, copyText, mailto } from './ui.js';
import { primaryOutput, typeLabel, worstMood, hasAd, failedRun } from './filters.js';
import { printReport, downloadReport, headless } from './report.js';
import { renderInsights } from './insights.js';

// Sharing. The app runs on localhost, so its own links only open for someone running Autopsy;
// every share also offers links that work for anyone: the Wixel admin page (BO access) and the
// output's own public URL (exact render / published page / image). No end-user emails are shared.

const ADMIN = 'https://wix-bo.com/wixel-agent/admin/#/sessions/';
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');

function appLink(view) {
  const link = { skill: state.skill, days: state.days, q: '', sort: state.sort, filters: {}, selected: null, open: false, tab: 'videos', ...view };
  return `${new URL('.', location.href).href}#v=${encodeURIComponent(JSON.stringify(link))}`;
}

// The output's own URL, if it has a public one.
export function publicOutputUrl(run) {
  const p = primaryOutput(run);
  if (run.renderUrl) return { url: run.renderUrl, label: 'Exact render (mp4)' };
  if (run.agentDownloadLink) return { url: `${run.agentDownloadLink}/raw`, label: 'Exact render (mp4)' };
  if (p?.publishedUrl || run.publishedUrl) return { url: p?.publishedUrl || run.publishedUrl, label: 'Published page' };
  if (p?.downloadUrl) return { url: p.downloadUrl, label: `Downloaded ${typeLabel(p.type).toLowerCase()} file` };
  if (p?.thumb && p.type !== 'video') return { url: p.thumb, label: `${typeLabel(p.type)} image` };
  return null;
}

function runSummary(run, detail) {
  const p = primaryOutput(run);
  const out = publicOutputUrl(run);
  const mood = worstMood(run);
  const lines = [
    `${p?.name || run.title || 'Wixel run'} — ${state.skill}`,
    `${dateTime(run.createdAt)} · ${run.userType === 'employee' ? 'Wix employee' : run.userType === 'wixel-team' ? 'Wixel team' : 'Real user'} · ${run.agent || ''}${run.source ? `/${run.source}` : ''}`,
    `Result: ${hasAd(run) ? `${(run.outputs || []).length || 1} output(s)${p ? ` — ${typeLabel(p.type)}` : ''}` : failedRun(run) ? 'tried, no output' : 'nothing made'}`
      + `${run.userDownloads || run.agentDownloads ? ' · downloaded' : ''}${run.publishedUrl ? ' · published' : ''}${mood ? ` · mood: ${mood}` : ''}`,
    run.errors ? `Errors: ${run.errors}${run.firstError ? ` — first: ${run.firstError.slice(0, 160)}` : ''}` : null,
    '',
    `Request: ${String(detail?.prompt || run.prompt || '').replace(/<HIDDEN>[\s\S]*/i, '').trim().slice(0, 500)}`,
    '',
    out ? `${out.label}: ${out.url}` : null,
    `Wixel admin (BO access): ${ADMIN}${run.id}`,
    `Autopsy (local app): ${appLink({ selected: run.id, open: true })}`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

export function shareRun(anchor, run, detail, { exportPdf } = {}) {
  const out = publicOutputUrl(run);
  const title = primaryOutput(run)?.name || run.title || 'Wixel run';
  const item = (ic, label, sub, fn) => h('button', { class: 'sh-row', onclick: () => { fn(); closePopover(); } }, icon(ic), h('span', {}, h('b', {}, label), h('small', {}, sub)));
  popover(anchor, h('div', { class: 'sh-pop' },
    h('div', { class: 'sh-h' }, 'Share this run'),
    item('copy', 'Copy app link', 'Opens this run in Autopsy (for people running it locally)', () => copyText(appLink({ selected: run.id, open: true, inspectTab: state.inspectTab }), 'App link')),
    item('external', 'Copy Wixel admin link', 'Anyone with back-office access', () => copyText(ADMIN + run.id, 'Admin link')),
    out ? item('film', `Copy ${out.label.toLowerCase()} link`, 'Public — opens anywhere', () => copyText(out.url, `${out.label} link`)) : null,
    item('copy', 'Copy summary', 'Text for Slack / notes', () => copyText(runSummary(run, detail), 'Summary')),
    item('external', 'Email…', 'Opens your mail app with the summary and links', () => mailto({ subject: `[Autopsy] ${state.skill}: ${title} · ${new Date(run.createdAt || Date.now()).toISOString().slice(0, 10)}`, body: runSummary(run, detail) })),
    exportPdf ? item('download', 'Export PDF report…', 'Everything about this run: request, outputs, timeline, steps, scenes, brand, assets — clickable links', exportPdf) : null,
  ), { align: 'right', width: 330 });
}

// ---------- insights ----------
export function insightsSummary(ins, label) {
  const top = (arr, n, f) => arr.slice(0, n).map(f).join('\n');
  const tools = [...ins.tools].filter((t) => t.fails).sort((a, b) => b.fails - a.fails);
  const p50 = (a) => {
    if (!a.length) return '–';
    const s = [...a].sort((x, y) => x - y);
    return dur(s[Math.floor(s.length / 2)]);
  };
  return [
    `Skill insights — ${label}`,
    `Generated ${new Date().toLocaleString()}`,
    '',
    `Runs: ${fmtInt(ins.n)} · output rate ${pct(ins.finishedOfReached.length, ins.reached.length)} · downloaded ${pct(ins.dl.length, ins.finished.length)} · published ${pct(ins.pub.length, ins.finished.length)} · frustrated ${pct(ins.moodCounts.frustrated, ins.n)}`,
    `Request → final output: ${p50(ins.toFinal)} median · first generation ${p50(ins.toFirst)} · avg generation call ${ins.genCalls ? dur(ins.genMs / ins.genCalls) : '–'}`,
    ins.profile?.length ? `Makes: ${ins.profile.slice(0, 4).map((p) => `${typeLabel(p.type)} ${Math.round(p.share * 100)}%`).join(', ')}` : null,
    '',
    'Most failing tools:',
    top(tools, 5, (t) => `  • ${t.key}: ${fmtInt(t.fails)} of ${fmtInt(t.calls)} (${pct(t.fails, t.calls)}), ${fmtInt(t.failRuns)} runs`),
    '',
    'Top errors:',
    top(ins.errs, 5, (e) => `  • ${e.runs.size} runs — ${e.step}: ${e.sig}`),
    '',
    'What users asked for:',
    top(ins.intents, 5, ([k, n]) => `  • ${k} (${n})`),
    ins.quotes.length ? '\nWhy users were unhappy:' : null,
    ins.quotes.length ? top(ins.quotes, 4, (r) => `  • “${r.sentimentDetail}”`) : null,
    '',
    `Open in Autopsy (local app): ${appLink({ tab: 'insights', filters: state.filters, q: state.q })}`,
  ].filter((l) => l !== null).join('\n');
}

export function shareInsights(anchor, ins, label, act) {
  const item = (ic, text, sub, fn) => h('button', { class: 'sh-row', onclick: () => { fn(); closePopover(); } }, icon(ic), h('span', {}, h('b', {}, text), h('small', {}, sub)));
  popover(anchor, h('div', { class: 'sh-pop' },
    h('div', { class: 'sh-h' }, 'Share these insights'),
    item('copy', 'Copy app link', 'Opens these insights with the same filters (local app)', () => copyText(appLink({ tab: 'insights', filters: state.filters, q: state.q }), 'App link')),
    item('copy', 'Copy summary', 'Key numbers, failing tools, errors, asks — text', () => copyText(insightsSummary(ins, label), 'Summary')),
    item('external', 'Email…', 'Opens your mail app with the summary', () => mailto({ subject: `[Autopsy] ${state.skill} insights · ${label.split(' · ')[1] || ''} · ${new Date().toISOString().slice(0, 10)}`, body: insightsSummary(ins, label) })),
    item('download', 'Export PDF…', 'The insights as they look here (dark, all colours), bigger type, clickable links — print dialog → “Save as PDF”', () => exportPdf(ins, label, act)),
  ), { align: 'right', width: 330 });
}

// PDF = the insights rendered into a report page (report.js): the UI's dark colours, bigger type,
// every run reference a link. The file is named after the skill, window and date.
export function exportPdf(ins, label, act) {
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
  const win = label.split(' · ')[1] || '';
  const fileName = `${state.mode === 'user' ? `${state.user?.email || 'user'} (all skills)` : state.skill} insights · ${win} · ${stamp}`;
  if (headless()) return buildInsightsPdf(ins, label, act, fileName);
  downloadReport({ kind: 'insights', fileName, inPage: () => buildInsightsPdf(ins, label, act, fileName) });
}

// Links in the PDF to the view each item opens on screen (insights.js paperHref): a search, a filter
// added to the current ones, a failing step, a finding. In the app, so only for people running Autopsy.
function paperHref(kind, a, b) {
  const filters = state.filters || {};
  const withFilter = (key, value) => appLink({ q: state.q, filters: { ...filters, [key]: [...new Set([...(filters[key] || []), value])] } });
  if (kind === 'search') return a ? appLink({ q: a, filters }) : null;
  if (kind === 'filter') return withFilter(a, b);
  if (kind === 'step') return b ? withFilter('failedStep', a) : appLink({ q: a, filters });
  if (kind === 'go') {
    if (a?.filter) return withFilter(...a.filter);
    if (a?.filterStep) return withFilter('failedStep', a.filterStep);
  }
  return null;
}

function buildInsightsPdf(ins, label, act, fileName) {
  const subject = state.mode === 'user' ? `${state.user?.email || 'user'} (all skills)` : state.skill;
  const filters = Object.entries(state.filters || {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · ');
  printReport({
    title: `${subject} — insights`,
    subtitle: `${label}${filters ? ` · filters: ${filters}` : ''}${state.q ? ` · search “${state.q}”` : ''}`,
    fileName,
    links: [{ href: appLink({ tab: 'insights', filters: state.filters, q: state.q }), label: 'Open in Autopsy (local app)' }],
    build: (body) => {
      const box = h('div', { class: 'insights rp-insights' });
      body.append(box);
      renderInsights(box, ins, { ...act, label: act.label, share: () => {}, print: true, expanded: { tools: true, models: true, all: true }, href: paperHref, scrollTo: null });
    },
  }).catch((err) => console.error(err));
}
