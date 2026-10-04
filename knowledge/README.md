# Autopsy Fleet — what we know

Generated 2026-10-04 07:58 UTC from the Fleet day rollups (`.fleet/days`). Last 7 days: 2026-09-27 → 2026-10-03 (7 days built); last 30 days: 14 days built. Real users only. Codex: origin/HEAD @ 5010e885 (2026-10-01).

Counts, durations, recoveries, tokens and outcomes are measured from the agent's own entries. "Time lost" = each failed call's time plus one recovery per run of consecutive failures (until the next successful attempt started, else the turn's end). Savings and recommended timeouts are estimates. Definitions: README → Fleet.

## The week in numbers
- 66,635 sessions, 120,495 turns, 728,382 tool calls
- 4.3% of tool calls fail (out of credits excluded); 704 h a week lost to failures
- 131 hidden timeouts (the tool returned while its job was still running)
- 9.7% of turns frustrated; 5.0 model iterations per turn; 119k input tokens per iteration
- Outputs kept (downloaded): 38% of sessions that produced one; 13% generated but wrote nothing
- 9.3% of sessions used no skill

## Things we learned about the data
- **Skills are preloaded since 2026-09-30.** The platform puts skills into the session's first message (`metadata.preloadedSkillBodies`) instead of the agent calling the `skill` tool: sessions with a skill-tool call fell from ~85% to ~40% overnight, across every agent. Fleet counts both; Autopsy's per-skill views only counted tool calls (being fixed separately).
- **`TURN_UPDATED_ASSETS` was only logged 2026-09-16 → 09-28.** Asset writes are in `WRITE_METERING` (path, asset type, outcome) and handed-over assets in `AGENT_MENTIONED_ASSETS`.
- **Hidden timeouts:** several tools (`generateMusic`, `poll_process_job`, `Generate*Async`, `BuildPresentation`) report success after ~15 minutes while the job is still `IN_PROGRESS`.
- **`ask_user` "User cancelled the question"** is how questions normally resolve — not a failure.
- **The admin SQL endpoint** re-runs a query for every 500-row page and can repeat rows across pages: every Fleet query stays under 500 rows.

## What changed (last 30 days)
- 2026-10-02: **Failing tool calls** 2.9% → 6.5%
- 2026-09-30: **New codex version** · new codex version fc0bcb69-9 (59% of turns)
- 2026-09-29: **New codex version** · new codex version e5fd67f5-2 (34% of turns)
- 2026-09-28: **New codex version** · new codex version 2dde3a82-b (22% of turns)
- 2026-09-24: **New codex version** · new codex version 369aec2c-c (33% of turns)
- 2026-09-23: **New codex version** · new codex version 4ad17396-b (35% of turns)

## Do these first (hours a week given back)
1. INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an empty error) — **47 h/week** · Model catalog / tool owner
2. wixel-ads spends 7.9 file operations per turn, re-reading the same file 0.7× a turn — **39 h/week** · Agent design (estimate)
3. Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → Cannot fetch content from the provided URL. Please ensu — **35 h/week** · Model catalog / tool owner
4. stories-creation spends 10.3 file operations per turn, re-reading the same file 1.1× a turn — **26 h/week** · Agent design (estimate)
5. invoke_rpc ListCosts is called the same way every time — give the agent the answer instead — **23 h/week** · Agent design (estimate)
6. video-logo-animation spends 11.2 file operations per turn, re-reading the same file 2.8× a turn — **19 h/week** · Agent design (estimate)
7. video-creation spends 6.3 file operations per turn, re-reading the same file 0.6× a turn — **18 h/week** · Agent design (estimate)
8. Error loading Codex resource "resources/video/video-data-model.md": UNKNOWN: document 'resources/video/video-data-model.md' not found in current version for bas — **14 h/week** · Skill author (codex)
9. INVALID_ARGUMENT: Error invoking endpoint: [N] → failedToTransferImage: Invalid value for 'referenceImages[N]' parameter. Failed to transfer the provided image. — **14 h/week** · Model catalog / tool owner
10. Auto-correct "INVALID_ARGUMENT: Error invoking endpoint: [N] → failedToTransferImage" inside edit_image — **14 h/week** · Agent design (estimate)

## Top issues and how to fix them in the skills

### INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an empty error)
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 2,094/week in 1,019 sessions · 47 h/week lost · Every day · rising
Skills: single-page-design (1,318), brand-kit (307), wixel-ads (124), image-generation-and-image-edit (102), export-handler (81), stories-creation (71)
- **single-page-design** (1,318, 63%) — `skills/image/single-page-design.md` lines 14, 16, 67, 93
  - Change: Check the parameters single-page-design tells the agent to pass to `edit_image` against the model's live schema; spell out the allowed values in the skill.
- **brand-kit** (307, 15%) — `skills/brand/brand-kit.md` lines 10
  - Change: Check the parameters brand-kit tells the agent to pass to `edit_image` against the model's live schema; spell out the allowed values in the skill.
- **wixel-ads** (124, 6%) — `skills/video/wixel-ads.md` lines 24, 84, 93, 107
  - Change: Check the parameters wixel-ads tells the agent to pass to `edit_image` against the model's live schema; spell out the allowed values in the skill.

### Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → Cannot fetch content from the provided URL. P
`analyze_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 2,126/week in 1,759 sessions · 35 h/week lost · Every day
Skills: wixel-ads (1,170), single-page-design (240), no skill (220), video-creation (190), image-qr (68), stories-creation (51)
- **wixel-ads** (1,170, 55%) — `skills/video/wixel-ads.md` lines 24, 30, 93, 101
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (2). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Change: In wixel-ads's instructions, don't hand `analyze_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `analyze_image` right after the step that produced it.
- **single-page-design** (240, 11%) — `skills/image/single-page-design.md` lines 81, 91, 92, 95
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (1). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Change: In single-page-design's instructions, don't hand `analyze_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `analyze_image` right after the step that produced it.
- **video-creation** (190, 9%) — `skills/video/video.md` lines 306, 344, 487, 505
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (2). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Change: In video-creation's instructions, don't hand `analyze_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `analyze_image` right after the step that produced it.

### Error loading Codex resource "resources/video/video-capability-catalog.md": UNKNOWN: document 'resources/video/video-capability-catalog.md' not found 
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 975/week in 824 sessions · 11 h/week lost · Every day · rising
Skills: wixel-ads (644), video-creation (221), video-regen (78), video-understanding (16), video-logo-animation (6), video-plan-approval (5)
- **wixel-ads** (644, 66%) — `skills/video/wixel-ads.md` lines 8, 10, 22, 24
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 9 file(s), e.g. references/video/video-ads-craft.md:24, references/video/video-audio.md:142, references/video/video-call-card.md:28 — that wording is what sends the agent looking.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (221, 23%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 9 file(s), e.g. references/video/video-ads-craft.md:24, references/video/video-audio.md:142, references/video/video-call-card.md:28 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (78, 8%) — `skills/video/video-edit.md` lines 14, 40, 42, 62
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 9 file(s), e.g. references/video/video-ads-craft.md:24, references/video/video-audio.md:142, references/video/video-call-card.md:28 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### Error loading Codex resource "resources/video/video-data-model.md": UNKNOWN: document 'resources/video/video-data-model.md' not found in current versi
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 1,052/week in 828 sessions · 14 h/week lost · Every day · rising
Skills: wixel-ads (619), video-creation (279), video-regen (120), video-understanding (14), stories-creation (7), video-plan-approval (7)
- **wixel-ads** (619, 59%) — `skills/video/wixel-ads.md` lines 8, 10, 22, 24
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 3 file(s), e.g. references/video/video-audio.md:3, references/video/video-audio.md:89, references/video/video-audio.md:156 — that wording is what sends the agent looking.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (279, 27%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 3 file(s), e.g. references/video/video-audio.md:3, references/video/video-audio.md:89, references/video/video-audio.md:156 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (120, 11%) — `skills/video/video-edit.md` lines 14, 40, 42, 62
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 3 file(s), e.g. references/video/video-audio.md:3, references/video/video-audio.md:89, references/video/video-audio.md:156 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → invalid_value: Error while downloading file. 
`analyze_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 920/week in 624 sessions · 7.7 h/week lost · Some days · new
Skills: single-page-design (300), no skill (223), image-qr (86), stories-creation (82), image-generation-and-image-edit (58), wixel-ads (32)
- **single-page-design** (300, 33%) — `skills/image/single-page-design.md` lines 81, 91, 92, 95
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (2). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Change: In single-page-design's instructions, don't hand `analyze_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `analyze_image` right after the step that produced it.
- **image-qr** (86, 9%) — `skills/image/image-qr.md` lines 186, 192, 455, 468
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (2). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Change: In image-qr's instructions, don't hand `analyze_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `analyze_image` right after the step that produced it.
- **stories-creation** (82, 9%) — `skills/stories/stories-creation.md` lines 170, 173
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (1). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Change: In stories-creation's instructions, don't hand `analyze_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `analyze_image` right after the step that produced it.

### Tool returned while its job was still IN_PROGRESS (hidden timeout)
`poll_process_job` · Hidden timeout · medium fix · owner: Platform (tool timeouts) · 90/week in 24 sessions · 99 h/week lost · Every day · rising
Skills: export-handler (22), logo-create (16), logo-edit (15), slides-creation (8), slides-edit (6), stories-creation (5)
- Not a skill fix (Platform (tool timeouts)) — parked. The tool gave up waiting while the job was still running and reported success. Set the wait from measured timing (Wait times) and re-attach to the same job instead of starting a new one.

### Sequence rejected before any step ran: unknown tool "functions.edit_image" in step "gen" — it is not available in this session.
`sequence` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 410/week in 405 sessions · 6.2 h/week lost · Some days · new
Skills: single-page-design (401), stories-creation (8), brand-new (1)
- **single-page-design** (401, 98%) — `skills/image/single-page-design.md` lines 354
  - Seen: The agent wrote the tool name as `functions.edit_image`. Inside a sequence, step tools are bare names.
  - Change: Where single-page-design describes the sequence, add one literal example step with `"tool": "edit_image"` and say plainly: no `functions.` prefix.
- **stories-creation** (8, 2%) — `skills/stories/stories-creation.md`
  - Seen: The agent wrote the tool name as `functions.edit_image`. Inside a sequence, step tools are bare names.
  - Seen: stories-creation's file doesn't mention `sequence` by name; the call likely comes from a reference it includes, or from the agent improvising.
  - Change: Where stories-creation describes the sequence, add one literal example step with `"tool": "edit_image"` and say plainly: no `functions.` prefix.
- **brand-new** (1, 0%) — `skills/brand/brand-new.md` lines 72, 221, 236, 403
  - Seen: The agent wrote the tool name as `functions.edit_image`. Inside a sequence, step tools are bare names.
  - Change: Where brand-new describes the sequence, add one literal example step with `"tool": "edit_image"` and say plainly: no `functions.` prefix.

### Error loading Codex resource "resources/video/video-generation.md": UNKNOWN: document 'resources/video/video-generation.md' not found in current versi
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 788/week in 641 sessions · 10 h/week lost · Every day · rising
Skills: wixel-ads (505), video-creation (204), video-regen (63), video-understanding (11), video-plan-approval (4), no skill (1)
- **wixel-ads** (505, 64%) — `skills/video/wixel-ads.md` lines 8, 10, 22, 24
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 6 file(s), e.g. references/video/video-audio.md:123, references/video/video-capability-catalog.md:3, references/video/video-capability-catalog.md:73 — that wording is what sends the agent looking.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (204, 26%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 6 file(s), e.g. references/video/video-audio.md:123, references/video/video-capability-catalog.md:3, references/video/video-capability-catalog.md:73 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (63, 8%) — `skills/video/video-edit.md` lines 14, 40, 42, 62
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 6 file(s), e.g. references/video/video-audio.md:123, references/video/video-capability-catalog.md:3, references/video/video-capability-catalog.md:73 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → failedToTransferImage: Invalid value for 'referenceImages[N]' parameter. Failed to transfer the provi
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 681/week in 570 sessions · 14 h/week lost · Every day · rising
Skills: single-page-design (487), image-generation-and-image-edit (89), brand-kit (37), stories-creation (26), logo-edit (18), image-qr (8)
- **single-page-design** (487, 72%) — `skills/image/single-page-design.md` lines 14, 16, 67, 93
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (2). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Change: In single-page-design's instructions, don't hand `edit_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `edit_image` right after the step that produced it.
- **image-generation-and-image-edit** (89, 13%) — `skills/image/image.md` lines 8, 13, 14, 20
  - Seen: The failing calls pass cloud-storage links: storage.googleapis.com (1). These are usually temporary or signed URLs (e.g. a scraped page's screenshot) that expire or need credentials by the time the provider fetches them.
  - Seen: The failing calls pass images straight from other websites: images-wixmp-14a6a70d3f0e6e1e6f56bf30wixmp.com (1). Sites often block hotlinking, so the model provider can't fetch them.
  - Change: In image-generation-and-image-edit's instructions, don't hand `edit_image` a cloud-storage link from an earlier step: re-host it on Wix first (the upload / convert step), or call `edit_image` right after the step that produced it.
  - Change: In image-generation-and-image-edit's instructions, before calling `edit_image` with a site image, re-host it on Wix (the upload / convert step the skill already uses for site assets) and pass the wixstatic URL.
- **brand-kit** (37, 5%) — `skills/brand/brand-kit.md` lines 10
  - Seen: Most failing URLs are on Wix media hosts, so the link itself is wrong or expired: a URL copied with a transformation suffix, a temporary link, or one retyped instead of copied.
  - Change: Tell the agent to pass media URLs exactly as a previous tool returned them (no editing, no /v1/ transform suffixes), and to re-fetch a fresh URL instead of reusing one from earlier in a long session.

### Error loading Codex resource "resources/video/video-story-planning.md": UNKNOWN: document 'resources/video/video-story-planning.md' not found in curre
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 1,171/week in 957 sessions · 11 h/week lost · Every day · rising
Skills: wixel-ads (784), video-creation (334), video-regen (30), video-plan-approval (10), video-understanding (9), stories-creation (2)
- The agent asks for a file or skill that isn't there. Fix the path in the instructions, or publish the file where the agent reads it.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: Bad request returned by OpenAI. Additional information: Your request was rejected
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 574/week in 421 sessions · 7.7 h/week lost · Every day
Skills: image-generation-and-image-edit (439), single-page-design (39), export-handler (28), stories-creation (17), logo-edit (16), image-enhance (9)
- The provider rejected the request's parameters. Check the model's live schema (/catalog-drift) and the RPC schema; validate before calling.

### Sequence rejected before any step ran: unknown tool "functions.generate_image" in step "gen" — it is not available in this session.
`sequence` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 305/week in 304 sessions · 3.6 h/week lost · Some days · new
Skills: single-page-design (278), image-generation-and-image-edit (23), icons (2), brand-new (1), create-character (1)
- The agent called a tool wrongly. Spell out the correct call in the skill (with an example), and have the tool validate or auto-correct the common slip.

### Error loading Codex resource "resources/video/video-prompt-engineering.md": UNKNOWN: document 'resources/video/video-prompt-engineering.md' not found 
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 630/week in 543 sessions · 7.9 h/week lost · Every day · rising
Skills: wixel-ads (393), video-creation (195), video-regen (24), video-understanding (8), video-plan-approval (8), stories-creation (2)
- The agent asks for a file or skill that isn't there. Fix the path in the instructions, or publish the file where the agent reads it.

### Error writing file: Invalid JSON: Expected ',' or '}' after property value in JSON at position N (line N column N) The problem is at >>>HERE>>> below 
`write` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 506/week in 302 sessions · 9.7 h/week lost · Every day · rising
Skills: doc (202), wixel-ads (87), image-generation-and-image-edit (61), stories-creation (47), video-creation (30), slides-creation (24)
- The agent called a tool wrongly. Spell out the correct call in the skill (with an example), and have the tool validate or auto-correct the common slip.

### Error writing file: path or name is required when applying edits.
`write` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 1,055/week in 773 sessions · 3.5 h/week lost · Every day · rising
Skills: stories-creation (262), wixel-ads (243), video-creation (132), video-logo-animation (98), image-qr (74), brand-kit (64)
- The agent called a tool wrongly. Spell out the correct call in the skill (with an example), and have the tool validate or auto-correct the common slip.

## Wait times
- `invoke_rpc · GenerateLogoImageBasedAsync`: p50 30.2 s, p99 2.7 min, 11 hidden timeouts at 15.0 min → wait at most **1.5 min** (~3.3 h/week); re-attach to the job instead of restarting
- `invoke_rpc · composeImageFallback`: p50 38.2 s, p99 1.3 min, 1 hidden timeouts → wait at most **1.5 min** (~2.0 h/week); re-attach to the job instead of restarting
- `invoke_rpc · generateVideoFromImageH3Max768` (6–8s): p50 49.3 s, p99 1.3 min, 1 hidden timeouts → wait at most **1.5 min** (~2.0 h/week); re-attach to the job instead of restarting
- `invoke_rpc · generateVideoFromImage` (≤5s): p50 1.8 min, p99 4.8 min, 1 hidden timeouts → wait at most **7.5 min** (~1.9 h/week); re-attach to the job instead of restarting
- `invoke_rpc · generateMusic` (>12s): p50 24.1 s, p99 47.3 s, 3 hidden timeouts at 15.0 min → wait at most **1.0 min** (~43 min/week); re-attach to the job instead of restarting
- `invoke_rpc · generateMusic`: p50 23.8 s, p99 53.5 s, 3 hidden timeouts at 15.0 min → wait at most **45.0 s** (~42 min/week); re-attach to the job instead of restarting
- `invoke_workflow · 9f49f540-2617-410f-84b0-bd7d9101bf77`: p50 14.2 s, p99 2.0 min → wait at most **1.0 min** (~41 min/week)
- `invoke_rpc · GenerateIconsAsset`: p50 39.5 s, p99 2.3 min, 3 hidden timeouts at 15.0 min → wait at most **3.0 min** (~36 min/week); re-attach to the job instead of restarting
- `invoke_rpc · ArtistCreateSlides`: p50 50.3 s, p99 1.9 min, 3 hidden timeouts at 15.0 min → wait at most **3.0 min** (~36 min/week); re-attach to the job instead of restarting
- `invoke_rpc · generateVideoFromImageH3Max768` (9–12s): p50 50.6 s, p99 1.3 min, 1 hidden timeouts at 15.0 min → wait at most **1.5 min** (~14 min/week); re-attach to the job instead of restarting
- `poll_process_job`: p50 208 ms, p99 12.7 min, 96 hidden timeouts at 15.0 min; re-attach to the job instead of restarting
- `invoke_rpc · BuildPresentation`: p50 1.3 min, p99 2.8 min, 4 hidden timeouts at 15.1 min; re-attach to the job instead of restarting

## Where the agent works harder than it needs to (estimates)
- wixel-ads spends 7.9 file operations per turn, re-reading the same file 0.7× a turn — ~39 h/week, ~2,232M input tokens/week
- stories-creation spends 10.3 file operations per turn, re-reading the same file 1.1× a turn — ~26 h/week, ~1,782M input tokens/week
- poll_process_job: waits 15.0 min, then gives up on a job that's still running — ~24 h/week
- invoke_rpc ListCosts is called the same way every time — give the agent the answer instead — ~23 h/week, ~1,196M input tokens/week
- video-logo-animation spends 11.2 file operations per turn, re-reading the same file 2.8× a turn — ~19 h/week, ~1,388M input tokens/week
- video-creation spends 6.3 file operations per turn, re-reading the same file 0.6× a turn — ~18 h/week, ~1,301M input tokens/week
- Auto-correct "INVALID_ARGUMENT: Error invoking endpoint: [N] → failedToTransferImage" inside edit_image — ~14 h/week, ~53M input tokens/week
- Make "generate_image → download → deliver" one deterministic step — ~14 h/week, ~416M input tokens/week
- Auto-correct "INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an" inside generate_image — ~10 h/week, ~49M input tokens/week
- list_rpc_methods is called the same way every time — give the agent the answer instead — ~10 h/week, ~536M input tokens/week
- Auto-correct "Error writing file: Invalid JSON: Expected ',' or '}' after property v" inside write — ~9.7 h/week, ~49M input tokens/week
- Auto-correct "Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME" inside analyze_image — ~9.2 h/week, ~40M input tokens/week

## Major skills (last 7 days)
| Skill | Sessions/wk | Failing calls | Time lost/wk | Frustrated | Kept | Iter./turn | Top issue |
|---|---:|---:|---:|---:|---:|---:|---|
| logo-create | 12,843 | 1.3% | 82 h | 5.0% | 24% | 2.7 | Tool returned while its job was still IN_PROGRESS (hidden timeout) |
| single-page-design | 9,665 | 6.5% | 80 h | 8.1% | 33% | 5.4 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-generation-and-image-edit | 7,091 | 3.1% | 24 h | 17.3% | 40% | 4.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| logo-edit | 3,936 | 1.0% | 42 h | 16.6% | 37% | 5.3 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| export-handler | 3,837 | 2.8% | 49 h | 3.9% | 97% | 7.9 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| wixel-ads | 2,772 | 10.5% | 110 h | 10.8% | 29% | 7.6 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| website-create | 2,767 | 0.5% | 1.1 h | 4.8% | 19% | 4.3 | Error loading Codex resource "resources/video/video-story-planning.md" |
| wix-explorer | 2,283 | 15.3% | 5.4 h | 0.0% | – | 4.6 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| slides-creation | 1,873 | 2.5% | 18 h | 4.9% | 54% | 6.6 | Tool returned while its job was still IN_PROGRESS (hidden timeout) |
| video-creation | 1,872 | 7.5% | 55 h | 9.9% | 35% | 8.1 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| video-logo-animation | 1,735 | 2.1% | 51 h | 11.3% | 88% | 13.2 | Error loading Codex resource "resources/video/video-capability-catalog |
| stories-creation | 1,419 | 4.9% | 35 h | 9.2% | 38% | 11.4 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-qr | 1,362 | 2.9% | 4.3 h | 6.9% | 70% | 4.8 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| brand-kit | 967 | 2.6% | 49 h | 10.5% | 16% | 20.3 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| doc | 910 | 8.3% | 10 h | 11.3% | 59% | 4.0 | Error writing file: Invalid JSON: Expected ',' or '}' after property v |
| site-content | 734 | 7.6% | 2.3 h | 2.1% | 31% | 2.9 | Error: Skill "site-content" not found. Check available_skills in the t |
| slides-edit | 543 | 1.8% | 8.5 h | 11.3% | 33% | 7.8 | Tool returned while its job was still IN_PROGRESS (hidden timeout) |
| video-regen | 428 | 8.6% | 12 h | 23.7% | 39% | 6.8 | Error loading Codex resource "resources/video/video-capability-catalog |
| business-card | 417 | 1.3% | 3.0 h | 11.2% | 34% | 11.5 | Error writing file: path or name is required when applying edits. |
| image-enhance | 378 | 5.1% | 1.7 h | 29.7% | 44% | 3.4 | INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: B |
| brand-new | 325 | 2.9% | 1.9 h | 8.0% | 20% | 5.3 | Sequence rejected before any step ran: unknown tool "functions.edit_im |
| image-remove-background | 325 | 2.8% | 1.8 h | 30.9% | 48% | 5.5 | Failed to invoke RPC: 'telemetry.conversationId' value must be a valid |
| image-upscale | 306 | 4.6% | 51 min | 51.2% | 82% | 3.2 | INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: B |
| publish-social-post | 296 | 1.6% | 44 min | 6.1% | 22% | 5.7 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| wix-apis | 202 | 1.2% | 5 min | 11.2% | 38% | 2.4 | Error invoking endpoint: [N] → (provider returned an empty error) |
| logo-variations | 201 | 1.1% | 47 min | 8.6% | 44% | 6.3 | Error writing file: Schema validation failed: themeId: Invalid UUID |
| icons | 171 | 1.3% | 38 min | 3.1% | 26% | 8.1 | Sequence rejected before any step ran: unknown tool "functions.generat |
| pdf-processor | 158 | 2.5% | 1.9 h | 14.4% | 50% | 6.1 | Error writing file: Invalid JSON: Expected double-quoted property name |
| image-collage | 119 | 2.8% | 35 min | 15.0% | 42% | 4.3 | fal.ai The provided image URL is not accessible or has expired. Please |
| brand-edit | 96 | 2.8% | 16 min | 7.5% | 31% | 4.5 | Failed to invoke RPC: Upstream exception |
