import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { getSessionBundle } from './admin.js';
import { normalizeSession } from './normalize.js';
import { getGenerationTrace, getJobTrace } from './temporal.js';
import { listRuns, listSkills, getIndexedRun, runsIndex, runsForDay } from './runs.js';
import { mediaStatus, mediaFile, queueDepth } from './media.js';
import { createReadStream } from 'node:fs';
import { playerInput, bundleList, playerScript } from './player.js';
import { loadReport } from './limits.js';
import { takeOver, claim } from './singleton.js';
import { requestContext } from './context.js';
import { spawn } from 'node:child_process';

const WEB = path.join(config.root, 'web');
const QUIET = /^\/api\/(load|media-batch|media-queue|health)$/;
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

function required(q, key) {
  const v = q.get(key);
  if (!v) throw Object.assign(new Error(`${key} is required`), { status: 400 });
  return v;
}

const routes = [
  [/^\/api\/health$/, async () => ({ ok: true, temporalKey: Boolean(config.temporal.apiKey), adminUi: config.adminUi, temporalUi: config.temporal.uiBase })],
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
    return runsForDay({ skill: required(q, 'skill'), day, sessions: Number(q.get('n') || 0) });
  }],
  [/^\/api\/session\/([\w-]{36})$/, async ([, id], q) => {
    const bundle = await getSessionBundle(id, { fresh: q.get('fresh') === '1' });
    return q.get('raw') === '1' ? bundle : normalizeSession(bundle);
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
  [/^\/api\/load$/, async () => ({ ...loadReport(), media: queueDepth() })],
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/player/iframe-bootstrap.js') {
    return playerScript().then(
      (buf) => send(req, res, 200, buf, 'text/javascript; charset=utf-8'),
      () => send(req, res, 503, { error: 'Live player not built. Run npm run build:player.' }),
    );
  }
  const mm = url.pathname.match(/^\/media\/([\w-]{36})\/([\w.]+)$/);
  if (mm) return serveMedia(req, res, mm[1], mm[2]);
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
  const url = `http://localhost:${config.port}`;
  console.log(`skill-run-explorer on ${url} (pid ${process.pid})`);
  if (process.argv.includes('--open')) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});
