import { Connection, Client } from '@temporalio/client';
import protos from '@temporalio/proto';
import { config } from './config.js';
import { cached } from './cache.js';
import { limited as limitedLane } from './limits.js';

let clientPromise;
function client() {
  if (!config.temporal.apiKey) throw new Error('No Temporal API key (set TEMPORAL_API_KEY or TEMPORAL_KEY_FILE)');
  clientPromise ??= Connection.connect({
    address: config.temporal.address,
    tls: true,
    apiKey: config.temporal.apiKey,
    metadata: { 'temporal-namespace': config.temporal.namespace },
  }).then((connection) => new Client({ connection, namespace: config.temporal.namespace }));
  return clientPromise;
}

// Temporal Cloud's prod namespace shares request limits with production workers; every call
// goes through the shared 'temporal' lane (see limits.js).
const limited = (fn) => limitedLane('temporal', fn);

export async function listByPrefix(prefix) {
  const c = await client();
  return limited(async () => {
    const out = [];
    for await (const w of c.workflow.list({ query: `WorkflowId STARTS_WITH '${prefix.replace(/'/g, '')}'` })) {
      out.push({
        workflowId: w.workflowId,
        runId: w.runId,
        type: w.type,
        status: w.status.name,
        taskQueue: w.taskQueue,
        startTime: w.startTime?.toISOString() ?? null,
        closeTime: w.closeTime?.toISOString() ?? null,
      });
      if (out.length >= 50) break;
    }
    return out.sort((a, b) => a.workflowId.length - b.workflowId.length);
  });
}

const { History } = protos.temporal.api.history.v1;

// History as plain objects: enum names as strings ('EVENT_TYPE_…'), bytes as base64, int64 as strings.
// (The SDK's historyToJSON trips over payload metadata in this version.)
export async function fetchHistory(workflowId, runId) {
  const c = await client();
  return limited(async () => {
    const history = await c.workflow.getHandle(workflowId, runId).fetchHistory();
    return History.toObject(History.fromObject(history), { enums: String, longs: String, bytes: String, defaults: false }).events ?? [];
  });
}

export function temporalUrl(workflowId, runId) {
  return `${config.temporal.uiBase}${encodeURIComponent(workflowId)}${runId ? `/${runId}/history` : ''}`;
}

// ---------- history → graph run ----------

// Proto Timestamps arrive as { seconds, nanos }.
const toMs = (t) => (t ? Number(t.seconds) * 1000 + Math.floor((t.nanos || 0) / 1e6) : null);

function decode(payloads) {
  return (payloads?.payloads ?? []).map((p) => {
    if (!p?.data) return null;
    const s = Buffer.from(p.data, 'base64').toString('utf8');
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  });
}

function attrs(e) {
  const k = Object.keys(e).find((k) => k.endsWith('Attributes'));
  return k ? e[k] : {};
}

function failureChain(f) {
  const out = [];
  for (let cur = f, i = 0; cur && i < 10; cur = cur.cause, i++) {
    out.push({ message: cur.message, type: cur.applicationFailureInfo?.type || (cur.timeoutFailureInfo ? 'Timeout' : undefined) });
  }
  return out;
}

function specNode(n) {
  const inner = n.childWorkflowNode || n.activityNode || n.genixWorkflowNode ||
    Object.values(n).find((v) => v && typeof v === 'object' && v.id);
  return inner ? { ...inner, kind: n.type } : null;
}

// Temporal child events don't carry the Genix node id, so match on workflow type, and
// break ties by how many of the node's literal params reappear in the child's input.
function matchNodes(specNodes, children) {
  const used = new Set();
  for (const ch of children) {
    const candidates = specNodes.filter((n) => !used.has(n.id) && n.workflow === ch.workflowType);
    if (!candidates.length) continue;
    let best = candidates[0];
    let confidence = candidates.length === 1 ? 'exact' : 'order';
    if (candidates.length > 1 && ch.input && typeof ch.input === 'object') {
      const score = (n) => Object.entries(n.params || {}).filter(([k, v]) => v !== '' && v != null && JSON.stringify(ch.input[k]) === JSON.stringify(v)).length;
      const scored = candidates.map((n) => [score(n), n]).sort((a, b) => b[0] - a[0]);
      if (scored[0][0] > (scored[1]?.[0] ?? -1)) confidence = 'scored';
      best = scored[0][1];
    }
    used.add(best.id);
    ch.nodeId = best.id;
    ch.matchConfidence = confidence;
  }
}

export function reduceGraphHistory(events) {
  const run = { children: [], activities: [], signals: [] };
  const byInitiated = new Map();
  const actBySched = new Map();

  for (const e of events) {
    const a = attrs(e);
    const t = e.eventType.replace('EVENT_TYPE_', '');
    const at = toMs(e.eventTime);
    switch (t) {
      case 'WORKFLOW_EXECUTION_STARTED': {
        const input = decode(a.input)[0] || {};
        Object.assign(run, {
          startedAt: at,
          workflowType: a.workflowType?.name,
          spec: input.spec ?? null,
          graphId: input.graphId ?? null,
          reqId: input.reqId ?? null,
          orderId: input.orderId ?? null,
          inputs: input.inputs ?? null,
          metadata: input.metadata ?? null,
        });
        break;
      }
      case 'START_CHILD_WORKFLOW_EXECUTION_INITIATED': {
        const ch = { workflowType: a.workflowType?.name, taskQueue: a.taskQueue?.name, input: decode(a.input)[0], initiatedAt: at, status: 'PENDING' };
        byInitiated.set(e.eventId, ch);
        run.children.push(ch);
        break;
      }
      case 'START_CHILD_WORKFLOW_EXECUTION_FAILED': {
        const ch = byInitiated.get(a.initiatedEventId);
        if (ch) Object.assign(ch, { status: 'FAILED', closedAt: at, errors: [{ message: `start failed: ${a.cause}` }] });
        break;
      }
      case 'CHILD_WORKFLOW_EXECUTION_STARTED': {
        const ch = byInitiated.get(a.initiatedEventId);
        if (ch) Object.assign(ch, { status: 'RUNNING', startedAt: at, workflowId: a.workflowExecution?.workflowId, runId: a.workflowExecution?.runId });
        break;
      }
      case 'CHILD_WORKFLOW_EXECUTION_COMPLETED':
      case 'CHILD_WORKFLOW_EXECUTION_FAILED':
      case 'CHILD_WORKFLOW_EXECUTION_TIMED_OUT':
      case 'CHILD_WORKFLOW_EXECUTION_CANCELED':
      case 'CHILD_WORKFLOW_EXECUTION_TERMINATED': {
        const ch = byInitiated.get(a.initiatedEventId);
        if (!ch) break;
        ch.status = t.replace('CHILD_WORKFLOW_EXECUTION_', '');
        ch.closedAt = at;
        if (a.result) ch.output = decode(a.result)[0];
        if (a.failure) ch.errors = failureChain(a.failure);
        break;
      }
      case 'WORKFLOW_EXECUTION_SIGNALED': {
        const input = decode(a.input)[0];
        run.signals.push({ name: a.signalName, at, input });
        break;
      }
      case 'ACTIVITY_TASK_SCHEDULED': {
        const act = { activityType: a.activityType?.name, input: decode(a.input)[0], scheduledAt: at, status: 'SCHEDULED' };
        actBySched.set(e.eventId, act);
        run.activities.push(act);
        break;
      }
      case 'ACTIVITY_TASK_STARTED': {
        const act = actBySched.get(a.scheduledEventId);
        if (act) Object.assign(act, { startedAt: at, attempt: a.attempt, status: 'RUNNING' });
        break;
      }
      case 'ACTIVITY_TASK_COMPLETED':
      case 'ACTIVITY_TASK_FAILED':
      case 'ACTIVITY_TASK_TIMED_OUT': {
        const act = actBySched.get(a.scheduledEventId);
        if (!act) break;
        act.status = t.replace('ACTIVITY_TASK_', '');
        act.closedAt = at;
        if (a.result) act.output = decode(a.result)[0];
        if (a.failure) act.errors = failureChain(a.failure);
        break;
      }
      case 'WORKFLOW_EXECUTION_COMPLETED':
        Object.assign(run, { status: 'COMPLETED', closedAt: at, result: decode(a.result)[0] });
        break;
      case 'WORKFLOW_EXECUTION_FAILED':
      case 'WORKFLOW_EXECUTION_TIMED_OUT':
      case 'WORKFLOW_EXECUTION_TERMINATED':
      case 'WORKFLOW_EXECUTION_CANCELED':
        Object.assign(run, { status: t.replace('WORKFLOW_EXECUTION_', ''), closedAt: at, errors: a.failure ? failureChain(a.failure) : [{ message: a.reason || t }] });
        break;
    }
  }
  run.status ??= 'RUNNING';

  // Cost signals name the child workflow that spent the money.
  for (const s of run.signals) {
    if (s.name !== 'costIncurred' || !s.input) continue;
    const ch = run.children.find((c) => c.workflowId === s.input.sourceWorkflowId);
    if (ch) {
      ch.costMicrocents = (ch.costMicrocents || 0) + (s.input.microcents || 0);
      ch.provider = s.input.provider;
      ch.endpoint = s.input.endpoint;
    }
  }

  const final = [...run.activities].reverse().find((x) => x.activityType === 'update_graph_execution_status_activity' && x.input?.status !== 'running');
  if (final?.input) {
    run.genixStatus = final.input.status;
    run.outputs = final.input.results;
    run.genixError = final.input.error;
    run.durationSec = final.input.duration;
    run.cost = final.input.cost_data;
  }

  const specNodes = (run.spec?.nodes || []).map(specNode).filter(Boolean);
  matchNodes(specNodes, run.children);

  for (const ch of run.children) {
    ch.queueMs = ch.startedAt && ch.initiatedAt ? ch.startedAt - ch.initiatedAt : null;
    ch.durationMs = ch.closedAt && (ch.startedAt || ch.initiatedAt) ? ch.closedAt - (ch.startedAt || ch.initiatedAt) : null;
    if (ch.workflowId) ch.temporalUrl = temporalUrl(ch.workflowId, ch.runId);
    // The top of a failure chain is generic ("Activity task failed"); the bottom says why.
    if (ch.errors?.length) ch.rootCause = ch.errors.at(-1).message;
  }
  run.durationMs = run.closedAt && run.startedAt ? run.closedAt - run.startedAt : null;
  run.graph = run.spec ? { name: run.spec.name, nodes: specNodes, edges: run.spec.edges || [], inputs: run.spec.inputs || [], outputs: run.spec.outputs || [] } : null;
  delete run.spec;
  delete run.signals;
  return run;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'TIMED_OUT', 'TERMINATED', 'CANCELED']);

async function loadGraphRun(workflowId, runId, depth) {
  const events = await fetchHistory(workflowId, runId);
  const run = reduceGraphHistory(events);
  run.workflowId = workflowId;
  run.temporalUrl = temporalUrl(workflowId, runId);
  // foreach nodes run nested run_graph_spec children; expand them in place.
  if (depth < 2) {
    for (const ch of run.children) {
      if (ch.workflowType === 'run_graph_spec' && ch.workflowId) {
        ch.sub = await loadGraphRun(ch.workflowId, ch.runId, depth + 1).catch((err) => ({ error: String(err.message || err) }));
      }
    }
  }
  return run;
}

// Full trace for one StartGraphExecution workflow id (the `workflow_id` in a tool result):
// the wrapper chain plus every Genix graph run under it.
export async function traceGeneration(workflowId) {
  const chain = await listByPrefix(workflowId);
  const graphRuns = [];
  for (const w of chain) {
    if (w.type !== 'execute_graph_v2') continue;
    const reqId = w.workflowId.slice(`${workflowId}-genix-`.length);
    if (!reqId) continue;
    const runs = await listByPrefix(reqId);
    const rgs = runs.find((r) => r.workflowId === reqId) || { workflowId: reqId };
    const run = await loadGraphRun(rgs.workflowId, rgs.runId, 0).catch((err) => ({ workflowId: reqId, error: String(err.message || err) }));
    graphRuns.push(run);
  }
  // When the wrapper failed before any graph ran, its own failure is the only clue.
  let wrapperErrors = null;
  const top = chain.find((w) => w.workflowId === workflowId);
  if (top && top.status !== 'COMPLETED' && TERMINAL.has(top.status)) {
    const r = reduceGraphHistory(await fetchHistory(top.workflowId, top.runId));
    wrapperErrors = r.errors || null;
  }
  return {
    workflowId,
    chain: chain.map((w) => ({ ...w, temporalUrl: temporalUrl(w.workflowId, w.runId) })),
    wrapperErrors,
    graphRuns,
    settled: chain.length > 0 && chain.every((w) => TERMINAL.has(w.status)),
  };
}

// A failed job's tool result has only a jobId, no workflow_id. The parent workflow's input
// carries job_id, so search failed parents started around the tool call and match on it.
export async function findWorkflowForJob(jobId, atMs) {
  const iso = (t) => new Date(t).toISOString();
  const query = `WorkflowType='StartGraphExecutionWorkflow' AND ExecutionStatus='Failed' AND StartTime BETWEEN '${iso(atMs - 30000)}' AND '${iso(atMs + 180000)}'`;
  const c = await client();
  const candidates = await limited(async () => {
    const out = [];
    for await (const w of c.workflow.list({ query })) {
      out.push({ workflowId: w.workflowId, runId: w.runId });
      if (out.length >= 40) break;
    }
    return out;
  });
  for (const w of candidates) {
    const events = await fetchHistory(w.workflowId, w.runId);
    const started = events[0] && attrs(events[0]);
    if (decode(started?.input)[0]?.job_id === jobId) return w.workflowId;
  }
  return null;
}

export function getJobTrace(jobId, atMs) {
  return cached('job-traces', jobId, Infinity, async () => {
    const workflowId = await findWorkflowForJob(jobId, atMs);
    const value = workflowId ? await traceGeneration(workflowId) : { jobId, workflowId: null, notFound: true };
    // A miss may just mean visibility lagged; don't pin it.
    return { value: { jobId, ...value }, ttlMs: workflowId && value.settled ? Infinity : 60000 };
  });
}

export function getGenerationTrace(workflowId, { fresh = false } = {}) {
  return cached('graph-runs', workflowId, fresh ? 0 : 30000, async () => {
    const value = await traceGeneration(workflowId);
    return { value, ttlMs: value.settled ? Infinity : 30000 };
  });
}
