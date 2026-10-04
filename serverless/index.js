// Autopsy's shared copy as a Wix Serverless app. Every page and API call goes through the same
// handler the local server uses (server/app.js), behind back-office sign-in, reading the daily build
// from cloudStore (AUTOPSY_SNAPSHOT: never Trino). Run details, graph runs and review videos are
// fetched on demand as they are locally.
//
// cloudStore may only be read from the current request's context (Access Guard), so each call is
// handed the request's store through AsyncLocalStorage, and the handler runs inside the request
// rather than behind an in-process HTTP server.
//
// The daily build (server/build.js) runs here too: a cron job at 03:30 starts it, and a chain of
// Time Capsule tasks works through the skills one at a time, each run stopping after ~10 minutes and
// scheduling the next (scheduled jobs mustn't run for hours). Final and freshly built days are
// skipped, so a chain that dies is picked up by the next one. Admins can see and start it at /_build.
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FullHttpResponse } from '@wix/serverless-api';

const current = new AsyncLocalStorage();
let handle = null;
let lib = null; // server modules, imported once the environment is set (whenStarted)

const BUILD_TASK = 'autopsy.build';
const STEP_MS = 10 * 60000;
const RUN_KEY = 'build/run.json';
const json = (status, body) => new FullHttpResponse({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---- the daily build as a task chain ----
async function startBuild(ctx, { days, skills: only = [], minSessions } = {}) {
  const { build, snapshot } = lib;
  const win = build.buildWindow(days || Number(ctx.getConfig('build-days')) || 30);
  const skills = await build.produce(() => build.skillsToBuild({ minSessions: minSessions ?? (Number(ctx.getConfig('build-min-sessions')) || 10), only }));
  const run = { win, only, skills: skills.map(({ skill, sessions, last_at }) => ({ skill, sessions, last_at })), next: 0, done: [], step: 0, startedAt: Date.now(), by: ctx.boUser?.email || 'cron' };
  await snapshot.writeJsonAtomic(RUN_KEY, run);
  await ctx.timeCapsule2.scheduler(BUILD_TASK).schedule(`${win.through}-${run.startedAt}-0`, new Date(Date.now() + 5000), { startedAt: run.startedAt });
  return run;
}

// One link of the chain: skills in order until ~10 minutes are up, then the next link.
async function buildStep(ctx, task) {
  const { build, snapshot } = lib;
  const run = await snapshot.readJson(RUN_KEY);
  // A newer build replaced this chain.
  if (!run || run.startedAt !== task.payload.startedAt || run.finishedAt) return;
  const deadline = Date.now() + STEP_MS;
  await build.produce(async () => {
    while (run.next < run.skills.length && Date.now() < deadline) {
      const s = run.skills[run.next];
      try {
        const r = await build.buildSkill(s.skill, run.win, { deadline, log: (m) => ctx.logger.info(m) });
        if (!r.done) break;
        run.done.push(s);
      } catch (err) {
        ctx.logger.error(`build ${s.skill}: ${err.message}`);
        if (await snapshot.readJson(snapshot.files.skillIndex(s.skill))) run.done.push(s);
      }
      run.next++;
      await build.publish(run.win, { done: run.done, finished: false, only: run.only, startedAt: run.startedAt });
    }
    if (run.next >= run.skills.length) {
      await build.publish(run.win, { done: run.done, finished: true, only: run.only, startedAt: run.startedAt });
      run.finishedAt = Date.now();
    }
  });
  run.step++;
  run.lastStepAt = Date.now();
  await snapshot.writeJsonAtomic(RUN_KEY, run);
  if (!run.finishedAt) await ctx.timeCapsule2.scheduler(BUILD_TASK).schedule(`${run.win.through}-${run.startedAt}-${run.step}`, new Date(Date.now() + 30000), { startedAt: run.startedAt });
}

// The nightly build runs only where it's switched on (build-enabled config = true): a dev server
// fires crons as it starts, and a copy that isn't the producer must never query Trino by itself.
const buildEnabled = (ctx) => ctx.getConfig('build-enabled') === 'true' || process.env.AUTOPSY_BUILD_ENABLED === '1';

// Who may start a build: the emails in the build-admins config (comma list).
const isAdmin = (ctx) => {
  const email = ctx.boUser?.email?.toLowerCase();
  const admins = (ctx.getConfig('build-admins') || process.env.AUTOPSY_BUILD_ADMINS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  return Boolean(email && admins.includes(email));
};

// A Node-style response the app can write to (writeHead / end / pipe); the head resolves as soon as
// the status is known, and the body streams out as it's written.
class Response extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.head = new Promise((resolve) => {
      this.sendHead = resolve;
    });
  }
  setHeader(k, v) {
    this.headers[k.toLowerCase()] = v;
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    this.headersSent = true;
    this.sendHead();
    return this;
  }
  write(...args) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    return super.write(...args);
  }
  end(...args) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    return super.end(...args);
  }
}

function requestBody(req) {
  if (req.rawBody?.buffer) return [req.rawBody.buffer];
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return [Buffer.from(JSON.stringify(req.body))];
  if (typeof req.body === 'string' && req.body) return [Buffer.from(req.body)];
  return [];
}

async function serve(ctx, req) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) for (const x of [].concat(v)) query.append(k, String(x));
  const nodeReq = Readable.from(requestBody(req));
  const headers = Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  Object.assign(nodeReq, { method: req.method, url: `${req.path || '/'}${query.size ? `?${query}` : ''}`, headers });
  const res = new Response();
  current.run(ctx, () => handle(nodeReq, res)).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  });
  await res.head;
  return new FullHttpResponse({ status: res.statusCode, headers: res.headers, body: res });
}

// Paths are matched by segment count (the app's deepest is /api/fleet/skillfix/:issue/claude).
const PATHS = ['/', ...Array.from({ length: 6 }, (_, n) => `/${Array.from({ length: n + 1 }, (_x, i) => `:p${i}`).join('/')}`)];

export default function builder(b) {
  let app = b
    // Staff only: the app shows what the Wixel admin page shows, including end users' prompts.
    .withWebSecurityOptions({ boAuth: { redirect: true } })
    .whenStarted(async (ctx) => {
      process.env.AUTOPSY_SNAPSHOT = '1';
      process.env.CACHE_DIR ||= path.join(os.tmpdir(), 'autopsy-cache');
      const key = ctx.getConfig('temporal-api-key');
      if (key && !process.env.TEMPORAL_API_KEY) process.env.TEMPORAL_API_KEY = key;
      // Imported now: config.js reads the environment above when it loads.
      const [snapshot, { kvStore }, cache, build, limits, appModule] = await Promise.all(['../server/snapshot.js', '../server/store.js', '../server/cache.js', '../server/build.js', '../server/limits.js', '../server/app.js'].map((m) => import(m)));
      const store = kvStore(() => current.getStore().cloudStore.keyValueStore);
      snapshot.useStore(store);
      // Slow lookups (employees, families, the email index) shared by every instance.
      cache.useSharedCache(store, ['meta']);
      // One build at a time on a shared cluster (it hit QUERY_QUEUE_FULL at 4).
      limits.setConcurrency('trino', 2);
      lib = { snapshot, build };
      handle = appModule.handle;
    })
    .addCronFunction('autopsy-daily-build', '30 3 * * *', (ctx) => current.run(ctx, async () => {
      if (buildEnabled(ctx)) await startBuild(ctx);
    }))
    .withTimeCapsule2(BUILD_TASK, (ctx, task) => current.run(ctx, () => buildStep(ctx, task)), { timeoutInMillis: STEP_MS + 5 * 60000, retries: { intervalsInSeconds: [60, 600] } })
    // The build's progress, and (for build admins) starting one now: { days, skills: [..] }.
    .addWebFunction('GET', '/_build', {}, (ctx) => current.run(ctx, async () => json(200, (await lib.snapshot.readJson(RUN_KEY)) || { none: true })))
    .addWebFunction('POST', '/_build', {}, (ctx, req) => current.run(ctx, async () => {
      if (!isAdmin(ctx)) return json(403, { error: 'Only build admins (build-admins config) can start a build' });
      return json(200, await startBuild(ctx, req.body || {}));
    }));
  for (const method of ['GET', 'POST']) for (const p of PATHS) app = app.addWebFunction(method, p, { timeoutMillis: 30000 }, (ctx, req) => serve(ctx, req));
  return app;
}
