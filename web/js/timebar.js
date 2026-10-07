import { h, dur } from './util.js';

// Where a run's time went (server/time-split.js): one coloured bar of the run from its first message to
// its end, each part its share of that, every moment counted once (two videos generating at once are one
// stretch of video time), then the parts listed with their share and time.
export const TIME_PARTS = {
  video: { label: 'Video', tip: 'Video generation: clips, avatar takes, logo shots, animations' },
  image: { label: 'Image', tip: 'Image generation and edits' },
  music: { label: 'Music', tip: 'Music generation' },
  audio: { label: 'Voice & sound', tip: 'Speech and voice-over generation' },
  text: { label: 'Text & vision', tip: 'Image analysis and video description' },
  subagents: { label: 'Sub-agents', tip: 'Waiting on the sub-agents it started (what they did is in their own runs)' },
  errors: { label: 'Errors', tip: 'Calls that failed, or gave up with their job still running (music still in progress after 15 minutes, a sub-agent that timed out), while nothing else ran' },
  waiting: { label: 'Waiting on the user', tip: 'A question to the user (a plan to approve, a choice) until it was answered, and the time between turns' },
  agent: { label: 'Agent', tip: 'The agent itself: thinking, reading, writing, quick lookups' },
};
const ORDER = Object.keys(TIME_PARTS);
const pct = (x) => (x > 0 && x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`);

// `shares`: { kind: 0–1 }; `secs`: { kind: seconds } to show next to each share (optional).
export function timeBar(shares, { secs = null, note = null } = {}) {
  const parts = ORDER.filter((k) => shares[k] > 0).map((k) => ({ k, share: shares[k], sec: secs?.[k] ?? null }));
  if (!parts.length) return null;
  const tip = (p) => `${TIME_PARTS[p.k].label}: ${pct(p.share)}${p.sec != null ? ` · ${dur(p.sec * 1000)}` : ''}\n${TIME_PARTS[p.k].tip}`;
  return h('div', { class: 'timebar' },
    h('div', { class: 'tbar', role: 'img', 'aria-label': parts.map((p) => `${TIME_PARTS[p.k].label} ${pct(p.share)}`).join(', ') },
      parts.map((p) => h('i', { class: `tk-${p.k}`, style: { flexGrow: String(p.share) }, title: tip(p) }, p.share >= 0.07 ? pct(p.share) : ''))),
    h('div', { class: 'tlegend' }, [...parts].sort((a, b) => b.share - a.share).map((p) => h('span', { title: TIME_PARTS[p.k].tip },
      h('i', { class: `tk-${p.k}` }), TIME_PARTS[p.k].label, h('b', {}, pct(p.share)), p.sec != null ? h('small', {}, dur(p.sec * 1000)) : null))),
    note ? h('p', { class: 'desc tnote' }, note) : null);
}

// One run: its own seconds per part, as shares of its total.
export function runTimeBar(t, opts) {
  if (!t?.total) return null;
  return timeBar(Object.fromEntries(ORDER.map((k) => [k, (t[k] || 0) / t.total])), { secs: t, ...opts });
}

// Many runs: each run's shares averaged (every run counts the same, however long), and the median run's length.
export function averageTime(runs) {
  const ts = runs.map((r) => r.time).filter((t) => t?.total > 0);
  if (!ts.length) return null;
  const shares = Object.fromEntries(ORDER.map((k) => [k, ts.reduce((a, t) => a + (t[k] || 0) / t.total, 0) / ts.length]));
  const totals = ts.map((t) => t.total).sort((a, b) => a - b);
  return { shares, n: ts.length, medianSec: totals[Math.floor(totals.length / 2)] };
}
