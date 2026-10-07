import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();

// Per-person settings live in .env at the repo root (gitignored; see .env.example). Real
// environment variables win over it.
(function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
})();

// The Temporal key is never committed: TEMPORAL_API_KEY (env or .env), else a file holding
// TEMPORAL_KEY=… (TEMPORAL_KEY_FILE, default: a wixel-video-server checkout's grapher .env).
const GRAPHER_ENV = path.join(HOME, 'dev/wixel-video-server/packages/ai-video-genix-grapher/.env');

function readTemporalKey() {
  if (process.env.TEMPORAL_API_KEY) return process.env.TEMPORAL_API_KEY;
  const file = process.env.TEMPORAL_KEY_FILE || GRAPHER_ENV;
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('TEMPORAL_KEY='));
    return line ? line.slice('TEMPORAL_KEY='.length).trim() : null;
  } catch {
    return null;
  }
}

// Shared copy: AUTOPSY_SNAPSHOT=1 serves runs, insights, families, skills and user mode only from
// the daily build in DATA_DIR (npm run build:data) and never queries Trino, so any number of
// people can read it at once. Fleet reads its own day files the same way (FLEET_READONLY).
const snapshot = process.env.AUTOPSY_SNAPSHOT === '1';
if (snapshot) process.env.FLEET_READONLY = '1';

export const config = {
  root: ROOT,
  cacheDir: path.resolve(ROOT, process.env.CACHE_DIR || '.cache'),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || '.data'),
  snapshot,
  port: Number(process.env.PORT || 5178),
  // 127.0.0.1 unless hosted: anything else must sit behind the back office's staff sign-in.
  host: process.env.HOST || '127.0.0.1',
  adminBase: 'https://bo.wix.com/_api/wixel-agent-admin/api',
  adminUi: 'https://wix-bo.com/wixel-agent/admin/#/sessions/',
  temporal: {
    address: 'us-east-1.aws.api.temporal.io:7233',
    namespace: 'prod-wixel.imhi2',
    apiKey: readTemporalKey(),
    uiBase: 'https://cloud.temporal.io/namespaces/prod-wixel.imhi2/workflows/',
  },
  // A session whose last activity is older than this is treated as finished and cached forever.
  sessionSettledMs: 30 * 60 * 1000,
};
