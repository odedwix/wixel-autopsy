import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context: the abort signal of the browser request that started the work (so deep calls
// like sql() drop queued upstream work when the browser moves on) and its priority — 'background'
// for work nobody is waiting on (stale-while-revalidate refreshes, family stats), which the
// limiter runs only when nothing on screen is queued.
export const requestContext = new AsyncLocalStorage();
export const currentSignal = () => requestContext.getStore()?.signal;
export const currentPriority = () => requestContext.getStore()?.priority || 'interactive';
// The daily build wants current data, never a stale cached copy (see cache.js `cached`).
export const wantFresh = () => Boolean(requestContext.getStore()?.fresh);
export const inBackground = (fn) => requestContext.run({ signal: undefined, priority: 'background' }, fn);
