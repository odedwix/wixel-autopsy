import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The Temporal key is never copied into this repo: read it from the env, or from the
// grapher's .env (the same source the prod-runs skill uses).
const GRAPHER_ENV = '/Users/odedgr/dev/wixel-video-server/packages/ai-video-genix-grapher/.env';

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

export const config = {
  root: ROOT,
  cacheDir: path.join(ROOT, '.cache'),
  port: Number(process.env.PORT || 5178),
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
