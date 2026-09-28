// View state: persisted to localStorage (restored on reload) and mirrored into the URL hash
// (so any view is a shareable link). The hash wins when both are present.

const KEY = 'skill-runs:v1';

const defaults = {
  skill: 'wixel-ads',
  days: 7,
  q: '',
  sort: 'newest',
  filters: { outcome: ['video'] },
  aspect: '9:16',
  size: 200,
  sound: true,
  theme: 'dark',
  filtersOpen: true,
  selected: null,
  open: false,
  tab: 'videos',
};

function fromHash() {
  if (!location.hash.startsWith('#v=')) return null;
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(3)));
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
  const { skill, days, q, sort, filters, aspect, size, sound, theme, filtersOpen, selected, open, tab } = state;
  const persisted = { skill, days, q, sort, filters, aspect, size, sound, theme, filtersOpen, selected, open, tab };
  try {
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {}
  // Only what defines the view goes into the link; layout preferences stay per-user.
  const link = { skill, days, q, sort, filters, selected, open, tab };
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
