import { h, icon, fmtInt } from './util.js';
import { state, set } from './state.js';
import { popover, closePopover } from './ui.js';

// Searchable skill picker: recently viewed (5) on top, then every skill, filtered as you type.

let skills = [];
export const setSkills = (list) => (skills = list || []);

export function rememberSkill(skill) {
  const recent = [skill, ...(state.recentSkills || []).filter((s) => s !== skill)].slice(0, 5);
  set({ recentSkills: recent }, { silent: true });
}

export function renderSkillButton(btn) {
  const cur = skills.find((s) => s.skill === state.skill);
  btn.replaceChildren(h('span', { class: 'sk-name' }, state.skill), cur ? h('span', { class: 'sk-n' }, fmtInt(cur.sessions)) : null, icon('search', 'sm'));
}

export function openSkillPicker(btn) {
  const input = h('input', { type: 'search', class: 'sk-input', placeholder: 'Search skills…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'sk-list', role: 'listbox' });
  let items = [];
  let active = 0;

  const row = (s, recent) => h('button', { class: `sk-row${s.skill === state.skill ? ' cur' : ''}`, role: 'option', onclick: () => pick(s.skill) },
    recent ? icon('film', 'sm') : null, h('span', { class: 'sk-name' }, s.skill), h('span', { class: 'sk-n' }, s.sessions != null ? fmtInt(s.sessions) : ''));

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const byName = new Map(skills.map((s) => [s.skill, s]));
    const recent = q ? [] : (state.recentSkills || []).filter((n) => n !== undefined).map((n) => byName.get(n) || { skill: n, sessions: null });
    const all = skills.filter((s) => !q || s.skill.toLowerCase().includes(q))
      // Prefix matches first, then by volume.
      .sort((a, b) => (q ? (b.skill.toLowerCase().startsWith(q) - a.skill.toLowerCase().startsWith(q)) : 0) || b.sessions - a.sessions);
    items = [...recent, ...all];
    active = Math.min(active, Math.max(0, items.length - 1));
    // replaceChildren would print "null" for the conditional parts.
    list.replaceChildren(...[
      recent.length ? h('div', { class: 'sk-sec' }, 'Recently viewed') : null,
      ...recent.map((s) => row(s, true)),
      h('div', { class: 'sk-sec' }, q ? `${all.length} matching` : `All skills · last 30 days`),
      ...all.map((s) => row(s, false)),
      !all.length ? h('div', { class: 'sk-empty' }, 'No skill matches — press Enter to open it anyway') : null,
    ].filter(Boolean));
    [...list.querySelectorAll('.sk-row')].forEach((el, i) => el.classList.toggle('active', i === active));
  };

  const pick = (skill) => {
    closePopover();
    if (skill && skill !== state.skill) set({ skill, selected: null, open: false });
  };

  input.addEventListener('input', () => {
    active = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      [...list.querySelectorAll('.sk-row')].forEach((el, i) => el.classList.toggle('active', i === active));
      list.querySelectorAll('.sk-row')[active]?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[active]?.skill || input.value.trim());
    }
  });
  popover(btn, h('div', { class: 'sk-pop' }, input, list), { width: 360 });
  draw();
  input.focus();
}
