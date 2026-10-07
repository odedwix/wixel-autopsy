// Session bundle (admin API) → one run record the UI can render without further parsing.
import { ownedAssetIds, writePath, jobTypes } from './own-assets.js';
import { splitTime } from './time-split.js';

const ms = (t) => (t ? Date.parse(t) : null);

function parseJson(s) {
  if (typeof s !== 'string') return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Skills the platform preloaded into a message (since 2026-09-30; metadata.preloadedSkillBodies:
// "<preloaded_skill>\nThe \"<name>\" skill is already loaded…"). The agent never calls the skill tool
// for them, so each counts as a load at that message, except a utility preloaded next to a product
// skill (export-handler + single-page-design): the product is the work. Same rule as queries.js.
const UTILITY = new Set(['export-handler']);
export function preloadedSkills(metadata) {
  const bodies = metadata?.preloadedSkillBodies;
  if (!bodies) return { all: [], loads: [] };
  const text = Array.isArray(bodies) ? bodies.join('\n') : String(bodies);
  const all = [...new Set([...text.matchAll(/The \\?"([\w.:-]+)\\?" skill is already loaded/g)].map((m) => m[1]))];
  const products = all.filter((x) => !UTILITY.has(x));
  return { all, loads: products.length ? products : all };
}

// ---- step categories ----
// Category drives colour and the per-category timing breakdown. RPC methods first, then tools.
const METHOD_CATEGORY = [
  [/^generateVideo|^holdStillAsVideo|^transformVideo|^generateAvatarTake|LogoShot|^StartAnimation|^EndAnimation|^GenerateSlideAnimation/, 'video'],
  // audio before tts: mergeVoiceIntoVideo is a mix step, not speech generation
  [/^generateMusic|^trimAudioClip|^mergeVoiceIntoVideo/, 'audio'],
  [/Speech|Voice|^TranscribeVoiceover/, 'tts'],
  [/Image|Cover|^upscale|^enhance|^generateHDR|^removeImageBackground|^smartBreakdown|^composeImage|^extractFirstFrame|Icon|Logo/, 'image'],
  [/Brand|^GetSiteBrand/, 'brand'],
  [/^DescribeVideoUrls|^probeMediaDuration|^getSubjectBounds/, 'analysis'],
  [/^ListCosts|^GetMax|^Eligible|^ListVoices|^list_rpc_methods/, 'lookup'],
];
const TOOL_CATEGORY = {
  generate_image: 'image', edit_image: 'image', convert_image_format: 'image',
  scrape_url: 'scrape', call_wix_site_api: 'scrape',
  analyze_image: 'analysis', analyze_video: 'analysis',
  skill: 'agent', read: 'agent', write: 'agent', list: 'agent', task: 'agent', ask_user: 'agent', download: 'export',
};

export function categorize(tool, method) {
  if (tool === 'invoke_rpc' && method) {
    for (const [re, cat] of METHOD_CATEGORY) if (re.test(method)) return cat;
    return 'rpc';
  }
  return TOOL_CATEGORY[tool] || 'other';
}

// Some tools report SUCCESS with an exception string as output (e.g. generate_image 400s).
function outputLooksFailed(output) {
  return typeof output === 'string' && /^(Exception|Error)\b|error_json:|"statusCode":\s*[45]\d\d/.test(output.slice(0, 400));
}

// ---- media ----
const MEDIA_URL = /https?:\/\/[^\s"'\\)<>]+?\.(?:mp4|mov|webm|mp3|wav|m4a|aac|png|jpe?g|webp|gif|svg)(?:\?[^\s"'\\)<>]*)?/gi;
const MEDIA_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{6}_[0-9a-f]{32}/gi;
const urlsIn = (v) => [...new Set((typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\\\//g, '/').match(MEDIA_URL) || [])];
// The same file appears under different paths (genix_uploads vs genix_transcoded, ?token=…);
// its id is the stable part.
export const mediaId = (url) => {
  const path = String(url).split('?')[0];
  const ids = path.match(MEDIA_ID);
  return ids ? ids.at(-1).toLowerCase() : path;
};
export const mediaKind = (url) => (/\.(mp4|mov|webm)(\?|$)/i.test(url) ? 'video' : /\.(mp3|wav|m4a|aac)(\?|$)/i.test(url) ? 'audio' : 'image');

// What a step was asked to make, in words: the prompt / instruction / script it was given.
function promptOf(step) {
  const a = step.args || {};
  const p = a.requestJson?.parameters || a.requestJson || {};
  return a.prompt || a.instruction || p.prompt || p.text || p.brand_brief || p.script || a.query || null;
}

// Long agent-tool outputs (skill bodies, read resources) are trimmed; ?raw=1 has them in full.
function trimOutput(v) {
  if (typeof v === 'string' && v.length > 2500) return { text: v.slice(0, 2500), truncated: v.length };
  return v;
}

// ---- scraped website ----
function parseScrape(text) {
  if (typeof text !== 'string') return null;
  const line = (label) => text.match(new RegExp(`^- ${label}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? null;
  const list = (s) => (s ? s.split(/,\s*/).map((x) => x.trim()).filter(Boolean) : []);
  const colorsLine = line('Proposed brand colors[^:]*') || line('Brand colors[^:]*') || line('Colors');
  return {
    logo: line('Logo'),
    favicon: line('Favicon'),
    colors: (colorsLine?.match(/#[0-9a-f]{3,8}\b/gi) || []),
    fonts: list(line('Fonts')),
    screenshot: text.match(/screenshot:\s*(https?:\/\/\S+)/i)?.[1] ?? null,
    images: [...new Set(text.match(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp|gif|svg)(?:\?[^\s)"']*)?/gi) || [])].slice(0, 40),
    raw: text,
  };
}

// The session's asset evidence (admin API shapes; see own-assets.js): its events, and its write
// tool results, which name every asset written ("Created project/assets/…, id: <id>") — the only
// record of a sub-agent's writes, which aren't metered.
const WRITTEN_ID = /id(?:: |":")([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
// A `sequence` (generate → write in one call, as story sub-agents do) carries its write steps' results
// inside its own, which also hold other steps' output, so only the write header counts there.
const SEQUENCE_WRITTEN = /(?:Created|Edited|Saved) project\/assets\/[^(]{0,300}\(type: [^,]{1,60}, id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
function sessionAssetEvidence(events, entries) {
  const writes = [];
  const reported = [];
  const mentioned = [];
  for (const e of entries || []) {
    const tool = e.entryType === 'TOOL_RESULT' ? e.toolResult?.toolName : null;
    const out = tool === 'write' || tool === 'sequence' ? e.toolResult.result?.output : null;
    if (typeof out !== 'string' || out.startsWith('Error')) continue;
    for (const m of out.slice(0, 40000).matchAll(tool === 'write' ? WRITTEN_ID : SEQUENCE_WRITTEN)) reported.push(m[1]);
  }
  for (const ev of events || []) {
    const p = ev.payload || {};
    if (ev.eventType === 'WRITE_METERING' && p.outcome === 'written') {
      const w = writePath(p.path);
      if (w) writes.push(w);
    }
    if (ev.eventType === 'TURN_UPDATED_ASSETS') {
      const arr = Array.isArray(p.assets) ? p.assets : parseJson(p.assets);
      for (const a of Array.isArray(arr) ? arr : []) if (a?.id) reported.push(a.id);
    }
    if (ev.eventType === 'AGENT_MENTIONED_ASSETS') for (const id of Object.keys(p)) if (/^[0-9a-f-]{36}$/i.test(id)) mentioned.push(id);
  }
  return { writes, reported, mentioned };
}

// ---- stories ----
// A STORY is pages, not a timeline: each visible page (children in indexInParent order, minus
// externalConfig.hidden) shows for durationMs (else the root's defaultPageDurationMs), hard cuts
// between them. A page's background is its Clip component (src: an mp4, or "" for a still page with
// a poster) or design.background (image or color). Voice-over and music sit in the root's
// externalConfig in milliseconds. The product exports exactly Σ floor(durationMs · fps / 1000)
// frames, so timing here matches its story export. Text layers are not reproduced.
const STORY_CLIP = 'bf89429d';
function storyOutputs(root, list, sceneRecord) {
  const ec = root.externalConfig || {};
  const fps = Number(ec.fps) || 60;
  const def = Number(ec.defaultPageDurationMs) || 3000;
  const pages = list.filter((a) => a.parentId === root.id && !a.externalConfig?.hidden)
    .sort((a, b) => (a.layout?.order?.indexInParent ?? 0) - (b.layout?.order?.indexInParent ?? 0));
  const scenes = pages.map((p, i) => {
    const clip = (p.components || []).find((c) => String(c.data?.extensionId || '').startsWith(STORY_CLIP))?.data?.props || {};
    const playback = typeof clip.playback === 'string' ? parseJson(clip.playback) || {} : clip.playback || {};
    const bg = p.design?.background || {};
    const sec = Math.floor((Number(p.externalConfig?.durationMs ?? def) * fps) / 1000) / fps;
    const base = sceneRecord(p);
    return {
      ...base,
      clipUrl: /\.(mp4|webm|mov)(\?|$)/i.test(clip.src || '') ? clip.src : null,
      clipVolume: playback.muted === false ? 1 : 0,
      clipStartSec: Number(playback.startTime || 0),
      stillUrl: clip.poster_url || clip.first_frame_image_url || bg.media?.image?.url || null,
      color: bg.color || '#000000',
      fit: bg.ratio === 'FIT',
      thumbnailUrl: p.thumbnailUrl || clip.poster_url || clip.first_frame_image_url || bg.media?.image?.url || null,
      // At the 24fps the review copies use; startSec/endSec are filled in like a video's scenes.
      frames: null,
      trimStart: 0,
      trimEnd: 0,
      playFrames: Math.round(sec * 24),
      order: i,
    };
  });
  const ms = (x) => Number(x || 0) / 1000;
  const vo = ec.voiceover?.url ? [{ url: ec.voiceover.url, atSec: ms(ec.voiceover.startMs), volume: Number(ec.voiceover.volume ?? 1) }] : [];
  const voices = [...vo, ...(ec.voiceoverClips || []).filter((c) => c?.url).map((c) => ({ url: c.url, atSec: ms(c.startMs ?? c.atMs), volume: Number(c.volume ?? 1) }))];
  const music = (ec.musicClips?.length ? ec.musicClips : ec.backgroundMusic?.url && ec.backgroundMusic.enabled !== false ? [ec.backgroundMusic] : [])
    .filter((c) => c?.url).map((c) => ({ url: c.url, atSec: ms(c.startMs ?? c.atMs), volume: Number(c.volume ?? 1), fadeOutSec: ms(c.fadeOutMs ?? 1500) }));
  const sfx = (ec.sfx || []).filter((c) => c?.url).map((c) => ({ url: c.url, atSec: ms(c.atMs ?? c.startMs), volume: Number(c.volume ?? 1) }));
  const dims = root.layout?.dimensions || { width: 1080, height: 1920 };
  return {
    kind: 'story',
    rootAssetId: root.id,
    name: root.name,
    status: null,
    thumbnailUrl: root.thumbnailUrl || scenes[0]?.thumbnailUrl || null,
    width: dims.width,
    height: dims.height,
    aspect: `${dims.width}:${dims.height}`,
    contentUpdatedAt: Math.max(...[root, ...pages].map((a) => ms(Date.parse(a.lastContentUpdatedDate || a.updatedDate || 0)) * 1000).filter(Number.isFinite), 0),
    story: { fps, voices, music, sfx, duckVolume: Number(ec.voiceover?.musicDuckVolume ?? 1), captions: ec.captions?.enabled ? 'on' : 'off', style: ec.style || null },
    music: null,
    rootAudio: [],
    scenes,
  };
}

// ---- the record ----
// `opts.rootId`: the run's own output to show as the root (from the list row), when known.
export function normalizeSession(bundle, opts = {}) {
  const { meta, entries = [], events = [], assets } = bundle;
  const sorted = [...entries].sort((a, b) => Number(a.sequence) - Number(b.sequence));

  const skills = [];
  const codexVersionIds = new Set();
  const userMessages = [];
  const turns = new Map();
  const modelCalls = [];
  const calls = new Map();
  const steps = [];
  const errors = [];
  let lastIterationStart = null;
  let scraped = null;
  let brief = null;

  for (const e of sorted) {
    const at = ms(e.createdDate);
    switch (e.entryType) {
      case 'USER_MESSAGE': {
        const m = e.userMessage || {};
        const pre = preloadedSkills(e.metadata);
        userMessages.push({ at, turnId: e.turnId, text: m.text || '', kind: m.kind || null, attachments: m.attachments || [], stageContext: m.messageContext?.stageContext || null, preloadedSkills: pre.all });
        for (const name of pre.loads) skills.push({ name, at, turnId: e.turnId, preloaded: true });
        break;
      }
      case 'TURN_BOUNDARY': {
        const tb = e.turnBoundary || {};
        const t = turns.get(e.turnId) || { turnId: e.turnId };
        if (tb.kind?.endsWith('STARTED')) {
          t.startedAt = at;
          t.model = e.metadata?.model ?? null;
          if (e.metadata?.codexVersionId) codexVersionIds.add((t.codexVersionId = e.metadata.codexVersionId));
        } else {
          t.endedAt = at;
          t.kind = tb.kind?.replace('TURN_BOUNDARY_KIND_', '');
          t.durationMs = tb.durationMs ? Number(tb.durationMs) : null;
          t.reason = tb.reason || null;
          t.lastAssistantMessage = tb.lastAssistantMessage || null;
          if (t.kind === 'FAILED') errors.push({ at, turnId: e.turnId, source: 'turn', message: tb.reason || 'Turn failed' });
        }
        turns.set(e.turnId, t);
        break;
      }
      case 'SYSTEM_EVENT': {
        const se = e.systemEvent || {};
        if (se.eventName === 'iteration_start') lastIterationStart = at;
        if (se.eventName === 'empty_response_retry') errors.push({ at, turnId: e.turnId, source: 'model', message: 'Empty model response (retried)' });
        if (se.eventName === 'turn_analysis') {
          const p = se.payload || {};
          const t = turns.get(e.turnId) || { turnId: e.turnId };
          t.sentiment = p.sentimentLabel || null;
          t.sentimentDetail = p.sentimentDetail || null;
          t.outcome = p.turnOutcome || null;
          t.intent = p.intentSubcategory || p.intentText || null;
          t.language = p.intentLanguage || null;
          turns.set(e.turnId, t);
        }
        break;
      }
      case 'MODEL_CALL': {
        const mc = e.modelCall || {};
        modelCalls.push({
          at,
          turnId: e.turnId,
          model: mc.model,
          purpose: mc.purpose,
          status: mc.status?.replace('MODEL_CALL_STATUS_', ''),
          inputTokens: Number(mc.usage?.inputTokens || 0),
          cachedInputTokens: Number(mc.usage?.cachedInputTokens || 0),
          outputTokens: Number(mc.usage?.outputTokens || 0),
          // Model calls carry no duration; the gap since the iteration started is the model's latency.
          latencyMs: lastIterationStart ? at - lastIterationStart : null,
          startedAt: lastIterationStart,
        });
        if (mc.status && !mc.status.endsWith('SUCCESS')) errors.push({ at, turnId: e.turnId, source: 'model', message: `${mc.model}: ${mc.status}` });
        break;
      }
      case 'TOOL_CALL': {
        const tc = e.toolCall || {};
        const args = tc.arguments || {};
        if (tc.toolName === 'skill' && args.name) skills.push({ name: args.name, at, turnId: e.turnId });
        const method = tc.toolName === 'invoke_rpc' ? args.method || null : null;
        const step = {
          id: tc.toolCallId,
          turnId: e.turnId,
          tool: tc.toolName,
          method,
          category: categorize(tc.toolName, method),
          label: method || (tc.toolName === 'skill' ? `skill: ${args.name}` : tc.toolName),
          startedAt: at,
          args,
          status: 'running',
          mediaIn: urlsIn(args).map((url) => ({ url, id: mediaId(url), kind: mediaKind(url) })),
        };
        // Writing the result into the project (the scenes, the root ad, slides…): `write`/`read` on
        // project/assets/*.json. Its own category, labelled by asset, so it isn't hidden as plumbing.
        if ((tc.toolName === 'write' || tc.toolName === 'read') && /^project\/assets\//.test(args.path || '')) {
          step.category = 'assets';
          step.assetName = String(args.path).replace(/^project\/assets\//, '').replace(/--[0-9a-f]{6,}\.json$|\.json$/i, '');
          step.assetOps = (args.edits || []).map((x) => x.op).filter(Boolean);
          step.label = `${tc.toolName === 'write' ? 'save' : 'check'}: ${step.assetName}`;
        }
        step.prompt = promptOf(step);
        calls.set(tc.toolCallId, step);
        steps.push(step);
        break;
      }
      case 'TOOL_RESULT': {
        const tr = e.toolResult || {};
        const step = calls.get(tr.toolCallId);
        if (!step) break;
        const outputRaw = tr.result?.output;
        const outputJson = parseJson(outputRaw);
        const job = tr.result?.processJob || outputJson?.processJob || null;
        step.endedAt = at;
        step.durationMs = e.metadata?.durationMs ?? (at - step.startedAt);
        step.rpcTarget = e.metadata?.toolMetadata?.rpcTarget || null;
        step.output = trimOutput(outputJson ?? outputRaw ?? null);
        const failed = tr.status?.includes('ERROR') || tr.errorMessage || outputLooksFailed(outputRaw) || job?.status === 'FAILED';
        step.status = failed ? 'failed' : 'ok';
        if (job) {
          step.jobId = job.jobId;
          step.jobStatus = job.status;
          step.graphId = job.description?.match(/graph execution for (\w+)/)?.[1] ?? null;
          step.workflowId = job.jobResult?.workflow_id ?? null;
          step.resultUrl = job.jobResult?.result_url ?? null;
        }
        if (step.tool === 'generate_image' || step.tool === 'edit_image' || step.tool === 'convert_image_format') {
          step.resultUrl = outputJson?.url ?? null;
          step.model = outputJson?.model ?? null;
        }
        // Media this step produced: a job's result (sometimes a JSON blob, e.g. TTS captions) or an
        // image tool's url. A non-URL result (a probed duration) is kept as a value.
        const IMAGE_MAKERS = ['generate_image', 'edit_image', 'convert_image_format'];
        const produced = urlsIn(job ? job.jobResult : IMAGE_MAKERS.includes(step.tool) ? outputJson : null);
        // Some results aren't a bare URL: TTS returns "mp3|captions.json|{captions…}", probes a number.
        if (step.resultUrl && !/^https?:\/\/\S+$/.test(step.resultUrl)) {
          step.resultValue = String(step.resultUrl).slice(0, 300);
          step.resultUrl = produced.find((u) => mediaKind(u) !== 'image') || produced[0] || null;
        }
        step.mediaOut = produced.map((url) => ({ url, id: mediaId(url), kind: mediaKind(url) }));
        step.model ??= step.args?.requestJson?.parameters?.model || null;
        if (step.tool === 'scrape_url' && !failed) scraped = { url: step.args?.url || null, ...parseScrape(outputRaw) };
        if (step.tool === 'ask_user' && !failed) brief = outputJson ?? outputRaw;
        if (failed && !step.jobId && typeof outputRaw === 'string') step.jobId = outputRaw.match(/Async job ([0-9a-f-]{36}) failed/)?.[1] ?? null;
        if (failed) {
          const message = tr.errorMessage || (typeof outputRaw === 'string' ? outputRaw : JSON.stringify(outputRaw))?.slice(0, 2000) || 'failed';
          step.error = message;
          errors.push({ at, turnId: step.turnId, source: 'tool', stepId: step.id, tool: step.tool, method: step.method, message });
        }
        break;
      }
    }
  }

  // ---- outputs: the asset tree ----
  const list = Array.isArray(assets?.assets) ? assets.assets : [];
  // What this session made (own-assets.js): its own writes, the editor's per-turn reports and the
  // assets it handed over. The project's root asset is often another session's work (a campaign's
  // story next to this session's video), so the root shown and assembled is one of the session's
  // own: the given one (the run's output from the list), else its video, else its story, else any.
  const sorted0 = sorted.length ? ms(sorted[0].createdDate) : null;
  const sortedN = sorted.length ? ms(sorted.at(-1).createdDate) : null;
  const madeIds = ownedAssetIds({ ...sessionAssetEvidence(events, entries), jobs: jobTypes(steps.map((x) => x.method).filter(Boolean)) }, list.map((a) => ({ id: a.id, parentId: a.parentId || null, name: a.name, type: a.type, created: ms(a.createdDate), updated: ms(a.updatedDate) })),
    (t) => Boolean(t) && sorted0 != null && t >= sorted0 - 60000 && t <= sortedN + 300000);
  const made = list.filter((a) => !a.parentId && madeIds.has(a.id));
  const root = (opts.rootId && list.find((a) => a.id === opts.rootId)) || made.find((a) => a.type === 'VIDEO') || made.find((a) => a.type === 'STORY') || made[0] || null;
  const scenes = root ? list.filter((a) => a.parentId === root.id) : [];
  // Timeline semantics from wixel-video-bm: scenes are hard cuts in layout.order.indexInParent
  // order; each plays (frameDuration - trim_start - trim_end) frames at 24fps starting trim_start
  // frames into its clip. Voice is baked into clips with volume > 0; others are muted.
  const sceneRecord = (a) => {
    const props = (a.components || []).map((c) => c.data?.props || {});
    const clip = props.find((p) => typeof p.src === 'string' && /\.(mp4|webm|mov)/i.test(p.src));
    const ec = a.externalConfig || {};
    const frames = ec.frameDuration ?? null;
    const trimStart = Number(ec.trim_start || 0);
    const trimEnd = Number(ec.trim_end || 0);
    return {
      id: a.id,
      name: a.name,
      thumbnailUrl: a.thumbnailUrl || clip?.poster_url || null,
      clipUrl: clip?.src || null,
      clipVolume: clip ? Number(clip.volume ?? 1) : null,
      frames,
      trimStart,
      trimEnd,
      playFrames: frames != null ? frames - trimStart - trimEnd : null,
      texts: props.filter((p) => p.richText).map((p) => (p.richText.content || []).map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('').trim()).filter(Boolean),
      // Typography the ad actually used: quill runs carry font / color / size.
      textStyles: props.filter((p) => p.richText).flatMap((p) => (p.richText.content || [])
        .filter((op) => typeof op.insert === 'string' && op.insert.trim() && op.attributes)
        .map((op) => ({ text: op.insert.trim().slice(0, 80), font: op.attributes.font || null, color: op.attributes.color || null, size: op.attributes.size || null, bold: Boolean(op.attributes.bold) }))),
      animation: props.find((p) => p.textAnimation)?.textAnimation?.preset || null,
      status: ec.status ?? null,
      order: a.layout?.order?.indexInParent ?? Number(a.name?.match(/\d+/)?.[0] ?? 999),
    };
  };
  const rootDims = root?.layout?.dimensions || root?.components?.[0]?.layout?.dimensions || null;
  const outputs = root?.type === 'STORY' ? storyOutputs(root, list, sceneRecord) : root
    ? {
        kind: 'video',
        rootAssetId: root.id,
        name: root.name,
        status: root.externalConfig?.status ?? null,
        thumbnailUrl: root.thumbnailUrl || null,
        width: rootDims?.width ?? null,
        height: rootDims?.height ?? null,
        aspect: root.externalConfig?.user_parameters?.aspect_ratio || (rootDims ? `${rootDims.width}:${rootDims.height}` : null),
        userParameters: root.externalConfig?.user_parameters ?? null,
        conversationSummary: root.externalConfig?.conversation_summary ?? null,
        music: root.externalConfig?.background_music ?? null,
        // Root audio tracks: a voiceover (extension "tts") and/or music ("audio-timeline"). Voice is
        // usually baked into scene clips, but some ads keep it here. A missing volume means 1; a
        // volume-0 tts is wixel-ads' muted captions carrier.
        // Root audio tracks: a voiceover (extension 7572e63a…, older 7eebe4f0…) and/or music
        // (80e9c773…). Their settings live in the component's externalConfig (trims and shift in
        // 24fps frames), as the product's player reads them; older ads kept them in data.props. A
        // missing volume means 1; a volume-0 voiceover is wixel-ads' muted captions carrier.
        rootAudio: (root.components || []).map((c) => ({ ext: String(c.data?.extensionId || ''), p: { ...(c.data?.props || {}), ...(c.externalConfig || {}) } }))
          .filter(({ p }) => p.enabled !== false && /\.(mp3|wav|m4a|aac)(\?|$)/i.test(String(p.resultUrl || p.result_url || p.url || '')))
          .map(({ ext, p }) => ({
            kind: /^(7572e63a|7eebe4f0)/.test(ext) || /tts/i.test(ext) || p.captionsUrl || p.captionsEnabled !== undefined ? 'voice' : 'music',
            url: p.resultUrl || p.result_url || p.url,
            volume: p.volume == null ? 1 : Number(p.volume),
            shiftSec: Number(p.frame_shift || 0) / 24,
            trimStartSec: Number(p.trim_start || 0) / 24,
            // Where it ends on the timeline (the product runs the video until its last track ends).
            durationSec: Number(p.duration) || null,
            trimEndSec: Number(p.trim_end || 0) / 24,
          })),
        captions: root.externalConfig?.captionsStyle ?? null,
        styleGuidelines: root.externalConfig?.context?.style_guidelines ?? null,
        scenes: scenes.map(sceneRecord).sort((a, b) => a.order - b.order),
      }
    : null;
  // ---- every top-level asset with its pages/parts (for non-video skills: docs, slides, logos…) ----
  const assetTree = list.filter((a) => !a.parentId).map((a) => ({
    id: a.id,
    type: String(a.type || '').toLowerCase(),
    name: a.name,
    thumbnailUrl: a.thumbnailUrl || null,
    updated: ms(a.updatedDate),
    // Made by this session (else: other work in the same project).
    own: madeIds.has(a.id),
    children: list.filter((c) => c.parentId === a.id)
      .sort((x, y) => (x.layout?.order?.indexInParent ?? 0) - (y.layout?.order?.indexInParent ?? 0))
      .map((c) => ({ id: c.id, name: c.name, type: String(c.type || '').toLowerCase(), thumbnailUrl: c.thumbnailUrl || null })),
  }));

  // ---- lineage: which steps made each scene's clip ----
  // A step's inputs are the media URLs in its args; its outputs the media it produced. Walking
  // producer → inputs → their producers gives the chain (image → edit → video → voice merge).
  const producerOf = new Map();
  for (const st of steps) for (const m of st.mediaOut || []) if (!producerOf.has(m.id)) producerOf.set(m.id, st);
  const lineage = (clipUrl) => {
    const out = new Map();
    const visit = (st, depth) => {
      if (!st || out.has(st.id) || depth > 8) return;
      out.set(st.id, st);
      for (const m of st.mediaIn || []) {
        const p = producerOf.get(m.id);
        if (p && p !== st && (p.startedAt || 0) <= (st.startedAt || 0)) visit(p, depth + 1);
      }
    };
    visit(producerOf.get(mediaId(clipUrl)), 0);
    return [...out.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map((x) => x.id);
  };
  if (outputs) for (const sc of outputs.scenes) sc.lineage = sc.clipUrl ? lineage(sc.clipUrl) : [];

  // ---- brand the site had vs brand the ad used ----
  const siteBrand = steps.find((x) => x.method === 'GetSiteBrand' && x.status === 'ok')?.output || null;
  const adFonts = new Map();
  const adColors = new Map();
  for (const sc of outputs?.scenes || []) for (const t of sc.textStyles || []) {
    if (t.font) adFonts.set(t.font, (adFonts.get(t.font) || 0) + 1);
    if (t.color) adColors.set(t.color.toUpperCase(), (adColors.get(t.color.toUpperCase()) || 0) + 1);
  }
  const brand = {
    site: siteBrand && typeof siteBrand === 'object' ? siteBrand : null,
    adFonts: [...adFonts.entries()].map(([font, n]) => ({ font, n })).sort((a, b) => b.n - a.n),
    adColors: [...adColors.entries()].map(([color, n]) => ({ color, n })).sort((a, b) => b.n - a.n),
    logoShot: steps.some((x) => /LogoShot/.test(x.method || '') && x.status === 'ok'),
    logoConverted: steps.find((x) => x.tool === 'convert_image_format' && /logo/i.test(JSON.stringify(x.args)))?.resultUrl || null,
  };

  const totalFrames = outputs?.scenes.reduce((s, x) => s + (x.playFrames || 0), 0) || 0;
  if (outputs) {
    outputs.fps = 24;
    outputs.durationSec = totalFrames ? Math.round((totalFrames / 24) * 10) / 10 : null;
    let at = 0;
    for (const sc of outputs.scenes) {
      sc.startSec = at / 24;
      at += sc.playFrames || 0;
      sc.endSec = at / 24;
    }
  }

  // ---- cost + user-facing signals from session events ----
  let modelMicrocents = 0;
  const feedback = [];
  const assetUpdates = [];
  const outOfFunds = [];
  const streamErrors = [];
  for (const ev of events) {
    const at = ms(ev.createdDate);
    const p = ev.payload || {};
    if (ev.eventType === 'MODEL_USAGE_RECORDED') modelMicrocents += Number(p.usage?.microcentsSpent || 0);
    // The editor reporting assets a turn wrote (TURN_UPDATED_ASSETS): when they actually landed.
    if (ev.eventType === 'TURN_UPDATED_ASSETS') {
      const list = Array.isArray(p.assets) ? p.assets : parseJson(p.assets) || [];
      assetUpdates.push({ at, turnId: ev.turnId, assets: (Array.isArray(list) ? list : []).map((a) => ({ id: a.id, name: a.name, type: String(a.assetType || '').replace(/^wixel-asset\//, '') })) });
    }
    if (ev.eventType === 'USER_FEEDBACK') feedback.push({ at, turnId: ev.turnId, value: p.feedback, tags: p.tags ? String(p.tags).split(',') : [], type: p.type });
    if (ev.eventType === 'OUT_OF_FUNDS') {
      outOfFunds.push({ at, turnId: ev.turnId, message: p.message, method: p.method, surfaced: p.surfaced });
      errors.push({ at, turnId: ev.turnId, source: 'credits', message: p.message || 'Out of credits', method: p.method });
    }
    if (ev.eventType === 'MODEL_STREAM_ERROR') {
      streamErrors.push({ at, turnId: ev.turnId, error: p.error, message: p.message });
      errors.push({ at, turnId: ev.turnId, source: 'model', message: p.error || p.message || 'Model stream error' });
    }
  }
  errors.sort((a, b) => (a.at || 0) - (b.at || 0));

  // ---- building the result: composing and saving assets ----
  // The model call right before a batch of asset saves is the agent writing those edits (large
  // JSON, often most of the phase); the saves themselves take a second or two.
  const saves = steps.filter((x) => x.category === 'assets' && x.tool === 'write');
  for (const m of modelCalls) {
    const next = steps.filter((x) => x.startedAt >= m.at && x.startedAt <= m.at + 3000);
    const n = next.filter((x) => x.category === 'assets' && x.tool === 'write').length;
    if (n) m.composes = n;
  }
  let assetBuild = null;
  if (saves.length) {
    // The phase: from the first composing call before the last generation-free stretch of saves to
    // the last save/check, per run of consecutive asset work (other tools in between split it).
    const composing = modelCalls.filter((m) => m.composes);
    const checks = steps.filter((x) => x.category === 'assets' && x.tool === 'read');
    const lastGen = steps.filter((x) => x.workflowId || x.jobId || ['image', 'video', 'tts', 'audio'].includes(x.category)).reduce((a, x) => Math.max(a, x.endedAt || x.startedAt || 0), 0);
    const finalSaves = saves.filter((x) => x.startedAt >= lastGen);
    const finalCompose = composing.filter((m) => m.at >= lastGen - 1000);
    const start = Math.min(...[...finalCompose.map((m) => m.startedAt), ...finalSaves.map((x) => x.startedAt)].filter(Boolean));
    const endAll = [...saves, ...checks].reduce((a, x) => Math.max(a, x.endedAt || x.startedAt || 0), 0);
    const lastUpdate = assetUpdates.reduce((a, u) => Math.max(a, u.at || 0), 0);
    assetBuild = {
      saves: saves.length,
      failed: saves.filter((x) => x.status === 'failed').length + checks.filter((x) => x.status === 'failed').length,
      assets: [...new Set(saves.map((x) => x.assetName))],
      saveMs: saves.reduce((a, x) => a + Number(x.durationMs || 0), 0),
      checkMs: checks.reduce((a, x) => a + Number(x.durationMs || 0), 0),
      composeMs: composing.reduce((a, m) => a + (m.latencyMs || 0), 0),
      composeTokens: composing.reduce((a, m) => a + m.outputTokens, 0),
      // The final build: after the last generation finished, until the last save or check.
      final: finalSaves.length && Number.isFinite(start) ? { startAt: start, endAt: endAll, ms: endAll - start, afterLastGenMs: start - lastGen, saves: finalSaves.length } : null,
      lastUpdateAt: lastUpdate || null,
    };
  }

  // ---- timing ----
  const byCategory = {};
  for (const s of steps) if (s.durationMs != null) byCategory[s.category] = (byCategory[s.category] || 0) + Number(s.durationMs);
  byCategory.model = modelCalls.reduce((a, m) => a + (m.latencyMs || 0), 0);
  const firstAt = sorted.length ? ms(sorted[0].createdDate) : ms(meta?.createdAt);
  const lastAt = sorted.length ? ms(sorted.at(-1).createdDate) : ms(meta?.updatedAt);

  const generations = steps.filter((s) => s.workflowId);
  const clips = steps.filter((s) => s.resultUrl && /\.(mp4|webm|mov)/i.test(s.resultUrl)).map((s) => ({ stepId: s.id, url: s.resultUrl, method: s.method }));
  const images = steps.filter((s) => s.resultUrl && /\.(png|jpe?g|webp)/i.test(s.resultUrl)).map((s) => ({ stepId: s.id, url: s.resultUrl, tool: s.tool, model: s.model }));
  const turnList = [...turns.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const running = turnList.some((t) => t.startedAt && !t.endedAt);

  return {
    id: bundle.sessionId,
    title: meta?.title ?? null,
    createdAt: ms(meta?.createdAt) ?? firstAt,
    updatedAt: ms(meta?.updatedAt) ?? lastAt,
    agentName: meta?.agentName ?? null,
    source: meta?.source ?? null,
    callerName: meta?.callerName ?? null,
    sentiment: meta?.sentiment ?? null,
    premiumPlan: meta?.premiumPlan ?? null,
    user: meta ? { id: meta.userId, email: meta.userEmail, photoUrl: meta.userPhotoUrl, isWixEmail: /@wix\.com$/i.test(meta.userEmail || '') } : null,
    projectId: meta?.projectId ?? assets?.projectId ?? null,
    msid: meta?.metaSiteId ?? null,
    skills,
    codexVersionIds: [...codexVersionIds],
    prompt: userMessages[0]?.text ?? '',
    userMessages,
    brief,
    scraped,
    brand,
    assetTree,
    turns: turnList,
    steps,
    modelCalls,
    errors,
    feedback,
    assetUpdates,
    assetBuild,
    outOfFunds,
    streamErrors,
    sentiments: turnList.filter((t) => t.sentiment).map((t) => ({ turnId: t.turnId, at: t.endedAt || t.startedAt, label: t.sentiment, detail: t.sentimentDetail })),
    generations: generations.length,
    clips,
    images,
    outputs,
    cost: {
      modelUsd: modelMicrocents / 1e8,
      inputTokens: modelCalls.reduce((a, m) => a + m.inputTokens, 0),
      outputTokens: modelCalls.reduce((a, m) => a + m.outputTokens, 0),
    },
    timing: { firstAt, lastAt, wallMs: firstAt && lastAt ? lastAt - firstAt : null, byCategory },
    status: running ? 'running' : outputs?.scenes.length ? (errors.length ? 'done-with-errors' : 'done') : errors.length ? 'failed' : 'no-output',
  };
}

// Which turns of a session count for `skill`: the same rule as the day queries (queries.js
// ownCtes). A turn loading the skill (skill tool or preload) claims the session; later turns stay
// with it until one loads a skill outside `family`. `family: null` counts every turn. Turn order
// is by start time.
// Where the counted turns' time went (time-split.js), from the session's own steps: the run view's
// bar, also for runs whose day hasn't got step data (the steps query can time out on a busy cluster).
export function detailTimeSplit(rec) {
  const owned = rec.scope && !rec.scope.whole ? new Set(rec.scope.owned) : null;
  const mine = (turnId) => !owned || owned.has(turnId);
  const steps = (rec.steps || []).filter((x) => mine(x.turnId) && x.startedAt);
  const turns = (rec.turns || []).filter((t) => mine(t.turnId) && t.startedAt).map((t) => {
    const last = Math.max(t.startedAt, ...steps.filter((x) => x.turnId === t.turnId).map((x) => x.endedAt || x.startedAt));
    return [t.startedAt, t.endedAt || last];
  });
  return splitTime({
    turns,
    calls: steps.map((x) => ({ tool: x.tool, method: x.method, failed: x.status === 'failed', unfinished: x.jobStatus === 'IN_PROGRESS' && !x.resultUrl, start: x.startedAt, end: x.endedAt || x.startedAt + Number(x.durationMs || 0) })),
  });
}

export function turnOwnership(rec, skill, family) {
  const loads = new Map();
  const firstAt = new Map();
  const seen = (turnId, at) => {
    if (turnId && at != null && !(firstAt.get(turnId) <= at)) firstAt.set(turnId, at);
  };
  for (const s of rec.steps || []) seen(s.turnId, s.startedAt);
  for (const m of rec.userMessages || []) seen(m.turnId, m.at);
  for (const l of rec.skills || []) if (l.turnId) loads.set(l.turnId, [...(loads.get(l.turnId) || []), l.name]);
  for (const t of rec.turns || []) if (t.startedAt) firstAt.set(t.turnId, Math.min(t.startedAt, firstAt.get(t.turnId) ?? Infinity));
  const order = [...firstAt.keys()].filter(Boolean).sort((a, b) => firstAt.get(a) - firstAt.get(b));
  const fam = new Set(family || []);
  let on = false;
  const turns = order.map((turnId, i) => {
    const skills = [...new Set(loads.get(turnId) || [])];
    if (!family) on = true;
    else if (skills.includes(skill)) on = true;
    else if (skills.some((x) => x !== skill && !fam.has(x))) on = false;
    return { turnId, n: i + 1, owned: on, skills, startedAt: firstAt.get(turnId) };
  });
  return { skill, family, whole: !family, turns, owned: turns.filter((t) => t.owned).map((t) => t.turnId) };
}
