// Trino SQL, run through the admin analytics endpoint (see admin.js `sql`).

const ENTRIES = 'domain_events.www_wixel_agent.v1_session_entry_crud';
const SESSIONS = 'domain_events.www_wixel_agent.v1_session_crud';
const ACCOUNTS = 'prod.wt_accounts.base';
const SESSION_DIM = 'prod.wixel.agent_session_dim';
const TEAM = 'sandbox.www.slides_employees_team';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const days = (n) => Math.max(1, Math.min(90, Math.floor(Number(n) || 7)));

// ---- skill loads ----
// A skill reaches a session two ways: the agent calls the skill tool, or (since 2026-09-30) the
// platform preloads it into the session's first USER_MESSAGE (metadata.preloadedSkillBodies, a JSON
// array of "<preloaded_skill>\nThe \"<name>\" skill is already loaded…" strings) and the agent never
// calls the tool for it. A preload counts as a load at that message. A utility preloaded next to a
// product skill (export-handler + single-page-design) isn't a load: the product skill is the work.
// `x` is a table alias prefix ('x.' or '').
const UTILITY = ['export-handler'];
const preloadBodies = (x) => `element_at(${x}metadata, 'preloadedSkillBodies')`;
const preloadAll = (x) => `regexp_extract_all(${preloadBodies(x)}, 'The \\\\"([\\w.:-]+)\\\\" skill is already loaded', 1)`;
const utilities = `ARRAY[${UTILITY.map(lit).join(', ')}]`;
const preloadLoads = (x) => `IF(cardinality(array_except(${preloadAll(x)}, ${utilities})) > 0, array_except(${preloadAll(x)}, ${utilities}), ${preloadAll(x)})`;
const isToolLoad = (x) => `${x}entry_type = 'TOOL_CALL' AND ${x}tool_call.tool_name = 'skill'`;
const isPreload = (x) => `${x}entry_type = 'USER_MESSAGE' AND ${preloadBodies(x)} IS NOT NULL`;
// Entries that may load a skill (the cheap pre-filter for scans that only want loads).
const isLoad = (x = '') => `((${isToolLoad(x)}) OR (${isPreload(x)}))`;
// The skills an entry loads (array), or NULL when it loads none.
const loadsOf = (x = '') => `CASE WHEN ${isToolLoad(x)} AND element_at(${x}tool_call.arguments, 'name') IS NOT NULL THEN ARRAY[element_at(${x}tool_call.arguments, 'name')]
         WHEN ${isPreload(x)} THEN ${preloadLoads(x)} END`;
// Preloads began on 2026-09-30. Reading messages' metadata is what makes these scans slow, so the
// preload half never looks earlier than this (a 90-day scan would time out otherwise).
const PRELOADS_FROM = `TIMESTAMP '2026-09-29 00:00:00'`;
// Every load of `skill` in a time range (`range(col)` → the created_date condition), as rows of
// (session_id, created_date). Two scans in a UNION ALL: tool calls, and preloads (the LIKE keeps
// the regexp to the few messages that can match). One OR'd scan was ~2x slower.
const skillLoads = (skill, range) => `(
    SELECT session_id, created_date FROM ${ENTRIES}
    WHERE ${isToolLoad('')} AND element_at(tool_call.arguments, 'name') = ${lit(skill)}
      AND ${range('created_date')}
    UNION ALL
    SELECT session_id, created_date FROM ${ENTRIES}
    WHERE ${isPreload('')} AND ${preloadBodies('')} LIKE ${lit(`%"${skill}\\" skill is already loaded%`)} AND contains(${preloadLoads('')}, ${lit(skill)})
      AND created_date >= ${PRELOADS_FROM} AND ${range('created_date')}
  )`;

// Skills and how many sessions loaded each, for the skill picker.
export function skillsQuery({ windowDays = 30 } = {}) {
  const since = `created_date >= current_timestamp - INTERVAL '${days(windowDays)}' DAY`;
  return `
SELECT skill, count(DISTINCT session_id) AS sessions, max(created_date) AS last_at
FROM (
  SELECT session_id, created_date, element_at(tool_call.arguments, 'name') AS skill FROM ${ENTRIES}
  WHERE ${isToolLoad('')} AND ${since}
  UNION ALL
  SELECT session_id, created_date, skill FROM ${ENTRIES} CROSS JOIN UNNEST(${preloadLoads('')}) AS l(skill)
  WHERE ${isPreload('')} AND created_date >= ${PRELOADS_FROM} AND ${since}
) l
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

// ---- scope: which sessions, and which of their turns, a day query counts ----
// A scope is either a skill ({ skill, family }) or a list of sessions ({ ids }, user mode).
//
// Skill scope, turn by turn: a turn that loads the skill claims the session; the turns after it
// stay with the skill until one loads a skill outside its family (the helpers it loads alongside
// it, e.g. wixel-ads → site-content, video-creation), which hands the session over to that other
// work. Turns before the first claim never count. `family: null` counts whole sessions.
const skillNames = (xs) => [...new Set(xs.filter((x) => /^[\w.:-]{1,80}$/.test(x)))];

function checkScope(sc) {
  if (sc.ids) {
    if (!sc.ids.length || sc.ids.some((id) => !/^[\w-]{36}$/.test(id))) throw new Error('bad session ids');
  } else if (!sc.skill) throw new Error('scope needs a skill or session ids');
}
const turnScoped = (sc) => Boolean(sc.skill && !sc.ids && Array.isArray(sc.family));

function pickedCte(sc, day, hours) {
  if (sc.ids) return `picked AS (SELECT sid, CAST(NULL AS timestamp(3)) AS skill_at FROM UNNEST(ARRAY[${sc.ids.map(lit).join(',')}]) AS t(sid))`;
  return `picked AS (
  SELECT session_id AS sid, min(created_date) AS skill_at
  FROM ${skillLoads(sc.skill, (c) => `${c} >= TIMESTAMP '${day} 00:00:00' - INTERVAL '1' DAY
      AND ${c} < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR`)} l
  GROUP BY 1
  HAVING min(created_date) >= TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[0]}' HOUR
     AND min(created_date) < TIMESTAMP '${day} 00:00:00' + INTERVAL '${hours[1]}' HOUR${sampleClause(sc.sample)}
)`;
}

// The entries read for the picked sessions. A whole day reads from the day before (sessions that
// started then). An hour window [h, 24) — a slice of a heavy day, or Refresh's top-up — reads from 6 h
// before h: the picked sessions first loaded the skill at h or later, so their counted turns start
// there, and the turn that loaded it began moments before. Turns before the scan only feed the
// whole-session extras (other skills used, turn count). Reading far less of the table is what makes
// a top-up quick.
const LOOKBACK_H = 6;
function windowOf(col, day, hours = [0, 24]) {
  const from = hours[0] > 0 ? hours[0] - LOOKBACK_H : -24;
  return `${col} >= TIMESTAMP '${day} 00:00:00' ${from < 0 ? '-' : '+'} INTERVAL '${Math.abs(from)}' HOUR
    AND ${col} < TIMESTAMP '${day} 00:00:00' + INTERVAL '3' DAY`;
}

// Per turn: does it load the skill (claims) or a skill outside the family (other)? Read from the
// turn boundaries and skill loads only, so it stays cheap next to the main scan.
function ownCtes(sc, day, hours) {
  if (!turnScoped(sc)) return '';
  const keep = skillNames([sc.skill, ...sc.family]).map(lit).join(', ');
  return `,
tl0 AS (
  SELECT x.session_id, x.turn_id, x.sequence, ${loadsOf('x.')} AS lds
  FROM ${ENTRIES} x JOIN picked ON picked.sid = x.session_id
  WHERE ${windowOf('x.created_date', day, hours)}
    AND (x.entry_type = 'TURN_BOUNDARY' OR ${isLoad('x.')})
),
tl AS (
  SELECT session_id, turn_id, min(sequence) AS seq,
    coalesce(bool_or(contains(lds, ${lit(sc.skill)})), false) AS claims,
    coalesce(bool_or(cardinality(filter(lds, s -> s NOT IN (${keep}))) > 0), false) AS other
  FROM tl0
  GROUP BY 1, 2
),
own AS (
  SELECT session_id, turn_id FROM (
    SELECT session_id, turn_id,
      max(CASE WHEN claims THEN seq END) OVER (PARTITION BY session_id ORDER BY seq ROWS UNBOUNDED PRECEDING) AS lc,
      max(CASE WHEN other AND NOT claims THEN seq END) OVER (PARTITION BY session_id ORDER BY seq ROWS UNBOUNDED PRECEDING) AS lo
    FROM tl
  ) m
  WHERE lc IS NOT NULL AND (lo IS NULL OR lc > lo)
)`;
}
// The same rule over rows already scanned (no second pass over the table, which Trino would do
// for a second CTE reference): per turn, its first sequence and whether it claims or hands over,
// then a running max over turns gives the last claim / last handover before each row.
function ownedRows(sc) {
  if (!turnScoped(sc)) return `e AS (SELECT e0.*, true AS owned FROM e0),`;
  const keep = skillNames([sc.skill, ...sc.family]).map(lit).join(', ');
  return `t AS (
  SELECT e0.*,
    min(sequence) OVER (PARTITION BY session_id, turn_id) AS tseq,
    coalesce(bool_or(contains(lds, ${lit(sc.skill)})) OVER (PARTITION BY session_id, turn_id), false) AS tclaims,
    coalesce(bool_or(cardinality(filter(lds, s -> s NOT IN (${keep}))) > 0) OVER (PARTITION BY session_id, turn_id), false) AS tother
  FROM e0
),
m AS (
  SELECT t.*,
    max(CASE WHEN tclaims THEN tseq END) OVER (PARTITION BY session_id ORDER BY tseq) AS lc,
    max(CASE WHEN tother AND NOT tclaims THEN tseq END) OVER (PARTITION BY session_id ORDER BY tseq) AS lo
  FROM t
),
e AS (SELECT m.*, (lc IS NOT NULL AND (lo IS NULL OR lc > lo)) AS owned FROM m),`;
}
const ownJoin = (sc) => (turnScoped(sc) ? '\n  JOIN own ON own.session_id = x.session_id AND own.turn_id = x.turn_id' : '');

// Bump when runsDayQuery's output changes, so cached days are re-queried.
export const RUNS_QUERY_VERSION = 16;

export function runsDayQuery({ scope, day, hours = [0, 24] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  checkHours(hours);
  checkScope(scope);
  return `
WITH ${pickedCte(scope, day, hours)},
e0 AS (
  SELECT x.*, picked.skill_at AS picked_at, element_at(x.tool_result.result, 'output') AS out,
    ${loadsOf('x.')} AS lds
  FROM ${ENTRIES} x JOIN picked ON picked.sid = x.session_id
  WHERE ${windowOf('x.created_date', day, hours)}
),
${ownedRows(scope)}
agg AS (
  SELECT
    session_id,
    min(created_date) FILTER (WHERE owned) AS first_ts,
    max(created_date) FILTER (WHERE owned) AS last_ts,
    arbitrary(user_id) FILTER (WHERE owned) AS user_id,
    arbitrary(_msid) FILTER (WHERE owned) AS msid,
    arbitrary(coalesce(_logged_account_id, _target_account_id)) FILTER (WHERE owned) AS account_id,
    min_by(user_message.text, sequence) FILTER (WHERE owned AND entry_type = 'USER_MESSAGE') AS prompt,
    arbitrary(picked_at) FILTER (WHERE owned) AS skill_at,
    count(DISTINCT id) FILTER (WHERE owned AND entry_type = 'USER_MESSAGE') AS user_messages,
    count(DISTINCT id) FILTER (WHERE owned AND entry_type = 'TOOL_CALL') AS tool_calls,
    count(DISTINCT id) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL) AS generations,
    count(DISTINCT id) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND (
      tool_result.status LIKE '%ERROR%' OR out LIKE 'Exception%' OR out LIKE '%error_json:%')) AS errors,
    min_by(substr(coalesce(tool_result.error_message, out), 1, 300), sequence) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND (
      tool_result.status LIKE '%ERROR%' OR out LIKE 'Exception%' OR out LIKE '%error_json:%')) AS first_error,
    count(DISTINCT id) FILTER (WHERE owned AND entry_type = 'TURN_BOUNDARY' AND turn_boundary.kind LIKE '%FAILED%') AS failed_turns,
    count(DISTINCT id) FILTER (WHERE owned AND entry_type = 'TURN_BOUNDARY' AND turn_boundary.kind LIKE '%STARTED%') AS turns,
    max(turn_boundary.duration_ms) FILTER (WHERE owned) AS longest_turn_ms,
    array_agg(DISTINCT element_at(tool_call.arguments, 'method')) FILTER (WHERE owned AND entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'invoke_rpc') AS methods,
    array_agg(DISTINCT element_at(metadata, 'codexVersionId')) FILTER (WHERE owned AND entry_type = 'TURN_BOUNDARY' AND element_at(metadata, 'codexVersionId') IS NOT NULL) AS codex_versions,
    array_distinct(flatten(array_agg(lds) FILTER (WHERE owned AND lds IS NOT NULL))) AS skills,
    min_by(regexp_extract(out, 'https://[^"\\\\ ]+?\\.mp4'), sequence) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL AND out LIKE '%.mp4%') AS first_clip,
    max_by(regexp_extract(out, 'https://[^"\\\\ ]+?\\.mp4'), sequence) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL AND out LIKE '%.mp4%') AS last_clip,
    array_agg(DISTINCT element_at(system_event.payload, 'sentimentLabel')) FILTER (WHERE owned AND entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis' AND element_at(system_event.payload, 'sentimentLabel') IS NOT NULL) AS sentiments,
    max_by(element_at(system_event.payload, 'sentimentLabel'), sequence) FILTER (WHERE owned AND entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis') AS last_sentiment,
    max_by(element_at(system_event.payload, 'sentimentDetail'), sequence) FILTER (WHERE owned AND entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis' AND element_at(system_event.payload, 'sentimentLabel') IN ('frustrated', 'confused')) AS sentiment_detail,
    count(DISTINCT id) FILTER (WHERE owned AND entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'download') AS agent_downloads,
    max_by(regexp_extract(out, 'https://links\\.wixel\\.com/link/[A-Za-z0-9_-]+'), sequence) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND tool_result.tool_name = 'download') AS agent_download_link,
    min_by(regexp_extract(out, 'https://static\\.wixstatic\\.com/media/[^"\\\\ ]+?\\.(?:png|jpg|jpeg|webp)'), sequence) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND tool_result.tool_name IN ('generate_image', 'edit_image')) AS first_image,
    -- The whole session, for saying what the counted turns left out.
    array_distinct(flatten(array_agg(lds) FILTER (WHERE lds IS NOT NULL))) AS all_skills,
    count(DISTINCT turn_id) FILTER (WHERE entry_type = 'TURN_BOUNDARY') AS all_turns,
    max(created_date) AS whole_last_ts,
    array_agg(DISTINCT turn_id) FILTER (WHERE owned) AS owned_turns,
    -- The assets the counted turns wrote: every successful write names them ("Created
    -- project/assets/<name>--<id8>.json (type: …, id: <id>…", batch writes list "id":"<id>"). The
    -- one record of a sub-agent's writes, which WRITE_METERING doesn't log.
    -- A sequence (generate → write in one call) holds its write steps' results; there only the
    -- write header counts, since other steps' output is in there too.
    -- (array_agg of no rows is NULL, and concat with a NULL is NULL: hence the coalesces.)
    array_distinct(concat(
      coalesce(flatten(array_agg(regexp_extract_all(substr(out, 1, 20000), 'id(?:: |":")([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 1))
        FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND tool_result.tool_name = 'write' AND out NOT LIKE 'Error%')), CAST(ARRAY[] AS array(varchar))),
      coalesce(flatten(array_agg(regexp_extract_all(substr(out, 1, 40000), '(?:Created|Edited|Saved) project/assets/[^(]{0,300}\\(type: [^,]{1,60}, id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 1))
        FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND tool_result.tool_name = 'sequence')), CAST(ARRAY[] AS array(varchar))))) AS written_ids,
    -- Why a run made nothing (toRun reads these only then): the end of what the counted turns last
    -- said, the sentences in it that put a number on credits ("needs about 88 credits"), how the last
    -- turn ended (STARTED = still open, e.g. on a question), the last tool called, the last question
    -- put to the user (a widget's name, or the question's subtitle), and the credits the agent saw:
    -- ListCosts' availableCredits and the plan's daily cap.
    max_by(substr(assistant_message.text, greatest(1, length(assistant_message.text) - 399)), sequence)
      FILTER (WHERE owned AND entry_type = 'ASSISTANT_MESSAGE' AND length(assistant_message.text) > 0) AS last_reply,
    max_by(slice(regexp_extract_all(assistant_message.text, '[^.!?;\\n。]*\\d\\s*\\**\\s*(?i:credit|crédit|crédito|crediti|kredi|kredyt|קרדיט|кредит|クレジット|크레딧|积分)[^.!?\\n。]*'), 1, 2), sequence)
      FILTER (WHERE owned AND entry_type = 'ASSISTANT_MESSAGE' AND length(assistant_message.text) > 0) AS credit_notes,
    bool_or(assistant_message.text LIKE '%wixel-plans%') FILTER (WHERE owned AND entry_type = 'ASSISTANT_MESSAGE') AS upgrade_link,
    max_by(turn_boundary.kind, sequence) FILTER (WHERE owned AND entry_type = 'TURN_BOUNDARY') AS last_turn_kind,
    max_by(tool_call.tool_name, sequence) FILTER (WHERE owned AND entry_type = 'TOOL_CALL') AS last_tool,
    max_by(coalesce(regexp_extract(element_at(tool_call.arguments, 'questions'), '"componentName":"([\\w-]+)"', 1), ''), sequence)
      FILTER (WHERE owned AND entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'ask_user') AS ask_widget,
    max_by(substr(coalesce(json_extract_scalar(element_at(tool_call.arguments, 'questions'), '$[0].subtitle'), json_extract_scalar(element_at(tool_call.arguments, 'questions'), '$[0].title'), ''), 1, 200), sequence)
      FILTER (WHERE owned AND entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'ask_user') AS ask_text,
    max_by(json_extract_scalar(out, '$.availableCredits'), sequence) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND out LIKE '{"availableCredits"%') AS credits_available,
    max_by(json_extract_scalar(out, '$.dailyLimit.cap'), sequence) FILTER (WHERE owned AND entry_type = 'TOOL_RESULT' AND out LIKE '%"dailyLimit"%') AS credits_day_cap
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
//
// What a session made is read from its own events, never from what else appeared in the project
// (projects are shared: a campaign's sub-agents make a post, a story and a video side by side):
//   WRITE_METERING          every asset write (since 2026-07-09): path 'project/assets/<name>--<id8>.json'
//   TURN_UPDATED_ASSETS     the editor's per-turn report (logged 09-16 → 09-28 and again from 10-05)
//   AGENT_MENTIONED_ASSETS  assets handed to the user (also existing ones the agent only referred to)
export function eventsDayQuery({ scope, day, hours = [0, 24] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  checkHours(hours);
  checkScope(scope);
  // Each event keeps its turn (id␟turn[␟value]); runs.js drops the turns the scope doesn't count,
  // using the runs query's owned_turns. Keeps this query to one pass over the events table.
  const t = `coalesce(x.turn_id, '')`;
  return `
WITH ${pickedCte(scope, day, hours)}
SELECT
  x.session_id,
  array_agg(DISTINCT concat(x.id, chr(31), ${t})) FILTER (WHERE x.event_type = 'USER_FEEDBACK' AND element_at(x.payload, 'feedback') = 'thumbs_up') AS thumbs_up_t,
  array_agg(DISTINCT concat(x.id, chr(31), ${t})) FILTER (WHERE x.event_type = 'USER_FEEDBACK' AND element_at(x.payload, 'feedback') = 'thumbs_down') AS thumbs_down_t,
  array_agg(DISTINCT concat(x.id, chr(31), ${t}, chr(31), element_at(x.payload, 'tags'))) FILTER (WHERE x.event_type = 'USER_FEEDBACK' AND element_at(x.payload, 'tags') IS NOT NULL) AS feedback_tags_t,
  array_agg(DISTINCT concat(x.id, chr(31), ${t})) FILTER (WHERE x.event_type = 'OUT_OF_FUNDS') AS out_of_funds_t,
  array_agg(DISTINCT concat(x.id, chr(31), ${t})) FILTER (WHERE x.event_type = 'MODEL_STREAM_ERROR') AS stream_errors_t,
  -- The assets each turn reported (id, name, type, snapshotUrl, children).
  array_agg(concat(x.id, chr(31), ${t}, chr(31), element_at(x.payload, 'assets'))) FILTER (WHERE x.event_type = 'TURN_UPDATED_ASSETS') AS asset_events_t,
  -- Every asset write: path (with the asset id's first 8 hex once it exists), intent, asset type.
  array_agg(concat(x.id, chr(31), ${t}, chr(31), coalesce(element_at(x.payload, 'path'), ''), chr(31), coalesce(element_at(x.payload, 'intent'), ''), chr(31), coalesce(element_at(x.payload, 'assetType'), '')))
    FILTER (WHERE x.event_type = 'WRITE_METERING' AND element_at(x.payload, 'outcome') = 'written') AS asset_writes_t,
  -- Assets handed to the user: { assetId: '{"name","type","snapshotUrl","isFallback"}' }.
  array_agg(concat(x.id, chr(31), ${t}, chr(31), json_format(CAST(x.payload AS json)))) FILTER (WHERE x.event_type = 'AGENT_MENTIONED_ASSETS') AS asset_mentions_t
FROM domain_events.www_wixel_agent.v1_session_event_crud x JOIN picked ON picked.sid = x.session_id
WHERE ${windowOf('x.created_date', day, hours)}
  AND x.event_type IN ('USER_FEEDBACK', 'OUT_OF_FUNDS', 'MODEL_STREAM_ERROR', 'TURN_UPDATED_ASSETS', 'WRITE_METERING', 'AGENT_MENTIONED_ASSETS')
GROUP BY 1
ORDER BY 1`;
}

// Which UTC days in the window have sessions that first loaded `skill`, and when it last ran.
// Cheap (skill loads only), so the day slices are only queried where there's data.
export function runsIndexQuery({ skill, windowDays }) {
  const d = days(windowDays);
  return `
WITH picked AS (
  SELECT session_id, min(created_date) AS skill_at
  FROM ${skillLoads(skill, (c) => `${c} >= date_trunc('day', current_timestamp) - INTERVAL '${d}' DAY`)} l
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
FROM ${skillLoads(skill, (c) => `${c} >= current_timestamp - INTERVAL '90' DAY`)} l`;
}

// Per-session step stats and timing for insights: per (tool, method, model) calls / failures /
// time, plus request → first generation → last good generation → turn completions, and the
// first turn's classified intent. Computed in Trino so insights never fetch sessions one by one.
export const STEPS_QUERY_VERSION = 6;
export function stepsDayQuery({ scope, day, hours = [0, 24] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  checkHours(hours);
  checkScope(scope);
  const failed = `(tool_result.status LIKE '%ERROR%' OR element_at(tool_result.result, 'output') LIKE 'Exception%' OR element_at(tool_result.result, 'output') LIKE '%error_json:%')`;
  return `
WITH ${pickedCte(scope, day, hours)}${ownCtes(scope, day, hours)},
e AS (
  SELECT x.* FROM ${ENTRIES} x JOIN picked ON picked.sid = x.session_id${ownJoin(scope)}
  WHERE ${windowOf('x.created_date', day, hours)}
),
calls AS (
  SELECT session_id, tool_call.tool_call_id AS cid, created_date AS call_at, element_at(tool_call.arguments, 'method') AS method,
         json_extract_scalar(element_at(tool_call.arguments, 'requestJson'), '$.parameters.model') AS pmodel,
         TRY_CAST(json_extract_scalar(element_at(tool_call.arguments, 'requestJson'), '$.parameters.duration') AS double) AS pdur
  FROM e WHERE entry_type = 'TOOL_CALL'
),
res AS (
  SELECT session_id, tool_result.tool_call_id AS cid, tool_result.tool_name AS tool, created_date,
         ${failed} AS failed,
         element_at(tool_result.result, 'output') LIKE '%"status":"IN_PROGRESS"%' AS unfinished,
         TRY_CAST(element_at(metadata, 'durationMs') AS double) AS ms,
         CASE WHEN tool_result.tool_name IN ('generate_image', 'edit_image') THEN json_extract_scalar(element_at(tool_result.result, 'output'), '$.model') END AS omodel,
         -- The Genix graph a media job ran: the key into the product's price list (ListCosts).
         regexp_extract(element_at(tool_result.result, 'output'), 'graph execution for (\\w+)', 1) AS graph,
         substr(coalesce(tool_result.error_message, element_at(tool_result.result, 'output')), 1, 180) AS msg
  FROM e WHERE entry_type = 'TOOL_RESULT'
),
st AS (
  SELECT r.session_id, r.tool, coalesce(c.method, '') AS method, coalesce(c.pmodel, r.omodel, '') AS model,
         count(*) AS n, count_if(r.failed) AS errs, sum(r.ms) AS ms, max(r.ms) AS max_ms,
         min_by(r.msg, r.created_date) FILTER (WHERE r.failed) AS err,
         arbitrary(r.graph) FILTER (WHERE r.graph IS NOT NULL) AS graph,
         sum(c.pdur) FILTER (WHERE NOT r.failed) AS billed_sec,
         -- Where the time went (runs.js timeBreakdown): each call that is a generation, a sub-agent, a
         -- question to the user or a failure, as flag:end ms:duration ms (flag 0 ok, 1 failed, 2 returned
         -- with its job still running; a call blocks until its job is done, so end − duration is when it
         -- started). Everything else counts as the agent's own time.
         -- (No durationMs on some results, ask_user's among them: then from the call's own time.)
         array_agg(concat_ws(':', IF(r.failed, '1', IF(r.unfinished, '2', '0')), CAST(CAST(round(to_unixtime(r.created_date) * 1000) AS bigint) AS varchar),
             CAST(CAST(round(coalesce(r.ms, date_diff('millisecond', c.call_at, r.created_date))) AS bigint) AS varchar)))
           FILTER (WHERE coalesce(r.ms, date_diff('millisecond', c.call_at, r.created_date)) > 0 AND (r.failed OR r.tool IN ('generate_image', 'edit_image', 'convert_image_format', 'sequence', 'analyze_image', 'ask_user', 'task')
             OR (r.tool = 'invoke_rpc' AND regexp_like(coalesce(c.method, ''), '^generate|^Generate|^holdStill|^transformVideo|LogoShot|Animation$|Speech|Music|InvokeImageWorkflow|composeImage|DescribeVideo|mergeVoice')))) AS spans
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
    count(DISTINCT id) FILTER (WHERE entry_type = 'MODEL_CALL' AND model_call.status NOT LIKE '%SUCCESS%') AS llm_errors,
    -- Each counted turn's start and end as turn␟s|e␟ms (a turn still open ends at last_ms).
    array_agg(concat_ws(chr(31), turn_id, IF(turn_boundary.kind LIKE '%STARTED%', 's', 'e'), CAST(CAST(round(to_unixtime(created_date) * 1000) AS bigint) AS varchar)))
      FILTER (WHERE entry_type = 'TURN_BOUNDARY' AND turn_id IS NOT NULL) AS turn_marks,
    CAST(round(to_unixtime(max(created_date)) * 1000) AS bigint) AS last_ms
  FROM e GROUP BY 1
)
SELECT t.*, s.steps
FROM timing t
LEFT JOIN (
  SELECT session_id, array_agg(concat_ws(chr(31), tool, method, model, CAST(n AS varchar), CAST(errs AS varchar),
    CAST(CAST(coalesce(round(ms), 0) AS bigint) AS varchar), CAST(CAST(coalesce(round(max_ms), 0) AS bigint) AS varchar),
    coalesce(replace(err, chr(31), ' '), ''), coalesce(graph, ''), CAST(coalesce(round(billed_sec, 1), 0) AS varchar), coalesce(array_join(spans, ','), ''))) AS steps
  FROM st GROUP BY 1
) s ON s.session_id = t.session_id
ORDER BY t.session_id`;
}

// How often each pair of skills is loaded in the same turn (last 3 days, all sessions), for
// working out a skill's family: the helpers it loads alongside it. Skill loads only, so cheap.
// A preload counts with everything preloaded (export-handler too): those are loaded together.
export function skillPairsQuery() {
  return `
WITH t AS (
  SELECT session_id, turn_id, array_distinct(flatten(array_agg(
    CASE WHEN ${isPreload('')} THEN ${preloadAll('')} ELSE ARRAY[element_at(tool_call.arguments, 'name')] END))) AS sk
  FROM ${ENTRIES}
  WHERE ${isLoad()}
    AND created_date >= current_timestamp - INTERVAL '3' DAY
  GROUP BY 1, 2
),
n AS (SELECT a, count(*) AS turns FROM t CROSS JOIN UNNEST(sk) AS x(a) GROUP BY 1)
SELECT x.a, y.b, count(*) AS together, max(n.turns) AS a_turns
FROM t CROSS JOIN UNNEST(sk) AS x(a) CROSS JOIN UNNEST(sk) AS y(b) JOIN n ON n.a = x.a
WHERE x.a <> y.b
GROUP BY 1, 2
HAVING count(*) * 100 >= max(n.turns) * 2
ORDER BY 1, 3 DESC`;
}
