import { caps } from './caps.js';
// View state: persisted to localStorage (restored on reload) and mirrored into the URL hash
// (so any view is a shareable link). The hash wins when both are present.

// Storage key kept from the tool's first name so saved views survive the rename to Autopsy.
const KEY = 'skill-runs:v1';

const defaults = {
  skill: 'wixel-ads',
  days: 7,
  q: '',
  sort: 'newest',
  filters: { outcome: ['video'] },
  aspect: 'auto',
  size: 200,
  sound: true,
  theme: 'dark',
  filtersOpen: true,
  selected: null,
  open: false,
  tab: 'videos',
  inspectTab: 'overview',
  inspectWide: false,
  // 'skill': one skill's runs; 'user': every session one user ran, any skill.
  mode: 'skill',
  user: null, // { id, email }
  recentUsers: [],
  // Per skill: which helpers count with it (a list), 'all' for whole sessions; absent = computed.
  families: {},
  // Run view: also show turns that belong to other skills.
  showOther: false,
  // Text size: the whole UI scaled (CSS zoom), 0.9–1.6.
  textScale: 1,
};

// Links carry a user as its id only (no email in URLs) and a skill's helper choice as `fam`.
function fromHash() {
  if (!location.hash.startsWith('#v=')) return null;
  try {
    const { uid, fam, ...v } = JSON.parse(decodeURIComponent(location.hash.slice(3)));
    if (v.mode === 'user' && uid) v.user = { id: uid, email: fromStorage()?.user?.id === uid ? fromStorage().user.email : null };
    if (fam !== undefined && v.skill) v.families = { ...(fromStorage()?.families || {}), [v.skill]: fam };
    return v;
  } catch {
    return null;
  }
}

function fromStorage() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export const state = { ...defaults, ...fromStorage(), ...fromHash() };
// One-time: card shape now defaults to "auto" (from the skill's outputs); older saved states had 9:16.
if (!state.shapeAuto) Object.assign(state, { aspect: 'auto', shapeAuto: true });

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);

let saveTimer;
export function set(patch, { silent = false } = {}) {
  Object.assign(state, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 150);
  if (!silent) for (const fn of listeners) fn(patch);
}

function save() {
  const { skill, days, q, sort, filters, aspect, size, sound, theme, filtersOpen, selected, open, tab, inspectTab, inspectWide, shapeAuto, recentSkills, mode, user, recentUsers, families, showOther, textScale } = state;
  const persisted = { skill, days, q, sort, filters, aspect, size, sound, theme, filtersOpen, selected, open, tab, inspectTab, inspectWide, shapeAuto, recentSkills, mode, user, recentUsers, families, showOther, textScale };
  try {
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {}
  // Only what defines the view goes into the link; layout preferences stay per-user.
  const link = { skill, days, q, sort, filters, selected, open, tab, inspectTab, ...(mode === 'user' && user ? { mode, uid: user.id } : {}), ...(families?.[skill] !== undefined ? { fam: families[skill] } : {}) };
  history.replaceState(null, '', `#v=${encodeURIComponent(JSON.stringify(link))}`);
}

// A pasted/shared link on an already-open tab only changes the hash; apply it as a view change.
// (The app's own URL updates use replaceState, which never fires hashchange.)
window.addEventListener('hashchange', () => {
  const v = fromHash();
  if (v) set(v);
});

export function toggleFilter(key, value) {
  const cur = new Set(state.filters[key] || []);
  cur.has(value) ? cur.delete(value) : cur.add(value);
  const filters = { ...state.filters, [key]: [...cur] };
  if (!filters[key].length) delete filters[key];
  set({ filters });
}

export function clearFilter(key) {
  const filters = { ...state.filters };
  if (key) delete filters[key];
  set({ filters: key ? filters : {} });
}

// The `fam` query value for the current skill: 'default' (computed), 'all', or a comma list.
export function famParam(skill = state.skill) {
  // The daily build counts each skill with its computed helpers only.
  if (caps.snapshot) return 'default';
  const f = state.families?.[skill];
  return f === undefined ? 'default' : f === 'all' ? 'all' : f.join(',');
}
