import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getSessionBundle } from './admin.js';
import { normalizeSession } from './normalize.js';

// Review media per run, like Frame.io proxies: one small H.264 file with a keyframe every
// ~0.5s (so scrubbing never waits on a long GOP decode), AAC audio, faststart; plus a poster
// and a sprite sheet for hover-scrub in the grid. The source is the exact render when one
// exists, otherwise the scene clips + music assembled in order.

const MEDIA = path.join(config.cacheDir, 'media');
const SPRITE_FRAMES = 60;
const SHORT_SIDE = 540;
const CONCURRENCY = 2;
// Recorded in each build's meta (v2 = root voiceover/music tracks mixed in; v4 = the run's own video,
// not the project's root asset, and the root voiceover read from where the product keeps it). Older
// assembled copies are rebuilt when next asked for.
const ASSEMBLY_VERSION = 4;

const dirFor = (id) => path.join(MEDIA, id);
const exists = (f) => fs.access(f).then(() => true, () => false);

function run(cmd, args, { timeoutMs = 10 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.split('\n').slice(-6).join(' | ')}`));
    });
  });
}

async function probe(url) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', url], { timeoutMs: 60000 });
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  return { duration: Number(j.format?.duration || 0), width: v?.width, height: v?.height, hasAudio: j.streams.some((s) => s.codec_type === 'audio') };
}

// links.wixel.com/link/<id>/raw 302s to the wixel-render mp4.
async function resolveAgentRender(link) {
  const res = await fetch(`${link.replace(/\/raw$/, '')}/raw`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const loc = res.headers.get('location');
  return loc && /\.mp4/i.test(loc) ? loc : null;
}

// ---- source selection ----
async function pickSource(run) {
  if (run?.renderUrl) return { kind: 'render', label: 'Exact render (user download)', url: run.renderUrl };
  if (run?.agentDownloadLink) {
    const url = await resolveAgentRender(run.agentDownloadLink).catch(() => null);
    if (url) return { kind: 'render', label: 'Exact render (agent download)', url };
  }
  // The run's own video or story (from the list), not the project's root: projects hold other
  // sessions' work.
  const rec = normalizeSession(await getSessionBundle(run.id), { rootId: run.videoAssetId || run.storyAssetId || undefined });
  if (rec.outputs?.kind === 'story') {
    // The user's own story export is exact, unless the story changed after it was made.
    const at = Number(run.storyExportUrl?.match(/story-(\d+)\.mp4/)?.[1]);
    if (at && at >= rec.outputs.contentUpdatedAt - 2000) return { kind: 'render', label: 'Story export (the file the user downloaded)', url: run.storyExportUrl };
    if (rec.outputs.scenes.length) return { kind: 'assembled', label: 'Assembled from the story pages (no text layers)', story: rec.outputs };
  }
  const scenes = (rec.outputs?.scenes || []).filter((s) => s.clipUrl);
  if (scenes.length) return { kind: 'assembled', label: 'Assembled from scenes (no text overlays)', scenes, music: rec.outputs.music, rootAudio: rec.outputs.rootAudio || [], fps: 24 };
  // Nothing composed: fall back to the last generated clip so failed/partial runs still show something.
  const clip = rec.clips.at(-1);
  if (clip) return { kind: 'clip', label: `Last generated clip (${clip.method})`, url: clip.url };
  return null;
}

// ---- encoders ----
const scaleFilter = `scale='if(gt(iw,ih),-2,${SHORT_SIDE})':'if(gt(iw,ih),${SHORT_SIDE},-2)'`;
const videoArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0'];
const audioArgs = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];

async function transcode(url, out) {
  const info = await probe(url);
  const args = ['-y', '-v', 'error', '-i', url];
  if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0', '-shortest', '-vf', scaleFilter, ...videoArgs, ...audioArgs, '-movflags', '+faststart', out);
  await run('ffmpeg', args);
}

// Scene clips in order (each cut to its timeline length, starting at its trim), normalized to one
// size/fps, concatenated; music bed mixed under the clips' own audio (voiceover is muxed into clips).
async function assemble(src, out) {
  const infos = await Promise.all(src.scenes.map((s) => probe(s.clipUrl)));
  const first = infos.find((i) => i.width) || { width: 1080, height: 1920 };
  const portrait = first.height >= first.width;
  const W = portrait ? SHORT_SIDE : Math.round((SHORT_SIDE * first.width) / first.height / 2) * 2;
  const H = portrait ? Math.round((SHORT_SIDE * first.height) / first.width / 2) * 2 : SHORT_SIDE;
  const args = ['-y', '-v', 'error'];
  const parts = [];
  let total = 0;
  src.scenes.forEach((s, i) => {
    const len = s.playFrames ? s.playFrames / src.fps : infos[i].duration;
    const start = (s.trimStart || 0) / src.fps;
    total += len;
    args.push('-i', s.clipUrl);
    // tpad clones the last frame if a clip is shorter than its slot, so concat never desyncs.
    parts.push(`[${i}:v]trim=start=${start}:duration=${len},setpts=PTS-STARTPTS,fps=24,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop_duration=${len},trim=duration=${len}[v${i}]`);
    // Only clips with volume > 0 carry voice; the rest are muted in the composition.
    parts.push(infos[i].hasAudio && s.clipVolume > 0
      ? `[${i}:a]atrim=start=${start}:duration=${len},asetpts=PTS-STARTPTS,volume=${s.clipVolume},aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${len}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${len}[a${i}]`);
  });
  const n = src.scenes.length;
  parts.push(`${src.scenes.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[v][clips]`);
  let aout = '[clips]';
  // Root audio tracks (voiceover / music components). When a music component exists, the legacy
  // background_music setting describes the same track — use one, not both.
  const tracks = (src.rootAudio || []).filter((t) => t.volume > 0);
  const hasMusicTrack = tracks.some((t) => t.kind === 'music');
  let next = n;
  const mixIns = [];
  for (const t of tracks) {
    args.push('-i', t.url);
    const d = Math.round(t.shiftSec * 1000);
    parts.push(`[${next}:a]atrim=start=${t.trimStartSec},asetpts=PTS-STARTPTS,volume=${t.volume},adelay=${d}:all=1,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${total},atrim=duration=${total}[t${next}]`);
    mixIns.push(`[t${next}]`);
    next++;
  }
  if (mixIns.length) {
    parts.push(`[clips]${mixIns.join('')}amix=inputs=${mixIns.length + 1}:duration=first:normalize=0[withroot]`);
    aout = '[withroot]';
  }
  const m = hasMusicTrack ? null : src.music;
  if (m?.url && m.enabled !== false) {
    args.push('-i', m.url);
    const mi = next;
    const shift = Number(m.shift || 0);
    const musicLen = Math.min(total - shift, Number(m.duration || total) - Number(m.trim_start || 0) - Number(m.trim_end || 0));
    const fadeOut = Number(m.fadeOutSec ?? 2);
    parts.push(`[${mi}:a]atrim=start=${Number(m.trim_start || 0)}:duration=${musicLen},asetpts=PTS-STARTPTS,afade=t=in:d=${Number(m.fadeInSec ?? 0.15)},afade=t=out:st=${Math.max(0, musicLen - fadeOut)}:d=${fadeOut},volume=${Number(m.volume ?? 0.3)},adelay=${Math.round(shift * 1000)}:all=1,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${total}[music]`);
    parts.push(`${aout}[music]amix=inputs=2:duration=first:normalize=0[mix]`);
    aout = '[mix]';
  }
  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', aout, ...videoArgs, ...audioArgs, '-movflags', '+faststart', out);
  await run('ffmpeg', args);
}

// A story: each page for its duration (clip from its start, frozen on the last frame if shorter;
// a still page's poster or background image; else its background color), hard cuts; the
// voice-over, sound effects, and music ducked under the voice and faded out at the end.
const HEX = /^#?([0-9a-f]{6})$/i;
async function assembleStory(src, out) {
  const st = src.story;
  const portrait = st.height >= st.width;
  const even = (x) => Math.round(x / 2) * 2;
  const W = portrait ? SHORT_SIDE : even((SHORT_SIDE * st.width) / st.height);
  const H = portrait ? even((SHORT_SIDE * st.height) / st.width) : SHORT_SIDE;
  const fill = (fit) => (fit ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2` : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
  const args = ['-y', '-v', 'error'];
  const parts = [];
  let n = 0;
  let total = 0;
  // Provider clip links expire: a page whose clip can't be read shows its still, else its color.
  // Stills are fetched once into local files: ffmpeg's looped image input re-reads its file for every
  // frame, which over HTTP means one download per frame.
  const ok = async (u) => Boolean(u) && Boolean(await probe(u).catch(() => null));
  const local = async (u, i) => {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      const f = path.join(path.dirname(out), `still-${i}.img`);
      await fs.writeFile(f, Buffer.from(await res.arrayBuffer()));
      return (await ok(f)) ? f : null;
    } catch {
      return null;
    }
  };
  const pages = await Promise.all(st.scenes.map(async (p, i) => ({ ...p, clipUrl: (await ok(p.clipUrl)) ? p.clipUrl : null, stillUrl: p.stillUrl ? await local(p.stillUrl, i) : null })));
  pages.forEach((p, i) => {
    const len = p.playFrames / 24;
    total += len;
    if (p.clipUrl) {
      args.push('-i', p.clipUrl);
      parts.push(`[${n++}:v]trim=start=${p.clipStartSec || 0},setpts=PTS-STARTPTS,fps=24,${fill(p.fit)},setsar=1,tpad=stop_mode=clone:stop_duration=${len},trim=duration=${len}[v${i}]`);
    } else if (p.stillUrl) {
      args.push('-loop', '1', '-framerate', '24', '-t', String(len), '-i', p.stillUrl);
      parts.push(`[${n++}:v]fps=24,${fill(p.fit)},setsar=1,trim=duration=${len},setpts=PTS-STARTPTS[v${i}]`);
    } else {
      parts.push(`color=c=0x${HEX.exec(p.color || '')?.[1] || '000000'}:s=${W}x${H}:r=24:d=${len},setsar=1[v${i}]`);
    }
  });
  parts.push(`${pages.map((_, i) => `[v${i}]`).join('')}concat=n=${pages.length}:v=1:a=0[v]`);
  // Story audio URLs sometimes use the bare wixstatic.com host (it doesn't resolve; the media lives on
  // static.wixstatic.com). A track that still can't be read is left out rather than failing the video.
  const fix = (u) => String(u).replace(/^https:\/\/wixstatic\.com\//, 'https://static.wixstatic.com/');
  const readable = async (list) => (await Promise.all(list.map(async (t) => {
    const info = await probe(fix(t.url)).catch(() => null);
    return info ? { ...t, url: fix(t.url), duration: info.duration } : null;
  }))).filter(Boolean);
  const a = { ...st.story, voices: await readable(st.story.voices), sfx: await readable(st.story.sfx), music: await readable(st.story.music) };
  const voiceSpans = a.voices.map((v) => [v.atSec, v.atSec + (v.duration || 0)]);
  const mix = [];
  const track = (url, chain) => {
    args.push('-i', url);
    parts.push(`[${n}:a]${chain},aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${total},atrim=duration=${total}[a${n}]`);
    mix.push(`[a${n++}]`);
  };
  const delay = (sec) => `adelay=${Math.round(sec * 1000)}:all=1`;
  for (const v of [...a.voices, ...a.sfx]) track(v.url, `volume=${v.volume},${delay(v.atSec)}`);
  for (const m of a.music) {
    const duck = voiceSpans.length && a.duckVolume < 1 ? `,volume='if(${voiceSpans.map(([s0, s1]) => `between(t,${s0},${s1})`).join('+')},${a.duckVolume},1)':eval=frame` : '';
    track(m.url, `${delay(m.atSec)},volume=${m.volume}${duck},afade=t=out:st=${Math.max(0, total - m.fadeOutSec)}:d=${m.fadeOutSec}`);
  }
  if (!mix.length) parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${total}[aout]`);
  else parts.push(`${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0,atrim=duration=${total}[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[aout]', ...videoArgs, ...audioArgs, '-t', String(total), '-movflags', '+faststart', out);
  try {
    await run('ffmpeg', args);
  } finally {
    await Promise.all(pages.filter((p) => p.stillUrl).map((p) => fs.rm(p.stillUrl, { force: true })));
  }
}

async function stills(dir) {
  const video = path.join(dir, 'review.mp4');
  const info = await probe(video);
  // Tiles keep the video's aspect, with the long side at 192px.
  const portrait = info.height >= info.width;
  const tw = portrait ? Math.round((192 * info.width) / info.height / 2) * 2 : 192;
  const th = portrait ? 192 : Math.round((192 * info.height) / info.width / 2) * 2;
  const cols = 10;
  const rows = Math.ceil(SPRITE_FRAMES / cols);
  const fps = SPRITE_FRAMES / Math.max(info.duration, 0.1);
  await Promise.all([
    run('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.min(1, info.duration / 3)), '-i', video, '-frames:v', '1', '-vf', scaleFilter, '-q:v', '4', path.join(dir, 'poster.jpg')]),
    run('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vf', `fps=${fps},scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', path.join(dir, 'sprite.jpg')]),
  ]);
  return { duration: info.duration, width: info.width, height: info.height, sprite: { cols, rows, count: SPRITE_FRAMES, tileWidth: tw, tileHeight: th } };
}

let hasFfmpeg;
async function build(run) {
  hasFfmpeg ??= await new Promise((resolve) => spawn('ffmpeg', ['-version']).on('error', () => resolve(false)).on('close', (c) => resolve(c === 0)));
  if (!hasFfmpeg) return { state: 'unavailable', reason: 'ffmpeg isn’t installed — run: brew install ffmpeg (then restart the app)' };
  const dir = dirFor(run.id);
  await fs.mkdir(dir, { recursive: true });
  const t0 = Date.now();
  const src = await pickSource(run);
  if (!src) return { state: 'unavailable', reason: 'No render, scenes or clips in this run' };
  const tmp = path.join(dir, 'review.tmp.mp4');
  if (src.story) await assembleStory(src, tmp);
  else if (src.kind === 'assembled') await assemble(src, tmp);
  else await transcode(src.url, tmp);
  await fs.rename(tmp, path.join(dir, 'review.mp4'));
  const meta = await stills(dir);
  return { state: 'ready', kind: src.kind, label: src.label, sourceUrl: src.url || null, builtMs: Date.now() - t0, v: ASSEMBLY_VERSION, ...meta };
}

// ---- queue ----
const jobs = new Map(); // id → { state, promise? }
const pending = [];
let active = 0;

async function readMeta(id) {
  try {
    const f = path.join(dirFor(id), 'meta.json');
    const meta = JSON.parse(await fs.readFile(f, 'utf8'));
    // Mark the run's media as recently used for the cache size cap.
    fs.utimes(f, new Date(), new Date()).catch(() => {});
    return meta;
  } catch {
    return null;
  }
}

function pump() {
  while (active < CONCURRENCY && pending.length) {
    const job = pending.shift();
    active++;
    job.state = 'processing';
    build(job.run)
      .catch((err) => ({ state: 'failed', reason: String(err.message || err).slice(0, 500) }))
      .then(async (meta) => {
        await fs.mkdir(dirFor(job.run.id), { recursive: true });
        await fs.writeFile(path.join(dirFor(job.run.id), 'meta.json'), JSON.stringify({ ...meta, at: Date.now() }));
        jobs.delete(job.run.id);
        active--;
        pump();
      });
  }
}

// Status for a run; queues a build if there's none. `priority` jumps the queue (opened/hovered now).
export async function mediaStatus(run, { priority = false, retry = false } = {}) {
  const meta = await readMeta(run.id);
  // A render that appears later (user downloads after we assembled) upgrades the media.
  const upgrade = meta?.state === 'ready' && meta.kind !== 'render' && (run.renderUrl || run.agentDownloadLink);
  const stale = meta?.state === 'ready' && meta.kind !== 'render' && (meta.v || 0) < ASSEMBLY_VERSION;
  if (meta && !upgrade && !stale && !(retry && meta.state === 'failed')) return meta;
  let job = jobs.get(run.id);
  if (!job) {
    job = { run, state: 'queued' };
    jobs.set(run.id, job);
    priority ? pending.unshift(job) : pending.push(job);
    pump();
  } else if (priority && job.state === 'queued') {
    pending.splice(pending.indexOf(job), 1);
    pending.unshift(job);
  }
  return { state: job.state, queuePosition: pending.indexOf(job) };
}

// Refresh: forget the review copies (and Exact composition mp4s) of these runs unless their video
// is the user's own render, so the next look rebuilds them from the assets as they are now.
export async function forgetMedia(ids) {
  let n = 0;
  for (const id of ids.filter((x) => /^[\w-]{36}$/.test(x))) {
    if (jobs.has(id)) continue;
    const meta = await readMeta(id);
    if (!meta || meta.kind === 'render') continue;
    await Promise.all(['meta.json', 'exact.mp4', 'exact.json', 'exact-cc.mp4', 'exact-cc.json'].map((f) => fs.rm(path.join(dirFor(id), f), { force: true })));
    n++;
  }
  return { forgotten: n };
}

export function mediaFile(id, name) {
  if (!/^[\w-]{36}$/.test(id) || !['review.mp4', 'poster.jpg', 'sprite.jpg'].includes(name)) return null;
  return path.join(dirFor(id), name);
}

// What a download should hand over: the original full-quality render when the run has one
// (the review copy is a 540p transcode of it), otherwise our review copy.
const RENDER_HOSTS = /(^|\.)(wixmp\.com|wixstatic\.com|wixel\.com|wix\.com)$/i;
// `which: 'review'` forces the review copy.
export async function downloadSource(id, which) {
  const meta = await readMeta(id);
  if (!meta || meta.state !== 'ready') return null;
  if (which !== 'review' && meta.kind === 'render' && meta.sourceUrl) {
    try {
      if (RENDER_HOSTS.test(new URL(meta.sourceUrl).hostname)) return { kind: 'render', url: meta.sourceUrl };
    } catch {}
  }
  return { kind: meta.kind, file: mediaFile(id, 'review.mp4') };
}

// One still frame of a clip, 480px wide, for printed reports. Wix CDNs only; cached by URL.
export async function clipFrame(src) {
  let u;
  try {
    u = new URL(src);
  } catch {
    throw Object.assign(new Error('bad url'), { status: 400 });
  }
  if (u.protocol !== 'https:' || !RENDER_HOSTS.test(u.hostname)) throw Object.assign(new Error('not a Wix media URL'), { status: 400 });
  const key = crypto.createHash('sha1').update(src).digest('hex').slice(0, 20);
  const dir = path.join(config.cacheDir, 'media', '_frames');
  const file = path.join(dir, `${key}.jpg`);
  const hit = await fs.readFile(file).catch(() => null);
  if (hit) return hit;
  await fs.mkdir(dir, { recursive: true });
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', '0.5', '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', file]);
  return fs.readFile(file);
}

export const queueDepth = () => ({ active, pending: pending.length });
