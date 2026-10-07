// The Autopsy HTTP app: routes, static files, media. server.js runs it locally; serverless/ hosts it.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { getSessionBundle } from './admin.js';
import { normalizeSession, turnOwnership, detailTimeSplit } from './normalize.js';
import { getGenerationTrace, getJobTrace } from './temporal.js';
import { listRuns, listSkills, getIndexedRun, runsIndex, runsForDay, familyFor, resolveFamily, listUserRuns } from './runs.js';
import { rememberUser, resolveUser } from './users.js';
import { assetSource, pagesPdf, imageAsJpeg } from './asset-download.js';
import { renderPdf, chromePath } from './pdf.js';
import { startExact, exactStatus, exactFile } from './exact.js';
import { checkConnectivity, connectivity } from './connectivity.js';
import { mediaStatus, mediaFile, queueDepth, downloadSource, clipFrame, forgetMedia } from './media.js';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { playerInput, bundleList, playerScript } from './player.js';
import { loadReport } from './limits.js';
import { requestContext } from './context.js';
import { cacheReport } from './cache-gc.js';
import { spawnSync } from 'node:child_process';
import { fleetView, fleetIssue, backfillStatus, requestDays, periodDays, readDay } from './fleet.js';
import { buildBrief, updateState, readState, startDraft, draftStatus, claudeAvailable } from './fleet-brief.js';
import { codexSummary } from './codex.js';
import { skillFix, askClaude, skillClaudeStatus } from './fleet-skillfix.js';
import { existsSync, readFileSync } from 'node:fs';
import { prices } from './prices.js';
import { snapshotInfo } from './snapshot.js';

const WEB = path.join(config.root, 'web');
const QUIET = /^\/api\/(load|media-batch|media-queue|health|exact\/[\w-]{36}|fleet\/status|fleet\/draft\/\w+|fleet\/skillfix\/\w+(\/claude)?)$/;
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

function bundleHas(file, marker) {
  try {
    return readFileSync(path.join(config.cacheDir, 'vendor', file), 'utf8').includes(marker);
  } catch {
    return false;
  }
}

let caps;
function capabilities() {
  caps ??= {
    temporalKey: Boolean(config.temporal.apiKey),
    ffmpeg: spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0,
    player: existsSync(path.join(config.cacheDir, 'vendor', 'iframe-bootstrap.js')),
    pdf: Boolean(chromePath()), // reports download straight to a PDF (else the print dialog)
    exact: Boolean(chromePath()) && existsSync(path.join(config.cacheDir, 'vendor', 'capture-bootstrap.js')), // Exact composition → mp4
    // The run view's Exact player, preloaded while the regular copy plays (a capture bundle built
    // after it gained AutopsyLive; older builds keep the manual Exact toggle).
    live: bundleHas('capture-bootstrap.js', 'AutopsyLive'),
  };
  return caps;
}

function fleetParams(q) {
  const aud = ['real', 'all', 'internal'].includes(q.get('aud')) ? q.get('aud') : 'real';
  const end = /^\d{4}-\d{2}-\d{2}$/.test(q.get('end') || '') ? q.get('end') : undefined;
  return { days: Number(q.get('days') || 7), end, today: q.get('today') === '1', aud, compare: q.get('compare') !== '0' };
}

// JSON bodies only, and only from this app's own pages: a cross-site form post (text/plain, no
// preflight) must not be able to edit the shared Fleet state or start Claude runs.
const sameOrigin = (origin, req) => {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};
async function readBody(req) {
  const origin = req.headers.origin;
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON body required'), { status: 415 });
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !sameOrigin(origin, req)) throw Object.assign(new Error('cross-site request refused'), { status: 403 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100000) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw Object.assign(new Error('bad JSON'), { status: 400 });
  }
}

function required(q, key) {
  const v = q.get(key);
  if (!v) throw Object.assign(new Error(`${key} is required`), { status: 400 });
  return v;
}

const routes = [
  // What this install can do; the UI switches optional features off (with a hint) when missing.
  // `snapshot`: this copy reads the daily build (time windows end at its last day), else null.
  [/^\/api\/health$/, async () => ({ ok: true, ...capabilities(), snapshot: await snapshotInfo(), adminUi: config.adminUi, temporalUi: config.temporal.uiBase, cache: cacheReport(), net: await checkConnectivity() })],
  // Can we reach bo.wix.com (Wix network / VPN)? `?fresh=1` re-checks now.
  [/^\/api\/connectivity$/, async (_m, q) => checkConnectivity({ fresh: q.get('fresh') === '1' })],
  [/^\/api\/skills$/, async (_m, q) => listSkills({ days: Number(q.get('days') || 30) })],
  // What each model's calls cost: the product's price list per Genix graph, image costs per model.
  [/^\/api\/prices$/, async () => prices()],
  [/^\/api\/runs$/, async (_m, q) => {
    const skill = q.get('skill');
    if (!skill) throw Object.assign(new Error('skill is required'), { status: 400 });
    return listRuns({ skill, days: Number(q.get('days') || 7) });
  }],
  // Progressive loading: the index says which days have runs, then each day loads on its own.
  [/^\/api\/runs-index$/, async (_m, q) => runsIndex({ skill: required(q, 'skill'), days: Number(q.get('days') || 7), fresh: q.get('fresh') === '1' })],
  [/^\/api\/runs-day$/, async (_m, q) => {
    const day = required(q, 'day');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Object.assign(new Error('day must be YYYY-MM-DD'), { status: 400 });
    const skill = required(q, 'skill');
    const since = Number(q.get('since')) || null;
    return runsForDay({ skill, family: await resolveFamily(skill, q.get('fam')), day, sessions: Number(q.get('n') || 0), fresh: q.get('fresh') === '1', since });
  }],
  // The Exact composition as an mp4 (runs with no render): status, `?start=1` renders it.
  // `cc=1`: with captions (the viewer turned them on); otherwise only if a person turned them on.
  [/^\/api\/exact\/([\w-]{36})$/, async ([, id], q) => (q.get('start') === '1' ? startExact(getIndexedRun(id) || { id }, { cc: q.get('cc') === '1' }) : exactStatus(id, { cc: q.get('cc') === '1' }))],
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
    // The root shown is the run's own output (from the list row) when this proxy has listed it.
    const row = getIndexedRun(id);
    const rec = normalizeSession(bundle, { rootId: row?.videoAssetId || row?.adAssetId || undefined });
    // With a skill: which turns count for it (the rest are other skills' work).
    const skill = q.get('skill');
    // A skill missing from the daily build: show the whole session rather than fail.
    const family = skill ? await resolveFamily(skill, q.get('fam')).catch((err) => (config.snapshot ? undefined : Promise.reject(err))) : undefined;
    if (skill && family !== undefined) rec.scope = turnOwnership(rec, skill, family);
    rec.timeSplit = detailTimeSplit(rec);
    return rec;
  }],
  [/^\/api\/trace\/([\w-]{36})$/, async ([, wid], q) => getGenerationTrace(wid, { fresh: q.get('fresh') === '1' })],
  [/^\/api\/media\/([\w-]{36})$/, async ([, id], q) => mediaStatus(getIndexedRun(id) || { id }, { priority: q.get('priority') === '1', retry: q.get('retry') === '1' })],
  [/^\/api\/player-input\/([\w-]{36})$/, async ([, id], q) => playerInput(id, q.get('root'), { captions: q.get('captions') === '1' ? true : q.get('captions') === '0' ? false : 'user' })],
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
  // Refresh: rebuild these runs' review copies (and exact mp4s) next time they're looked at.
  [/^\/api\/media-refresh$/, async (_m, _q, _u, req) => {
    if (req.method !== 'POST') throw Object.assign(new Error('POST only'), { status: 405 });
    const { ids } = await readBody(req);
    return forgetMedia(Array.isArray(ids) ? ids.slice(0, 2000) : []);
  }],
  [/^\/api\/load$/, async () => ({ ...loadReport(), media: queueDepth(), cache: cacheReport(), net: connectivity() })],
  // ---- Fleet: every major skill at once (daily rollups; see server/fleet.js) ----
  [/^\/api\/fleet$/, async (_m, q) => fleetView(fleetParams(q))],
  [/^\/api\/fleet\/status$/, async (_m, q) => {
    const days = periodDays(q.get('today') === '1' ? { today: true } : { days: Number(q.get('days') || 30) });
    const files = await Promise.all(days.map(readDay));
    return { ...backfillStatus(), days: days.map((d, i) => ({ day: d, present: Boolean(files[i]), final: files[i]?.final || false, builtAt: files[i]?.builtAt || null, parts: files[i]?.parts || null })), codex: await codexSummary(), claude: claudeAvailable() };
  }],
  // Queue days for building (newest first, background lane). Also done automatically by /api/fleet.
  [/^\/api\/fleet\/build$/, async (_m, q) => {
    requestDays(periodDays({ days: Number(q.get('days') || 30) }));
    return backfillStatus();
  }],
  [/^\/api\/fleet\/brief\/(\w+)$/, async ([, key], q) => {
    const { issue, period, aud } = await fleetIssue(key, fleetParams(q));
    return buildBrief({ ...issue, audLabel: aud === 'real' ? 'real users' : aud === 'internal' ? 'employees and team' : 'everyone' }, { period, withTraces: q.get('traces') !== '0' });
  }],
  // Fix per skill: what to change in one skill's instructions for one issue (+ a Claude Code prompt).
  [/^\/api\/fleet\/skillfix\/(\w+)$/, async ([, key], q) => {
    const { issue, period } = await fleetIssue(key, fleetParams(q));
    return skillFix(issue, required(q, 'skill'), { period });
  }],
  // Ask Claude for that suggestion (local CLI, read-only); stored in FLEET_DIR/suggestions when done.
  [/^\/api\/fleet\/skillfix\/(\w+)\/claude$/, async ([, key], q, _u, req) => {
    // GET: how the run is going (and the stored answer once it's in).
    if (req.method !== 'POST') return skillClaudeStatus(key, required(q, 'skill'));
    await readBody(req);
    if (!claudeAvailable()) throw Object.assign(new Error('The claude CLI is not installed'), { status: 501 });
    const { issue, period } = await fleetIssue(key, fleetParams(q));
    const fix = await skillFix(issue, required(q, 'skill'), { period });
    if (fix.parked) throw Object.assign(new Error(fix.reason), { status: 400 });
    const d = askClaude(issue, fix.skill, fix.prompt);
    return { state: (await d).state };
  }],
  [/^\/api\/fleet\/state$/, async (_m, q, _u, req) => (req.method === 'POST' ? updateState(await readBody(req)) : readState())],
  // Draft a fix with the local Claude CLI (read-only tools, in the codex checkout). POST starts it.
  [/^\/api\/fleet\/draft\/(\w+)$/, async ([, key], q, _u, req) => {
    if (req.method !== 'POST') return draftStatus(key);
    if (!claudeAvailable()) throw Object.assign(new Error('The claude CLI is not installed'), { status: 501 });
    const { markdown } = await readBody(req);
    if (!markdown || markdown.length > 60000) throw Object.assign(new Error('brief required'), { status: 400 });
    return startDraft(key, markdown);
  }],
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
async function serveDownload(req, res, id, name, which, cc = false) {
  const src = which === 'exact'
    ? ((await exactStatus(id, { cc })).state === 'ready' ? { kind: 'exact', file: exactFile(id, { cc }) } : null)
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
  const okView = kind === 'fleet' ? view.startsWith('#f=') : view.startsWith('#v=');
  if (!['run', 'insights', 'fleet'].includes(kind) || !okView || view.length > 12000) return send(req, res, 400, { error: 'bad report request' });
  try {
    // The Fleet digest may wait for days still building (up to 4 minutes).
    const page = kind === 'fleet' ? `/fleet.html?report=fleet${view}` : `/?report=${kind}${view}`;
    const { buf } = await renderPdf(`http://127.0.0.1:${config.port}${page}`, kind === 'fleet' ? { timeoutMs: 300000 } : undefined);
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

// Every request: player assets, media, downloads, reports, then the API routes, then static files.
// Shared by the local server (server.js) and a hosted entry point (serverless/).
export async function handle(req, res) {
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
  if (dm) return serveDownload(req, res, dm[1], url.searchParams.get('name'), url.searchParams.get('src'), url.searchParams.get('cc') === '1');
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
      const body = await requestContext.run({ signal: ac.signal }, () => handler(m, url.searchParams, url, req));
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
}
