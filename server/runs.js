import { sql } from './admin.js';
import { cached, readCache, writeCache } from './cache.js';
import { RUNS_QUERY_VERSION, STEPS_QUERY_VERSION, runsDayQuery, eventsDayQuery, stepsDayQuery, skillsQuery, runsIndexQuery, lastSeenQuery } from './queries.js';

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

async function sessionAttrs(ids, day) {
  if (!ids.length) return new Map();
  if (ids.length > 1000) {
    const parts = await Promise.all(chunks(ids).map((c) => sessionAttrs(c, day)));
    return new Map(parts.flatMap((m) => [...m]));
  }
  const list = ids.map(lit).join(',');
  const [dim, crud] = await Promise.all([
    sql(`SELECT session_id, agent_name, subject, session_source, caller_name, device_type, total_cost_usd, credits_charged_usd
         FROM prod.wixel.agent_session_dim WHERE session_id IN (${list})`),
    // The dim table lags; the CRUD stream covers today's sessions.
    sql(`SELECT id, max_by(agent_name, revision) AS agent_name, max_by(subject, revision) AS subject, max_by(project_id, revision) AS project_id
         FROM domain_events.www_wixel_agent.v1_session_crud
         WHERE id IN (${list}) AND created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY GROUP BY id`),
  ]);
  const m = new Map();
  for (const r of crud) m.set(r.id, { agent_name: r.agent_name, title: r.subject, project_id: r.project_id });
  for (const r of dim) {
    m.set(r.session_id, {
      ...m.get(r.session_id),
      agent_name: r.agent_name || m.get(r.session_id)?.agent_name,
      title: r.subject || m.get(r.session_id)?.title,
      source: r.session_source,
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
           max_by(thumbnail_url, _event_time) FILTER (WHERE thumbnail_url IS NOT NULL) AS thumb,
           max_by(published_info.published_asset_link, _event_time) FILTER (WHERE published_info.published_asset_link IS NOT NULL) AS published_url,
           min(_event_time) FILTER (WHERE published_info IS NOT NULL) AS published_at
         FROM domain_events.www_asset.v1_asset_crud
         WHERE parent_id IS NULL AND _event_time >= ${since} AND project_id IN (${list})
         GROUP BY 1, 2`),
    sql(`SELECT project_id, asset_id, count(*) AS n, max(date_created) AS at, max_by(asset_url, date_created) AS url,
           max_by(REGEXP_EXTRACT(additional_info, 'fileType:([^,]+)', 1), date_created) AS file_type
         FROM events.dbo.users_193
         WHERE evid = 19 AND result = 'success' AND date_created >= ${since} AND project_id IN (${list})
         GROUP BY 1, 2`),
  ]);
  const m = new Map();
  for (const a of assets) {
    const p = m.get(a.project_id) || { assets: [], downloads: [] };
    p.assets.push(a);
    m.set(a.project_id, p);
  }
  for (const d of downloads) {
    const p = m.get(d.project_id) || { assets: [], downloads: [] };
    p.downloads.push(d);
    m.set(d.project_id, p);
  }
  return m;
}

// ---- account → user type ----
// The vizion report's rule: an account missing from prod.wt_accounts.base is a Wix employee;
// the slides/Wixel team list wins over that. The base lookup is a ~20s scan, so results are
// cached per account forever and only new accounts are looked up (≤1400 ids per query: 64KB SQL cap).
let accountTypes;
let teamSet;
async function resolveUserTypes(accountIds) {
  accountTypes ??= (await readCache('meta', 'account-types', Infinity)) || {};
  teamSet ??= new Set(await cached('meta', 'wixel-team', DAY, async () => ({
    value: (await sql('SELECT DISTINCT account_id FROM sandbox.www.slides_employees_team')).map((r) => r.account_id),
    ttlMs: DAY,
  })));
  const missing = [...new Set(accountIds.filter((id) => id && !(id in accountTypes)))];
  for (let i = 0; i < missing.length; i += 1400) {
    const ids = missing.slice(i, i + 1400);
    const [row] = await sql(`SELECT array_join(array_agg(t.id), ',') AS missing FROM UNNEST(ARRAY[${ids.map(lit).join(',')}]) AS t(id)
      LEFT JOIN prod.wt_accounts.base b ON b.account_id = t.id WHERE b.account_id IS NULL`);
    const employees = new Set((row?.missing || '').split(',').filter(Boolean));
    for (const id of ids) accountTypes[id] = employees.has(id) ? 'employee' : 'real';
  }
  if (missing.length) await writeCache('meta', 'account-types', accountTypes, Infinity);
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

function dayRows(skill, day, sample = null) {
  // A day's rows keep changing while its sessions may still be active (entries are read
  // up to 2 days past the skill load); after that they're final.
  const final = Date.parse(`${day}T00:00:00Z`) + 3 * DAY < Date.now();
  return cached('runs-day', `v${RUNS_QUERY_VERSION}__${skill}__${day}${sample ? `__s${sample}` : ''}`, final ? Infinity : 3 * 60000, async () => {
    const [rows, events] = await Promise.all([
      sliced((hours) => runsDayQuery({ skill, day, hours, sample })),
      sliced((hours) => eventsDayQuery({ skill, day, hours, sample })).catch(() => []),
    ]);
    const [attrs] = await Promise.all([
      sessionAttrs(rows.map((r) => r.session_id), day),
      // Warm the account cache in parallel; listRuns reads it.
      resolveUserTypes(rows.map((r) => r.account_id)),
    ]);
    const projects = await projectSignals([...new Set([...attrs.values()].map((a) => a.project_id).filter(Boolean))], day);
    const ev = new Map(events.map((e) => [e.session_id, e]));
    const value = rows.map((r) => {
      const a = attrs.get(r.session_id) || {};
      const { session_id: _, ...e } = ev.get(r.session_id) || {};
      return { ...r, ...e, ...a, project: projects.get(a.project_id) || null };
    });
    return { value, ttlMs: final ? Infinity : 3 * 60000 };
  }, { staleWhileRevalidate: true });
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

// A run's outputs: the top-level assets its session wrote (from TURN_UPDATED_ASSETS). Sessions
// without those events fall back to the project's top-level assets touched after the run started
// (projects outlive sessions, so an older session's asset is never credited to this run).
function outputsOf(r) {
  const started = tsMs(r.first_ts) || 0;
  const top = r.project?.assets || [];
  const topById = new Map(top.map((a) => [a.asset_id, a]));
  const written = parseAssetEvents(r.asset_events);
  let picked;
  if (written.size) {
    picked = [...written.values()].filter((w) => topById.has(w.id)).map((w) => ({ w, a: topById.get(w.id) }));
    // The asset table can lag the events; if none matched yet, trust the events (minus scene parts).
    if (!picked.length) picked = [...written.values()].filter((w) => !/^scene\b/i.test(w.name || '')).map((w) => ({ w, a: null }));
  } else {
    picked = top.filter((a) => !a.updated || tsMs(a.updated) >= started - 60000).map((a) => ({ w: null, a }));
  }
  const outs = picked.map(({ w, a }) => ({
    id: a?.asset_id || w.id,
    type: normType(a?.type || w?.assetType),
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
    codexVersions: (r.codex_versions || []).filter(Boolean),
    firstClip: r.first_clip || null,
    lastClip: r.last_clip || null,
    firstImage: r.first_image || null,
  };
}

// Last listed rows by id, so media and detail routes can find a run's render links without
// re-running the list.
const runIndex = new Map();
export const getIndexedRun = (id) => runIndex.get(id) || null;

// Which days in the window have runs (so empty days are never queried), plus when the skill
// last ran when the window is empty.
export function runsIndex({ skill, days = 7 }) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  return cached('runs-index', `${skill}__${n}__${utcDay(Date.now())}`, 3 * 60000, async () => {
    const rows = await retryOnce(() => sql(runsIndexQuery({ skill, windowDays: n })));
    const dayList = rows.map((r) => ({ day: r.day, sessions: Number(r.sessions) }));
    let lastSeen = null;
    if (!dayList.length) {
      const [ls] = await sql(lastSeenQuery({ skill })).catch(() => []);
      lastSeen = ls?.last_at ? { at: tsMs(ls.last_at), sessions90d: Number(ls.sessions_90d || 0) } : { at: null, sessions90d: 0 };
    }
    return { value: { skill, days: n, dayList, total: dayList.reduce((a, d) => a + d.sessions, 0), lastSeen }, ttlMs: 3 * 60000 };
  }, { staleWhileRevalidate: true });
}

// Per-session step stats for one day (insights). Cached on the same rules as the day's rows.
function dayStepRows(skill, day, sample = null) {
  const final = Date.parse(`${day}T00:00:00Z`) + 3 * DAY < Date.now();
  return cached('steps-day', `v${STEPS_QUERY_VERSION}__${skill}__${day}${sample ? `__s${sample}` : ''}`, final ? Infinity : 3 * 60000, async () => {
    const rows = await sliced((hours) => stepsDayQuery({ skill, day, hours, sample }));
    return { value: rows, ttlMs: final ? Infinity : 3 * 60000 };
  }, { staleWhileRevalidate: true });
}

const SEP = String.fromCharCode(31);
// Steps travel as compact tuples: [tool, method, model, calls, failures, totalMs, maxMs, firstError].
function parseSteps(list) {
  return (list || []).map((x) => {
    const [tool, method, model, n, errs, ms, maxMs, err] = x.split(SEP);
    return [tool, method || null, model || null, Number(n), Number(errs), Number(ms), Number(maxMs), err || null];
  });
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
  };
}

// One day's runs, ready for the grid.
// `sessions` is the day's count from the index; above the target the day is sampled.
export async function runsForDay({ skill, day, sessions = 0 }) {
  const sample = sampleFor(sessions);
  const [rawRows, stepRows] = await Promise.all([dayRows(skill, day, sample), dayStepRows(skill, day, sample).catch(() => [])]);
  const seen = new Set();
  const rows = rawRows.filter((r) => !seen.has(r.session_id) && seen.add(r.session_id));
  const userType = await resolveUserTypes(rows.map((r) => r.account_id));
  const bySession = new Map(stepRows.map((r) => [r.session_id, r]));
  const sampleRate = sample ? sample.length / 16 : 1;
  const runs = rows.map((r) => ({ ...toRun(r, userType), ...stepFields(bySession.get(r.session_id)), sampleRate }));
  for (const r of runs) runIndex.set(r.id, r);
  return runs;
}

export async function listRuns({ skill, days = 7 }) {
  const index = await runsIndex({ skill, days });
  // A day that fails still leaves the others usable; the client is told which days are missing.
  const missingDays = [];
  const perDay = await mapLimit(index.dayList, 3, (d) => runsForDay({ skill, day: d.day, sessions: d.sessions }).catch((err) => {
    missingDays.push({ day: d.day, error: String(err.message || err).slice(0, 200) });
    return [];
  }));
  const seen = new Set();
  const runs = perDay.flat().filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.createdAt - a.createdAt);
  return { runs, missingDays, lastSeen: index.lastSeen };
}

export function listSkills({ days = 30 } = {}) {
  return cached('meta', `skills_${days}`, 6 * 3600000, async () => ({ value: await sql(skillsQuery({ windowDays: days })), ttlMs: 6 * 3600000 }));
}
