import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context (currently: the abort signal of the browser request that started the work),
// so deep calls like sql() can drop queued upstream work when the browser moves on.
export const requestContext = new AsyncLocalStorage();
export const currentSignal = () => requestContext.getStore()?.signal;
