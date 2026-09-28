// Facets: OR within a facet, AND across facets. Counts are "what you'd get if you added this
// option" (every other active facet applied), so they never lie about the result.

// A run "has output" when it wrote at least one top-level asset (any type the skill makes).
export const hasAd = (r) => Boolean(r.outputs?.length || r.adAssetId || r.thumbnail);
export const hasOutput = hasAd;
// It "tried" when it called something that makes an asset: a media job, an image tool, or a write.
const MAKERS = new Set(['generate_image', 'edit_image', 'convert_image_format', 'write']);
export const attempted = (r) => r.generations > 0 || Boolean(r.steps?.some((x) => MAKERS.has(x[0]) && x[3] > 0));

export const TYPE_LABEL = { video: 'Video', image: 'Image', logo: 'Logo', doc: 'Doc', slides: 'Slides', icons: 'Icons', story: 'Story', pdf: 'PDF', form: 'Form', event: 'Event', widget: 'Widget', site: 'Site', asset: 'Asset' };
export const typeLabel = (t) => TYPE_LABEL[t] || (t ? t[0].toUpperCase() + t.slice(1) : 'Asset');

// What a skill makes, learned from its runs: share of runs producing each output type.
export function outputProfile(runs) {
  const counts = new Map();
  let withOut = 0;
  for (const r of runs) {
    const types = new Set((r.outputs || []).map((o) => o.type));
    if (types.size) withOut++;
    for (const t of types) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].map(([type, n]) => ({ type, runs: n, share: withOut ? n / withOut : 0 })).sort((a, b) => b.runs - a.runs);
}

// The current skill's profile, shared by the grid, the details panel and insights.
let currentProfile = [];
export const setProfile = (p) => (currentProfile = p || []);
export const getProfile = () => currentProfile;

// The output to show for a run: the skill's main type first, then whatever it wrote last.
export function primaryOutput(r, profile = currentProfile) {
  const outs = r.outputs || [];
  for (const p of profile || []) {
    const o = outs.find((x) => x.type === p.type);
    if (o) return o;
  }
  return outs[0] || (r.thumbnail ? { id: r.adAssetId, type: r.outputType || 'video', name: r.adName, thumb: r.thumbnail } : null);
}
// A step's identity: the RPC method for invoke_rpc, otherwise the tool name.
export const stepKey = (tool, method) => (tool === 'invoke_rpc' && method ? method : tool);
export const downloaded = (r) => r.userDownloads > 0 || r.agentDownloads > 0;
export const failedRun = (r) => attempted(r) && !hasAd(r);
const GEN_METHOD = /^generate|^holdStill|^transformVideo|LogoShot|^mergeVoice/;

export const MOOD = {
  frustrated: { label: 'Frustrated', icon: 'frustrated', color: 'var(--err)' },
  confused: { label: 'Confused', icon: 'confused', color: 'var(--warn)' },
  positive: { label: 'Positive', icon: 'happy', color: 'var(--ok)' },
  neutral: { label: 'Neutral', icon: 'neutral', color: 'var(--neutral)' },
};

// The mood that matters most for a run: any frustration beats confusion beats the rest.
export function worstMood(r) {
  for (const m of ['frustrated', 'confused', 'positive', 'neutral']) if (r.sentiments?.includes(m)) return m;
  return null;
}

export const FACETS = [
  {
    key: 'outcome',
    label: 'Result',
    options: [
      { value: 'video', label: 'Produced output', dot: 'var(--ok)', test: hasAd },
      { value: 'failed', label: 'Tried, no output', dot: 'var(--err)', test: failedRun },
      { value: 'none', label: 'Never tried', dot: 'var(--text-3)', test: (r) => !hasAd(r) && !attempted(r) },
    ],
  },
  { key: 'outputType', label: 'Output type', dynamic: (r) => [...new Set((r.outputs || []).map((o) => o.type))], labelOf: (v) => typeLabel(v) },
  {
    key: 'delivery',
    label: 'What the user did',
    options: [
      { value: 'downloaded', label: 'Downloaded', test: downloaded },
      { value: 'user-dl', label: '· from the editor', test: (r) => r.userDownloads > 0 },
      { value: 'agent-dl', label: '· asked the agent', test: (r) => r.agentDownloads > 0 },
      { value: 'published', label: 'Published', test: (r) => Boolean(r.publishedUrl) },
      { value: 'neither', label: 'Neither', test: (r) => hasAd(r) && !downloaded(r) && !r.publishedUrl },
    ],
  },
  {
    key: 'mood',
    label: 'User mood (any turn)',
    options: Object.entries(MOOD).map(([value, m]) => ({ value, label: m.label, dot: m.color, test: (r) => r.sentiments?.includes(value) })),
  },
  {
    key: 'feedback',
    label: 'Feedback',
    options: [
      { value: 'up', label: 'Thumbs up', test: (r) => r.thumbsUp > 0 },
      { value: 'down', label: 'Thumbs down', test: (r) => r.thumbsDown > 0 },
      { value: 'tagged', label: 'Left a reason', test: (r) => r.feedbackTags?.length > 0 },
    ],
  },
  {
    key: 'user',
    label: 'User',
    options: [
      { value: 'real', label: 'Real users', test: (r) => r.userType === 'real' },
      { value: 'employee', label: 'Wix employees', test: (r) => r.userType === 'employee' },
      { value: 'wixel-team', label: 'Wixel team', test: (r) => r.userType === 'wixel-team' },
      { value: 'unknown', label: 'Unknown', test: (r) => !r.userType || r.userType === 'unknown' },
    ],
  },
  {
    key: 'issues',
    label: 'Issues',
    options: [
      { value: 'errors', label: 'Tool errors', dot: 'var(--err)', test: (r) => r.errors > 0 },
      { value: 'failed-turn', label: 'Failed turn', dot: 'var(--err)', test: (r) => r.failedTurns > 0 },
      { value: 'credits', label: 'Out of credits', dot: 'var(--warn)', test: (r) => r.outOfFunds > 0 },
      { value: 'stream', label: 'Model stream error', dot: 'var(--warn)', test: (r) => r.streamErrors > 0 },
      { value: 'clean', label: 'No issues', dot: 'var(--ok)', test: (r) => !r.errors && !r.failedTurns && !r.outOfFunds && !r.streamErrors },
    ],
  },
  {
    key: 'render',
    label: 'Video render',
    options: [
      { value: 'exact', label: 'Exact render exists', test: (r) => Boolean(r.renderUrl || r.agentDownloadLink) },
      { value: 'assembled', label: 'Assembled only', test: (r) => Boolean(r.videoAssetId) && !r.renderUrl && !r.agentDownloadLink },
    ],
  },
  { key: 'failedStep', label: 'Failed step', dynamic: (r) => [...new Set((r.steps || []).filter((x) => x[4] > 0).map((x) => stepKey(x[0], x[1])))], limit: 6 },
  { key: 'agent', label: 'Agent', dynamic: (r) => (r.agent ? [r.agent] : []) },
  { key: 'source', label: 'Source', dynamic: (r) => (r.source ? [r.source] : []) },
  { key: 'model', label: 'Generation methods', dynamic: (r) => (r.methods || []).filter((m) => GEN_METHOD.test(m)), limit: 8 },
];

// Dynamic facets get their options from the data.
export function facetOptions(facet, runs) {
  if (!facet.dynamic) return facet.options;
  const counts = new Map();
  for (const r of runs) for (const v of facet.dynamic(r)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => ({ value, label: facet.labelOf ? facet.labelOf(value) : value, test: (r) => facet.dynamic(r).includes(value) }));
}

// ---- search ----
const haystacks = new WeakMap();
function hay(r) {
  let s = haystacks.get(r);
  if (!s) {
    s = [r.title, r.adName, r.prompt, r.id, r.projectId, r.msid, r.userId, r.accountId, r.adAssetId, r.firstError, r.sentimentDetail, ...(r.methods || []), ...(r.feedbackTags || [])]
      .filter(Boolean).join('\n').toLowerCase();
    haystacks.set(r, s);
  }
  return s;
}
export function matchesQuery(r, q) {
  if (!q) return true;
  const h = hay(r);
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => h.includes(t));
}

// ---- apply ----
export function compile(filters, runs) {
  const active = [];
  for (const f of FACETS) {
    const vals = filters[f.key];
    if (!vals?.length) continue;
    const opts = facetOptions(f, runs).filter((o) => vals.includes(o.value));
    // A saved value that no longer exists in this data must not silently empty the view.
    if (opts.length) active.push({ key: f.key, test: (r) => opts.some((o) => o.test(r)) });
  }
  return active;
}

export function applyFilters(runs, filters, q) {
  const active = compile(filters, runs);
  return runs.filter((r) => matchesQuery(r, q) && active.every((a) => a.test(r)));
}

export function facetCounts(runs, filters, q) {
  const active = compile(filters, runs);
  const base = runs.filter((r) => matchesQuery(r, q));
  const out = {};
  for (const f of FACETS) {
    const others = active.filter((a) => a.key !== f.key);
    const pool = base.filter((r) => others.every((a) => a.test(r)));
    out[f.key] = facetOptions(f, runs).map((o) => ({ ...o, count: pool.reduce((n, r) => n + (o.test(r) ? 1 : 0), 0) }));
    out[f.key].pool = pool.length;
  }
  return out;
}

export const SORTS = {
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  errors: (a, b) => (b.errors + b.failedTurns + b.outOfFunds) - (a.errors + a.failedTurns + a.outOfFunds) || b.createdAt - a.createdAt,
  longest: (a, b) => (b.wallMs || 0) - (a.wallMs || 0),
  generations: (a, b) => (b.generations || 0) - (a.generations || 0),
  cost: (a, b) => (b.costUsd || 0) - (a.costUsd || 0),
};

// Headline numbers; each one is also a one-click filter.
export const STATS = [
  { key: 'all', label: 'Runs', filter: null },
  { key: 'video', label: 'Produced output', dot: 'var(--ok)', filter: ['outcome', 'video'], test: hasAd },
  { key: 'failed', label: 'Tried, no output', dot: 'var(--err)', filter: ['outcome', 'failed'], test: failedRun },
  { key: 'downloaded', label: 'Downloaded', dot: 'var(--info)', filter: ['delivery', 'downloaded'], test: downloaded },
  { key: 'published', label: 'Published', dot: 'var(--accent)', filter: ['delivery', 'published'], test: (r) => Boolean(r.publishedUrl) },
  { key: 'frustrated', label: 'Frustrated', dot: 'var(--err)', filter: ['mood', 'frustrated'], test: (r) => r.sentiments?.includes('frustrated') },
  { key: 'down', label: 'Thumbs down', dot: 'var(--warn)', filter: ['feedback', 'down'], test: (r) => r.thumbsDown > 0 },
  { key: 'employee', label: 'Employees', dot: 'var(--info)', filter: ['user', 'employee'], test: (r) => r.userType === 'employee' },
];
