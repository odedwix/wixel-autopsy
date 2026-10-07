import crypto from 'node:crypto';
import { sql, getJson } from './admin.js';
import { config } from './config.js';
import { limited } from './limits.js';
import { cached, readCache, writeCache, readStale } from './cache.js';
import { splitTime } from './time-split.js';
import { inBackground } from './context.js';
import { RUNS_QUERY_VERSION, STEPS_QUERY_VERSION, runsDayQuery, eventsDayQuery, stepsDayQuery, skillsQuery, runsIndexQuery, lastSeenQuery, skillPairsQuery } from './queries.js';
import { ownedAssetIds, writePath, jobTypes } from './own-assets.js';

const DAY = 86400000;
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

// ---- session attributes (agent, title, source, cost) for one day's rows ----
// IN (...) lists are chunked: the SQL endpoint rejects statements over 64KB (~1,400 ids).
const chunks = (arr, n = 1000) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// `skipDim`: the dimension table lags about a day, so for a top-up of the last day it has nothing yet.
async function sessionAttrs(ids, day, { skipDim = false } = {}) {
  if (!ids.length) return new Map();
  if (ids.length > 1000) {
    const parts = await Promise.all(chunks(ids).map((c) => sessionAttrs(c, day, { skipDim })));
    return new Map(parts.flatMap((m) => [...m]));
  }
  const list = ids.map(lit).join(',');
  // Results over 500 rows come back a page at a time and each page re-runs the query, so every
  // query here orders by a unique key: otherwise pages can repeat rows and miss others.
  const [dim, crud] = await Promise.all([
    skipDim ? [] : sql(`SELECT session_id, agent_name, subject, session_source, caller_name, device_type, total_cost_usd, credits_charged_usd
         FROM prod.wixel.agent_session_dim WHERE session_id IN (${list}) ORDER BY session_id`),
    // The dim table lags; the CRUD stream covers today's sessions.
    sql(`SELECT id, max_by(agent_name, revision) AS agent_name, max_by(subject, revision) AS subject, max_by(project_id, revision) AS project_id,
           max_by(session_type, revision) AS session_type, max_by(parent_session_id, revision) AS parent_session_id
         FROM domain_events.www_wixel_agent.v1_session_crud
         WHERE id IN (${list}) AND created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY GROUP BY id ORDER BY id`),
  ]);
  const m = new Map();
  // A sub-agent session (session_type SUB, with a parent): campaigns making several assets at once.
  for (const r of crud) m.set(r.id, { agent_name: r.agent_name, title: r.subject, project_id: r.project_id, source: /SUB/i.test(r.session_type || '') ? 'sub-agent' : undefined, parent_session_id: r.parent_session_id || null });
  for (const r of dim) {
    m.set(r.session_id, {
      ...m.get(r.session_id),
      agent_name: r.agent_name || m.get(r.session_id)?.agent_name,
      title: r.subject || m.get(r.session_id)?.title,
      source: r.session_source || m.get(r.session_id)?.source,
      caller_name: r.caller_name,
      device_type: r.device_type,
      total_cost_usd: r.total_cost_usd,
      credits_charged_usd: r.credits_charged_usd,
    });
  }
  return m;
}

// ---- project signals: output thumbnails, UI downloads, publishes ----
// Top-level assets of each project (any type: video, image, logo, doc, slides…), with the vizion
// report's download (users_193 evid 19) and publish (asset published_info) logic. A run's outputs
// are picked from these by the asset ids its session events say it wrote.
async function projectSignals(projectIds, day) {
  if (!projectIds.length) return new Map();
  if (projectIds.length > 1000) {
    const parts = await Promise.all(chunks(projectIds).map((c) => projectSignals(c, day)));
    return new Map(parts.flatMap((m) => [...m]));
  }
  const list = projectIds.map(lit).join(',');
  const since = `TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY`;
  const [assets, downloads] = await Promise.all([
    sql(`SELECT project_id, id AS asset_id,
           max_by(name, _event_time) AS name,
           max_by(type, _event_time) AS type,
           max_by(updated_date, _event_time) AS updated,
           min(created_date) AS created,
           max_by(thumbnail_url, _event_time) FILTER (WHERE thumbnail_url IS NOT NULL) AS thumb,
           max_by(published_info.published_asset_link, _event_time) FILTER (WHERE published_info.published_asset_link IS NOT NULL) AS published_url,
           min(_event_time) FILTER (WHERE published_info IS NOT NULL) AS published_at
         FROM domain_events.www_asset.v1_asset_crud
         WHERE parent_id IS NULL AND _event_time >= ${since} AND project_id IN (${list})
         GROUP BY 1, 2 ORDER BY 1, 2`),
    sql(`SELECT project_id, asset_id, count(*) AS n, max(date_created) AS at, max_by(asset_url, date_created) AS url,
           max_by(REGEXP_EXTRACT(additional_info, 'fileType:([^,]+)', 1), date_created) AS file_type
         FROM events.dbo.users_193
         WHERE evid = 19 AND result = 'success' AND date_created >= ${since} AND project_id IN (${list})
         GROUP BY 1, 2 ORDER BY 1, 2`),
  ]);
  const m = new Map();
  const seen = new Set();
  for (const a of assets) {
    if (seen.has(a.asset_id)) continue;
    seen.add(a.asset_id);
    const p = m.get(a.project_id) || { assets: [], downloads: [] };
    p.assets.push(a);
    m.set(a.project_id, p);
  }
  const seenDl = new Set();
  for (const d of downloads) {
    if (seenDl.has(`${d.project_id}/${d.asset_id}`)) continue;
    seenDl.add(`${d.project_id}/${d.asset_id}`);
    const p = m.get(d.project_id) || { assets: [], downloads: [] };
    p.downloads.push(d);
    m.set(d.project_id, p);
  }
  return m;
}

// Pages and scenes a run wrote → the top-level asset they belong to (two levels at most).
async function topLevelOf(ids, day) {
  const out = new Map();
  let todo = [...new Set(ids)];
  for (let level = 0; level < 2 && todo.length; level++) {
    const rows = (await Promise.all(chunks(todo).map((c) => sql(`SELECT id, max_by(parent_id, _event_time) AS parent
      FROM domain_events.www_asset.v1_asset_crud
      WHERE id IN (${c.map(lit).join(',')}) AND _event_time >= TIMESTAMP '${day} 00:00:00' - INTERVAL '7' DAY
      GROUP BY 1 ORDER BY 1`)))).flat();
    const next = [];
    for (const r of rows) {
      if (!r.parent) continue;
      for (const [child, top] of [...out].filter(([, t]) => t === r.id)) out.set(child, r.parent);
      if (!out.has(r.id)) out.set(r.id, r.parent);
      next.push(r.parent);
    }
    todo = next;
  }
  return out;
}

// ---- account → user type ----
// The vizion report's rule: an account missing from prod.wt_accounts.base is a Wix employee;
// the slides/Wixel team list wins over that. The base lookup is a ~20s scan, so results are
// cached per account forever and only new accounts are looked up (500 ids per query: well under the
// 64KB SQL cap, and fast enough to stay under the endpoint's 30s when Trino is busy).
let accountTypes;
let teamSet;
// One lookup at a time: a second caller waits and then finds the accounts already resolved.
let typesChain = Promise.resolve();
let typesBusy = 0;
export function resolveUserTypes(accountIds) {
  typesBusy++;
  const run = typesChain.then(() => lookUpUserTypes(accountIds)).finally(() => typesBusy--);
  typesChain = run.catch(() => {});
  return run;
}
// What's known now, without waiting for new accounts (they resolve in the background).
const knownUserType = (id) => (!id ? 'unknown' : teamSet?.has(id) ? 'wixel-team' : accountTypes?.[id] || 'unknown');
// The grid never waits long for user types, and never fails over them: past `ms`, or when the
// lookup fails, accounts not resolved yet show as unknown until the day is next loaded.
// Behind a lookup that's already running (a slow one takes a minute to fail), it doesn't wait at all.
async function userTypesWithin(accountIds, ms) {
  const busy = typesBusy > 0;
  const work = resolveUserTypes(accountIds).catch(() => null);
  if (busy && accountTypes && teamSet) return knownUserType;
  return (await Promise.race([work, new Promise((r) => setTimeout(() => r(null), ms))])) || knownUserType;
}
// When Trino is busy the base scan times out even for a handful of ids, and each try (retried once)
// costs a minute; after a failure new accounts wait this long before the next try, and show as
// unknown meanwhile.
const TYPES_REST_MS = 2 * 60000;
let typesFailedAt = 0;
async function lookUpUserTypes(accountIds) {
  accountTypes ??= (await readCache('meta', 'account-types', Infinity)) || {};
  teamSet ??= new Set(await cached('meta', 'wixel-team', DAY, async () => ({
    value: (await sql('SELECT DISTINCT account_id FROM sandbox.www.slides_employees_team')).map((r) => r.account_id),
    ttlMs: DAY,
  }), { staleWhileRevalidate: true }));
  const missing = [...new Set(accountIds.filter((id) => id && !(id in accountTypes)))];
  if (missing.length && Date.now() - typesFailedAt < TYPES_REST_MS) throw new Error(`user types: ${missing.length} new accounts wait for Trino (the last lookup timed out)`);
  // Each batch is saved as soon as it's resolved, and retried once on a timeout, so a busy
  // cluster costs at most the batch it was on (the next call picks up from there).
  for (let i = 0; i < missing.length; i += 500) {
    const ids = missing.slice(i, i + 500);
    const [row] = await retryOnce(() => sql(`SELECT array_join(array_agg(t.id), ',') AS missing FROM UNNEST(ARRAY[${ids.map(lit).join(',')}]) AS t(id)
      LEFT JOIN prod.wt_accounts.base b ON b.account_id = t.id WHERE b.account_id IS NULL`)).catch((err) => {
      typesFailedAt = Date.now();
      throw err;
    });
    const employees = new Set((row?.missing || '').split(',').filter(Boolean));
    for (const id of ids) accountTypes[id] = employees.has(id) ? 'employee' : 'real';
    await writeCache('meta', 'account-types', accountTypes, Infinity);
  }
  return (id) => (!id ? 'unknown' : teamSet.has(id) ? 'wixel-team' : accountTypes[id] || 'unknown');
}

// Trino timeouts are often load, not the query; one retry after a pause usually clears them.
async function retryOnce(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!/timed out/.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return fn();
  }
}

// A day too heavy for the endpoint's 30s limit is split into hour windows (halving down to 3h)
// and the parts merged; each session lands in exactly one window.
async function sliced(make, hours = [0, 24]) {
  try {
    return await sql(make(hours));
  } catch (err) {
    if (!/timed out/.test(err.message) || hours[1] - hours[0] <= 3) throw err;
    const mid = Math.floor((hours[0] + hours[1]) / 2);
    const [a, b] = await Promise.all([sliced(make, [hours[0], mid]), sliced(make, [mid, hours[1]])]);
    return [...a, ...b];
  }
}

// ---- one UTC day of runs for a skill ----
// About this many sessions per day are enough for every view and insight; busier days are sampled.
const PER_DAY_TARGET = 400;
const HEX = '0123456789abcdef';
export function sampleFor(sessions) {
  if (!sessions || sessions <= PER_DAY_TARGET * 1.15) return null;
  return HEX.slice(0, Math.max(1, Math.floor((16 * PER_DAY_TARGET) / sessions)));
}

// Cache key part for a scope: the skill + which family counted (or "all" for whole sessions),
// or a user and the exact sessions (a user's day gains sessions while it's recent).
const hash = (x) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 10);
function scopeKey(sc) {
  if (sc.ids) return `user__${sc.user}__${hash([...sc.ids].sort().join(','))}`;
  return `${sc.skill}__${Array.isArray(sc.family) ? `f${hash([...sc.family].sort().join(','))}` : 'all'}${sc.sample ? `__s${sc.sample}` : ''}`;
}

// Session events arrive per turn (id␟turn[␟value…]); keep the ones from counted turns (and
// session-level ones with no turn). Asset evidence from other skills' turns is dropped, so a run
// whose only writes were other skills' work shows no outputs.
function eventFields(e, ownedTurns) {
  const owned = ownedTurns ? new Set(ownedTurns) : null;
  const SEP = String.fromCharCode(31);
  const parse = (list) => (list || []).map((x) => {
    const [id, turn, ...rest] = String(x).split(SEP);
    return { id, turn, value: rest.join(SEP), parts: rest };
  });
  const mine = (list) => parse(list).filter((x) => !owned || !x.turn || owned.has(x.turn));
  return {
    thumbs_up: mine(e.thumbs_up_t).length,
    thumbs_down: mine(e.thumbs_down_t).length,
    feedback_tags: mine(e.feedback_tags_t).map((x) => x.value),
    out_of_funds: mine(e.out_of_funds_t).length,
    stream_errors: mine(e.stream_errors_t).length,
    asset_events: mine(e.asset_events_t).map((x) => x.value),
    asset_writes: mine(e.asset_writes_t).map((x) => ({ ...writePath(x.parts[0]), intent: x.parts[1] || null, type: x.parts[2] || null })),
    asset_mentions: mine(e.asset_mentions_t).map((x) => x.value),
  };
}

// `fresh` (the Refresh button): re-query now instead of serving the cache, even a final day's
// (downloads and publishes keep arriving after a session ends).
const dayFinal = (day) => Date.parse(`${day}T00:00:00Z`) + 3 * DAY < Date.now();
const rowsKey = (scope, day) => `v${RUNS_QUERY_VERSION}__${scopeKey(scope)}__${day}`;
const stepsKey = (scope, day) => `v${STEPS_QUERY_VERSION}__${scopeKey(scope)}__${day}`;

function dayRows(scope, day, { fresh = false } = {}) {
  // A day's rows keep changing while its sessions may still be active (entries are read
  // up to 2 days past the skill load); after that they're final.
  const final = dayFinal(day);
  const key = rowsKey(scope, day);
  return cached('runs-day', key, fresh ? 0 : final ? Infinity : 3 * 60000, async () => {
    // The routine re-check of a recent day (every few minutes while it's looked at) tops up from the
    // newest sessions it already has instead of reading the whole day again; Shift+Refresh (`fresh`)
    // reads it whole.
    const from = fresh ? null : await topUpHour('runs-day', key, day);
    const value = from == null ? await buildDayRows(scope, day) : mergeRows(await readStale('runs-day', key), await buildDayRows(scope, day, [from, 24]));
    return { value, ttlMs: final ? Infinity : 3 * 60000 };
  }, { staleWhileRevalidate: !fresh });
}

// Where a top-up of a cached recent day starts: an hour before the newest session it holds (runs still
// going then may have finished since), on the hour; null = read the whole day.
async function topUpHour(ns, key, day) {
  if (dayFinal(day)) return null;
  const have = await readStale(ns, key);
  if (!have?.length) return null;
  const newest = Math.max(...have.map((r) => tsMs(r.skill_at || r.first_ts) || 0));
  const h = Math.floor((newest - TOP_UP_OVERLAP - Date.parse(`${day}T00:00:00Z`)) / 3600000);
  return h > 0 ? Math.min(23, h) : null;
}
const mergeRows = (have, part) => {
  const ids = new Set(part.map((r) => r.session_id));
  return [...(have || []).filter((r) => !ids.has(r.session_id)), ...part].sort((a, b) => String(a.session_id).localeCompare(String(b.session_id)));
};

// The rows of the sessions that first loaded the skill within `hours` of the day (all of it by default).
async function buildDayRows(scope, day, hours = [0, 24]) {
  const [rows, events] = await Promise.all([
    sliced((h) => runsDayQuery({ scope, day, hours: h }), hours),
    sliced((h) => eventsDayQuery({ scope, day, hours: h }), hours).catch(() => []),
  ]);
  // A top-up (a later hour window of the last day or two) skips the lagging dimension table and
  // doesn't wait for brand-new accounts' user types (looked up in the background).
  const topUpWindow = hours[0] > 0 && Date.parse(`${day}T00:00:00Z`) > Date.now() - 2 * DAY;
  // A failed lookup leaves those accounts unknown; it never fails the day.
  const types = resolveUserTypes(rows.map((r) => r.account_id)).catch(() => null);
  const [attrs] = await Promise.all([
    sessionAttrs(rows.map((r) => r.session_id), day, { skipDim: topUpWindow }),
    // Warm the account cache in parallel; listRuns reads it.
    topUpWindow ? null : types,
  ]);
  const projects = await projectSignals([...new Set([...attrs.values()].map((a) => a.project_id).filter(Boolean))], day);
  // Written ids that aren't top-level assets are pages or scenes: credit their top-level asset.
  const tops = new Set([...projects.values()].flatMap((p) => p.assets.map((a) => a.asset_id)));
  const parts = await topLevelOf(rows.flatMap((r) => r.written_ids || []).filter((id) => !tops.has(id)), day).catch(() => new Map());
  const ev = new Map(events.map((e) => [e.session_id, e]));
  const value = rows.map((r) => {
    const a = attrs.get(r.session_id) || {};
    const written = [...new Set((r.written_ids || []).map((id) => parts.get(id) || id))];
    return { ...r, written_ids: written, ...eventFields(ev.get(r.session_id) || {}, r.owned_turns), ...a, project: projects.get(a.project_id) || null };
  });
  return value;
}

// Refresh, the quick way: query again only the sessions that first loaded the skill from `fromHour`
// on (new ones, and the recent ones that may have finished since), and merge them into the cached
// day. A day with nothing cached yet is loaded whole. Returns the re-queried rows only.
async function topUp(ns, key, ttlMs, build, whole) {
  const have = await readStale(ns, key);
  if (!have) return { all: await whole(), part: null };
  const part = await build();
  const all = mergeRows(have, part);
  await writeCache(ns, key, all, ttlMs);
  return { all, part };
}

const num = (v) => (v == null ? null : Number(v));
const tsMs = (s) => (s ? Date.parse(`${String(s).replace(' ', 'T')}Z`) : null);

// Compact row for the grid. Short keys are not worth the confusion; payload is small anyway.
// Output types, normalized across the asset table (VIDEO, SLIDES…) and session events
// (wixel-asset/video, wixel-asset/slide…).
const TYPE_ALIASES = { slide: 'slides', presentation: 'slides', icon: 'icons' };
const normType = (t) => {
  const x = String(t || '').toLowerCase().replace(/^wixel-asset\//, '');
  return TYPE_ALIASES[x] || x || 'asset';
};

function parseAssetEvents(list) {
  const out = new Map();
  for (const raw of list || []) {
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const a of Array.isArray(arr) ? arr : []) if (a?.id) out.set(a.id, { ...out.get(a.id), ...a });
  }
  return out;
}

// AGENT_MENTIONED_ASSETS payloads: { assetId: '{"name","type","snapshotUrl","isFallback"}' }.
function parseMentions(list) {
  const out = new Map();
  for (const raw of list || []) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const [id, v] of Object.entries(obj || {})) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
      let info = v;
      try {
        info = typeof v === 'string' ? JSON.parse(v) : v;
      } catch {}
      out.set(id, { id, ...(info && typeof info === 'object' ? info : {}) });
    }
  }
  return out;
}

// A run's outputs: the top-level assets its counted turns wrote, or handed over while they ran (see
// own-assets.js). Only the session's own write log counts: assets other sessions made in the same
// project at the same time (a campaign's post and story next to its video) are not this run's.
function outputsOf(r) {
  const started = tsMs(r.first_ts) || 0;
  // When other skills took the session over after the counted turns, the window ends there (other
  // work before the skill was loaded doesn't limit it).
  const handedOver = tsMs(r.whole_last_ts) > tsMs(r.last_ts) + 1000;
  // Otherwise shortly after the last counted turn (the editor saves a moment after the turn ends).
  const until = (tsMs(r.last_ts) || Infinity) + (handedOver ? 120000 : 300000);
  const inWindow = (t) => Boolean(t) && t >= started - 60000 && t <= until;
  const top = r.project?.assets || [];
  const reported = parseAssetEvents(r.asset_events);
  const mentioned = parseMentions(r.asset_mentions);
  const own = ownedAssetIds(
    { writes: r.asset_writes || [], reported: [...reported.keys(), ...(r.written_ids || [])], mentioned: [...mentioned.keys()], jobs: jobTypes(r.methods) },
    top.map((a) => ({ id: a.asset_id, parentId: null, name: a.name, type: a.type, created: tsMs(a.created), updated: tsMs(a.updated) })),
    inWindow,
  );
  let picked = top.filter((a) => own.has(a.asset_id)).map((a) => ({ w: reported.get(a.asset_id) || mentioned.get(a.asset_id) || null, a }));
  // The asset table can lag the events: an asset the turns reported or wrote and handed over, not
  // in the table yet, comes from the events (minus scene parts).
  if (!picked.length) {
    const id8s = new Set((r.asset_writes || []).map((w) => w.id8).filter(Boolean));
    picked = [...reported.values(), ...[...mentioned.values()].filter((m) => id8s.has(m.id.slice(0, 8)))]
      .filter((w, i, all) => !/^scene\b/i.test(w.name || '') && all.findIndex((x) => x.id === w.id) === i).map((w) => ({ w, a: null }));
  }
  const outs = picked.map(({ w, a }) => ({
    id: a?.asset_id || w.id,
    type: normType(a?.type || w?.assetType || w?.type),
    name: a?.name || w?.name || null,
    thumb: a?.thumb || w?.snapshotUrl || null,
    publishedUrl: a?.published_url || null,
    publishedAt: tsMs(a?.published_at),
    updated: tsMs(a?.updated) || 0,
    intent: w?.intent || null,
  })).sort((x, y) => y.updated - x.updated);
  const ids = new Set(outs.map((o) => o.id));
  const dl = (r.project?.downloads || []).filter((d) => ids.has(d.asset_id));
  for (const o of outs) {
    const mine = dl.filter((d) => d.asset_id === o.id);
    o.downloads = mine.reduce((n, d) => n + Number(d.n || 0), 0);
    o.downloadUrl = mine.map((d) => d.url).find(Boolean) || null;
  }
  return { outs, dl };
}

function finishedAd(r) {
  const { outs, dl } = outputsOf(r);
  const primary = outs[0] || null;
  const video = outs.find((o) => o.type === 'video');
  const mp4 = video && dl.find((d) => d.asset_id === video.id && /\.mp4/i.test(d.url || ''));
  return {
    outputs: outs.slice(0, 12),
    outputType: primary?.type || null,
    adAssetId: primary?.id || null,
    adName: primary?.name || null,
    thumbnail: primary?.thumb || null,
    publishedUrl: outs.find((o) => o.publishedUrl)?.publishedUrl || null,
    publishedAt: outs.find((o) => o.publishedAt)?.publishedAt || null,
    userDownloads: dl.reduce((n, d) => n + Number(d.n || 0), 0),
    downloadedAt: tsMs(dl.map((d) => d.at).sort().at(-1)),
    renderUrl: mp4?.url || null,
    videoAssetId: video?.id || null,
    // A story's own mp4 export (the story player has no other render); used when it's up to date.
    storyAssetId: outs.find((o) => o.type === 'story')?.id || null,
    storyExportUrl: outs.find((o) => o.type === 'story' && /\/exports\/story-\d+\.mp4/i.test(o.downloadUrl || ''))?.downloadUrl || null,
    videoCount: outs.filter((o) => o.type === 'video').length,
  };
}

function toRun(r, userType) {
  return {
    ...finishedAd(r),
    projectId: r.project_id || null,
    agentDownloads: num(r.agent_downloads),
    agentDownloadLink: r.agent_download_link || null,
    sentiments: (r.sentiments || []).filter(Boolean),
    lastSentiment: r.last_sentiment || null,
    sentimentDetail: r.sentiment_detail || null,
    thumbsUp: num(r.thumbs_up) || 0,
    thumbsDown: num(r.thumbs_down) || 0,
    feedbackTags: (r.feedback_tags || []).filter(Boolean),
    outOfFunds: num(r.out_of_funds) || 0,
    streamErrors: num(r.stream_errors) || 0,
    id: r.session_id,
    title: r.title || null,
    prompt: (r.prompt || '').slice(0, 280),
    promptLength: (r.prompt || '').length,
    createdAt: tsMs(r.first_ts),
    skillAt: tsMs(r.skill_at),
    lastAt: tsMs(r.last_ts),
    wallMs: tsMs(r.last_ts) - tsMs(r.first_ts),
    userId: r.user_id,
    accountId: r.account_id,
    msid: r.msid,
    userType: userType(r.account_id),
    agent: r.agent_name || null,
    source: r.source || null,
    parentSessionId: r.parent_session_id || null,
    caller: r.caller_name || null,
    device: r.device_type || null,
    costUsd: num(r.total_cost_usd),
    creditsUsd: num(r.credits_charged_usd),
    userMessages: num(r.user_messages),
    toolCalls: num(r.tool_calls),
    generations: num(r.generations),
    errors: num(r.errors),
    firstError: r.first_error ? r.first_error.slice(0, 160) : null,
    failedTurns: num(r.failed_turns),
    turns: num(r.turns),
    longestTurnMs: num(r.longest_turn_ms),
    methods: (r.methods || []).filter(Boolean).sort(),
    skills: (r.skills || []).filter(Boolean).sort(),
    // What the whole session did beyond the turns counted here (other skills' work).
    allSkills: (r.all_skills || r.skills || []).filter(Boolean).sort(),
    otherSkills: (r.all_skills || []).filter((x) => x && !(r.skills || []).includes(x)).sort(),
    allTurns: num(r.all_turns) ?? num(r.turns),
    codexVersions: (r.codex_versions || []).filter(Boolean),
    firstClip: r.first_clip || null,
    lastClip: r.last_clip || null,
    firstImage: r.first_image || null,
  };
}

// ---- why a run made nothing ----
// The first that holds, for the card of a run with no output (measured on 770 such runs of
// wixel-ads-lite, wixel-ads and stories-creation, 10-04 → 10-07: the credit wall was 76% of
// wixel-ads-lite's and 44% of the stories'; most of the rest asked the user something and got no answer):
//   running    its last turn is still open and it was active in the last 20 minutes
//   credits    the agent stopped at the credit wall: OUT_OF_FUNDS, an "insufficient credits" error, a
//              link to the plans page, or a reply needing more credits than it had (agents check the
//              price and stop, in the user's language, without OUT_OF_FUNDS)
//   cancelled  the user stopped the turn
//   failed     the last turn failed, or it tried to make something and its calls errored
//   waiting    it asked the user something (a question, or a widget such as the video plan) and got no answer
//   cutoff     its last turn never ended (no question pending)
//   continued  the session's later turns went to another skill
//   handoff    a sub-agent that handed back to its parent
//   ended      anything else: what it last said
//   never      it never said or made anything
const CREDIT_WORD = '(?:credit|crédit|crédito|crediti|kredi|kredyt|קרדיט|кредит|クレジット|크레딧|积分)';
const CREDIT_NUM = new RegExp(`(\\d[\\d,.]*)\\s*\\**\\s*${CREDIT_WORD}`, 'giu');
const MENTIONS_CREDITS = new RegExp(CREDIT_WORD, 'iu');
const MAKER_TOOLS = new Set(['generate_image', 'edit_image', 'convert_image_format', 'write', 'sequence']);
const plainText = (s) => String(s || '')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/^\s*\|.*\|\s*$/gm, ' ') // table rows
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`#>]+/g, '')
  .replace(/\s+/g, ' ')
  .replace(/^[\s"“”'‘’,;:.)\]–—-]+/, '')
  .trim();
// The last sentence or two, up to ~180 characters; a short last line (a footnote, a sign-off) brings
// the one before it.
function lastWords(s) {
  const t = plainText(s);
  const parts = (t.match(/[^.!?。؟？]+[.!?。؟？]*/g) || [t]).map((x) => x.trim()).filter(Boolean);
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = parts[i] + (out ? ` ${out}` : '');
    if (out && next.length > 180 && out.length >= 60) break;
    out = next;
    if (out.length >= 180) break;
  }
  return out.length > 220 ? `…${out.slice(-219)}` : out;
}
// A widget's name as words: wixel-video-plan → "video plan", wixel-brand-site-brief → "brand site brief".
const widgetLabel = (w) => String(w || '').replace(/^wixel-/, '').replace(/-widget$/, '').split('-').filter((x) => !['bm', 'components'].includes(x)).join(' ');
const numOf = (s) => {
  const n = Number(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && String(s ?? '') !== '' ? n : null;
};

function stopReason(r, run) {
  const kind = String(r.last_turn_kind || '').replace('TURN_BOUNDARY_KIND_', '');
  const open = kind === 'STARTED';
  const asked = r.last_tool === 'ask_user';
  const reply = r.last_reply || '';
  if (open && !asked && run.lastAt && Date.now() - run.lastAt < 20 * 60000) return { kind: 'running', text: lastWords(reply) || null };

  const notes = (r.credit_notes || []).map(plainText).filter(Boolean);
  const nums = notes.flatMap((n) => [...n.matchAll(CREDIT_NUM)].map((m) => numOf(m[1]))).filter((n) => n != null);
  const available = numOf(r.credits_available) ?? (nums.length > 1 ? Math.min(...nums) : null);
  const needed = nums.length ? Math.max(...nums) : null;
  const dayCap = numOf(r.credits_day_cap);
  const short = needed != null && available != null && needed > available;
  const credits = () => ({
    kind: 'credits',
    needed: short || (needed != null && available == null) ? Math.round(needed) : null,
    available: available != null ? Math.round(available) : null,
    dayCap: dayCap != null && needed != null && needed > dayCap ? dayCap : null,
    // The agent's own words about it; a last reply about something else isn't the reason.
    text: notes.join('. ') || (MENTIONS_CREDITS.test(reply) ? lastWords(reply) : null),
  });
  if (run.outOfFunds || /insufficient credits|not enough credits/i.test(r.first_error || '') || r.upgrade_link || short) return credits();
  if (kind === 'CANCELLED') return { kind: 'cancelled', text: lastWords(reply) || null };
  const tried = run.generations > 0 || (run.steps || []).some((s) => MAKER_TOOLS.has(s[0]) && s[3] > 0);
  if (kind === 'FAILED' || (tried && run.errors > 0)) return { kind: 'failed', text: run.firstError || lastWords(reply) || null };
  const question = /[?؟？]\s*$/.test(plainText(reply));
  if (asked || question) {
    const w = asked && r.ask_widget ? widgetLabel(r.ask_widget) : null;
    // Often the agent offering a cheaper version after a price check: the balance it saw goes with it.
    return { kind: 'waiting', widget: w || null, available: notes.length && available != null ? Math.round(available) : null, text: (asked && !w ? plainText(r.ask_text) : '') || lastWords(reply) || null };
  }
  if (open) return { kind: 'cutoff', text: lastWords(reply) || null };
  // Stopped on a price it named ("You need at least 19 credits to make this story"), with no balance
  // to compare it to: it made nothing and isn't waiting on a question, so that's why.
  if (notes.length && !tried) return credits();
  if (run.otherSkills?.length && run.allTurns > run.turns) return { kind: 'continued', skill: run.otherSkills[0], text: lastWords(reply) || null };
  if (run.source === 'sub-agent') return { kind: 'handoff', text: lastWords(reply) || null };
  if (reply) return { kind: 'ended', text: lastWords(reply) };
  return { kind: 'never', text: null };
}

// Last listed rows by id, so media and detail routes can find a run's render links without
// re-running the list.
const runIndex = new Map();
export const getIndexedRun = (id) => runIndex.get(id) || null;

// Which days in the window have runs (so empty days are never queried), plus when the skill
// last ran when the window is empty.
export function runsIndex({ skill, days = 7, fresh = false }) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  return cached('runs-index', `v2__${skill}__${n}__${utcDay(Date.now())}`, fresh ? 0 : 3 * 60000, async () => {
    const rows = await retryOnce(() => sql(runsIndexQuery({ skill, windowDays: n })));
    const dayList = rows.map((r) => ({ day: r.day, sessions: Number(r.sessions) }));
    let lastSeen = null;
    if (!dayList.length) {
      const [ls] = await sql(lastSeenQuery({ skill })).catch(() => []);
      lastSeen = ls?.last_at ? { at: tsMs(ls.last_at), sessions90d: Number(ls.sessions_90d || 0) } : { at: null, sessions90d: 0 };
    }
    return { value: { skill, days: n, dayList, total: dayList.reduce((a, d) => a + d.sessions, 0), lastSeen }, ttlMs: 3 * 60000 };
  }, { staleWhileRevalidate: !fresh });
}

// Per-session step stats for one day (insights). Cached on the same rules as the day's rows.
// While a query version is new, the day's steps from the version before are served (they lack only what
// the new one added) and the new ones load in the background: a version bump would otherwise make every
// day wait on the steps query again, and that one can time out for minutes on a busy cluster.
const prevStepsKey = (scope, day) => `v${STEPS_QUERY_VERSION - 1}__${scopeKey(scope)}__${day}`;
async function dayStepRows(scope, day, { fresh = false } = {}) {
  if (!fresh && (await readStale('steps-day', stepsKey(scope, day))) === undefined) {
    const prev = await readStale('steps-day', prevStepsKey(scope, day));
    if (prev !== undefined) {
      inBackground(() => buildStepRows(scope, day)).catch((err) => console.error(`steps ${scope.skill || 'user'} ${day}: ${err.message}`));
      return prev;
    }
  }
  return buildStepRows(scope, day, { fresh });
}
function buildStepRows(scope, day, { fresh = false } = {}) {
  const final = dayFinal(day);
  const key = stepsKey(scope, day);
  return cached('steps-day', key, fresh ? 0 : final ? Infinity : 3 * 60000, async () => {
    // Topped up like the day's rows, from the same hour (taken from the rows, which carry the times).
    const have = fresh ? null : await readStale('steps-day', key);
    const from = have ? await topUpHour('runs-day', rowsKey(scope, day), day) : null;
    const rows = from == null ? await sliced((hours) => stepsDayQuery({ scope, day, hours })) : mergeRows(have, await sliced((hours) => stepsDayQuery({ scope, day, hours }), [from, 24]));
    return { value: rows, ttlMs: final ? Infinity : 3 * 60000 };
  }, { staleWhileRevalidate: !fresh });
}

const SEP = String.fromCharCode(31);
// Steps travel as compact tuples: [tool, method, model, calls, failures, totalMs, maxMs, firstError,
// graph (the Genix graph a media job ran, for its price), billed seconds (asked for by the calls that succeeded)].
// The query's 11th field (the calls' spans) stays on the server: timeBreakdown reads it.
function parseSteps(list) {
  return (list || []).map((x) => {
    const [tool, method, model, n, errs, ms, maxMs, err, graph, billed] = x.split(SEP);
    return [tool, method || null, model || null, Number(n), Number(errs), Number(ms), Number(maxMs), err || null, graph || null, Number(billed || 0)];
  });
}

// ---- where a run's time went (time-split.js) ----
// The steps query's turn marks (turn␟s|e␟ms) and, per step, its calls' spans (flag:end:duration).
function timeBreakdown(sr) {
  const turns = new Map();
  for (const m of sr.turn_marks || []) {
    const [turn, which, ms] = String(m).split(SEP);
    const t = turns.get(turn) || {};
    if (which === 's') t.s = Math.min(t.s ?? Infinity, Number(ms));
    else t.e = Math.max(t.e ?? 0, Number(ms));
    turns.set(turn, t);
  }
  const lastMs = Number(sr.last_ms) || 0;
  const calls = [];
  for (const x of sr.steps || []) {
    const f = String(x).split(SEP);
    if (f[10]) for (const c of f[10].split(',')) {
      const [flag, end, dur] = c.split(':').map(Number); // flag: 0 ok, 1 failed, 2 returned with its job still running
      calls.push({ tool: f[0], method: f[1], failed: flag === 1, unfinished: flag === 2, start: end - dur, end });
    }
  }
  return splitTime({ turns: [...turns.values()].filter((t) => t.s != null).map((t) => [t.s, t.e ?? lastMs]), calls });
}

function stepFields(sr) {
  if (!sr) return { steps: null };
  const lastOk = tsMs(sr.last_gen_ok_at);
  const done = (sr.turn_done_ats || []).map(tsMs).filter(Boolean).sort((a, b) => a - b);
  // "Final" = the end of the turn that produced the last good generation.
  const finalAt = lastOk ? done.find((t) => t >= lastOk) ?? lastOk : null;
  return {
    steps: parseSteps(sr.steps),
    requestAt: tsMs(sr.request_at),
    firstGenAt: tsMs(sr.first_gen_at),
    lastGenOkAt: lastOk,
    finalAt,
    firstTurnDoneAt: done[0] ?? null,
    intent: sr.intent || null,
    llmErrors: Number(sr.llm_errors || 0),
    time: timeBreakdown(sr),
  };
}

// One day's runs, ready for the grid.
// `fromHour`: Refresh's top-up (see topUp): only those sessions are queried, merged into the cached
// day, and returned.
async function scopedDay(scope, day, sampleRate = 1, { fresh = false, fromHour = null } = {}) {
  let rawRows;
  let stepRows;
  if (fromHour != null) {
    const ttl = dayFinal(day) ? Infinity : 3 * 60000;
    const hours = [Math.max(0, Math.min(23, fromHour)), 24];
    const t0 = Date.now();
    const timed = (p) => p.then((v) => ({ ...v, ms: Date.now() - t0 }));
    const [r, st] = await Promise.all([
      timed(topUp('runs-day', rowsKey(scope, day), ttl, () => buildDayRows(scope, day, hours), () => dayRows(scope, day, { fresh: true }))),
      timed(topUp('steps-day', stepsKey(scope, day), ttl, () => sliced((h) => stepsDayQuery({ scope, day, hours: h }), hours), () => dayStepRows(scope, day))).catch(() => ({ all: [], part: [], ms: null })),
    ]);
    console.log(`top-up ${scope.skill} ${day} from ${hours[0]}:00 — ${r.part ? `${r.part.length} sessions` : 'whole day (not cached)'} in ${r.ms}ms, steps ${st.ms}ms`);
    rawRows = r.part || r.all;
    stepRows = st.all;
  } else {
    [rawRows, stepRows] = await Promise.all([dayRows(scope, day, { fresh }), dayStepRows(scope, day, { fresh }).catch(() => [])]);
  }
  const seen = new Set();
  const rows = rawRows.filter((r) => !seen.has(r.session_id) && seen.add(r.session_id));
  // A cached day's accounts are known already (a whole-day build warmed them above), so this is
  // instant unless a lookup failed earlier.
  const userType = await userTypesWithin(rows.map((r) => r.account_id), 3000);
  const bySession = new Map(stepRows.map((r) => [r.session_id, r]));
  const runs = rows.map((r) => {
    const run = { ...toRun(r, userType), ...stepFields(bySession.get(r.session_id)), sampleRate };
    if (!run.outputs?.length) run.stop = stopReason(r, run);
    return run;
  });
  for (const r of runs) runIndex.set(r.id, r);
  return runs;
}

// `sessions` is the day's count from the index; above the target the day is sampled.
// `family`: the skills counted with it (null = whole sessions).
// `since` (ms, Refresh): only sessions that started after it, less an overlap for runs that were
// still going then, are queried again and returned; the rest of the day comes from the cache.
// Runs take ~11 min from request to result (median; 24 min for the slowest 10%), so an hour back
// catches every run that was still going.
const TOP_UP_OVERLAP = 3600000;
export async function runsForDay({ skill, family, day, sessions = 0, fresh = false, since = null }) {
  const sample = sampleFor(sessions);
  const fromHour = since ? Math.floor((since - TOP_UP_OVERLAP - Date.parse(`${day}T00:00:00Z`)) / 3600000) : null;
  if (fromHour != null && fromHour >= 24) return [];
  return scopedDay({ skill, family, sample }, day, sample ? sample.length / 16 : 1, { fresh, fromHour });
}

export async function listRuns({ skill, family, days = 7 }) {
  const index = await runsIndex({ skill, days });
  // A day that fails still leaves the others usable; the client is told which days are missing.
  const missingDays = [];
  const perDay = await mapLimit(index.dayList, 3, (d) => runsForDay({ skill, family, day: d.day, sessions: d.sessions }).catch((err) => {
    missingDays.push({ day: d.day, error: String(err.message || err).slice(0, 200) });
    return [];
  }));
  const seen = new Set();
  const runs = perDay.flat().filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.createdAt - a.createdAt);
  return { runs, missingDays, lastSeen: index.lastSeen };
}

// ---- skill families ----
// A skill's family: the helpers it loads in the same turn often enough to be part of its job
// (≥3% of its turns), plus the sub-steps of those helpers (wixel-ads → video-creation →
// video-plan-approval). Hubs, skills loaded alongside many others (site-content, wix-apis,
// export-handler), are kept as helpers but never followed, or every skill would end up in every
// family. Co-loading can't tell which of two mutual partners is in charge (wixel-ads and
// video-creation each list the other), so families are shown and editable in the UI.
// Pinned for 30 days per skill so cached days (keyed by the family) stay valid.
const FAMILY_VERSION = 8;
export function skillPairs() {
  return cached('meta', `skill-pairs-v${FAMILY_VERSION}`, DAY, async () => ({ value: await retryOnce(() => sql(skillPairsQuery(), { maxRows: 5000 })), ttlMs: DAY }));
}

export function familyFor(skill) {
  return cached('meta', `family-v${FAMILY_VERSION}__${skill}`, 30 * DAY, async () => {
    const pairs = await skillPairs();
    const of = new Map();
    for (const p of pairs) {
      const list = of.get(p.a) || [];
      list.push({ skill: p.b, share: Number(p.together) / Number(p.a_turns), turns: Number(p.a_turns) });
      of.set(p.a, list);
    }
    const partners = (x, min) => (of.get(x) || []).filter((p) => p.share >= min);
    const shareOf = (x, y) => (of.get(x) || []).find((p) => p.skill === y)?.share || 0;
    // A hub is a utility: loaded alongside many skills (≥5 partners at ≥3% of its turns) AND relied
    // on by many (≥8 established skills load it in ≥3% of theirs) — site-content, wix-apis,
    // export-handler. Engines that are also products (single-page-design, image generation) are
    // relied on but not broadly co-loaded; small bundles (brand-kit) the reverse.
    const turnsOf = (x) => of.get(x)?.[0]?.turns || 0;
    const reliedOn = (x) => [...of.keys()].filter((y) => y !== x && turnsOf(y) >= 100 && shareOf(y, x) >= 0.03).length;
    const hub = (x) => partners(x, 0.03).length >= 5 && reliedOn(x) >= 8;
    const detail = new Map();
    // A hub viewed on its own counts only the turns that load it: it's a helper to every
    // product, so following its partners would pull all of them in.
    const selfHub = hub(skill);
    if (!selfHub) for (const p of partners(skill, 0.03)) detail.set(p.skill, { skill: p.skill, share: p.share, via: null, hub: hub(p.skill) });
    // Sub-steps of a helper: skills that mostly load with it (≥50% of their own turns), e.g.
    // video-plan-approval with video-creation (88%). A skill that merely co-occurs (a separate
    // product loaded next to export-handler now and then) doesn't count.
    for (const h of [...detail.values()].filter((d) => !d.hub)) {
      for (const [d] of of) {
        if (d !== skill && !detail.has(d) && shareOf(d, h.skill) >= 0.5 && shareOf(h.skill, d) >= 0.05) detail.set(d, { skill: d, share: shareOf(d, h.skill), via: h.skill, hub: hub(d) });
      }
    }
    // Shared helpers (hubs) never end another skill's turns: a later "download it" turn loads
    // export-handler, a "use my site" turn site-content, and that's still the same job.
    if (!selfHub) for (const [x] of of) if (x !== skill && !detail.has(x) && hub(x)) detail.set(x, { skill: x, share: shareOf(skill, x), via: null, hub: true, shared: true });
    const list = [...detail.values()].sort((a, b) => Number(Boolean(a.shared)) - Number(Boolean(b.shared)) || b.share - a.share);
    return { value: { skill, family: list.map((d) => d.skill), detail: list, hub: selfHub, turns: of.get(skill)?.[0]?.turns || 0, computedAt: Date.now() }, ttlMs: 30 * DAY };
  });
}

// "default" (or nothing) → the computed family; "all" → whole sessions; else a comma list.
export async function resolveFamily(skill, fam) {
  if (fam === 'all') return null;
  if (fam && fam !== 'default') return [...new Set(fam.split(',').map((x) => x.trim()).filter((x) => /^[\w.:-]{1,80}$/.test(x)))];
  return (await familyFor(skill)).family;
}

// ---- user mode: every session one user ran, any skill ----
// The admin API lists a user's sessions (newest first, 50 a page); their rows come from the
// same day queries, scoped to those session ids and counting whole sessions.
export async function userSessions(userId, days) {
  if (!/^[\w-]{36}$/.test(userId)) throw Object.assign(new Error('bad user id'), { status: 400 });
  const since = Date.now() - days * DAY;
  return cached('user-sessions', `${userId}__${days}`, 2 * 60000, async () => {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const res = await limited('admin', () => getJson(`${config.adminBase}/sessions?userId=${userId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      const list = res.sessions || [];
      out.push(...list.map((x) => ({ id: x.id, createdAt: Date.parse(x.createdAt), email: x.userEmail || null })));
      cursor = res.cursor;
      if (!cursor || !list.length || Date.parse(list.at(-1).createdAt) < since) break;
    }
    return { value: out.filter((x) => x.createdAt >= since), ttlMs: 2 * 60000 };
  }, { staleWhileRevalidate: true });
}

export async function listUserRuns({ userId, days = 30 }) {
  const n = Math.max(1, Math.min(90, Number(days) || 30));
  const sessions = await userSessions(userId, n);
  const byDay = new Map();
  for (const x of sessions) {
    const day = utcDay(x.createdAt);
    byDay.set(day, [...(byDay.get(day) || []), x.id]);
  }
  const missingDays = [];
  const perDay = await mapLimit([...byDay], 3, ([day, ids]) => scopedDay({ ids, user: userId }, day).catch((err) => {
    missingDays.push({ day, error: String(err.message || err).slice(0, 200) });
    return [];
  }));
  const seen = new Set();
  const runs = perDay.flat().filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.createdAt - a.createdAt);
  return { user: { id: userId, email: sessions.find((x) => x.email)?.email || null }, runs, missingDays, sessions: sessions.length };
}

export function listSkills({ days = 30 } = {}) {
  return cached('meta', `skills-v2_${days}`, 6 * 3600000, async () => ({ value: await sql(skillsQuery({ windowDays: days })), ttlMs: 6 * 3600000 }));
}
