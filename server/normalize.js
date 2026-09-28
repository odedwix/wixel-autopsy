// Session bundle (admin API) → one run record the UI can render without further parsing.

const ms = (t) => (t ? Date.parse(t) : null);

function parseJson(s) {
  if (typeof s !== 'string') return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
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

// ---- the record ----
export function normalizeSession(bundle) {
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
        userMessages.push({ at, text: m.text || '', kind: m.kind || null, attachments: m.attachments || [], stageContext: m.messageContext?.stageContext || null });
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
          if (t.kind === 'FAILED') errors.push({ at, source: 'turn', message: tb.reason || 'Turn failed' });
        }
        turns.set(e.turnId, t);
        break;
      }
      case 'SYSTEM_EVENT': {
        const se = e.systemEvent || {};
        if (se.eventName === 'iteration_start') lastIterationStart = at;
        if (se.eventName === 'empty_response_retry') errors.push({ at, source: 'model', message: 'Empty model response (retried)' });
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
        if (mc.status && !mc.status.endsWith('SUCCESS')) errors.push({ at, source: 'model', message: `${mc.model}: ${mc.status}` });
        break;
      }
      case 'TOOL_CALL': {
        const tc = e.toolCall || {};
        const args = tc.arguments || {};
        if (tc.toolName === 'skill' && args.name) skills.push({ name: args.name, at });
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
          errors.push({ at, source: 'tool', stepId: step.id, tool: step.tool, method: step.method, message });
        }
        break;
      }
    }
  }

  // ---- outputs: the asset tree ----
  const list = Array.isArray(assets?.assets) ? assets.assets : [];
  const root = list.find((a) => a.id === assets?.rootAssetId) || list.find((a) => a.type === 'VIDEO' && !a.parentId) || null;
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
  const rootDims = root?.components?.[0]?.layout?.dimensions || null;
  const outputs = root
    ? {
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
        captions: root.externalConfig?.captionsStyle ?? null,
        styleGuidelines: root.externalConfig?.context?.style_guidelines ?? null,
        scenes: scenes.map(sceneRecord).sort((a, b) => a.order - b.order),
      }
    : null;
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
  const outOfFunds = [];
  const streamErrors = [];
  for (const ev of events) {
    const at = ms(ev.createdDate);
    const p = ev.payload || {};
    if (ev.eventType === 'MODEL_USAGE_RECORDED') modelMicrocents += Number(p.usage?.microcentsSpent || 0);
    if (ev.eventType === 'USER_FEEDBACK') feedback.push({ at, turnId: ev.turnId, value: p.feedback, tags: p.tags ? String(p.tags).split(',') : [], type: p.type });
    if (ev.eventType === 'OUT_OF_FUNDS') {
      outOfFunds.push({ at, turnId: ev.turnId, message: p.message, method: p.method, surfaced: p.surfaced });
      errors.push({ at, source: 'credits', message: p.message || 'Out of credits', method: p.method });
    }
    if (ev.eventType === 'MODEL_STREAM_ERROR') {
      streamErrors.push({ at, turnId: ev.turnId, error: p.error, message: p.message });
      errors.push({ at, source: 'model', message: p.error || p.message || 'Model stream error' });
    }
  }
  errors.sort((a, b) => (a.at || 0) - (b.at || 0));

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
    turns: turnList,
    steps,
    modelCalls,
    errors,
    feedback,
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
