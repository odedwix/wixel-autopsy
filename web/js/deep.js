import { h, icon, dur, tc, copy } from './util.js';
import { CAT_COLOR } from './insights.js';
import { mediaKind } from './timeline.js';
import { openGraphView } from './graph.js';
import { caps, HINT } from './caps.js';

// Deep-dive views for one run: how each scene was made, the brand the site had vs what the ad
// used, every asset in the run, and the raw record.

// Compact play/pause for audio where a native control won't fit.
let playing = null;
export function audioButton(url, cls = 'dz-media') {
  const btn = h('button', { class: `${cls} dz-play`, title: 'Play / pause' }, icon('play'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (playing?.btn === btn) {
      playing.a.pause();
      btn.replaceChildren(icon('play'));
      playing = null;
      return;
    }
    if (playing) {
      playing.a.pause();
      playing.btn.replaceChildren(icon('play'));
    }
    const a = new Audio(url);
    a.play().catch(() => {});
    a.onended = () => {
      btn.replaceChildren(icon('play'));
      playing = null;
    };
    playing = { a, btn };
    btn.replaceChildren(icon('pause'));
  });
  return btn;
}

// Videos show a real frame before hover (#t= seeks the first paint), then play on hover.
const thumb = (url, kind = mediaKind(url), cls = 'dz-media', poster) => {
  if (!url) return h('div', { class: `${cls} empty` });
  if (kind === 'video') return h('video', { class: cls, src: `${url}#t=0.5`, poster, muted: true, loop: true, playsinline: true, preload: 'metadata', onmouseenter: (e) => e.target.play().catch(() => {}), onmouseleave: (e) => e.target.pause() });
  if (kind === 'audio') return cls === 'dz-media' ? audioButton(url) : h('audio', { class: 'dz-audio', src: url, controls: true, preload: 'none' });
  // Scraped URLs are often hotlink-protected or dead; a broken image removes its tile.
  return h('img', { class: cls, src: url, loading: 'lazy', alt: '', onerror: (e) => { const f = e.target.closest('.dz-asset'); if (f) f.remove(); else e.target.style.visibility = 'hidden'; } });
};

// ---------- Scenes: the prompt next to each shot, and the chain that made it ----------
export function renderScenes(root, d, { seek }) {
  const scenes = d.outputs?.scenes || [];
  if (!scenes.length) return root.replaceChildren(h('p', { class: 'desc' }, 'This run has no finished scenes.'));
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  stepsIndex = byId;
  sceneTitle = d.outputs?.name || d.title || 'Run';
  root.replaceChildren(...scenes.map((sc, i) => {
    const chain = (sc.lineage || []).map((id) => byId.get(id)).filter(Boolean);
    const visual = chain.filter((s) => ['image', 'video'].includes(s.category) || s.method === 'mergeVoiceIntoVideo');
    const audio = chain.filter((s) => ['tts', 'audio'].includes(s.category) && s.method !== 'mergeVoiceIntoVideo');
    const genMs = chain.reduce((a, s) => a + (s.durationMs || 0), 0);
    return h('div', { class: 'dz-scene' },
      h('div', { class: 'dz-shot', onclick: () => seek(sc.startSec) },
        thumb(sc.clipUrl, 'video', 'dz-clip', sc.thumbnailUrl || undefined),
        h('div', { class: 'dz-shot-meta' }, h('b', {}, sc.name || `Scene ${i + 1}`), h('span', { class: 'mono' }, `${tc(sc.startSec)} · ${(sc.endSec - sc.startSec).toFixed(1)}s`),
          sc.texts?.length ? h('div', { class: 'dz-onscreen' }, sc.texts.map((t) => h('div', {}, `“${t}”`))) : null,
          h('span', { class: 'desc' }, `${chain.length} steps · ${dur(genMs)} of generation`))),
      h('div', { class: 'dz-chain' },
        chain.length ? null : h('p', { class: 'desc' }, 'The clip wasn’t produced by a step in this run (reused or uploaded).'),
        visual.length ? h('div', { class: 'dz-lane' }, h('h5', {}, 'Picture'), visual.map(stepCard)) : null,
        audio.length ? h('div', { class: 'dz-lane' }, h('h5', {}, 'Voice & sound'), audio.map(stepCard)) : null));
  }));
}

// Image-to-video steps start from their input frame, so it doubles as the clip's poster
// (the remote mp4s aren't fast-start, so a real first frame would mean downloading them).
export const posterFor = (s, stepsById) => {
  const img = (s.mediaIn || []).find((m) => m.kind === 'image');
  if (img) return img.url;
  // A voice merge takes a video in; use that video's own input frame.
  const vid = (s.mediaIn || []).find((m) => m.kind === 'video');
  const parent = vid && stepsById ? [...stepsById.values()].find((x) => (x.mediaOut || []).some((o) => o.id === vid.id)) : null;
  return parent ? (parent.mediaIn || []).find((m) => m.kind === 'image')?.url : undefined;
};

let stepsIndex = null;
let sceneTitle = '';
function stepCard(s) {
  const out = (s.mediaOut || []).find((m) => !/captions\.json/.test(m.url));
  const graphable = (s.workflowId || (s.status === 'failed' && s.jobId)) && caps.temporalKey;
  return h('div', { class: `dz-step${s.status === 'failed' ? ' failed' : ''}${graphable ? ' graphable' : ''}`, title: graphable ? 'Click to open the Genix graph run' : '', onclick: graphable ? () => openGraphView({ title: sceneTitle, step: s }) : null },
    out ? thumb(out.url, out.kind, 'dz-media', out.kind === 'video' ? posterFor(s, stepsIndex) : undefined) : h('div', { class: 'dz-media empty' }, icon('sparkle')),
    h('div', { class: 'dz-step-body' },
      h('div', { class: 'dz-step-h' }, h('span', { class: 'cat', style: { background: CAT_COLOR[s.category] } }), h('b', {}, s.method || s.tool), s.model ? h('span', { class: 'desc' }, s.model) : null, h('span', { class: 'mono', style: { marginLeft: 'auto' } }, dur(s.durationMs))),
      s.prompt ? h('div', { class: 'dz-prompt', title: String(s.prompt) }, String(s.prompt)) : null,
      s.error ? h('div', { class: 'dz-err' }, String(s.error).slice(0, 200)) : null));
}

// ---------- Brand: what the site had vs what the ad used ----------
const hexRgb = (hex) => {
  const m = String(hex).replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  const x = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
};
// Close enough to read as "the same brand colour" (simple RGB distance; good enough for swatches).
const near = (a, b) => {
  const x = hexRgb(a);
  const y = hexRgb(b);
  return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 48 : false;
};
const normFont = (f) => String(f).toLowerCase().replace(/[^a-z0-9]/g, '');

export function renderBrand(root, d) {
  const s = d.scraped;
  const b = d.brand || {};
  const siteColors = s?.colors || [];
  const siteFonts = s?.fonts || [];
  const swatch = (color, matched, n) => h('div', { class: 'dz-swatch', title: `${color}${n ? ` · used ${n}×` : ''}${matched != null ? (matched ? ' · matches the other side' : ' · no match on the other side') : ''}` },
    h('i', { style: { background: color } }), h('span', { class: 'mono' }, color), matched ? h('span', { class: 's ok' }, '✓') : null);
  const site = h('div', { class: 'dz-col' },
    h('h5', {}, 'Website (scraped)'),
    s ? h('div', { class: 'dz-brand' },
      s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'mono' }, s.url) : null,
      h('div', { class: 'dz-logos' }, s.logo ? h('img', { src: s.logo, class: 'dz-logo', alt: 'logo', title: 'Logo' }) : null, s.favicon ? h('img', { src: s.favicon, class: 'dz-fav', alt: 'favicon', title: 'Favicon' }) : null),
      h('div', { class: 'dz-swatches' }, siteColors.map((c) => swatch(c, b.adColors?.some((a) => near(a.color, c))))),
      h('div', { class: 'dz-fonts' }, siteFonts.map((f) => h('span', { class: `pill${b.adFonts?.some((a) => normFont(a.font) === normFont(f)) ? ' ok' : ''}` }, f))),
      s.screenshot ? h('a', { href: s.screenshot, target: '_blank', rel: 'noopener' }, h('img', { class: 'dz-shot-img', src: s.screenshot, loading: 'lazy', alt: 'site screenshot' })) : null)
      : h('p', { class: 'desc' }, 'No website was scraped in this run.'));
  const ad = h('div', { class: 'dz-col' },
    h('h5', {}, 'The ad used'),
    h('div', { class: 'dz-brand' },
      h('div', { class: 'dz-logos' }, b.logoConverted ? h('img', { src: b.logoConverted, class: 'dz-logo', alt: 'logo used' }) : null,
        h('span', { class: `pill${b.logoShot ? ' ok' : ''}` }, b.logoShot ? 'Logo shot in the ad' : 'No logo shot')),
      h('div', { class: 'dz-swatches' }, (b.adColors || []).map((c) => swatch(c.color, siteColors.length ? siteColors.some((x) => near(x, c.color)) : null, c.n))),
      h('div', { class: 'dz-fonts' }, (b.adFonts || []).map((f) => h('span', { class: `pill${siteFonts.some((x) => normFont(x) === normFont(f.font)) ? ' ok' : ''}`, title: `${f.n} text runs` }, `${f.font} ×${f.n}`))),
      d.outputs?.captions ? h('div', { class: 'desc' }, `Captions: ${d.outputs.captions.preset || 'custom'} · ${d.outputs.captions.enabled ? 'on' : 'off'} · ${d.outputs.captions.position || ''}`) : null,
      d.outputs?.music ? h('div', { class: 'desc' }, `Music: ${d.outputs.music.track_name || 'track'} · volume ${d.outputs.music.volume ?? '–'}`) : null));
  const verdict = [];
  if (siteColors.length && b.adColors?.length) {
    const used = siteColors.filter((c) => b.adColors.some((a) => near(a.color, c))).length;
    verdict.push(`${used} of ${siteColors.length} site colours appear in the ad’s text`);
  }
  if (siteFonts.length && b.adFonts?.length) {
    const used = siteFonts.filter((f) => b.adFonts.some((a) => normFont(a.font) === normFont(f))).length;
    verdict.push(`${used} of ${siteFonts.length} site fonts are used`);
  }
  // replaceChildren would print a literal "null", so drop empty parts first.
  root.replaceChildren(...[verdict.length ? h('p', { class: 'dz-verdict' }, verdict.join(' · ')) : null, h('div', { class: 'dz-compare' }, site, ad),
    d.brief ? h('details', { style: { marginTop: '12px' } }, h('summary', {}, 'Brief the user submitted'), h('pre', { class: 'tl-pre' }, typeof d.brief === 'string' ? d.brief : JSON.stringify(d.brief, null, 2))) : null].filter(Boolean));
}

// ---------- Assets: every piece of media in the run, grouped by where it came from ----------
export function renderAssets(root, d) {
  const seen = new Set();
  const add = (list, url, meta) => {
    const key = String(url).split('?')[0];
    if (!url || seen.has(key)) return;
    seen.add(key);
    list.push({ url, ...meta });
  };
  const groups = { uploads: [], website: [], images: [], clips: [], audio: [] };
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  for (const m of d.userMessages || []) for (const a of m.attachments || []) add(groups.uploads, a.url || a.blob?.url, { label: a.fileName || 'attachment' });
  const briefUrls = JSON.stringify(d.brief || '').match(/https?:\/\/[^\s"'\\]+/g) || [];
  for (const u of briefUrls) add(groups.uploads, u, { label: 'from the brief' });
  if (d.scraped) {
    add(groups.website, d.scraped.logo, { label: 'logo' });
    add(groups.website, d.scraped.screenshot, { label: 'screenshot' });
    for (const u of d.scraped.images || []) add(groups.website, u, { label: 'site image' });
  }
  for (const s of d.steps) {
    for (const m of s.mediaOut || []) {
      if (/captions\.json/.test(m.url)) continue;
      const meta = { label: s.method || s.tool, prompt: s.prompt, model: s.model, failed: s.status === 'failed', poster: m.kind === 'video' ? posterFor(s, byId) : undefined };
      add(m.kind === 'video' ? groups.clips : m.kind === 'audio' ? groups.audio : groups.images, m.url, meta);
    }
  }
  const titles = { uploads: 'User uploads', website: 'From the website', images: 'Generated images', clips: 'Generated clips', audio: 'Voice & music' };
  root.replaceChildren(...Object.entries(groups).filter(([, l]) => l.length).map(([k, list]) => h('div', { class: 'dz-group' },
    h('h5', {}, titles[k], h('span', { class: 'n' }, list.length)),
    h('div', { class: k === 'audio' ? 'dz-audios' : 'dz-gallery' }, list.map((a) => h('figure', { class: 'dz-asset', title: [a.label, a.model, a.prompt].filter(Boolean).join('\n\n').slice(0, 600) },
      k === 'audio' ? h('audio', { class: 'dz-audio', src: a.url, controls: true, preload: 'none' }) : thumb(a.url, k === 'clips' ? 'video' : mediaKind(a.url), 'dz-media', a.poster),
      h('figcaption', {}, a.label, a.model ? ` · ${a.model}` : ''),
      h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'dz-open', title: 'Open' }, icon('external', 'sm'))))))));
  if (!root.children.length) root.replaceChildren(h('p', { class: 'desc' }, 'No media in this run.'));
}

// ---------- Raw ----------
export function renderRaw(root, d) {
  const keys = Object.keys(d);
  root.replaceChildren(
    h('div', { class: 'links', style: { marginBottom: '10px' } },
      h('button', { class: 'btn', onclick: () => copy(JSON.stringify(d, null, 2)) }, icon('copy'), 'Copy record'),
      h('a', { class: 'btn', href: `api/session/${d.id}?raw=1`, target: '_blank', rel: 'noopener' }, icon('external'), 'Raw admin bundle')),
    ...keys.map((k) => h('details', { class: 'dz-raw' }, h('summary', {}, k, h('span', { class: 'desc' }, ` ${Array.isArray(d[k]) ? `[${d[k].length}]` : typeof d[k]}`)),
      h('pre', { class: 'tl-pre' }, JSON.stringify(d[k], null, 2).slice(0, 20000)))));
}
