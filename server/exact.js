import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from './config.js';
import { withChrome, waitFor } from './pdf.js';
import { currentReviewFile, mediaFile } from './media.js';

// The Exact composition as an mp4, for runs with no render: the product's own player (text
// overlays, captions, music) in headless Chrome, sized to the composition, seeked frame by frame and
// screenshotted (web/player/capture.html + the capture bundle from build-player.sh). ffmpeg joins
// the frames with the audio of our assembled copy (the same clips, voiceover and music, mixed by
// media.js). Cached in the run's media folder; one capture at a time.
//
// Each frame waits for its clips to decode that exact frame and the page to settle, then a full-size
// screenshot drawn without a GPU: ~190 ms a frame (median of 17 captures; ~4.6× the video's length in
// one page). So a few pages of one Chrome share the frames, each a contiguous part (stepping forward
// a frame at a time is the cheap direction for the decoders).

const jobs = new Map(); // runId → { state, done, total, error, startedAt }
const dirFor = (id) => path.join(config.cacheDir, 'media', id);
// Two copies at most: without captions unless a person turned them on (the default), and with them
// (`cc`: the viewer turned them on in the player).
export const exactFile = (id, { cc = false } = {}) => path.join(dirFor(id), cc ? 'exact-cc.mp4' : 'exact.mp4');
const jobKey = (id, cc) => `${id}${cc ? '|cc' : ''}`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd}: ${err.slice(-300)}`))));
  });
}

// Seconds of sound in a file (its first audio stream), or null.
function audioSeconds(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(Number.parseFloat(out) || null));
  });
}

// v2: captions only when a person turned them on (v1 copies kept the agent's own captions).
// v3: the soundtrack runs as long as the video (v2 took it from a review copy that stopped with the
// scenes, so a video whose music plays on past them went silent there; media.js ASSEMBLY_VERSION 5).
const EXACT_VERSION = 3;
export async function exactStatus(id, { cc = false } = {}) {
  if (jobs.has(jobKey(id, cc))) return jobs.get(jobKey(id, cc));
  const metaFile = path.join(dirFor(id), cc ? 'exact-cc.json' : 'exact.json');
  const meta = JSON.parse(await fs.readFile(metaFile, 'utf8').catch(() => '{}'));
  const v = meta.v || 1;
  if (v < 2) return { state: 'none' };
  const st = await fs.stat(exactFile(id, { cc })).catch(() => null);
  if (!st) return { state: 'none' };
  // A v2 copy is rebuilt only if its sound stops early (most were fine); checked once, remembered.
  if (v === 2 && meta.audio !== 'none' && meta.frames) {
    if (meta.audioSec == null) {
      meta.audioSec = (await audioSeconds(exactFile(id, { cc }))) ?? 0;
      await fs.writeFile(metaFile, JSON.stringify(meta)).catch(() => {});
    }
    if (meta.audioSec < meta.frames / meta.fps - 0.2) return { state: 'none' };
  }
  return { state: 'ready', bytes: st.size };
}

export async function startExact(run0, { cc = false } = {}) {
  const id = run0.id;
  const key = jobKey(id, cc);
  const cur = await exactStatus(id, { cc });
  if (['ready', 'queued', 'loading', 'rendering', 'encoding'].includes(cur.state)) return cur;
  const job = { state: 'queued', done: 0, total: 0, startedAt: Date.now() };
  jobs.set(key, job);
  capture(run0, job, cc)
    .then(() => jobs.delete(key))
    .catch((err) => {
      job.state = 'failed';
      job.error = String(err.message || err).slice(0, 400);
      setTimeout(() => jobs.get(key) === job && jobs.delete(key), 10 * 60000);
    });
  return job;
}

// Pages capturing at once: 3 at most, fewer on a smaller machine (each is a renderer drawing in
// software); EXACT_TABS overrides. A short video doesn't spread thinner than ~2 s a page.
const TABS = Math.max(1, Math.min(Number(process.env.EXACT_TABS) || 3, Math.floor(os.availableParallelism() / 4)));
const MIN_FRAMES_PER_TAB = 48;

// Open the capture page in one Chrome page, sized to the composition; resolves with { fps, frames, width, height }.
async function openCapture(send, url) {
  await send('Page.navigate', { url });
  const got = await waitFor(send, 'window.__captureMeta || (window.__captureError && { error: window.__captureError }) || null', 180000);
  if (!got) throw new Error('the player did not load in 3 minutes');
  if (got.error) throw new Error(got.error);
  // The viewport is the composition, so a screenshot is one frame at full size.
  await send('Emulation.setDeviceMetricsOverride', { width: got.width, height: got.height, deviceScaleFactor: 1, mobile: false });
  return got;
}

async function capture(r, job, cc = false) {
  const frames = path.join(dirFor(r.id), cc ? 'exact-frames-cc' : 'exact-frames');
  await fs.rm(frames, { recursive: true, force: true });
  await fs.mkdir(frames, { recursive: true });
  let meta;
  // The soundtrack comes from the review copy, rebuilt meanwhile if it's from an older assembly.
  const review = currentReviewFile(r).catch(() => null);
  await withChrome(async ({ send, newPage }) => {
    job.state = 'loading';
    // The run's video, or its story (drawn as timed scenes by the same player; see player.js).
    const root = r.videoAssetId || r.storyAssetId;
    const url = `http://127.0.0.1:${config.port}/player/capture.html?run=${r.id}${root ? `&root=${root}` : ''}&captions=${cc ? '1' : 'user'}`;
    // All pages load together (the second and later find the media in Chrome's cache). The first must
    // load; a helper page that doesn't just leaves its share to the others.
    // (Settled from the start: a helper failing while the first page loads must not go unhandled.)
    const helpers = Promise.allSettled(Array.from({ length: TABS - 1 }, async () => {
      const s = await newPage();
      await openCapture(s, url);
      return s;
    }));
    meta = await openCapture(send, url);
    const extra = (await helpers).filter((x) => x.status === 'fulfilled').map((x) => x.value);
    const pages = [send, ...extra].slice(0, Math.max(1, Math.floor(meta.frames / MIN_FRAMES_PER_TAB)));
    job.state = 'rendering';
    job.total = meta.frames;
    job.pages = pages.length;
    const per = Math.ceil(meta.frames / pages.length);
    let done = 0;
    await Promise.all(pages.map(async (page, i) => {
      for (let f = i * per; f < Math.min(meta.frames, (i + 1) * per); f++) {
        const s = await page('Runtime.evaluate', { expression: `window.AutopsyCapture.seek(${f})`, awaitPromise: true, returnByValue: true });
        if (s.result?.exceptionDetails) throw new Error(`seek ${f}: ${s.result.exceptionDetails.text}`);
        const shot = await page('Page.captureScreenshot', { format: 'jpeg', quality: 92, fromSurface: true });
        if (!shot.result?.data) throw new Error(`screenshot ${f} failed`);
        await fs.writeFile(path.join(frames, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(shot.result.data, 'base64'));
        job.done = ++done;
      }
    }));
  });
  job.state = 'encoding';
  // (A rebuild that can't run, e.g. for a run opened from a link and not in the list, leaves the copy there is.)
  const audio = (await review) || mediaFile(r.id, 'review.mp4');
  const hasAudio = Boolean(audio && (await fs.stat(audio).catch(() => null)));
  const out = exactFile(r.id, { cc });
  await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(meta.fps), '-i', path.join(frames, 'f%05d.jpg'),
    ...(hasAudio ? ['-i', audio, '-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-b:a', '192k'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', String(meta.frames / meta.fps), `${out}.tmp.mp4`]);
  await fs.rename(`${out}.tmp.mp4`, out);
  const audioSec = hasAudio ? await audioSeconds(out) : null;
  await fs.rm(frames, { recursive: true, force: true });
  await fs.writeFile(path.join(dirFor(r.id), cc ? 'exact-cc.json' : 'exact.json'), JSON.stringify({ ...meta, v: EXACT_VERSION, pages: job.pages, audioSec, captions: cc ? 'on' : 'only if a person turned them on', builtMs: Date.now() - job.startedAt, audio: hasAudio ? 'assembled copy' : 'none', at: Date.now() }));
}
