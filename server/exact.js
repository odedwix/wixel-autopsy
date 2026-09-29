import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { withChrome, waitFor } from './pdf.js';
import { mediaFile } from './media.js';

// The Exact composition as an mp4, for runs with no render: the product's own player (text
// overlays, captions, music) in headless Chrome, sized to the composition, seeked frame by frame and
// screenshotted (web/player/capture.html + the capture bundle from build-player.sh). ffmpeg joins
// the frames with the audio of our assembled copy (the same clips, voiceover and music, mixed by
// media.js). Cached in the run's media folder; a few minutes per ad, one at a time.

const jobs = new Map(); // runId → { state, done, total, error, startedAt }
const dirFor = (id) => path.join(config.cacheDir, 'media', id);
export const exactFile = (id) => path.join(dirFor(id), 'exact.mp4');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd}: ${err.slice(-300)}`))));
  });
}

export async function exactStatus(id) {
  if (jobs.has(id)) return jobs.get(id);
  const st = await fs.stat(exactFile(id)).catch(() => null);
  return st ? { state: 'ready', bytes: st.size } : { state: 'none' };
}

export async function startExact(run0) {
  const id = run0.id;
  const cur = await exactStatus(id);
  if (['ready', 'queued', 'loading', 'rendering', 'encoding'].includes(cur.state)) return cur;
  const job = { state: 'queued', done: 0, total: 0, startedAt: Date.now() };
  jobs.set(id, job);
  capture(run0, job)
    .then(() => jobs.delete(id))
    .catch((err) => {
      job.state = 'failed';
      job.error = String(err.message || err).slice(0, 400);
      setTimeout(() => jobs.get(id) === job && jobs.delete(id), 10 * 60000);
    });
  return job;
}

async function capture(r, job) {
  const frames = path.join(dirFor(r.id), 'exact-frames');
  await fs.rm(frames, { recursive: true, force: true });
  await fs.mkdir(frames, { recursive: true });
  let meta;
  await withChrome(async ({ send }) => {
    job.state = 'loading';
    await send('Page.navigate', { url: `http://127.0.0.1:${config.port}/player/capture.html?run=${r.id}${r.videoAssetId ? `&root=${r.videoAssetId}` : ''}` });
    const got = await waitFor(send, 'window.__captureMeta || (window.__captureError && { error: window.__captureError }) || null', 180000);
    if (!got) throw new Error('the player did not load in 3 minutes');
    if (got.error) throw new Error(got.error);
    meta = got;
    // The viewport is the composition, so a screenshot is one frame at full size.
    await send('Emulation.setDeviceMetricsOverride', { width: meta.width, height: meta.height, deviceScaleFactor: 1, mobile: false });
    await send('Runtime.evaluate', { expression: 'window.AutopsyCapture.seek(0)', awaitPromise: true });
    job.state = 'rendering';
    job.total = meta.frames;
    for (let f = 0; f < meta.frames; f++) {
      const s = await send('Runtime.evaluate', { expression: `window.AutopsyCapture.seek(${f})`, awaitPromise: true, returnByValue: true });
      if (s.result?.exceptionDetails) throw new Error(`seek ${f}: ${s.result.exceptionDetails.text}`);
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92, fromSurface: true });
      if (!shot.result?.data) throw new Error(`screenshot ${f} failed`);
      await fs.writeFile(path.join(frames, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(shot.result.data, 'base64'));
      job.done = f + 1;
    }
  });
  job.state = 'encoding';
  const audio = mediaFile(r.id, 'review.mp4');
  const hasAudio = Boolean(audio && (await fs.stat(audio).catch(() => null)));
  const out = exactFile(r.id);
  await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(meta.fps), '-i', path.join(frames, 'f%05d.jpg'),
    ...(hasAudio ? ['-i', audio, '-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-b:a', '192k'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', String(meta.frames / meta.fps), `${out}.tmp.mp4`]);
  await fs.rename(`${out}.tmp.mp4`, out);
  await fs.rm(frames, { recursive: true, force: true });
  await fs.writeFile(path.join(dirFor(r.id), 'exact.json'), JSON.stringify({ ...meta, builtMs: Date.now() - job.startedAt, audio: hasAudio ? 'assembled copy' : 'none', at: Date.now() }));
}
