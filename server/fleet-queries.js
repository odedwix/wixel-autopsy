// Fleet rollups: Trino SQL that reads one UTC day (or an hour window of it) of agent entries for
// ALL skills at once and returns totals only, never per-session rows. A day becomes a few small
// files; a week or a month is those files added up locally (fleet.js), with no extra upstream calls.
//
// Every query shares one scan of the day's entries with turn-scoped attribution worked out by
// window functions (Trino inlines CTEs, so a second reference would re-scan the table):
//   - each turn's lead = the first non-helper skill it loads, carried forward to later turns that
//     load none (skill loads from the 2 days before the window come along so carried-over sessions
//     keep their owner);
//   - the session's root = its first lead;
//   - owner = root when the lead is in root's family (wixel-ads → video-creation stays wixel-ads),
//     else the lead. Turns before any skill load belong to the first helper loaded, else "(none)".
// Families and helpers are computed locally from skill co-loads (runs.js familyFor) and passed in.

const ENTRIES = 'domain_events.www_wixel_agent.v1_session_entry_crud';
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (xs) => (xs.length ? `ARRAY[${xs.map(lit).join(',')}]` : 'CAST(ARRAY[] AS array(varchar))');

// Bump when a query's output changes, so cached days are re-queried.
export const FLEET_QUERY_VERSION = 9;

// Seconds; histogram bucket i holds durations in [EDGES[i-1], EDGES[i]) (bucket 0: below the first).
export const EDGES = [0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30, 45, 60, 90, 120, 180, 300, 450, 600, 900, 1200, 1800, 3600];
const edgesSql = `ARRAY[${EDGES.map((e) => `${e * 1000}e0`).join(',')}]`;

// Tools that are the agent's own plumbing (file system, method lookups), kept out of work chains.
export const PLUMBING = ['read', 'write', 'list', 'grep', 'get_rpc_method_definition', 'list_rpc_methods', 'get_workflow_definition', 'skill', 'send_feedback'];
// Tools that wait for the user, not the system: never failures, never "wait".
export const USER_TOOLS = ['ask_user'];

function checkWindow(day, hours) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  const [a, b] = hours;
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b <= 24 && a < b)) throw new Error(`bad hours ${a}-${b}`);
}
const t0 = (day, h) => `TIMESTAMP '${day} 00:00:00' + INTERVAL '${h}' HOUR`;

// Skills the platform preloaded into a message ("The \"wixel-ads\" skill is already loaded…").
const preloadNames = (meta) => `regexp_extract_all(element_at(${meta}, 'preloadedSkillBodies'), 'The \\\\"([\\w.:-]+)\\\\" skill is already loaded', 1)`;
// Utilities preloaded next to a product skill; never the session's skill when something else is there.
const UTILITY = ['export-handler'];

// The shared scan + attribution. `ctx`: { helpers: [skill], famPairs: ['root>member'], internal: [accountId] }.
function attributed(day, hours, ctx) {
  checkWindow(day, hours);
  const from = t0(day, hours[0]);
  const to = t0(day, hours[1]);
  const pad = (x) => `lpad(CAST(${x} AS varchar), 14, '0')`;
  return `base AS (
  SELECT session_id, turn_id, sequence, created_date, entry_type, user_id,
    coalesce(_logged_account_id, _target_account_id) AS acct,
    tool_call, tool_result, model_call, turn_boundary, system_event, metadata, user_message.text AS umsg, false AS pre
  FROM ${ENTRIES}
  WHERE created_date >= ${from} AND created_date < ${to}
  UNION ALL
  SELECT session_id, turn_id, sequence, created_date, entry_type, NULL, NULL, tool_call, NULL, NULL, NULL, NULL, metadata, NULL, true
  FROM ${ENTRIES}
  WHERE created_date >= ${from} - INTERVAL '2' DAY AND created_date < ${from}
    AND ((entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill')
      OR (entry_type = 'USER_MESSAGE' AND created_date >= ${from} - INTERVAL '1' DAY AND element_at(metadata, 'preloadedSkillBodies') IS NOT NULL))
),
-- A skill reaches a turn two ways: the agent calls the skill tool, or (since 2026-09-30) the
-- platform preloads it into the session's first message (metadata.preloadedSkillBodies). A
-- preload counts as a load at that message; with several, the product skill wins over utilities.
l0 AS (
  SELECT b.*, CASE WHEN entry_type = 'USER_MESSAGE' THEN ${preloadNames('metadata')} END AS pl
  FROM base b
),
l AS (
  SELECT l0.*,
    CASE WHEN entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill' THEN element_at(tool_call.arguments, 'name')
         WHEN cardinality(pl) > 0 THEN coalesce(element_at(filter(pl, x -> NOT contains(${arr([...ctx.helpers, ...UTILITY])}, x)), 1), element_at(pl, 1)) END AS loads
  FROM l0
),
t1 AS (
  SELECT l.*,
    min(sequence) OVER (PARTITION BY session_id, turn_id) AS tseq,
    min(CASE WHEN loads IS NOT NULL AND NOT contains(${arr(ctx.helpers)}, loads) THEN ${pad('sequence')} || loads END) OVER (PARTITION BY session_id, turn_id) AS tp,
    min(CASE WHEN loads IS NOT NULL THEN ${pad('sequence')} || loads END) OVER (PARTITION BY session_id, turn_id) AS ta,
    max(acct) OVER (PARTITION BY session_id) AS sacct
  FROM l
),
t2 AS (
  SELECT t1.*,
    substr(max(CASE WHEN tp IS NOT NULL THEN ${pad('tseq')} || substr(tp, 15) END) OVER (PARTITION BY session_id ORDER BY tseq), 15) AS lead,
    substr(max(CASE WHEN ta IS NOT NULL THEN ${pad('tseq')} || substr(ta, 15) END) OVER (PARTITION BY session_id ORDER BY tseq), 15) AS lany,
    substr(min(CASE WHEN tp IS NOT NULL THEN ${pad('tseq')} || substr(tp, 15) END) OVER (PARTITION BY session_id), 15) AS root
  FROM t1
),
e AS (
  SELECT t2.*,
    CASE WHEN lead IS NULL THEN coalesce(lany, '(none)')
         WHEN root IS NOT NULL AND contains(${arr(ctx.famPairs)}, root || '>' || lead) THEN root
         ELSE lead END AS owner,
    CASE WHEN contains(${arr(ctx.internal)}, sacct) THEN 'internal' ELSE 'real' END AS aud
  FROM t2 WHERE NOT pre
)`;
}

// Per tool result: what was called (method, model, size, argument shape, call time — brought over
// from the call by tool_call_id) and how it went.
function results() {
  const rj = `element_at(tool_call.arguments, 'requestJson')`;
  const norm = (x) => `regexp_replace(regexp_replace(regexp_replace(${x}, 'https?://[^"\\\\ ]+', 'U'), '[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}', 'I'), '"(?:[^"\\\\]|\\\\.){40,}"', 'S')`;
  const shape = `to_hex(xxhash64(to_utf8(concat(coalesce(${norm(rj)}, ''), '|', ${norm(`json_format(CAST(map_filter(tool_call.arguments, (k, v) -> k <> 'requestJson') AS json))`)}))))`;
  const dur = `TRY_CAST(json_extract_scalar(${rj}, '$.parameters.duration') AS double)`;
  // Inputs that change how long a job takes: clip length (bucketed) and resolution.
  const size = `nullif(concat_ws(' · ', CASE WHEN ${dur} <= 5 THEN '≤5s' WHEN ${dur} <= 8 THEN '6–8s' WHEN ${dur} <= 12 THEN '9–12s' WHEN ${dur} > 12 THEN '>12s' END,
      json_extract_scalar(${rj}, '$.parameters.resolution')), '')`;
  const callCol = (x) => `max(CASE WHEN entry_type = 'TOOL_CALL' THEN ${x} END) OVER (PARTITION BY session_id, cid)`;
  return `c AS (
  SELECT e.*, coalesce(tool_call.tool_call_id, tool_result.tool_call_id) AS cid FROM e
),
j AS (
  SELECT c.*,
    ${callCol(`CASE WHEN tool_call.tool_name = 'invoke_rpc' THEN element_at(tool_call.arguments, 'method') WHEN tool_call.tool_name = 'invoke_workflow' THEN coalesce(element_at(tool_call.arguments, 'workflowName'), element_at(tool_call.arguments, 'appId')) END`)} AS method,
    ${callCol(`json_extract_scalar(${rj}, '$.parameters.model')`)} AS pmodel,
    ${callCol(size)} AS size,
    ${callCol(shape)} AS shape,
    ${callCol(`to_hex(xxhash64(to_utf8(json_format(CAST(tool_call.arguments AS json)))))`)} AS exact,
    ${callCol('created_date')} AS call_at
  FROM c
),
r AS (
  SELECT j.*,
    tool_result.tool_name AS tool,
    element_at(tool_result.result, 'output') AS out,
    TRY_CAST(element_at(metadata, 'durationMs') AS double) AS ms,
    element_at(metadata, 'synthesized') IS NOT NULL AS synth,
    json_extract_scalar(element_at(tool_result.result, 'output'), '$.processJob.status') AS pj
  FROM j
),
f AS (
  SELECT r.*,
    coalesce(pmodel, CASE WHEN tool IN ('generate_image', 'edit_image') THEN json_extract_scalar(out, '$.model') END, '') AS model,
    -- coalesce: a NULL output or status must read as "no", or NOT failed would drop the row.
    coalesce(entry_type = 'TOOL_RESULT' AND NOT contains(${arr(USER_TOOLS)}, tool) AND (
      tool_result.status LIKE '%ERROR%' OR out LIKE 'Exception%' OR out LIKE '%error_json:%' OR synth), false) AS failed,
    coalesce(entry_type = 'TOOL_RESULT' AND NOT tool_result.status LIKE '%ERROR%' AND pj IN ('IN_PROGRESS', 'PENDING', 'QUEUED', 'RUNNING'), false) AS hidden
  FROM r
),
w AS (
  SELECT f.*,
    (failed OR hidden) AS bad,
    lag(failed OR hidden) OVER (PARTITION BY session_id, turn_id, tool, method ORDER BY sequence) AS prev_bad,
    lag(created_date) OVER (PARTITION BY session_id, turn_id, tool, method ORDER BY sequence) AS prev_at,
    min(CASE WHEN NOT (failed OR hidden) THEN created_date END) OVER (PARTITION BY session_id, turn_id, tool, method ORDER BY sequence ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_ok_at,
    -- When the next successful attempt was CALLED: recovery ends there (its own run time isn't lost).
    min(CASE WHEN NOT (failed OR hidden) THEN call_at END) OVER (PARTITION BY session_id, turn_id, tool, method ORDER BY sequence ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_ok_call_at,
    max(created_date) OVER (PARTITION BY session_id, turn_id) AS turn_end,
    bool_or(entry_type = 'TURN_BOUNDARY' AND turn_boundary.kind LIKE '%FAILED%') OVER (PARTITION BY session_id, turn_id) AS turn_failed,
    max(CASE WHEN entry_type = 'USER_MESSAGE' THEN created_date END) OVER (PARTITION BY session_id) AS last_user_at,
    max(CASE WHEN entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis' AND element_at(system_event.payload, 'sentimentLabel') IN ('frustrated', 'confused') THEN created_date END) OVER (PARTITION BY session_id) AS last_upset_at,
    lag(created_date) OVER (PARTITION BY session_id ORDER BY sequence) AS prev_entry_at,
    max(CASE WHEN entry_type = 'TURN_BOUNDARY' THEN element_at(metadata, 'codexVersionId') END) OVER (PARTITION BY session_id, turn_id) AS ver
  FROM f
)`;
}

const msDiff = (a, b) => `CAST(to_milliseconds(${a} - ${b}) AS double)`;
// Time lost to a run of consecutive failures of one operation in a turn: every failed call's own
// duration, plus ONE recovery per run — from the run's first failure until the next successful
// attempt of that operation was called (else the turn's end).
const RUN_START = `NOT coalesce(prev_bad, false)`;
const RECOVERY = `greatest(0e0, ${'CAST(to_milliseconds(coalesce(next_ok_call_at, turn_end) - created_date) AS double)'})`;
const hist = (x, cond) => `histogram(CASE WHEN ${cond} THEN width_bucket(${x}, ${edgesSql}) END)`;

// ---- Q1: usage per skill ----
// One summary row per (owner, audience) (tool = NULL): sessions, accounts, turns, model iterations
// and tokens, agent thinking time, user replies, upset users, skill versions. Plus one row per
// (owner, audience, tool, method): calls, failures, hidden timeouts (the tool returned while its
// job was still running), time lost, retries and argument-shape variety. The rarest operations
// are folded into one "(other)" row per skill so the result stays under the endpoint's 500 rows.
const TOP_OPS = 470;
const AFFIRM = `length(umsg) <= 40 AND regexp_like(lower(trim(umsg)), '^(yes|yep|yeah|ok|okay|sure|approve|approved|looks good|lgtm|go|go ahead|continue|proceed|perfect|great|good|do it|confirm|confirmed|sounds good|כן|sí|si|oui|ja|sim|👍)[\\s.!]*$')`;
export function usageQuery({ day, hours = [0, 24], ctx }) {
  const isRes = `entry_type = 'TOOL_RESULT'`;
  const tb = `entry_type = 'TURN_BOUNDARY'`;
  const ta = (label) => `entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis' AND element_at(system_event.payload, 'sentimentLabel') = '${label}'`;
  // [name, aggregate over entries, how folded rows combine]
  const M = [
    ['calls', `count(*) FILTER (WHERE ${isRes})`, 'sum'],
    ['fails', 'count_if(failed)', 'sum'],
    ['hidden', 'count_if(hidden)', 'sum'],
    ['interrupted', `count_if(synth AND ${isRes} AND NOT contains(${arr(USER_TOOLS)}, tool))`, 'sum'],
    ['bad_ms', `sum(ms) FILTER (WHERE ${isRes} AND bad)`, 'sum'],
    ['lost_ms', `coalesce(sum(coalesce(ms, 0)) FILTER (WHERE ${isRes} AND bad), 0) + coalesce(sum(${RECOVERY}) FILTER (WHERE ${isRes} AND bad AND ${RUN_START}), 0)`, 'sum'],
    ['unrecovered', `count_if(${isRes} AND bad AND next_ok_at IS NULL)`, 'sum'],
    ['retries', `count_if(${isRes} AND prev_bad)`, 'sum'],
    ['retry_ok', `count_if(${isRes} AND prev_bad AND NOT bad)`, 'sum'],
    ['ok_ms', `sum(ms) FILTER (WHERE ${isRes} AND NOT bad)`, 'sum'],
    ['shapes', `approx_distinct(shape) FILTER (WHERE ${isRes})`, 'sum'],
    ['sessions', 'count(DISTINCT session_id)', 'sum'],
    ['accounts', 'approx_distinct(sacct)', 'sum'],
    ['turns', `count(DISTINCT turn_id) FILTER (WHERE ${tb})`, 'sum'],
    ['failed_turns', `count(DISTINCT turn_id) FILTER (WHERE ${tb} AND turn_boundary.kind LIKE '%FAILED%')`, 'sum'],
    ['turn_ms', `sum(turn_boundary.duration_ms) FILTER (WHERE ${tb} AND turn_boundary.kind NOT LIKE '%STARTED%')`, 'sum'],
    ['iterations', `count(*) FILTER (WHERE entry_type = 'MODEL_CALL')`, 'sum'],
    ['model_errors', `count(*) FILTER (WHERE entry_type = 'MODEL_CALL' AND model_call.status NOT LIKE '%SUCCESS%')`, 'sum'],
    ['in_tokens', 'sum(model_call.usage.input_tokens)', 'sum'],
    ['cached_tokens', 'sum(model_call.usage.cached_input_tokens)', 'sum'],
    ['out_tokens', 'sum(model_call.usage.output_tokens)', 'sum'],
    ['think_ms', `sum(${msDiff('created_date', 'prev_entry_at')}) FILTER (WHERE entry_type = 'MODEL_CALL' AND prev_entry_at IS NOT NULL AND created_date - prev_entry_at < INTERVAL '10' MINUTE)`, 'sum'],
    ['user_msgs', `count(*) FILTER (WHERE entry_type = 'USER_MESSAGE')`, 'sum'],
    ['affirm_msgs', `count(*) FILTER (WHERE entry_type = 'USER_MESSAGE' AND ${AFFIRM})`, 'sum'],
    ['frustrated', `count(*) FILTER (WHERE ${ta('frustrated')})`, 'sum'],
    ['confused', `count(*) FILTER (WHERE ${ta('confused')})`, 'sum'],
    ['versions', `histogram(CASE WHEN ${tb} AND turn_boundary.kind LIKE '%STARTED%' THEN element_at(metadata, 'codexVersionId') END)`, 'arbitrary'],
  ];
  return `
WITH ${attributed(day, hours, ctx)},
${results()},
g AS (
  SELECT owner, aud, CASE WHEN ${isRes} THEN tool END AS tool, CASE WHEN ${isRes} THEN coalesce(method, '') END AS method,
    ${M.map(([n, x]) => `${x} AS ${n}`).join(',\n    ')}
  FROM w
  GROUP BY 1, 2, 3, 4
),
k AS (
  SELECT g.*, CASE WHEN tool IS NULL THEN 0 ELSE row_number() OVER (PARTITION BY tool IS NULL ORDER BY calls DESC, owner, aud, tool, method) END AS rk,
    -- Room left after the summary rows and one fold row per skill.
    ${TOP_OPS} - 2 * sum(IF(tool IS NULL, 1, 0)) OVER () AS cap
  FROM g WHERE tool IS NULL OR calls > 0
)
SELECT owner, aud, IF(rk <= cap, tool, '(other)') AS tool, IF(rk <= cap, method, '') AS method,
  ${M.map(([n, , f]) => `${f}(${n}) AS ${n}`).join(', ')}, count(*) AS folded
FROM k
GROUP BY 1, 2, 3, 4
ORDER BY owner, aud, calls DESC, tool, method`;
}

// ---- Q2: timing per operation ----
// How long each operation takes, across all skills (timing is the system's, not the skill's):
// one row per (tool, method, model, size bucket) with success and failure duration histograms
// (mergeable across days, so week and month percentiles stay exact to the bucket), hidden
// timeouts and their durations, and how retries went.
export function timingQuery({ day, hours = [0, 24], ctx }) {
  const isRes = `entry_type = 'TOOL_RESULT'`;
  return `
WITH ${attributed(day, hours, ctx)},
${results()}
SELECT tool, coalesce(method, '') AS method, model, coalesce(size, '') AS size,
  count(*) AS calls, count_if(failed) AS fails, count_if(hidden) AS hidden, count_if(synth) AS interrupted,
  ${hist('ms', 'NOT bad AND ms IS NOT NULL')} AS ok_hist,
  ${hist('ms', 'bad AND ms IS NOT NULL')} AS bad_hist,
  sum(ms) FILTER (WHERE NOT bad) AS ok_ms, sum(ms) FILTER (WHERE bad) AS bad_ms, max(ms) AS max_ms,
  min(ms) FILTER (WHERE hidden) AS hidden_min_ms, max(ms) FILTER (WHERE hidden) AS hidden_max_ms,
  count_if(prev_bad) AS retries, count_if(prev_bad AND NOT bad) AS retry_ok,
  sum(${msDiff('call_at', 'prev_at')}) FILTER (WHERE prev_bad AND call_at > prev_at) AS retry_gap_ms,
  count_if(bad AND next_ok_at IS NULL) AS unrecovered,
  approx_distinct(shape) AS shapes, approx_distinct(exact) AS vals, count(DISTINCT session_id) AS sessions,
  histogram(owner) AS owners
FROM w
WHERE ${isRes} AND NOT contains(${arr(USER_TOOLS)}, tool)
GROUP BY 1, 2, 3, 4
HAVING count(*) >= 3
ORDER BY calls DESC, 1, 2, 3, 4
LIMIT 480`;
}

// Error text → signature: what failed and why, without the parts that differ per call.
// Wrappers are dropped (the gateway's "Exception during invocation of Prompt", PredictionId,
// taskUUID, service class names, request ids, "Before retrying…" advice); when the message carries
// a JSON error body, the provider's own error code and message are kept after an arrow
// ("Error invoking endpoint: [N] → failedToTransferImage: Invalid value for 'referenceImages[N]'…");
// then URLs, ids and numbers are blanked and long quoted prose dropped.
function signatureSql(msg) {
  let m = `substr(${msg}, 1, 1500)`;
  m = `regexp_replace(${m}, 'Exception during invocation of Prompt ''[^'']*''\\.?\\s*', '')`;
  m = `regexp_replace(${m}, 'PredictionId: \\S+\\s*', '')`;
  m = `regexp_replace(${m}, '\\[taskUUID=[^\\]]*\\]\\s*', '')`;
  m = `regexp_replace(${m}, '\\[com\\.wixpress[^\\]]*\\]\\s*', '')`;
  m = `regexp_replace(${m}, 'request id: \\S+\\s*', '')`;
  m = `regexp_replace(${m}, '(?s)\\s*Before retrying.*$', '')`;
  const pre = `trim(regexp_extract(${m}, '^([^{]*)', 1))`;
  const code = `regexp_extract(${m}, '"(?:code|errorCode)"\\s*:\\s*"([A-Za-z][\\w.]{2,60})"', 1)`;
  const mess = `coalesce(regexp_extract(${m}, '"(?:message|errorMessage)"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,160})', 1), regexp_extract(${m}, '"error"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,160})', 1))`;
  const empty = `regexp_like(${m}, '"errors"\\s*:\\s*(\\[\\s*\\]|\\})')`;
  const inner = `CASE
      WHEN strpos(${m}, '{') > 0 AND ${code} IS NULL AND ${empty} THEN concat_ws(' → ', nullif(${pre}, ''), '(provider returned an empty error)')
      WHEN strpos(${m}, '{') > 0 AND (${code} IS NOT NULL OR ${mess} IS NOT NULL) THEN concat_ws(' → ', nullif(${pre}, ''), concat_ws(': ', ${code}, ${mess}))
      ELSE ${m} END`;
  let x = `substr(${inner}, 1, 500)`;
  x = `regexp_replace(${x}, 'https?://\\S+', '<url>')`;
  x = `regexp_replace(${x}, '"(?=[^"]{25,}")[^"]*\\s[^"]*"', '"…"')`;
  x = `regexp_replace(${x}, '(?i)[0-9a-f]{8}-[0-9a-f-]{27,}', '<id>')`;
  x = `regexp_replace(${x}, '(?i)\\b[0-9a-f]{16,}\\b', '<id>')`;
  x = `regexp_replace(${x}, '\\d+(\\.\\d+)?', 'N')`;
  x = `regexp_replace(${x}, '\\\\[nrt]|\\s+', ' ')`;
  return `substr(trim(${x}), 1, 160)`;
}

// ---- Q3: failure signatures ----
const TOP_SIGS = 470;
export function failuresQuery({ day, hours = [0, 24], ctx }) {
  const msg = `coalesce(tool_result.error_message, out, '')`;
  return `
WITH ${attributed(day, hours, ctx)},
${results()},
b AS (
  SELECT w.*,
    CASE WHEN hidden THEN 'Tool returned while its job was still ' || pj || ' (hidden timeout)'
         WHEN synth THEN 'Interrupted: ' || ${signatureSql(msg)}
         ELSE ${signatureSql(msg)} END AS sig
  FROM w WHERE entry_type = 'TOOL_RESULT' AND bad
),
g AS (
  SELECT owner, aud, tool, coalesce(method, '') AS method, sig,
    count(*) AS n,
    count(DISTINCT session_id) AS sessions,
    approx_distinct(sacct) AS users,
    count_if(hidden) AS hidden,
    sum(coalesce(ms, 0)) AS ms,
    coalesce(sum(${RECOVERY}) FILTER (WHERE ${RUN_START}), 0) AS recover_ms,
    count_if(next_ok_at IS NULL) AS unrecovered,
    count_if(turn_failed) AS turn_failed,
    -- Ended the session: never recovered in the turn and the user never wrote again.
    count_if(next_ok_at IS NULL AND (last_user_at IS NULL OR last_user_at < created_date)) AS abandoned,
    count_if(last_upset_at > created_date) AS upset_after,
    histogram(model) AS models,
    histogram(ver) AS versions,
    histogram(hour(created_date)) AS hours,
    arbitrary(substr(${msg}, 1, 400)) AS example,
    slice(array_agg(concat_ws('|', session_id, CAST(CAST(to_unixtime(created_date) * 1000 AS bigint) AS varchar),
      coalesce(json_extract_scalar(out, '$.jobId'), json_extract_scalar(out, '$.processJob.jobId'), ''))), 1, 4) AS examples
  FROM b
  GROUP BY 1, 2, 3, 4, 5
),
-- At most ~400 rows: the endpoint pages by re-running the query, so the long tail of rare
-- signatures is folded into one "(other errors)" row per skill and audience.
k AS (
  SELECT g.*, row_number() OVER (ORDER BY n DESC, owner, aud, tool, method, sig) AS rk,
    ${TOP_SIGS} - approx_distinct(owner || aud) OVER () AS cap
  FROM g
)
SELECT owner, aud,
  IF(rk <= cap, tool, '') AS tool, IF(rk <= cap, method, '') AS method, IF(rk <= cap, sig, '(other errors)') AS sig,
  sum(n) AS n, sum(sessions) AS sessions, sum(users) AS users, sum(hidden) AS hidden, sum(ms) AS ms, sum(recover_ms) AS recover_ms,
  sum(unrecovered) AS unrecovered, sum(turn_failed) AS turn_failed, sum(abandoned) AS abandoned, sum(upset_after) AS upset_after,
  IF(max(rk) <= max(cap), arbitrary(models)) AS models, IF(max(rk) <= max(cap), arbitrary(versions)) AS versions,
  IF(max(rk) <= max(cap), arbitrary(hours)) AS hours, IF(max(rk) <= max(cap), arbitrary(example)) AS example,
  IF(max(rk) <= max(cap), arbitrary(examples)) AS examples, count(*) AS folded
FROM k
GROUP BY 1, 2, 3, 4, 5
ORDER BY 6 DESC, 1, 2, 3, 4, 5`;
}

// ---- Q3: work chains and conversation patterns ----
// Per turn, the ordered chain of non-plumbing tool steps (repeats collapsed), how many model
// iterations and tokens it took and whether it went through cleanly; grouped by (owner,
// audience, chain). Plus per-turn plumbing counts and repeated reads of the same path, and
// whether the turn's user message was a bare "yes / ok" after the previous turn asked something.
export function chainsQuery({ day, hours = [0, 24], ctx }) {
  const step = `CASE WHEN entry_type = 'TOOL_CALL' AND NOT contains(${arr(PLUMBING)}, tool_call.tool_name)
      THEN tool_call.tool_name || coalesce(':' || CASE WHEN tool_call.tool_name = 'invoke_rpc' THEN element_at(tool_call.arguments, 'method') END, '') END`;
  return `
WITH ${attributed(day, hours, ctx)},
tt AS (
  SELECT owner, aud, session_id, turn_id, min(tseq) AS tseq,
    array_agg(${step} ORDER BY sequence) FILTER (WHERE ${step} IS NOT NULL) AS steps,
    count(*) FILTER (WHERE entry_type = 'TOOL_CALL' AND contains(${arr(PLUMBING)}, tool_call.tool_name)) AS plumbing,
    count(*) FILTER (WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'read')
      - count(DISTINCT element_at(tool_call.arguments, 'path')) FILTER (WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'read') AS reread,
    count(*) FILTER (WHERE entry_type = 'MODEL_CALL') AS iterations,
    sum(model_call.usage.input_tokens) AS in_tokens,
    sum(model_call.usage.output_tokens) AS out_tokens,
    max(turn_boundary.duration_ms) AS turn_ms,
    bool_or(entry_type = 'TOOL_RESULT' AND tool_result.status LIKE '%ERROR%') AS had_error,
    bool_or(entry_type = 'TURN_BOUNDARY' AND turn_boundary.kind LIKE '%FAILED%') AS failed,
    bool_or(entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'ask_user') AS asked,
    max_by(${step}, sequence) FILTER (WHERE ${step} IS NOT NULL) AS last_step,
    bool_or(entry_type = 'USER_MESSAGE' AND ${AFFIRM}) AS affirm
  FROM e
  GROUP BY 1, 2, 3, 4
),
tc AS (
  SELECT tt.*,
    array_join(slice(reduce(coalesce(steps, ARRAY[]), CAST(ARRAY[] AS array(varchar)),
      (s, x) -> IF(cardinality(s) > 0 AND element_at(s, -1) = x, s, s || x), s -> s), 1, 12), ' › ') AS chain,
    cardinality(coalesce(steps, ARRAY[])) AS nsteps,
    lag(asked) OVER (PARTITION BY session_id ORDER BY tseq) AS prev_asked,
    lag(last_step) OVER (PARTITION BY session_id ORDER BY tseq) AS prev_last
  FROM tt
),
-- Each turn counts once per row kind it belongs to (its chain, all turns, a bare "yes" turn),
-- in one pass over tc (a UNION of three SELECTs would scan the table three times).
x AS (
  SELECT owner, aud, kind,
    CASE kind WHEN 'chain' THEN chain WHEN 'affirm' THEN coalesce(prev_last, '') ELSE '' END AS k,
    count(*) AS turns, count(DISTINCT session_id) AS sessions, sum(nsteps) AS steps, sum(iterations) AS iterations,
    sum(in_tokens) AS in_tokens, sum(out_tokens) AS out_tokens, sum(turn_ms) AS turn_ms, count_if(had_error) AS with_errors,
    count_if(failed) AS failed,
    -- plumbing: file operations; for 'affirm' rows, how many followed an explicit question.
    IF(kind = 'affirm', count_if(prev_asked), sum(plumbing)) AS plumbing, sum(reread) AS reread
  FROM tc CROSS JOIN UNNEST(ARRAY['chain', 'turns', 'affirm']) AS u(kind)
  WHERE kind = 'turns' OR (kind = 'chain' AND nsteps >= 2) OR (kind = 'affirm' AND affirm)
  GROUP BY 1, 2, 3, 4
  HAVING kind <> 'chain' OR count(*) >= 3
),
-- At most ~480 rows: every 'turns' and 'affirm' row, then the most common chains.
y AS (
  SELECT x.*, sum(IF(kind = 'chain', 0, 1)) OVER () AS fixed,
    IF(kind = 'chain', row_number() OVER (PARTITION BY kind = 'chain' ORDER BY turns DESC, owner, aud, k), 0) AS rk
  FROM x
)
SELECT owner, aud, kind, k, turns, sessions, steps, iterations, in_tokens, out_tokens, turn_ms, with_errors, failed, plumbing, reread
FROM y WHERE rk <= 480 - fixed
ORDER BY owner, aud, kind, turns DESC, k`;
}

// ---- Q0: the accounts active on the day (one row: a comma list) ----
// Classified locally with the per-account cache (runs.js resolveUserTypes): accounts repeat from
// day to day, so after the first days only new ones are looked up.
export function dayAccountsQuery({ day }) {
  checkWindow(day, [0, 24]);
  return `
SELECT array_join(array_agg(DISTINCT coalesce(_logged_account_id, _target_account_id)), ',') AS accounts
FROM ${ENTRIES}
WHERE created_date >= ${t0(day, 0)} AND created_date < ${t0(day, 24)} AND entry_type = 'USER_MESSAGE'
  AND coalesce(_logged_account_id, _target_account_id) IS NOT NULL`;
}

// (Previous approach, kept for reference: one ~20 s anti-join per day — times out under load.)
// ---- internal accounts active on the day ----
// The vizion rule (an account missing from prod.wt_accounts.base is an employee) plus the Wixel
// team list, for the accounts that wrote a message that day. One ~20s query; only the internal
// ones come back (a few dozen).
export function internalAccountsQuery({ day }) {
  checkWindow(day, [0, 24]);
  return `
WITH a AS (
  SELECT DISTINCT coalesce(_logged_account_id, _target_account_id) AS acct
  FROM ${ENTRIES}
  WHERE created_date >= ${t0(day, 0)} AND created_date < ${t0(day, 24)} AND entry_type = 'USER_MESSAGE'
),
x AS (
  SELECT a.acct, b.account_id IS NULL AS missing, t.account_id IS NOT NULL AS team, count(*) OVER () AS accounts
  FROM a
  LEFT JOIN prod.wt_accounts.base b ON b.account_id = a.acct
  LEFT JOIN (SELECT DISTINCT account_id FROM sandbox.www.slides_employees_team) t ON t.account_id = a.acct
  WHERE a.acct IS NOT NULL
)
SELECT acct, CASE WHEN team THEN 'wixel-team' ELSE 'employee' END AS kind, accounts
FROM x WHERE missing OR team`;
}

// ---- Q5: outcomes — did the session's output get kept? ----
// Per session active on the day, owned by its first non-helper skill (session-level, not turn by
// turn: downloads happen in the editor, outside turns): did the agent produce assets (asset
// writes / handed-over assets), did anyone download them (the editor's download event, users_193 evid 19,
// or the agent's download tool), how many generations it took, and thumbs up / down.
export function outcomesQuery({ day, ctx }) {
  checkWindow(day, [0, 24]);
  const pad = (x) => `lpad(CAST(${x} AS varchar), 14, '0')`;
  const from = t0(day, 0);
  const to = t0(day, 24);
  return `
WITH src AS (
  SELECT session_id, sequence, entry_type, tool_call, tool_result, system_event, metadata, _logged_account_id, _target_account_id, false AS pre
  FROM ${ENTRIES} WHERE created_date >= ${from} AND created_date < ${to}
  UNION ALL
  -- The day before: only what tells a continuing session's skill (skill loads and preloads).
  SELECT session_id, sequence, entry_type, tool_call, NULL, NULL, metadata, NULL, NULL, true
  FROM ${ENTRIES}
  WHERE created_date >= ${from} - INTERVAL '1' DAY AND created_date < ${from}
    AND ((entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill') OR (entry_type = 'USER_MESSAGE' AND element_at(metadata, 'preloadedSkillBodies') IS NOT NULL))
),
s AS (
  SELECT session_id,
    substr(min(CASE
      WHEN entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'skill' AND NOT contains(${arr(ctx.helpers)}, element_at(tool_call.arguments, 'name'))
        THEN ${pad('sequence')} || element_at(tool_call.arguments, 'name')
      WHEN entry_type = 'USER_MESSAGE' AND element_at(metadata, 'preloadedSkillBodies') IS NOT NULL
        THEN ${pad('sequence')} || coalesce(element_at(filter(${preloadNames('metadata')}, x -> NOT contains(${arr([...ctx.helpers, ...UTILITY])}, x)), 1), element_at(${preloadNames('metadata')}, 1)) END), 15) AS root,
    max(coalesce(_logged_account_id, _target_account_id)) AS acct,
    count(*) FILTER (WHERE entry_type = 'TOOL_RESULT' AND element_at(tool_result.result, 'jobId') IS NOT NULL AND tool_result.status NOT LIKE '%ERROR%') AS gens,
    count(*) FILTER (WHERE entry_type = 'TOOL_RESULT' AND tool_result.tool_name IN ('generate_image', 'edit_image') AND tool_result.status NOT LIKE '%ERROR%') AS images,
    count(*) FILTER (WHERE entry_type = 'TOOL_CALL' AND tool_call.tool_name = 'download') AS agent_dl,
    count(*) FILTER (WHERE entry_type = 'USER_MESSAGE' AND NOT pre) AS msgs,
    -- What the user asked for (the product's own intent label, first turn) and whether they got upset.
    min_by(element_at(system_event.payload, 'intentText'), sequence) FILTER (WHERE entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis') AS intent,
    coalesce(bool_or(NOT pre AND entry_type = 'SYSTEM_EVENT' AND system_event.event_name = 'turn_analysis' AND element_at(system_event.payload, 'sentimentLabel') IN ('frustrated', 'confused')), false) AS upset
  FROM src
  GROUP BY 1
  HAVING count_if(NOT pre) > 0
),
ev AS (
  SELECT session_id,
    -- Assets the agent wrote or handed over. TURN_UPDATED_ASSETS was only logged 2026-09-16 → 09-28;
    -- WRITE_METERING (every asset write) and AGENT_MENTIONED_ASSETS cover the rest.
    count(*) FILTER (WHERE event_type IN ('TURN_UPDATED_ASSETS', 'AGENT_MENTIONED_ASSETS')
      OR (event_type = 'WRITE_METERING' AND element_at(payload, 'outcome') = 'written' AND element_at(payload, 'path') LIKE 'project/assets/%')) AS assets,
    count(*) FILTER (WHERE event_type = 'USER_FEEDBACK' AND element_at(payload, 'feedback') = 'thumbs_up') AS up,
    count(*) FILTER (WHERE event_type = 'USER_FEEDBACK' AND element_at(payload, 'feedback') = 'thumbs_down') AS down
  FROM domain_events.www_wixel_agent.v1_session_event_crud
  WHERE created_date >= ${from} AND created_date < ${to} + INTERVAL '1' DAY
    AND event_type IN ('TURN_UPDATED_ASSETS', 'AGENT_MENTIONED_ASSETS', 'WRITE_METERING', 'USER_FEEDBACK')
  GROUP BY 1
),
pr AS (
  SELECT id AS session_id, max_by(project_id, revision) AS project_id
  FROM domain_events.www_wixel_agent.v1_session_crud
  WHERE created_date >= ${from} - INTERVAL '2' DAY AND created_date < ${to}
  GROUP BY 1
),
dl AS (
  SELECT project_id, count(*) AS n
  FROM events.dbo.users_193
  WHERE evid = 19 AND result = 'success' AND date_created >= ${from} AND date_created < ${to} + INTERVAL '1' DAY
  GROUP BY 1
)
-- One pass, two groupings: per skill, and per first intent (with which skills served it).
SELECT IF(grouping(x.owner) = 0, x.owner) AS owner, IF(grouping(x.intent) = 0, x.intent) AS intent, x.aud,
  count(*) AS sessions,
  count_if(x.upset) AS upset,
  IF(grouping(x.intent) = 0, histogram(x.owner)) AS owners,
  count_if(x.assets_n > 0) AS produced,
  count_if(x.assets_n > 0 AND (x.dl_n > 0 OR x.agent_dl > 0)) AS kept,
  count_if(x.dl_n > 0) AS ui_downloaded,
  count_if(x.agent_dl > 0) AS agent_downloaded,
  count_if(x.assets_n = 0 AND (x.gens + x.images) > 0) AS tried_no_output,
  sum(x.gens + x.images) AS generations,
  sum(x.gens + x.images) FILTER (WHERE x.assets_n > 0 AND (x.dl_n > 0 OR x.agent_dl > 0)) AS kept_generations,
  count_if(x.msgs >= 4) AS long_sessions,
  sum(x.up_n) AS thumbs_up,
  sum(x.down_n) AS thumbs_down
FROM (
  SELECT s.session_id, s.gens, s.images, s.agent_dl, s.msgs, s.upset, coalesce(s.root, '(none)') AS owner, coalesce(s.intent, '(unknown)') AS intent,
    CASE WHEN contains(${arr(ctx.internal)}, s.acct) THEN 'internal' ELSE 'real' END AS aud,
    coalesce(ev.assets, 0) AS assets_n, coalesce(ev.up, 0) AS up_n, coalesce(ev.down, 0) AS down_n, coalesce(dl.n, 0) AS dl_n
  FROM s
  LEFT JOIN ev ON ev.session_id = s.session_id
  LEFT JOIN pr ON pr.session_id = s.session_id
  LEFT JOIN dl ON dl.project_id = pr.project_id
) x
GROUP BY GROUPING SETS ((x.owner, x.aud), (x.intent, x.aud))
HAVING grouping(x.owner) = 0 OR count(*) >= 3
ORDER BY 4 DESC, 1, 2, 3`;
}
