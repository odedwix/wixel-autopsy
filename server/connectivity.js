import { config } from './config.js';

// Can this machine reach the systems the data comes from? Everything live (Trino via the admin
// SQL endpoint, session details, user lookups) goes through bo.wix.com, which answers only from
// inside the Wix network (office or VPN). A cheap probe every minute — and right away after an
// upstream call fails on the network — tells the UI to say so instead of showing spinners, while
// whatever is already cached keeps working.

let state = { status: 'unknown', checkedAt: 0 };
let inflight = null;
// A session known to exist makes the probe a ~1KB lookup; until one has loaded, the list (~40KB).
let knownSession = null;
export const noteSession = (id) => (knownSession = id);

const why = {
  offline: 'Can’t reach bo.wix.com — connect to the Wix VPN (or the office network). Showing cached data only.',
  blocked: 'bo.wix.com answered but refused access (login page / 401-403) — you’re probably off the Wix VPN. Showing cached data only.',
  degraded: 'The Wixel admin API is answering with errors right now — live data may fail to load. Cached data still works.',
};

async function probe() {
  const t0 = Date.now();
  try {
    const url = knownSession ? `${config.adminBase}/sessions?sessionId=${knownSession}` : `${config.adminBase}/sessions?limit=1`;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const type = res.headers.get('content-type') || '';
    const ms = Date.now() - t0;
    if (res.status >= 300 && res.status < 400) return { status: 'blocked', http: res.status, ms };
    if (res.status === 401 || res.status === 403) return { status: 'blocked', http: res.status, ms };
    if (res.ok && !/json/.test(type)) return { status: 'blocked', http: res.status, ms }; // an HTML login page
    if (res.status >= 500) return { status: 'degraded', http: res.status, ms };
    return { status: 'ok', http: res.status, ms };
  } catch (err) {
    return { status: 'offline', error: String(err.cause?.code || err.name || err.message), ms: Date.now() - t0 };
  }
}

export async function checkConnectivity({ fresh = false } = {}) {
  if (!fresh && Date.now() - state.checkedAt < 30000) return state;
  inflight ??= probe().then((r) => {
    state = { ...r, message: why[r.status] || null, checkedAt: Date.now() };
    inflight = null;
    if (r.status !== 'ok') console.log(`connectivity: ${r.status}${r.http ? ` (HTTP ${r.http})` : r.error ? ` (${r.error})` : ''}`);
    return state;
  });
  return inflight;
}

export const connectivity = () => state;

// admin.js calls this when a request fails without an HTTP answer (DNS, refused, reset, timeout
// before headers): re-probe now rather than waiting for the next minute.
export function noteNetworkFailure() {
  if (Date.now() - state.checkedAt > 5000) checkConnectivity({ fresh: true }).catch(() => {});
}

export function startConnectivityChecks() {
  checkConnectivity({ fresh: true }).catch(() => {});
  setInterval(() => checkConnectivity({ fresh: true }).catch(() => {}), 60000).unref();
}
