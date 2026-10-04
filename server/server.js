import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { handle } from './app.js';
import { takeOver, claim } from './singleton.js';
import { startSweeping } from './cache-gc.js';
import { startConnectivityChecks } from './connectivity.js';
import { storeKind } from './snapshot.js';

const server = http.createServer(handle);

// Local by default: this proxy holds a production Temporal key. HOST opens it up for a hosted copy,
// which must sit behind the back office's staff sign-in (it shows end users' emails and prompts).
// Starting the app replaces any copy already running, then (with --open) opens the browser.
try {
  await takeOver(config.port);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
server.listen(config.port, config.host, () => {
  claim();
  startSweeping();
  startConnectivityChecks();
  const url = `http://localhost:${config.port}`;
  console.log(`autopsy on ${url} (pid ${process.pid})${config.host !== '127.0.0.1' ? `, listening on ${config.host}` : ''}${config.snapshot ? ` — reading the daily build in the ${storeKind()}` : ''}`);
  if (process.argv.includes('--open')) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});
