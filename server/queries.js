// Trino SQL, run through the admin analytics endpoint (see admin.js `sql`).

const ENTRIES = 'domain_events.www_wixel_agent.v1_session_entry_crud';
const SESSIONS = 'domain_events.www_wixel_agent.v1_session_crud';
const ACCOUNTS = 'prod.wt_accounts.base';
const SESSION_DIM = 'prod.wixel.agent_session_dim';
const TEAM = 'sandbox.www.slides_employees_team';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const days = (n) => Math.max(1, Math.min(90, Math.floor(Number(n) || 7)));

// Skills and how many sessions loaded each, for the skill picker.
export function skillsQuery({ windowDays = 30 } = {}) {
  return `
SELECT element_at(tool_call.arguments, 'name') AS skill, count(DISTINCT session_id) AS sessions, max(created_date) AS last_at
FROM ${ENTRIES}
WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill'
  AND created_date >= current_timestamp - INTERVAL '${days(windowDays)}' DAY
GROUP BY 1 HAVING count(DISTINCT session_id) >= 5
ORDER BY 2 DESC`;
}

// One row per session that first loaded `skill` on UTC day `day` (YYYY-MM-DD). Everything the
// grid needs to draw a card and filter on, without touching the per-session admin API.
// Queried one day at a time: the endpoint stops at 30s, and past days can be cached forever.
// Entries are read up to 2 days past the skill load, which covers every realistic session.
// A day can be queried in hour windows ([from, to), 0–24) when a whole day is too heavy for the
// endpoint's 30s limit; sessions belong to the window their first skill load falls in.
// High-volume skills are sampled per day: keep sessions whose id starts with one of `sample`'s
// hex characters. Deterministic (the same sessions every time, so it caches) and cheap.
function sampleClause(sample) {
  if (!sample) return '';
  if (!/^[0-9a-f]{1,15}$/.test(sample)) throw new Error(`bad sample ${sample}`);
  return `\n     AND substr(session_id, 1, 1) IN (${[...sample].map((c) => `'${c}'`).join(',')})`;
}

function checkHours([a, b]) {
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b <= 24 && a < b)) throw new Error(`bad hours ${a}-${b}`);
}

// Bump when runsDayQuery's output changes, so cached days are re-queried.
export const RUNS_QUERY_VERSION = 5;

export function runsDayQuery({ skill, day, hours = [0, 24], sample = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  checkHours(hours);
  return `
WITH picked AS (
  SELECT session_id AS sid, min(created_date) AS skill_at
  FROM ${ENTRIES}
  WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill'
    AND element_at(tool_call.arguments, 'name') = ${lit(skill)}
    AND created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY
    AND created_date < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR
  GROUP BY 1
  HAVING min(created_date) >= TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[0]}' HOUR
     AND min(created_date) < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR${sampleClause(sample)}
),
e AS (
  SELECT x.*, picked.skill_at AS picked_at, element_at(x.tool_result.result, 'output') AS out
  FROM ${ENTRIES} x JOIN picked ON picked.sid = x.session_id
  WHERE x.created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY
    AND x.created_date < TIMESTAMP '${day} 00:00:00' + INTERVAL '3' DAY
),
agg AS (
  SELECT
    session_id,
    min(created_date) AS first_ts,
    max(created_date) AS last_ts,
    arbitrary(user_id) AS user_id,
    arbitrary(_msid) AS msid,
    arbitrary(coalesce(_logged_account_id, _target_account_id)) AS account_id,
    min_by(user_message.text, sequence) FILTER (WHERE entry_type = 'USER_MESSAGE') AS prompt,
    arbitrary(picked_at) AS skill_at,
    count(DISTINCT id) FILTER (WHERE entry_type = 'USER_MESSAGE') AS user_messages,
    count(DISTINCT id) FILTER (WHERE entry_type = 'TOOL_CALL') AS tool_calls,
    count(DISTINCT id) FILTER (WHERE entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL) AS generations,
    count(DISTINCT id) FILTER (WHERE entry_type = 'TOOL_RESULT' AND (
      tool_result.status LIKE '%ERROR%' OR out LIKE 'Exception%' OR out LIKE '%error_json:%')) AS errors,
    min_by(substr(coalesce(tool_result.error_message, out), 1, 300), sequence) FILTER (WHERE entry_type = 'TOOL_RESULT' AND (
      tool_result.status LIKE '%ERROR%' OR out LIKE 'Exception%' OR out LIKE '%error_json:%')) AS first_error,
    count(DISTINCT id) FILTER (WHERE entry_type = 'TURN_BOUNDARY' AND turn_boundary.kind LIKE '%FAILED%') AS failed_turns,
    count(DISTINCT id) FILTER (WHERE entry_type = 'TURN_BOUNDARY' AND turn_boundary.kind LIKE '%STARTED%') AS turns,
    max(turn_boundary.duration_ms) AS longest_turn_ms,
    array_agg(DISTINCT element_at(tool_call.arguments, 'method')) FILTER (WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'invoke_rpc') AS methods,
    array_agg(DISTINCT element_at(metadata, 'codexVersionId')) FILTER (WHERE entry_type = 'TURN_BOUNDARY' AND element_at(metadata, 'codexVersionId') IS NOT NULL) AS codex_versions,
    array_agg(DISTINCT element_at(tool_call.arguments, 'name')) FILTER (WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill') AS skills,
    min_by(regexp_extract(out, 'https://[^"\\\\ ]+?\\.mp4'), sequence) FILTER (WHERE entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL AND out LIKE '%.mp4%') AS first_clip,
    max_by(regexp_extract(out, 'https://[^"\\\\ ]+?\\.mp4'), sequence) FILTER (WHERE entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL AND out LIKE '%.mp4%') AS last_clip,
    array_agg(DISTINCT element_at(system_event.payload, 'sentimentLabel')) FILTER (WHERE entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis' AND element_at(system_event.payload, 'sentimentLabel') IS NOT NULL) AS sentiments,
    max_by(element_at(system_event.payload, 'sentimentLabel'), sequence) FILTER (WHERE entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis') AS last_sentiment,
    max_by(element_at(system_event.payload, 'sentimentDetail'), sequence) FILTER (WHERE entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis' AND element_at(system_event.payload, 'sentimentLabel') IN ('frustrated', 'confused')) AS sentiment_detail,
    count(DISTINCT id) FILTER (WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'download') AS agent_downloads,
    max_by(regexp_extract(out, 'https://links\\.wixel\\.com/link/[A-Za-z0-9_-]+'), sequence) FILTER (WHERE entry_type = 'TOOL_RESULT' AND tool_result.tool_name = 'download') AS agent_download_link,
    min_by(regexp_extract(out, 'https://static\\.wixstatic\\.com/media/[^"\\\\ ]+?\\.(?:png|jpg|jpeg|webp)'), sequence) FILTER (WHERE entry_type = 'TOOL_RESULT' AND tool_result.tool_name IN ('generate_image', 'edit_image')) AS first_image
  FROM e
  GROUP BY session_id
)
SELECT * FROM agg ORDER BY session_id`;
}

// Session and account attributes for a page of runs. Kept out of runsQuery because the
// joins against the big dimension tables push it past the endpoint's 30s limit.
export function enrichQuery({ sessionIds, accountIds, windowDays = 7 }) {
  const ids = sessionIds.map(lit).join(',') || "''";
  const accts = accountIds.filter(Boolean).map(lit).join(',') || "''";
  return `
WITH d AS (SELECT session_id, agent_name, subject, session_source, caller_name, device_type, total_cost_usd, credits_charged_usd
           FROM ${SESSION_DIM} WHERE session_id IN (${ids})),
s AS (SELECT id, max_by(agent_name, revision) AS agent_name, max_by(subject, revision) AS subject
      FROM ${SESSIONS} WHERE id IN (${ids}) AND created_date >= current_timestamp - INTERVAL '${days(windowDays) + 1}' DAY GROUP BY id),
a AS (SELECT account_id, mail_domain FROM ${ACCOUNTS} WHERE account_id IN (${accts})),
t AS (SELECT DISTINCT account_id FROM ${TEAM} WHERE account_id IN (${accts}))
SELECT 'session' AS kind, s.id AS id, coalesce(d.agent_name, s.agent_name) AS agent_name, coalesce(d.subject, s.subject) AS title,
       d.session_source AS source, d.caller_name, d.device_type, d.total_cost_usd, d.credits_charged_usd, NULL AS user_type
FROM s LEFT JOIN d ON d.session_id = s.id
UNION ALL
SELECT 'account', a.account_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       CASE WHEN t.account_id IS NOT NULL THEN 'wixel-team' WHEN a.mail_domain = 'wix.com' THEN 'employee' ELSE 'real' END
FROM a LEFT JOIN t ON t.account_id = a.account_id`;
}

// User-facing session events for the same day's sessions (thumbs, out of credits, stream errors)
// and the assets each run wrote.
// Separate from runsDayQuery so each stays well under the endpoint's 30s limit.
export function eventsDayQuery({ skill, day, hours = [0, 24], sample = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  checkHours(hours);
  return `
WITH picked AS (
  SELECT session_id AS sid
  FROM ${ENTRIES}
  WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill'
    AND element_at(tool_call.arguments, 'name') = ${lit(skill)}
    AND created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY
    AND created_date < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR
  GROUP BY 1
  HAVING min(created_date) >= TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[0]}' HOUR
     AND min(created_date) < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR${sampleClause(sample)}
)
SELECT
  x.session_id,
  count(DISTINCT x.id) FILTER (WHERE x.event_type = 'USER_FEEDBACK' AND element_at(x.payload, 'feedback') = 'thumbs_up') AS thumbs_up,
  count(DISTINCT x.id) FILTER (WHERE x.event_type = 'USER_FEEDBACK' AND element_at(x.payload, 'feedback') = 'thumbs_down') AS thumbs_down,
  array_agg(DISTINCT element_at(x.payload, 'tags')) FILTER (WHERE x.event_type = 'USER_FEEDBACK' AND element_at(x.payload, 'tags') IS NOT NULL) AS feedback_tags,
  count(DISTINCT x.id) FILTER (WHERE x.event_type = 'OUT_OF_FUNDS') AS out_of_funds,
  count(DISTINCT x.id) FILTER (WHERE x.event_type = 'MODEL_STREAM_ERROR') AS stream_errors,
  -- The assets each turn wrote (id, name, assetType, intent, snapshotUrl): the run's outputs, exactly.
  array_agg(element_at(x.payload, 'assets')) FILTER (WHERE x.event_type = 'TURN_UPDATED_ASSETS') AS asset_events
FROM domain_events.www_wixel_agent.v1_session_event_crud x JOIN picked ON picked.sid = x.session_id
WHERE x.created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY
  AND x.created_date < TIMESTAMP '${day} 00:00:00' + INTERVAL '3' DAY
  AND x.event_type IN ('USER_FEEDBACK', 'OUT_OF_FUNDS', 'MODEL_STREAM_ERROR', 'TURN_UPDATED_ASSETS')
GROUP BY 1
ORDER BY 1`;
}

// Which UTC days in the window have sessions that first loaded `skill`, and when it last ran.
// Cheap (skill tool calls only), so the day slices are only queried where there's data.
export function runsIndexQuery({ skill, windowDays }) {
  const d = days(windowDays);
  return `
WITH picked AS (
  SELECT session_id, min(created_date) AS skill_at
  FROM ${ENTRIES}
  WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill'
    AND element_at(tool_call.arguments, 'name') = ${lit(skill)}
    AND created_date >= date_trunc('day', current_timestamp) - INTERVAL '${d}' DAY
  GROUP BY 1
)
SELECT CAST(date(skill_at) AS varchar) AS day, count(*) AS sessions, max(skill_at) AS last_at
FROM picked
WHERE skill_at >= date_trunc('day', current_timestamp) - INTERVAL '${d - 1}' DAY
GROUP BY 1
ORDER BY 1 DESC`;
}

export function lastSeenQuery({ skill }) {
  return `
SELECT max(created_date) AS last_at, count(DISTINCT session_id) AS sessions_90d
FROM ${ENTRIES}
WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill'
  AND element_at(tool_call.arguments, 'name') = ${lit(skill)}
  AND created_date >= current_timestamp - INTERVAL '90' DAY`;
}

// Per-session step stats and timing for insights: per (tool, method, model) calls / failures /
// time, plus request → first generation → last good generation → turn completions, and the
// first turn's classified intent. Computed in Trino so insights never fetch sessions one by one.
export const STEPS_QUERY_VERSION = 1;
export function stepsDayQuery({ skill, day, hours = [0, 24], sample = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  checkHours(hours);
  const failed = `(tool_result.status LIKE '%ERROR%' OR element_at(tool_result.result, 'output') LIKE 'Exception%' OR element_at(tool_result.result, 'output') LIKE '%error_json:%')`;
  return `
WITH picked AS (
  SELECT session_id AS sid
  FROM ${ENTRIES}
  WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill'
    AND element_at(tool_call.arguments, 'name') = ${lit(skill)}
    AND created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY
    AND created_date < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR
  GROUP BY 1
  HAVING min(created_date) >= TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[0]}' HOUR
     AND min(created_date) < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR${sampleClause(sample)}
),
e AS (
  SELECT x.* FROM ${ENTRIES} x JOIN picked ON picked.sid = x.session_id
  WHERE x.created_date >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY
    AND x.created_date < TIMESTAMP '${day} 00:00:00' + INTERVAL '3' DAY
),
calls AS (
  SELECT session_id, tool_call.tool_call_id AS cid, element_at(tool_call.arguments, 'method') AS method,
         json_extract_scalar(element_at(tool_call.arguments, 'requestJson'), '$.parameters.model') AS pmodel
  FROM e WHERE entry_type = 'TOOL_CALL'
),
res AS (
  SELECT session_id, tool_result.tool_call_id AS cid, tool_result.tool_name AS tool, created_date,
         ${failed} AS failed,
         TRY_CAST(element_at(metadata, 'durationMs') AS double) AS ms,
         CASE WHEN tool_result.tool_name IN ('generate_image', 'edit_image') THEN json_extract_scalar(element_at(tool_result.result, 'output'), '$.model') END AS omodel,
         substr(coalesce(tool_result.error_message, element_at(tool_result.result, 'output')), 1, 180) AS msg
  FROM e WHERE entry_type = 'TOOL_RESULT'
),
st AS (
  SELECT r.session_id, r.tool, coalesce(c.method, '') AS method, coalesce(c.pmodel, r.omodel, '') AS model,
         count(*) AS n, count_if(r.failed) AS errs, sum(r.ms) AS ms, max(r.ms) AS max_ms,
         min_by(r.msg, r.created_date) FILTER (WHERE r.failed) AS err
  FROM res r LEFT JOIN calls c ON c.session_id = r.session_id AND c.cid = r.cid
  GROUP BY 1, 2, 3, 4
),
timing AS (
  SELECT session_id,
    min(created_date) FILTER (WHERE entry_type = 'USER_MESSAGE') AS request_at,
    min(created_date) FILTER (WHERE entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL) AS first_gen_at,
    max(created_date) FILTER (WHERE entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL AND NOT ${failed}) AS last_gen_ok_at,
    array_agg(created_date) FILTER (WHERE entry_type = 'TURN_BOUNDARY' AND turn_boundary.kind LIKE '%COMPLETED%') AS turn_done_ats,
    min_by(element_at(system_event.payload, 'intentSubcategory'), sequence) FILTER (WHERE entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis') AS intent,
    count(DISTINCT id) FILTER (WHERE entry_type = 'MODEL_CALL' AND model_call.status NOT LIKE '%SUCCESS%') AS llm_errors
  FROM e GROUP BY 1
)
SELECT t.*, s.steps
FROM timing t
LEFT JOIN (
  SELECT session_id, array_agg(concat_ws(chr(31), tool, method, model, CAST(n AS varchar), CAST(errs AS varchar),
    CAST(CAST(coalesce(round(ms), 0) AS bigint) AS varchar), CAST(CAST(coalesce(round(max_ms), 0) AS bigint) AS varchar),
    coalesce(replace(err, chr(31), ' '), ''))) AS steps
  FROM st GROUP BY 1
) s ON s.session_id = t.session_id
ORDER BY t.session_id`;
}
