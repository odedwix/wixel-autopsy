// Guardrails for the production systems this proxy reads from. Every upstream call goes through
// one of these: a concurrency cap, a minimum spacing between calls, and rolling counters that
// the UI shows, so load stays small and visible.
//
//   trino    — the admin API's SQL endpoint → the shared Trino analytics cluster
//   admin    — the Wixel admin API (production BO service reading the agent's session store)
//   temporal — Temporal Cloud prod namespace (shares request limits with production workers)

const LIMITS = {
  // Background work (refreshing cached days, stats) gets at most `background` of the slots and
  // only runs when nothing on screen is waiting.
  trino: { concurrency: 4, minIntervalMs: 250, background: 1 },
  admin: { concurrency: 3, minIntervalMs: 150, background: 1 },
  temporal: { concurrency: 2, minIntervalMs: 250, background: 1 },
};

// Backoff: when Trino keeps timing out (it's busy, or we're too much for it), slow down for a
// while — fewer at once, further apart — instead of piling on. Hour-window splitting of heavy
// days makes that worse, so it's the moment to ease off.
const BACKOFF = { timeouts: 3, windowMs: 2 * 60000, holdMs: 3 * 60000, concurrency: 2, minIntervalMs: 1200 };

const WINDOW_MS = 5 * 60000;
const lanes = {};
for (const [name, cfg] of Object.entries(LIMITS)) {
  lanes[name] = { ...cfg, active: 0, activeBg: 0, queue: [], bgQueue: [], last: 0, calls: [], total: 0, errors: 0, timeouts: [], backoffUntil: 0 };
}

const backingOff = (lane) => Date.now() < lane.backoffUntil;
const cap = (lane) => (backingOff(lane) ? Math.min(lane.concurrency, BACKOFF.concurrency) : lane.concurrency);
const spacing = (lane) => (backingOff(lane) ? Math.max(lane.minIntervalMs, BACKOFF.minIntervalMs) : lane.minIntervalMs);
const canRun = (lane, bg) => lane.active < cap(lane) && (!bg || (lane.activeBg < lane.background && !lane.queue.length));

function prune(lane) {
  const cutoff = Date.now() - WINDOW_MS;
  while (lane.calls.length && lane.calls[0] < cutoff) lane.calls.shift();
  while (lane.timeouts.length && lane.timeouts[0] < Date.now() - BACKOFF.windowMs) lane.timeouts.shift();
}

const abortError = () => Object.assign(new Error('request cancelled'), { name: 'AbortError' });

// Waiting callers can be cancelled (the browser moved on); a call already running is left to
// finish — its result still fills the cache, and aborting it wouldn't stop the upstream work.
async function acquire(lane, signal, bg) {
  if (signal?.aborted) throw abortError();
  if (!canRun(lane, bg)) {
    await new Promise((resolve, reject) => {
      const q = bg ? lane.bgQueue : lane.queue;
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = q.indexOf(entry);
        if (i >= 0) q.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      q.push(entry);
    });
  }
  lane.active++;
  if (bg) lane.activeBg++;
  const gap = spacing(lane);
  const wait = lane.last + gap - Date.now();
  lane.last = Math.max(Date.now(), lane.last + gap);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// On-screen work first; background only when nothing interactive waits. One waiter per freed
// slot (it counts itself in when it wakes).
function release(lane, bg) {
  lane.active--;
  if (bg) lane.activeBg--;
  if (lane.active >= cap(lane)) return;
  if (lane.queue.length) lane.queue.shift()();
  else if (lane.bgQueue.length && lane.activeBg < lane.background) lane.bgQueue.shift()();
}

export async function limited(name, fn, { signal, priority = 'interactive' } = {}) {
  const lane = lanes[name];
  const bg = priority === 'background';
  await acquire(lane, signal, bg);
  lane.calls.push(Date.now());
  lane.total++;
  prune(lane);
  try {
    return await fn();
  } catch (err) {
    lane.errors++;
    if (/timed out/i.test(err.message)) {
      lane.timeouts.push(Date.now());
      prune(lane);
      if (lane.timeouts.length >= BACKOFF.timeouts && !backingOff(lane)) {
        lane.backoffUntil = Date.now() + BACKOFF.holdMs;
        console.log(`${name}: ${lane.timeouts.length} timeouts in 2 min — backing off (${BACKOFF.concurrency} at a time, ${BACKOFF.minIntervalMs}ms apart) for 3 min`);
      }
    }
    throw err;
  } finally {
    release(lane, bg);
  }
}

// Busy = on-screen work is queued or we're backing off; background refreshes wait for calm.
export function laneBusy(name) {
  const lane = lanes[name];
  return backingOff(lane) || lane.queue.length > 0 || lane.active >= cap(lane);
}

export function loadReport() {
  const out = {};
  for (const [name, lane] of Object.entries(lanes)) {
    prune(lane);
    out[name] = { inflight: lane.active, queued: lane.queue.length, queuedBackground: lane.bgQueue.length, last5m: lane.calls.length, total: lane.total, errors: lane.errors, concurrency: cap(lane), backoffUntil: backingOff(lane) ? lane.backoffUntil : null, timeouts2m: lane.timeouts.length };
  }
  return out;
}

// How long a lane will stay in backoff (ms, 0 when it isn't): long jobs (Fleet day builds) wait it
// out instead of adding load to a cluster that's already timing out.
export function backoffRemaining(name) {
  const lane = lanes[name];
  return backingOff(lane) ? lane.backoffUntil - Date.now() : 0;
}
