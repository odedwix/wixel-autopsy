import { spawn } from 'node:child_process';
import { getSessionBundle } from './admin.js';
import { getIndexedRun } from './runs.js';

// Downloads for non-video outputs (slides, docs, stories, logos, images), best source first:
//   1. the exact file the user downloaded from the editor (PDF, PPTX, PNG, MP4…), when it's
//      reachable (editor exports of slides and docs are private, so usually only renders are);
//   2. a multi-page asset (slides, doc, story pages): a PDF of its page snapshots, in order;
//   3. a single asset: its original image if it is one plain image (a logo), else its snapshot
//      (a composed design with text, as the user saw it).
// Snapshots are the editor's previews (~1000px wide), so a built PDF is a review copy, not a
// print-quality export.

const HOSTS = /(^|\.)(wixmp\.com|wixstatic\.com|wixel\.com|wix\.com)$/i;
const allowed = (u) => {
  try {
    return HOSTS.test(new URL(u).hostname);
  } catch {
    return false;
  }
};
const extOf = (u) => (String(u).split('?')[0].match(/\.(pdf|pptx|png|jpe?g|webp|svg|mp4|gif|zip)$/i)?.[1] || '').toLowerCase();

function propsOf(a) {
  return (a.components || []).map((c) => c.data?.props || {});
}
const snapshotOf = (a) => a.thumbnail?.url || a.thumbnailUrl || null;
// The asset's own image file when that's all it is: a logo (a design whose only content is its
// background image) or a single plain image layer. Anything with text or several layers is a
// composition, and its snapshot is what the user saw.
const MEDIA = /^https:\/\/static\.wixstatic\.com\/media\/\S+\.(png|jpe?g|webp|svg)$/i;
function plainImage(a) {
  const props = propsOf(a);
  const bg = a.design?.background?.media?.image?.url;
  if (!props.length) return MEDIA.test(bg || '') ? bg : null;
  if (props.length !== 1 || props.some((p) => p.richText)) return null;
  return Object.values(props[0]).find((v) => typeof v === 'string' && MEDIA.test(v)) || null;
}

export async function assetSource(runId, assetId) {
  const run = getIndexedRun(runId);
  const out = run?.outputs?.find((o) => o.id === assetId);
  if (out?.type === 'video') return { kind: 'video' };
  // The user's own export, when it's reachable (editor exports of slides/docs are private: 403).
  if (out?.downloadUrl && allowed(out.downloadUrl)) {
    const head = await fetch(out.downloadUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (head?.ok) return { kind: 'url', url: out.downloadUrl, ext: extOf(out.downloadUrl) || 'bin', label: 'the file the user downloaded' };
  }
  const bundle = await getSessionBundle(runId);
  const list = Array.isArray(bundle.assets?.assets) ? bundle.assets.assets : [];
  const a = list.find((x) => x.id === assetId);
  if (!a) throw Object.assign(new Error('Asset not found in this run'), { status: 404 });
  if (String(a.type).toUpperCase() === 'VIDEO') return { kind: 'video' };
  const pages = list.filter((x) => x.parentId === a.id)
    .sort((x, y) => (x.layout?.order?.indexInParent ?? 0) - (y.layout?.order?.indexInParent ?? 0))
    .map(snapshotOf).filter((u) => u && allowed(u));
  if (pages.length) return { kind: 'pdf', pages, label: `PDF of ${pages.length} page previews` };
  const original = plainImage(a);
  if (original && allowed(original)) return { kind: 'url', url: original, ext: extOf(original) || 'png', label: 'the original image' };
  const snap = snapshotOf(a);
  if (snap && allowed(snap)) return { kind: 'image', url: snap, label: 'the design preview' };
  throw Object.assign(new Error('Nothing downloadable for this asset'), { status: 404 });
}

// ---- images → JPEG → PDF, no dependencies ----
function toJpeg(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj444p', '-q:v', '2', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.slice(0, 200)}`))));
    p.stdin.end(buf);
  });
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

async function fetchBuf(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`page ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function imageAsJpeg(url) {
  return toJpeg(await fetchBuf(url));
}

export async function pagesPdf(urls) {
  const jpegs = [];
  for (let i = 0; i < urls.length; i += 4) {
    jpegs.push(...(await Promise.all(urls.slice(i, i + 4).map((u) => fetchBuf(u).then(toJpeg).catch(() => null)))));
  }
  const pages = jpegs.filter(Boolean).map((buf) => ({ buf, ...(jpegSize(buf) || { w: 1000, h: 562 }) }));
  if (!pages.length) throw Object.assign(new Error('Could not fetch any page previews'), { status: 502 });
  // Objects: 1 catalog, 2 page tree, then per page: page, contents, image.
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    size += buf.length;
  };
  const obj = (n, body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    for (const b of [].concat(body)) push(b);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const id = pageIds[i];
    // 72 dpi at the preview's pixel size: 1 px = 0.75 pt keeps pages a sensible physical size.
    const W = (p.w * 0.75).toFixed(2);
    const H = (p.h * 0.75).toFixed(2);
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    obj(id + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(id + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.buf.length} >>\nstream\n`, p.buf, '\nendstream']);
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return { buf: Buffer.concat(parts), pages: pages.length, skipped: urls.length - pages.length };
}
