import { h, icon, fmtInt, getJson } from './util.js';
import { state, set } from './state.js';
import { popover, closePopover } from './ui.js';

// Searchable skill picker: recently viewed (5) on top, then every skill, filtered as you type.
// Its Users tab switches to user mode: every session one person ran, any skill.

let skills = [];
export const setSkills = (list) => (skills = list || []);

export function rememberSkill(skill) {
  const recent = [skill, ...(state.recentSkills || []).filter((s) => s !== skill)].slice(0, 5);
  set({ recentSkills: recent }, { silent: true });
}

export function renderSkillButton(btn) {
  if (state.mode === 'user') {
    btn.title = 'Switch user or skill (⌘K)';
    btn.replaceChildren(icon('user', 'sm'), h('span', { class: 'sk-name' }, state.user?.email || `user ${state.user?.id?.slice(0, 8) || '?'}`), h('span', { class: 'sk-n' }, 'all skills'), icon('search', 'sm'));
    return;
  }
  btn.title = 'Switch skill (⌘K)';
  const cur = skills.find((s) => s.skill === state.skill);
  btn.replaceChildren(h('span', { class: 'sk-name' }, state.skill), cur ? h('span', { class: 'sk-n' }, fmtInt(cur.sessions)) : null, icon('search', 'sm'));
}

// Every run by one user, any skill.
export function showUser(user) {
  if (!user?.id) return;
  const recentUsers = [user, ...(state.recentUsers || []).filter((u) => u.id !== user.id)].slice(0, 5);
  set({ mode: 'user', user, recentUsers, selected: null, open: false, filters: {} });
}

export function openSkillPicker(btn, { tab } = {}) {
  let which = tab || (state.mode === 'user' ? 'users' : 'skills');
  const pop = h('div', { class: 'sk-pop' });
  const tabs = () => h('div', { class: 'seg sk-tabs' },
    h('button', { 'aria-checked': String(which === 'skills'), onclick: () => { which = 'skills'; render(); } }, 'Skills'),
    h('button', { 'aria-checked': String(which === 'users'), onclick: () => { which = 'users'; render(); } }, 'Users'));
  const render = () => {
    pop.replaceChildren(tabs(), ...(which === 'users' ? usersPane() : skillsPane()));
    pop.querySelector('input')?.focus();
  };
  popover(btn, pop, { width: 360 });
  render();
}

function usersPane() {
  const input = h('input', { type: 'search', class: 'sk-input', placeholder: 'Email, user id or session link…', autocomplete: 'off', spellcheck: 'false' });
  const msg = h('div', { class: 'sk-empty' }, 'Every session this person ran, across all skills.');
  const go = async (q) => {
    msg.textContent = 'Looking up…';
    try {
      const user = await getJson(`/api/resolve-user?q=${encodeURIComponent(q)}`);
      closePopover();
      showUser(user);
    } catch (err) {
      msg.textContent = err.message;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      go(input.value.trim());
    }
  });
  const recent = (state.recentUsers || []).filter((u) => u?.id);
  return [input, h('div', { class: 'sk-list' }, ...[
    recent.length ? h('div', { class: 'sk-sec' }, 'Recently viewed') : null,
    ...recent.map((u) => h('button', { class: `sk-row${state.mode === 'user' && state.user?.id === u.id ? ' cur' : ''}`, onclick: () => { closePopover(); showUser(u); } },
      icon('user', 'sm'), h('span', { class: 'sk-name' }, u.email || u.id))),
    msg,
  ].filter(Boolean))];
}

function skillsPane() {
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
    if (skill && (skill !== state.skill || state.mode === 'user')) set({ skill, mode: 'skill', selected: null, open: false });
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
  draw();
  return [input, list];
}
