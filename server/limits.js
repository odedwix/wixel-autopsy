// Guardrails for the production systems this proxy reads from. Every upstream call goes through
// one of these: a concurrency cap, a minimum spacing between calls, and rolling counters that
// the UI shows, so load stays small and visible.
//
//   trino    — the admin API's SQL endpoint → the shared Trino analytics cluster
//   admin    — the Wixel admin API (production BO service reading the agent's session store)
//   temporal — Temporal Cloud prod namespace (shares request limits with production workers)

const LIMITS = {
  trino: { concurrency: 4, minIntervalMs: 250 },
  admin: { concurrency: 3, minIntervalMs: 150 },
  temporal: { concurrency: 2, minIntervalMs: 250 },
};

const WINDOW_MS = 5 * 60000;
const lanes = {};
for (const [name, cfg] of Object.entries(LIMITS)) {
  lanes[name] = { ...cfg, active: 0, queue: [], last: 0, calls: [], total: 0, errors: 0 };
}

function prune(lane) {
  const cutoff = Date.now() - WINDOW_MS;
  while (lane.calls.length && lane.calls[0] < cutoff) lane.calls.shift();
}

const abortError = () => Object.assign(new Error('request cancelled'), { name: 'AbortError' });

// Waiting callers can be cancelled (the browser moved on); a call already running is left to
// finish — its result still fills the cache, and aborting it wouldn't stop the upstream work.
async function acquire(lane, signal) {
  if (signal?.aborted) throw abortError();
  if (lane.active >= lane.concurrency) {
    await new Promise((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = lane.queue.indexOf(entry);
        if (i >= 0) lane.queue.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      lane.queue.push(entry);
    });
  }
  lane.active++;
  const wait = lane.last + lane.minIntervalMs - Date.now();
  lane.last = Math.max(Date.now(), lane.last + lane.minIntervalMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function release(lane) {
  lane.active--;
  lane.queue.shift()?.();
}

export async function limited(name, fn, { signal } = {}) {
  const lane = lanes[name];
  await acquire(lane, signal);
  lane.calls.push(Date.now());
  lane.total++;
  prune(lane);
  try {
    return await fn();
  } catch (err) {
    lane.errors++;
    throw err;
  } finally {
    release(lane);
  }
}

export function loadReport() {
  const out = {};
  for (const [name, lane] of Object.entries(lanes)) {
    prune(lane);
    out[name] = { inflight: lane.active, queued: lane.queue.length, last5m: lane.calls.length, total: lane.total, errors: lane.errors, concurrency: lane.concurrency };
  }
  return out;
}
