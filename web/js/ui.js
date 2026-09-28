import { h } from './util.js';

// Small shared UI pieces: a rich hover tooltip, a toast, and an anchored popover.

// ---------- tooltip: instant, styled, can hold a list (native title= is slow and plain) ----------
let tipEl;
function tipBox() {
  tipEl ??= document.body.appendChild(h('div', { class: 'tip rich', hidden: true }));
  return tipEl;
}
function place(e) {
  const t = tipBox();
  const x = Math.min(window.innerWidth - t.offsetWidth - 10, e.clientX + 14);
  const y = e.clientY + 16 + t.offsetHeight > window.innerHeight ? e.clientY - t.offsetHeight - 10 : e.clientY + 16;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
// Any click or scroll hides it (a tooltip must never outlive the hover).
for (const ev of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(ev, () => tipEl && (tipEl.hidden = true), { passive: true, capture: true });

// `content` returns a string or nodes; computed on hover so it's never stale.
export function richTip(el, content) {
  el.addEventListener('pointerenter', (e) => {
    const c = content();
    if (!c) return;
    const t = tipBox();
    t.replaceChildren(...(Array.isArray(c) ? c : [c]).filter(Boolean));
    t.hidden = false;
    place(e);
  });
  el.addEventListener('pointermove', (e) => tipEl && !tipEl.hidden && place(e));
  el.addEventListener('pointerleave', () => tipEl && (tipEl.hidden = true));
  return el;
}

// ---------- toast ----------
let toastEl;
let toastTimer;
export function toast(message, { ms = 3500 } = {}) {
  toastEl ??= document.body.appendChild(h('div', { class: 'toast', role: 'status', hidden: true }));
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

// ---------- popover anchored under an element; closes on outside click / Esc ----------
let open = null;
export function popover(anchor, content, { align = 'left', width } = {}) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: 'popover', role: 'dialog' }, content);
  if (width) el.style.width = `${width}px`;
  document.body.append(el);
  const w = el.offsetWidth;
  el.style.top = `${r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, align === 'right' ? r.right - w : r.left))}px`;
  const onDown = (e) => !el.contains(e.target) && !anchor.contains(e.target) && closePopover();
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
  document.addEventListener('keydown', onKey, true);
  open = { el, cleanup: () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true); } };
  return el;
}
export function closePopover() {
  if (!open) return;
  open.cleanup();
  open.el.remove();
  open = null;
}
export const popoverOpen = () => Boolean(open);

// ---------- clipboard with feedback ----------
export async function copyText(text, what = 'Link') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    // Clipboard API can be blocked; fall back to a hidden textarea.
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`${what} copied`);
  }
}

export function mailto({ subject, body }) {
  const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
  window.location.href = url;
}
