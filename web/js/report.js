import { h } from './util.js';
import { state } from './state.js';
import { caps } from './caps.js';
import { toast } from './ui.js';

// Printable reports (a run, or a skill's insights) → the browser's "Save as PDF". The report is
// laid out at A4-landscape width in the dark theme with every colour kept
// (print-color-adjust: exact), type ~25% larger than the app, and real <a href> links, so the PDF
// reads like the UI and its links click. The app is hidden while the report is on screen; the
// browser names the file after the page title.

export const ADMIN = 'https://wix-bo.com/wixel-agent/admin/#/sessions/';
const ZOOM = 1.25;

// Rendered by the proxy's headless Chrome (server/pdf.js) the page marks itself ready
// (window.__reportState) instead of opening the print dialog.
export const headless = () => Boolean(window.__AUTOPSY_HEADLESS);

export async function printReport({ title, titleMeta, subtitle, fileName, links = [], build }) {
  const root = h('div', { id: 'report', class: 'report' });
  const body = h('div', { class: 'rp-body' });
  root.append(
    h('header', { class: 'rp-head' },
      h('div', { class: 'rp-brand' }, h('img', { src: 'icon.png', alt: '' }), 'Autopsy'),
      h('h1', {}, title, titleMeta ? h('span', { class: 'rp-meta' }, titleMeta) : null),
      subtitle ? h('p', { class: 'rp-sub' }, subtitle) : null,
      links.length ? h('div', { class: 'rp-links' }, ...links.filter(Boolean).map((l) => h('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.label))) : null,
      h('p', { class: 'rp-stamp' }, `Generated ${new Date().toLocaleString()}`)),
    body);

  // Report styling needs the dark tokens (it sets its own size: zoom here, --fs: 1 in app.css).
  const prev = { theme: document.documentElement.dataset.theme, title: document.title };
  document.documentElement.dataset.theme = 'dark';
  root.style.zoom = String(ZOOM);
  document.body.classList.add('printing-report');
  document.body.append(root);
  const cleanup = () => {
    root.remove();
    document.body.classList.remove('printing-report');
    document.documentElement.dataset.theme = prev.theme || state.theme;
    document.title = prev.title;
    window.removeEventListener('afterprint', cleanup);
  };
  try {
    await build(body);
    await settle(root);
  } catch (err) {
    if (headless()) window.__reportState = { error: String(err.message || err) };
    cleanup();
    throw err;
  }
  document.title = fileName.replace(/[/:*?"<>|]+/g, '-');
  if (headless()) {
    window.__reportState = { title: document.title };
    return;
  }
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 60);
}

// Media for paper: videos become their poster (or go), every image loads eagerly, and the print
// waits (up to 15s) for them so pages don't come out with blank boxes.
// Cards stay whole on paper unless they're tall: one over ~half a printed page may continue onto the
// next (its border repeats there), so it doesn't leave the rest of its page empty. The report is
// laid out at its printed width, so heights measured now are the printed ones.
const PAGE_PX = (210 / 25.4) * 96 / ZOOM; // A4 landscape height, in the report's unzoomed pixels
function markBreakable(root) {
  for (const card of root.querySelectorAll('.ins-card, .rp-sec')) {
    card.classList.toggle('rp-breakable', card.getBoundingClientRect().height / ZOOM > PAGE_PX * 0.5);
  }
}

async function settle(root) {
  for (const v of root.querySelectorAll('video')) {
    // No poster: a frame grabbed from the clip by the proxy (ffmpeg, cached).
    const src = (v.getAttribute('src') || '').replace(/#.*$/, '');
    const poster = v.getAttribute('poster') || (/^https:/.test(src) ? `api/frame?url=${encodeURIComponent(src)}` : null);
    if (poster) v.replaceWith(h('img', { class: v.className, src: poster, alt: '' }));
    else v.remove();
  }
  for (const a of root.querySelectorAll('audio')) a.remove();
  const imgs = [...root.querySelectorAll('img')];
  for (const i of imgs) {
    i.loading = 'eager';
    // Wix image CDNs resize on the fly: ask for ~2× the printed size instead of the original
    // (a 850KB logo PNG becomes a 25KB JPEG), which keeps a run's PDF to a few MB.
    const src = i.getAttribute('src') || '';
    if (/^https:\/\/(static\.wixstatic\.com\/media\/|img-wixmp-[\w-]+\.wixmp\.com\/images\/)/.test(src) && !/\/v1\//.test(src)) {
      const r = i.getBoundingClientRect();
      const px = Math.min(1400, Math.max(300, Math.ceil((Math.max(r.width, r.height) * 2.5) / 100) * 100));
      i.src = `${src.split('?')[0]}/v1/fit/w_${px},h_${px},q_82/image.jpg`;
    }
  }
  await Promise.race([
    Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))),
    new Promise((r) => setTimeout(r, 15000)),
  ]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  markBreakable(root);
}

// Save a report straight to Downloads: the proxy renders it with headless Chrome (server/pdf.js)
// for the current view (#v=… hash) and it arrives as an ordinary file download, no dialog. Without
// Chrome on this machine (or inside that headless render), `inPage` builds it here and opens the
// print dialog instead.
export async function downloadReport({ kind, fileName, inPage }) {
  if (headless() || !caps.pdf) return inPage();
  const started = Date.now();
  toast('Building the PDF…', { ms: 120000 });
  const tick = setInterval(() => toast(`Building the PDF… ${Math.round((Date.now() - started) / 1000)}s`, { ms: 120000 }), 1000);
  try {
    const res = await fetch(`api/report.pdf?kind=${kind}&name=${encodeURIComponent(fileName)}&view=${encodeURIComponent(location.hash)}`);
    if (res.status === 503) return inPage();
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const blob = await res.blob();
    const a = h('a', { href: URL.createObjectURL(blob), download: `${fileName.replace(/[/:*?"<>|]+/g, '-')}.pdf` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(`Saved to Downloads: ${a.download}`, { ms: 5000 });
  } catch (err) {
    toast(`Couldn't build the PDF: ${err.message}`, { ms: 6000 });
  } finally {
    clearInterval(tick);
  }
}

// A titled section of a report.
export function section(title, ...content) {
  return h('section', { class: 'rp-sec' }, h('h2', {}, title), ...content.flat().filter(Boolean));
}
