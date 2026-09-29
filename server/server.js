import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { getSessionBundle } from './admin.js';
import { normalizeSession, turnOwnership } from './normalize.js';
import { getGenerationTrace, getJobTrace } from './temporal.js';
import { listRuns, listSkills, getIndexedRun, runsIndex, runsForDay, familyFor, resolveFamily, listUserRuns } from './runs.js';
import { rememberUser, resolveUser } from './users.js';
import { assetSource, pagesPdf, imageAsJpeg } from './asset-download.js';
import { renderPdf, chromePath } from './pdf.js';
import { startExact, exactStatus, exactFile } from './exact.js';
import { checkConnectivity, connectivity, startConnectivityChecks } from './connectivity.js';
import { mediaStatus, mediaFile, queueDepth, downloadSource, clipFrame } from './media.js';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { playerInput, bundleList, playerScript } from './player.js';
import { loadReport } from './limits.js';
import { takeOver, claim } from './singleton.js';
import { requestContext } from './context.js';
import { startSweeping, cacheReport } from './cache-gc.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const WEB = path.join(config.root, 'web');
const QUIET = /^\/api\/(load|media-batch|media-queue|health|exact\/[\w-]{36})$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function send(req, res, status, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'content-type': type, 'cache-control': 'no-store' };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['content-encoding'] = 'gzip';
    return res.writeHead(status, headers).end(zlib.gzipSync(buf, { level: 5 }));
  }
  res.writeHead(status, headers).end(buf);
}

let caps;
function capabilities() {
  caps ??= {
    temporalKey: Boolean(config.temporal.apiKey),
    ffmpeg: spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0,
    player: existsSync(path.join(config.cacheDir, 'vendor', 'iframe-bootstrap.js')),
    pdf: Boolean(chromePath()), // reports download straight to a PDF (else the print dialog)
    exact: Boolean(chromePath()) && existsSync(path.join(config.cacheDir, 'vendor', 'capture-bootstrap.js')), // Exact composition → mp4
  };
  return caps;
}

function required(q, key) {
  const v = q.get(key);
  if (!v) throw Object.assign(new Error(`${key} is required`), { status: 400 });
  return v;
}

const routes = [
  // What this install can do; the UI switches optional features off (with a hint) when missing.
  [/^\/api\/health$/, async () => ({ ok: true, ...capabilities(), adminUi: config.adminUi, temporalUi: config.temporal.uiBase, cache: cacheReport(), net: await checkConnectivity() })],
  // Can we reach bo.wix.com (Wix network / VPN)? `?fresh=1` re-checks now.
  [/^\/api\/connectivity$/, async (_m, q) => checkConnectivity({ fresh: q.get('fresh') === '1' })],
  [/^\/api\/skills$/, async (_m, q) => listSkills({ days: Number(q.get('days') || 30) })],
  [/^\/api\/runs$/, async (_m, q) => {
    const skill = q.get('skill');
    if (!skill) throw Object.assign(new Error('skill is required'), { status: 400 });
    return listRuns({ skill, days: Number(q.get('days') || 7) });
  }],
  // Progressive loading: the index says which days have runs, then each day loads on its own.
  [/^\/api\/runs-index$/, async (_m, q) => runsIndex({ skill: required(q, 'skill'), days: Number(q.get('days') || 7) })],
  [/^\/api\/runs-day$/, async (_m, q) => {
    const day = required(q, 'day');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Object.assign(new Error('day must be YYYY-MM-DD'), { status: 400 });
    const skill = required(q, 'skill');
    return runsForDay({ skill, family: await resolveFamily(skill, q.get('fam')), day, sessions: Number(q.get('n') || 0) });
  }],
  // The Exact composition as an mp4 (runs with no render): status, `?start=1` renders it.
  [/^\/api\/exact\/([\w-]{36})$/, async ([, id], q) => (q.get('start') === '1' ? startExact(getIndexedRun(id) || { id }) : exactStatus(id))],
  // One run's list row, if this proxy has served it (reports opened from a link).
  [/^\/api\/run\/([\w-]{36})$/, async ([, id]) => getIndexedRun(id) || Promise.reject(Object.assign(new Error('run not indexed'), { status: 404 }))],
  // A skill's family (the helpers counted with it) and why each is in it.
  [/^\/api\/family$/, async (_m, q) => familyFor(required(q, 'skill'))],
  // User mode: every session one user ran in the window, any skill.
  [/^\/api\/resolve-user$/, async (_m, q) => resolveUser(q.get('q'))],
  [/^\/api\/user-runs$/, async (_m, q) => listUserRuns({ userId: required(q, 'user'), days: Number(q.get('days') || 30) })],
  [/^\/api\/session\/([\w-]{36})$/, async ([, id], q) => {
    const bundle = await getSessionBundle(id, { fresh: q.get('fresh') === '1' });
    rememberUser(bundle.meta).catch(() => {});
    if (q.get('raw') === '1') return bundle;
    const rec = normalizeSession(bundle);
    // With a skill: which turns count for it (the rest are other skills' work).
    const skill = q.get('skill');
    if (skill) rec.scope = turnOwnership(rec, skill, await resolveFamily(skill, q.get('fam')));
    return rec;
  }],
  [/^\/api\/trace\/([\w-]{36})$/, async ([, wid], q) => getGenerationTrace(wid, { fresh: q.get('fresh') === '1' })],
  [/^\/api\/media\/([\w-]{36})$/, async ([, id], q) => mediaStatus(getIndexedRun(id) || { id }, { priority: q.get('priority') === '1', retry: q.get('retry') === '1' })],
  [/^\/api\/player-input\/([\w-]{36})$/, async ([, id], q) => playerInput(id, q.get('root'))],
  // Same-origin bundle-server pass-through for the live player (bundleServerBaseUrl: '').
  [/^\/_api\/wixel-viewer-bundle-server\/bundles$/, async (_m, _q, url) => bundleList(url.search)],
  // Status for the cards on screen; queues builds for any that have none (in the order given,
  // so the client lists what's most visible first).
  [/^\/api\/media-batch$/, async (_m, q) => {
    const ids = (q.get('ids') || '').split(',').filter((id) => /^[\w-]{36}$/.test(id)).slice(0, 80);
    const out = {};
    for (const id of ids) out[id] = await mediaStatus(getIndexedRun(id) || { id });
    return out;
  }],
  [/^\/api\/media-queue$/, async () => queueDepth()],
  [/^\/api\/load$/, async () => ({ ...loadReport(), media: queueDepth(), cache: cacheReport(), net: connectivity() })],
  // Failed generations: tool result has only a jobId; `at` is the tool call's start (ms).
  [/^\/api\/trace-job\/([\w-]{36})$/, async ([, jobId], q) => getJobTrace(jobId, Number(q.get('at')))],
];

async function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(WEB, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(WEB)) return send(req, res, 403, { error: 'forbidden' });
  try {
    send(req, res, 200, await fs.readFile(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(req, res, 404, { error: 'not found' });
  }
}

// Media files need Range support: the <video> element seeks by requesting byte ranges.
async function serveMedia(req, res, id, name) {
  const file = mediaFile(id, name);
  const stat = file && (await fs.stat(file).catch(() => null));
  if (!stat) return send(req, res, 404, { error: 'not ready' });
  const type = name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
  res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
  createReadStream(file, { start, end }).pipe(res);
}

// Save-to-disk: the exact render streamed through (a cross-origin link can't force a download),
// else the review copy, with a readable filename.
async function serveDownload(req, res, id, name, which) {
  const src = which === 'exact'
    ? ((await exactStatus(id)).state === 'ready' ? { kind: 'exact', file: exactFile(id) } : null)
    : await downloadSource(id, which);
  if (!src) return send(req, res, 404, { error: 'video not ready yet' });
  const base = String(name || id).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || id;
  const headers = { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="${base}.mp4"`, 'cache-control': 'no-store' };
  if (src.url) {
    const up = await fetch(src.url, { signal: AbortSignal.timeout(120000) }).catch(() => null);
    if (up?.ok && up.body) {
      const len = up.headers.get('content-length');
      res.writeHead(200, len ? { ...headers, 'content-length': len } : headers);
      return Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
    }
    // Render link gone or unreachable: fall back to the review copy rather than failing.
  }
  const file = src.file || mediaFile(id, 'review.mp4');
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return send(req, res, 404, { error: 'video not ready yet' });
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  createReadStream(file).pipe(res);
}

// Non-video outputs: the user's exact download, the original image, or a PDF of page previews.
async function serveAssetDownload(req, res, runId, assetId, name) {
  try {
    const src = await assetSource(runId, assetId);
    if (src.kind === 'video') return serveDownload(req, res, runId, name);
    const base = String(name || assetId).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || assetId;
    const head = (ext, type, extra = {}) => ({ 'content-type': type, 'content-disposition': `attachment; filename="${base}.${ext}"`, 'cache-control': 'no-store', 'x-autopsy-source': src.label, ...extra });
    if (src.kind === 'pdf') {
      const pdf = await pagesPdf(src.pages);
      res.writeHead(200, head('pdf', 'application/pdf', { 'content-length': pdf.buf.length }));
      return res.end(pdf.buf);
    }
    if (src.kind === 'image') {
      const jpg = await imageAsJpeg(src.url);
      res.writeHead(200, head('jpg', 'image/jpeg', { 'content-length': jpg.length }));
      return res.end(jpg);
    }
    const up = await fetch(src.url, { signal: AbortSignal.timeout(120000) });
    if (!up.ok || !up.body) return send(req, res, 502, { error: `source ${up.status}` });
    const len = up.headers.get('content-length');
    res.writeHead(200, head(src.ext, up.headers.get('content-type') || 'application/octet-stream', len ? { 'content-length': len } : {}));
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    if (!res.headersSent) send(req, res, err.status || 500, { error: String(err.message || err) });
  }
}

// A report as a PDF download (no print dialog): headless Chrome renders this app's own report view
// for the given view (#v=… hash). `kind`: run | insights; `name`: the file name.
async function serveReportPdf(req, res, q) {
  const kind = q.get('kind');
  const view = q.get('view') || '';
  if (!['run', 'insights'].includes(kind) || !view.startsWith('#v=') || view.length > 12000) return send(req, res, 400, { error: 'bad report request' });
  try {
    const { buf } = await renderPdf(`http://127.0.0.1:${config.port}/?report=${kind}${view}`);
    const name = `${String(q.get('name') || `autopsy ${kind} report`).replace(/[\/:*?"<>|\r\n]+/g, '-').slice(0, 180)}.pdf`;
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': buf.length, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}` });
    res.end(buf);
  } catch (err) {
    console.error(`report pdf failed: ${err.message}`);
    send(req, res, err.status || 500, { error: String(err.message || err) });
  }
}

// A still from a clip (for printed reports): ffmpeg reads 0.5s in from the CDN; cached per URL.
async function serveFrame(req, res, src) {
  try {
    const buf = await clipFrame(src);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'public, max-age=86400' });
    res.end(buf);
  } catch (err) {
    send(req, res, err.status || 502, { error: String(err.message || err) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // The platform font stylesheets the players load first (vendored by build-player.sh).
  if (url.pathname === '/player/fonts.json') {
    return fs.readFile(path.join(config.cacheDir, 'vendor', 'fonts.json')).then(
      (buf) => send(req, res, 200, buf, 'application/json; charset=utf-8'),
      () => send(req, res, 200, '[]', 'application/json; charset=utf-8'),
    );
  }
  if (url.pathname === '/player/capture-bootstrap.js') {
    return fs.readFile(path.join(config.cacheDir, 'vendor', 'capture-bootstrap.js')).then(
      (buf) => send(req, res, 200, buf, 'text/javascript; charset=utf-8'),
      () => send(req, res, 503, { error: 'Capture bundle not built. Run npm run build:player.' }),
    );
  }
  if (url.pathname === '/player/iframe-bootstrap.js') {
    return playerScript().then(
      (buf) => send(req, res, 200, buf, 'text/javascript; charset=utf-8'),
      () => send(req, res, 503, { error: 'Live player not built. Run npm run build:player.' }),
    );
  }
  const mm = url.pathname.match(/^\/media\/([\w-]{36})\/([\w.]+)$/);
  if (mm) return serveMedia(req, res, mm[1], mm[2]);
  const dm = url.pathname.match(/^\/download\/([\w-]{36})$/);
  if (dm) return serveDownload(req, res, dm[1], url.searchParams.get('name'), url.searchParams.get('src'));
  if (url.pathname === '/api/frame') return serveFrame(req, res, url.searchParams.get('url'));
  if (url.pathname === '/api/report.pdf') return serveReportPdf(req, res, url.searchParams);
  const am = url.pathname.match(/^\/download-asset\/([\w-]{36})\/([\w-]{36})$/);
  if (am) return serveAssetDownload(req, res, am[1], am[2], url.searchParams.get('name'));
  const t0 = Date.now();
  for (const [re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    // The browser dropping the request (skill switched, tab closed) cancels its queued work.
    const ac = new AbortController();
    res.on('close', () => !res.writableEnded && ac.abort());
    try {
      const body = await requestContext.run({ signal: ac.signal }, () => handler(m, url.searchParams, url));
      if (!ac.signal.aborted) send(req, res, 200, body);
    } catch (err) {
      if (err?.name === 'AbortError' || ac.signal.aborted) {
        if (!QUIET.test(url.pathname)) console.log(`${req.method} ${url.pathname}${url.search} cancelled after ${Date.now() - t0}ms`);
        return;
      }
      const msg = String(err?.message || err).replace(/eyJ[\w.-]{20,}/g, '<redacted>');
      console.error(`${url.pathname} failed: ${msg}`);
      send(req, res, err.status || 502, { error: msg });
    }
    // Polling endpoints are only logged when slow; everything else always.
    const ms = Date.now() - t0;
    if (!QUIET.test(url.pathname) || ms > 1000) console.log(`${req.method} ${url.pathname}${url.search} ${ms}ms`);
    return;
  }
  serveStatic(req, res, url.pathname);
});

// Local only: this proxy holds a production Temporal key.
// Starting the app replaces any copy already running, then (with --open) opens the browser.
try {
  await takeOver(config.port);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
server.listen(config.port, '127.0.0.1', () => {
  claim();
  startSweeping();
  startConnectivityChecks();
  const url = `http://localhost:${config.port}`;
  console.log(`autopsy on ${url} (pid ${process.pid})`);
  if (process.argv.includes('--open')) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});
