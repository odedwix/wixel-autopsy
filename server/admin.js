import { noteNetworkFailure, noteSession } from './connectivity.js';
import { config } from './config.js';
import { cached } from './cache.js';
import { limited } from './limits.js';
import { currentSignal, currentPriority, fromSnapshot } from './context.js';

// Wixel Agent admin API. Reachable from the Wix network without a cookie.

export async function getJson(url, { timeoutMs = 60000, retries = 2, body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${res.status} ${url.split('?')[0]}: ${text.slice(0, 300)}`), { status: res.status });
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      // No HTTP answer at all (DNS, refused, reset): maybe off the VPN — re-check connectivity now.
      if (!err.status && err.name !== 'AbortError') noteNetworkFailure();
      // 4xx won't get better on retry, and neither will a Trino timeout or SQL error.
      if (err.status && (err.status < 500 || /timed out|USER_ERROR/.test(err.message))) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Runs Trino SQL through the admin analytics endpoint. It caps each call at 500 rows and
// 30s of Trino time, so page with offset until a short page comes back.
export async function sql(query, { maxRows = 5000, signal = currentSignal() } = {}) {
  // The shared copy never adds load to the shared cluster: everything comes from the daily build.
  if (fromSnapshot(config)) throw Object.assign(new Error('Not in the daily build (this copy reads the daily build only and never queries Trino)'), { status: 404 });
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += 500) {
    const res = await limited('trino', () => getJson(`${config.adminBase}/analytics/session-entries`, { timeoutMs: 90000, body: { mode: 'sql', sql: query, limit: 500, offset } }), { signal, priority: currentPriority() });
    if (res.error) throw new Error(`SQL: ${res.error}`);
    rows.push(...res.rows);
    if (res.rows.length < 500) break;
  }
  return rows;
}

async function paged(url, key) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const res = await limited('admin', () => getJson(cursor ? `${url}?cursor=${encodeURIComponent(cursor)}` : url));
    out.push(...(res[key] || []));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

// Everything the admin page knows about one session, fetched in parallel.
export async function fetchSessionBundle(sessionId) {
  const base = `${config.adminBase}/sessions/${sessionId}`;
  const [meta, entries, events, assets] = await Promise.all([
    limited('admin', () => getJson(`${config.adminBase}/sessions?sessionId=${sessionId}`)).then((r) => r.sessions?.[0] ?? null),
    paged(`${base}/session-entries`, 'sessionEntries'),
    paged(`${base}/session-events`, 'sessionEvents'),
    limited('admin', () => getJson(`${base}/project-assets`)).catch((err) => ({ error: String(err.message || err) })),
  ]);
  if (meta?.id) noteSession(meta.id);
  return { sessionId, fetchedAt: new Date().toISOString(), meta, entries, events, assets };
}

export function getSessionBundle(sessionId, { fresh = false } = {}) {
  return cached('sessions', sessionId, fresh ? 0 : 60000, async () => {
    const value = await fetchSessionBundle(sessionId);
    const last = Math.max(
      Date.parse(value.meta?.updatedAt || 0),
      ...value.entries.map((e) => Date.parse(e.createdDate || 0)),
    );
    const settled = Date.now() - last > config.sessionSettledMs;
    return { value, ttlMs: settled ? Infinity : 60000 };
  });
}
