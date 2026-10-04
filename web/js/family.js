import { h, icon, getJson } from './util.js';
import { state, set } from './state.js';
import { popover, closePopover } from './ui.js';
import { caps } from './caps.js';

const their = (skill) => (skill.endsWith('s') ? `${skill}'` : `${skill}'s`);

// What counts as a skill's work. A session counts from the turn that loads the skill; later
// turns stay with it until one loads a skill outside its family, and those turns (other skills'
// work) are left out of runs, outputs, timing and insights. The family is computed from how often
// skills load together; this editor shows why each helper is in it and lets you change it.

const families = new Map(); // skill → /api/family result
export async function familyInfo(skill) {
  if (!families.has(skill)) families.set(skill, await getJson(`/api/family?skill=${encodeURIComponent(skill)}`));
  return families.get(skill);
}

// The family in effect for the current skill: { mode: 'default' | 'custom' | 'all', list }.
export function currentFamily(info) {
  // The daily build is counted with the computed helpers only.
  const f = caps.snapshot ? undefined : state.families?.[state.skill];
  if (f === 'all') return { mode: 'all', list: [] };
  if (Array.isArray(f)) return { mode: 'custom', list: f };
  return { mode: 'default', list: info?.family || [] };
}

export function renderScopeButton(btn) {
  if (state.mode === 'user') {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const info = families.get(state.skill);
  const cur = currentFamily(info);
  const label = cur.mode === 'all' ? 'Whole sessions' : info?.hub ? 'Its own turns' : `+${cur.list.length} helper${cur.list.length === 1 ? '' : 's'}`;
  btn.replaceChildren(...[h('span', { class: 'k' }, 'Counting'), h('span', {}, label), cur.mode === 'custom' ? h('span', { class: 'edited', title: 'You changed this' }, '•') : null].filter(Boolean));
  btn.title = cur.mode === 'all'
    ? `Counting whole sessions that used ${state.skill}, including other skills' work — click to change`
    : `Counting ${their(state.skill)} turns${cur.list.length ? ` and its helpers (${cur.list.join(', ')})` : ''}; other skills' turns are left out — click to change`;
  if (!info) familyInfo(state.skill).then(() => renderScopeButton(btn)).catch(() => {});
}

export async function openFamilyEditor(btn) {
  const skill = state.skill;
  let info;
  try {
    info = await familyInfo(skill);
  } catch (err) {
    info = { skill, family: [], detail: [], error: err.message };
  }
  const cur = currentFamily(info);
  let mode = cur.mode === 'all' ? 'all' : 'turns';
  const chosen = new Set(cur.list);
  const detail = new Map(info.detail.map((d) => [d.skill, d]));
  for (const s of chosen) if (!detail.has(s)) detail.set(s, { skill: s, share: null, added: true });

  // The shared copy shows the computed helpers but can't recount with others (built once a day).
  const ro = Boolean(caps.snapshot);
  const body = h('div', { class: 'fam-body' });
  const pct = (x) => `${Math.round(x * 100)}%`;
  const draw = () => {
    const rows = [...detail.values()];
    body.replaceChildren(...[
      h('label', { class: `fam-mode${mode === 'turns' ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'fam-mode', checked: mode === 'turns', disabled: ro, onchange: () => { mode = 'turns'; draw(); } }),
        h('span', {}, h('b', {}, `${their(skill)} turns`), h('small', {}, `From the turn that loads ${skill}. Later turns stay with it until one loads a skill not listed below — those are other skills' work and are left out.`))),
      mode === 'turns' && info.hub ? h('p', { class: 'fam-note' }, `${skill} is a helper that loads alongside many skills, so only the turns that load it count (its partners would pull every product in).`) : null,
      mode === 'turns' && !info.hub ? h('div', { class: 'fam-list' },
        rows.length ? null : h('p', { class: 'fam-note' }, `No helpers: any other skill loaded in a later turn ends ${their(skill)} part of the session.`),
        ...rows.map((d) => h('label', { class: 'fam-row' },
          h('input', { type: 'checkbox', checked: chosen.has(d.skill), disabled: ro, onchange: (e) => { e.target.checked ? chosen.add(d.skill) : chosen.delete(d.skill); } }),
          h('span', { class: 'n' }, d.skill),
          d.hub ? h('span', { class: 'tag', title: 'Loaded alongside many skills (a shared helper)' }, 'shared') : null,
          h('span', { class: 'why' }, d.added ? 'added by you' : d.shared ? 'shared helper (any skill)' : d.via ? `sub-step of ${d.via} (${pct(d.share)} of its turns)` : `loaded with it in ${pct(d.share)} of its turns`))),
        ro ? null : addRow(),
      ) : null,
      h('label', { class: `fam-mode${mode === 'all' ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'fam-mode', checked: mode === 'all', disabled: ro, onchange: () => { mode = 'all'; draw(); } }),
        h('span', {}, h('b', {}, 'Whole sessions'), h('small', {}, `Everything in any session that used ${skill} at some point, including other skills' work.`))),
      info.error ? h('p', { class: 'fam-note err' }, `Couldn't load the computed helpers: ${info.error}`) : null,
      ro ? h('p', { class: 'fam-note' }, 'This shared copy is built once a day with the computed helpers. To count other helpers or whole sessions, run Autopsy locally.') : h('div', { class: 'fam-actions' },
        h('button', { class: 'btn ghost', onclick: () => apply('default') }, 'Reset to computed'),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn', onclick: () => apply(mode === 'all' ? 'all' : [...chosen].sort()) }, 'Apply')),
    ].filter(Boolean));
  };
  const addRow = () => {
    const input = h('input', { type: 'text', class: 'fam-add', placeholder: 'Add a skill…', spellcheck: 'false' });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = input.value.trim();
      if (!/^[\w.:-]{1,80}$/.test(v) || v === skill) return;
      if (!detail.has(v)) detail.set(v, { skill: v, share: null, added: true });
      chosen.add(v);
      draw();
    });
    return input;
  };
  const apply = (value) => {
    closePopover();
    const next = { ...state.families };
    const same = value === 'default' || (Array.isArray(value) && value.join(',') === [...info.family].sort().join(','));
    if (same) delete next[skill];
    else next[skill] = value;
    if (JSON.stringify(next[skill]) !== JSON.stringify(state.families?.[skill])) set({ families: next });
  };
  draw();
  popover(btn, h('div', { class: 'fam-pop' },
    h('div', { class: 'fam-head' }, h('b', {}, `What counts as ${skill}`), h('span', { class: 'fam-sub' }, 'Most sessions use several skills. Pick what this view counts.')),
    body), { width: 420 });
}
