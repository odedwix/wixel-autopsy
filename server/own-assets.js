// Which project assets a session made, read from the session's own write log, never from what
// else appeared in the project. Projects are shared: a campaign's sub-agents make a post, a story
// and a video side by side in one project, and an edit session works on assets made long before.
//
//   writes     WRITE_METERING, every asset write: path 'project/assets/<name>--<id8>.json' (the id's
//              first 8 hex once the asset exists; a first create may carry the name only)
//   reported   TURN_UPDATED_ASSETS, the editor's per-turn report: [{ id, name, type, children }]
//   mentioned  AGENT_MENTIONED_ASSETS, assets handed to the user: { id: { name, type } }. The agent
//              also mentions existing assets it only referred to, so a mention counts only when the
//              asset was created or changed while the counted turns ran.

const WRITE_PATH = /^project\/assets\/(.*?)(?:--([0-9a-f]{8}))?\.json$/i;
export function writePath(path) {
  const m = WRITE_PATH.exec(String(path || ''));
  return m ? { name: m[1], id8: m[2]?.toLowerCase() || null } : null;
}

// Some assets are built server-side by a job, with no write and no id in the job's result: a deck by
// BuildPresentation / DeckFinish, an icon set by CreateIconsAsset / GenerateIconsAsset. An asset of
// that type created while the counted turns ran, in a run that called the job, is the job's.
const JOB_MAKES = [[/^(BuildPresentation|DeckFinish)$/, 'slide'], [/^(CreateIconsAsset|GenerateIconsAsset)$/, 'icons']];
export function jobTypes(methods) {
  const out = new Set();
  for (const m of methods || []) for (const [re, t] of JOB_MAKES) if (re.test(m)) out.add(t);
  return out;
}
const baseType = (t) => String(t || '').toLowerCase().replace(/^wixel-asset\//, '').replace(/^slides$/, 'slide');

// `assets`: the project's assets as { id, parentId, name, type, created, updated } (ms). Returns the
// ids of the top-level assets the evidence points at. A write to a page or scene credits its top-level
// asset. `inWindow(t)` says whether a time falls inside the counted turns.
export function ownedAssetIds({ writes = [], reported = [], mentioned = [], jobs = new Set() }, assets, inWindow) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const topOf = (a) => {
    for (let i = 0; a?.parentId && i < 4; i++) a = byId.get(a.parentId) || null;
    return a;
  };
  const out = new Set();
  const add = (a) => {
    const top = topOf(a);
    if (top) out.add(top.id);
  };
  const id8s = new Set(writes.map((w) => w.id8).filter(Boolean));
  const names = new Set(writes.filter((w) => !w.id8 && w.name).map((w) => w.name));
  for (const a of assets) {
    if (id8s.has(a.id.slice(0, 8).toLowerCase())) add(a);
    // A first create logged by name only: the asset of that name created in the window.
    else if (!a.parentId && names.has(a.name) && inWindow(a.created)) add(a);
  }
  if (jobs.size) for (const a of assets) if (!a.parentId && jobs.has(baseType(a.type)) && inWindow(a.created)) add(a);
  for (const id of reported) add(byId.get(id));
  for (const id of mentioned) {
    const a = byId.get(id);
    if (a && (inWindow(a.created) || inWindow(a.updated))) add(a);
  }
  return out;
}
