// Where a run's time went, from its first message to the end of its last counted turn. Every moment goes
// to one thing, the first of TIME_KINDS running then: two videos generating at once count once, and a
// video made while an image also was counts as video. A call blocks until its job is done, so its span
// runs from its start to its result. Failed calls are errors (time lost, unless something else was
// running), and so is a call that gave up with its job still running (generateMusic: 12 of 65 calls on
// 10-06/07 waited the full 15 minutes and came back IN_PROGRESS, no file). A question to the user
// (ask_user) and the gaps between turns are waiting on the user; a sub-agent's time (task) is its own
// kind; the rest is the agent itself (thinking, reading, writing).
// Shared by the day's rows (runs.js, from the steps query) and a run's detail (normalize.js).

export const TIME_KINDS = ['video', 'image', 'music', 'audio', 'text', 'subagents', 'errors', 'waiting', 'agent'];

export function spanKind(tool, method = '') {
  if (tool === 'ask_user') return 'waiting';
  if (tool === 'task') return 'subagents';
  if (['generate_image', 'edit_image', 'convert_image_format', 'sequence'].includes(tool)) return 'image';
  if (tool === 'analyze_image') return 'text';
  if (tool !== 'invoke_rpc') return null;
  const m = method || '';
  if (/Speech|Voice|Sound/i.test(m)) return 'audio';
  if (/Music/.test(m)) return 'music';
  if (/DescribeVideo|Text|Copy|Script/.test(m)) return 'text';
  if (/Image|composeImage|LogoOnBlack/.test(m)) return 'image';
  if (/^generate|^Generate|^holdStill|^transformVideo|LogoShot|Animation$|mergeVoice/.test(m)) return 'video';
  return null;
}

// `turns`: [[startMs, endMs]] of the counted turns; `calls`: [{ tool, method, failed, unfinished, start, end }] (ms;
// `unfinished`: its job was still running when the call returned).
// Returns { total, video, image, … } in seconds (kinds under 0.05 s left out), or null.
export function splitTime({ turns, calls }) {
  const spans = turns.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  if (!spans.length) return null;
  const ivs = [];
  for (const c of calls) {
    const k = c.failed || (c.unfinished && c.end - c.start >= 60000) ? 'errors' : spanKind(c.tool, c.method);
    if (k && c.end > c.start) ivs.push([c.start, c.end, k]);
  }
  const start = spans[0][0];
  const end = Math.max(...spans.map((t) => t[1]), ...ivs.map((i) => i[1]));
  // Between one counted turn's end and the next one's start, the user hadn't answered yet.
  for (let i = 0; i + 1 < spans.length; i++) if (spans[i + 1][0] > spans[i][1]) ivs.push([spans[i][1], spans[i + 1][0], 'waiting']);
  const cuts = [...new Set([start, end, ...ivs.flatMap(([a, b]) => [a, b])])].filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  const rank = Object.fromEntries(TIME_KINDS.map((k, i) => [k, i]));
  const ms = {};
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    let best = 'agent';
    for (const [s, e, k] of ivs) if (s < b && e > a && rank[k] < rank[best]) best = k;
    ms[best] = (ms[best] || 0) + (b - a);
  }
  const out = { total: Math.round((end - start) / 100) / 10 };
  for (const k of TIME_KINDS) if (ms[k] >= 50) out[k] = Math.round(ms[k] / 100) / 10;
  return out;
}
