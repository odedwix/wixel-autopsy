// Facets: OR within a facet, AND across facets. Counts are "what you'd get if you added this
// option" (every other active facet applied), so they never lie about the result.

// A run "has output" when it wrote at least one top-level asset of a type the skill makes (see
// expectedTypes: a wixel-ads run that only made an image hasn't made its video).
export const hasAd = (r) => (Array.isArray(r.outputs) ? r.outputs.length > 0 : Boolean(r.adAssetId || r.thumbnail));
export const hasOutput = hasAd;
// A paid Wixel plan right now (server/runs.js planOf): anything but free, former or unknown.
export const paying = (r) => Boolean(r.plan) && !['free', 'former'].includes(r.plan);
export const PLAN_LABEL = { basic: 'Basic', pro: 'Pro', max: 'Max', 'top-up': 'Top-Up', paying: 'Paying' };
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
    const types = new Set((r.allOutputs || r.outputs || []).map((o) => o.type));
    if (types.size) withOut++;
    for (const t of types) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].map(([type, n]) => ({ type, runs: n, share: withOut ? n / withOut : 0 })).sort((a, b) => b.runs - a.runs);
}

// The current skill's profile, shared by the grid, the details panel and insights.
let currentProfile = [];
export const setProfile = (p) => (currentProfile = p || []);
export const getProfile = () => currentProfile;

// What the skill is supposed to make, learned from its runs: its main output type, plus any other
// type at least a quarter of its producing runs make (brand-kit: image, logo, icons). Runs are shown
// and judged by these only; other types they wrote are kept aside as `otherOutputs`.
export function expectedTypes(profile) {
  if (!profile?.length) return null;
  return profile.filter((p, i) => i === 0 || (p.share >= 0.25 && p.runs >= 3)).map((p) => p.type);
}

// Splits each run's outputs by the expected types (null = keep everything, e.g. user mode).
// Idempotent: the originals stay in `allOutputs`.
export function applyExpected(runs, types) {
  const keep = types ? new Set(types) : null;
  for (const r of runs) {
    r.allOutputs ??= r.outputs || [];
    r.outputs = keep ? r.allOutputs.filter((o) => keep.has(o.type)) : r.allOutputs;
    r.otherOutputs = keep ? r.allOutputs.filter((o) => !keep.has(o.type)) : [];
  }
}

// The expected output in words, for labels: "a video", "videos", "an image or a logo".
let expected = null;
export const setExpected = (t) => (expected = t);
export const getExpected = () => expected;
export function madeLabel(plural = false) {
  const t = expected?.length ? expected : null;
  if (!t) return plural ? 'outputs' : 'output';
  const words = t.slice(0, 2).map((x) => typeLabel(x).toLowerCase());
  return plural ? words.map(pluralOf).join(' / ') : words.join(' or ');
}
export const pluralOf = (w) => (/s$/i.test(w) ? w : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);

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
const GEN_METHOD = /^generate|^holdStill|^transformVideo|LogoShot|Animation$|^StartAnimation/;

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

// The outcome is one switch above the grid (All / Made it / Tried, no output / Never tried), not a
// facet; the facets below are the few that answer real questions, each option with its count.
export const OUTCOMES = [
  { value: 'video', label: () => `Made ${/^[aeiou]/.test(madeLabel()) ? 'an' : 'a'} ${madeLabel()}`, dot: 'var(--ok)', test: hasAd },
  { value: 'failed', label: () => `Tried, no ${madeLabel()}`, dot: 'var(--err)', test: failedRun },
  { value: 'none', label: () => 'Never tried', dot: 'var(--text-3)', test: (r) => !hasAd(r) && !attempted(r) },
];

// Why a run made nothing (server/runs.js stopReason): the card's headline and the filter's option.
export const STOPS = {
  credits: { label: 'Not enough credits', icon: 'coins', tone: 'warn' },
  waiting: { label: 'Waiting for the user', icon: 'chat' },
  running: { label: 'Still working', icon: 'clock' },
  cancelled: { label: 'Stopped by the user', icon: 'stop' },
  failed: { label: 'Failed', icon: 'alert', tone: 'err' },
  cutoff: { label: 'Never finished', icon: 'clock' },
  continued: { label: 'Continued in another skill', icon: 'forward', title: (s) => `Continued in ${s.skill}` },
  handoff: { label: 'Handed back to the main chat', icon: 'back' },
  ended: { label: 'Ended without making anything', icon: 'dash' },
  never: { label: 'Never tried to make anything', icon: 'dash' },
};
// The one fact that says most: what it needed against what it had, what it was waiting on.
export function stopFact(s) {
  if (s.kind === 'credits') {
    const parts = [];
    if (s.needed && s.available != null) parts.push(`Needs ${s.needed} · has ${s.available}`);
    else if (s.available != null) parts.push(`${s.available} credit${s.available === 1 ? '' : 's'} left`);
    else if (s.needed) parts.push(`Needs ${s.needed} credits`);
    if (s.dayCap) parts.push(`over the ${s.dayCap}/day plan limit`);
    return parts.join(' · ') || null;
  }
  if (s.kind === 'waiting') {
    const asked = s.widget ? `${s.widget[0].toUpperCase()}${s.widget.slice(1)} shown, no answer` : 'Asked, no answer';
    return s.available != null ? `${asked} · ${s.available} credit${s.available === 1 ? '' : 's'} left` : asked;
  }
  return null;
}

export const FACETS = [
  { key: 'outcome', label: 'Result', hidden: true, options: OUTCOMES.map((o) => ({ value: o.value, dot: o.dot, test: o.test, get label() { return o.label(); } })) },
  {
    key: 'delivery',
    label: 'What the user did',
    options: [
      { value: 'downloaded', label: 'Downloaded', test: downloaded },
      { value: 'published', label: 'Published', test: (r) => Boolean(r.publishedUrl) },
      { value: 'neither', label: 'Neither', test: (r) => hasAd(r) && !downloaded(r) && !r.publishedUrl },
    ],
  },
  {
    key: 'user',
    label: 'User',
    options: [
      { value: 'real', label: 'Real users', test: (r) => r.userType === 'real' },
      { value: 'employee', label: 'Wix employees', test: (r) => r.userType === 'employee' },
      { value: 'wixel-team', label: 'Wixel team', test: (r) => r.userType === 'wixel-team' },
    ],
  },
  // Wixel's paid plans per account (today's plan, not the one at the time of the run).
  {
    key: 'plan',
    label: 'Plan',
    options: [
      { value: 'paying', label: 'Paying (any plan)', test: paying },
      { value: 'basic', label: 'Basic', test: (r) => r.plan === 'basic' },
      { value: 'pro', label: 'Pro', test: (r) => r.plan === 'pro' },
      { value: 'max', label: 'Max', test: (r) => r.plan === 'max' },
      { value: 'top-up', label: 'Top-Up', test: (r) => r.plan === 'top-up' },
      { value: 'former', label: 'Used to pay', test: (r) => r.plan === 'former' },
      { value: 'free', label: 'Free', test: (r) => r.plan === 'free' },
    ],
  },
  {
    key: 'mood',
    label: 'How it went for the user',
    options: [
      { value: 'frustrated', label: 'Frustrated', dot: 'var(--err)', test: (r) => r.sentiments?.includes('frustrated') },
      { value: 'confused', label: 'Confused', dot: 'var(--warn)', test: (r) => r.sentiments?.includes('confused') },
      { value: 'up', label: 'Thumbs up', dot: 'var(--ok)', test: (r) => r.thumbsUp > 0 },
      { value: 'down', label: 'Thumbs down', dot: 'var(--err)', test: (r) => r.thumbsDown > 0 },
    ],
  },
  {
    key: 'issues',
    label: 'Problems',
    options: [
      { value: 'errors', label: 'Tool errors', dot: 'var(--err)', test: (r) => r.errors > 0 },
      { value: 'failed-turn', label: 'Failed turn', dot: 'var(--err)', test: (r) => r.failedTurns > 0 },
      // The agent usually checks the price and stops without an OUT_OF_FUNDS event (see STOPS).
      { value: 'credits', label: 'Not enough credits', dot: 'var(--warn)', test: (r) => r.outOfFunds > 0 || r.stop?.kind === 'credits' },
      { value: 'clean', label: 'No problems', dot: 'var(--ok)', test: (r) => !r.errors && !r.failedTurns && !r.outOfFunds && !r.streamErrors },
    ],
  },
  { key: 'stop', label: 'Why it made nothing', options: Object.entries(STOPS).map(([value, d]) => ({ value, label: d.label, test: (r) => !hasAd(r) && r.stop?.kind === value })) },
  { key: 'failedStep', label: 'Failed step', dynamic: (r) => [...new Set((r.steps || []).filter((x) => x[4] > 0).map((x) => stepKey(x[0], x[1])))], limit: 5 },
  { key: 'model', label: 'Model', dynamic: (r) => modelsOfRun(r), limit: 6 },
  { key: 'source', label: 'Started from', dynamic: (r) => (r.source ? [r.source] : []), labelOf: (v) => SOURCE_LABEL[v] || v },
  // Every skill the session loaded (in skill mode: which skills people combine with this one).
  { key: 'skillsUsed', label: 'Skills in the session', dynamic: (r) => r.allSkills || r.skills || [], limit: 5 },
];
const SOURCE_LABEL = { 'wixel-chat-ui': 'Chat', 'sub-agent': 'Sub-agent (campaigns, parallel work)', 'api': 'API' };

// The generation models a run used (media job graphs by their price-list name, image models).
let modelNamer = (tool, method, model) => model || (tool === 'invoke_rpc' ? method : tool);
export const setModelNamer = (fn) => (modelNamer = fn);
const GEN_STEP = (tool, method) => tool === 'generate_image' || tool === 'edit_image' || (tool === 'invoke_rpc' && GEN_METHOD.test(method || ''));
function modelsOfRun(r) {
  return [...new Set((r.steps || []).filter((x) => GEN_STEP(x[0], x[1]) && x[3] - x[4] > 0).map((x) => modelNamer(x[0], x[1], x[2], x[8])).filter(Boolean))];
}

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
  // A pick of runs from an insight ("these 9 stalled runs"), not a facet.
  if (filters.ids?.length) {
    const ids = new Set(filters.ids);
    active.push({ key: 'ids', test: (r) => ids.has(r.id) });
  }
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
