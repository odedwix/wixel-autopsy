# Autopsy Fleet — what we know

Generated 2026-10-07 07:25 UTC from the Fleet day rollups (`.fleet/days`). Last 7 days: 2026-09-30 → 2026-10-06 (7 days built); last 30 days: 30 days built. Real users only. Codex: origin/HEAD @ ad2f3642 (2026-10-06).

Counts, durations, recoveries, tokens and outcomes are measured from the agent's own entries. "Time lost" = each failed call's time plus one recovery per run of consecutive failures (until the next successful attempt started, else the turn's end). Savings and recommended timeouts are estimates. Definitions: README → Fleet.

## The week in numbers
- 70,687 sessions, 124,072 turns, 713,987 tool calls
- 4.4% of tool calls fail (out of credits excluded); 522 h a week lost to failures
- 161 hidden timeouts (the tool returned while its job was still running)
- 9.2% of turns frustrated; 4.7 model iterations per turn; 124k input tokens per iteration
- Outputs kept (downloaded): 34% of sessions that produced one; 12% generated but wrote nothing
- 7.3% of sessions used no skill

## Things we learned about the data
- **Skills are preloaded since 2026-09-30.** The platform puts skills into the session's first message (`metadata.preloadedSkillBodies`) instead of the agent calling the `skill` tool: sessions with a skill-tool call fell from ~85% to ~40% overnight, across every agent. Fleet and Autopsy's per-skill views count both.
- **What a session made:** `TURN_UPDATED_ASSETS` was logged 2026-09-16 → 09-28 and again from 10-05. Main sessions' writes are in `WRITE_METERING`; sub-agents (campaigns: `session_type` SUB) don't log it, so the `write` tool's own results (they name the asset id) are the reliable record. Assets that merely appear in a shared project are not a session's output.
- **Fix suggestions are shown only when proven** (an audit on 2026-10-07 found most generated ones were guesses): a missing file traced in the codex, or an image host failing ≥5× the Wix rate across every call. "Same call every time" was wrong for ListCosts (it returns each user's credits: 313 calls, 50 different answers).
- **Hidden timeouts:** several tools (`generateMusic`, `poll_process_job`, `Generate*Async`, `BuildPresentation`) report success after ~15 minutes while the job is still `IN_PROGRESS`.
- **`ask_user` "User cancelled the question"** is how questions normally resolve — not a failure.
- **The admin SQL endpoint** re-runs a query for every 500-row page and can repeat rows across pages: every Fleet query stays under 500 rows.

## What changed (last 30 days)
- 2026-10-06: **Hidden timeouts / 1k turns** 0.9 → 3.6 · new codex version 4a2f4c4d-c (24% of turns)
- 2026-10-05: **Frustrated turns** 10.0% → 6.1% · new codex version 5df7c362-0 (25% of turns)
- 2026-10-04: **New codex version** · new codex version 33a4b21e-3 (21% of turns), 27e0d5e3-b (22% of turns)
- 2026-10-02: **Failing tool calls** 2.9% → 6.5%
- 2026-09-30: **New codex version** · new codex version fc0bcb69-9 (59% of turns)
- 2026-09-29: **New codex version** · new codex version e5fd67f5-2 (34% of turns)
- 2026-09-28: **New codex version** · new codex version 2dde3a82-b (22% of turns)
- 2026-09-24: **New codex version** · new codex version 369aec2c-c (33% of turns)
- 2026-09-23: **New codex version** · new codex version 4ad17396-b (35% of turns)
- 2026-09-22: **New codex version** · new codex version c19aefcf-9 (43% of turns)
- 2026-09-20: **Failing tool calls** 2.2% → 4.2%
- 2026-09-17: **Hidden timeouts / 1k turns** 1.5 → 11.9 · new codex version c4ba5703-e (39% of turns)
- 2026-09-16: **New codex version** · new codex version e29fe0aa-d (39% of turns)
- 2026-09-15: **New codex version** · new codex version e52b68b2-9 (35% of turns)
- 2026-09-14: **New codex version** · new codex version fc316c66-f (41% of turns)

## Biggest problems (measured time lost a week)
A fix is suggested only where the cause is proven (see "Top issues"); time lost is measured, not time a fix would give back.
1. Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → Cannot fetch content from the provided URL. Please ensu — **25 h/week lost** · Model catalog / tool owner
2. Error loading Codex resource "resources/video/video-creative-routing.md": UNKNOWN: document 'resources/video/video-creative-routing.md' not found in current ver — **23 h/week lost** · Skill author (codex)
3. INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an empty error) — **14 h/week lost** · Model catalog / tool owner
4. task_id: <id> Sub-agent timed out: it ran for N minutes without finishing and was cancelled. This was NOT a user stop, so do not wait for anyone. Split the work — **13 h/week lost** · Platform / provider
5. Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → invalid_value: Error while downloading file. Upstream s — **10 h/week lost** · Model catalog / tool owner
6. INTERNAL: Error invoking endpoint: [N] → providerError: ideogram . Additional information below. — **10.0 h/week lost** · Platform / provider
7. INVALID_ARGUMENT: Error invoking endpoint: [N] → failedToTransferImage: Invalid value for 'referenceImages[N]' parameter. Failed to transfer the provided image. — **9.7 h/week lost** · Model catalog / tool owner
8. task_id: <id> Error running sub-agent: Google proxy request failed (N): "…"utf-N\">  <meta name=\"viewport\" content=\"…">  <meta name=\"robots\" content=\"noin — **8.9 h/week lost** · Triage
9. Error loading Codex resource "resources/video/video-data-model.md": UNKNOWN: document 'resources/video/video-data-model.md' not found in current version for bas — **8.0 h/week lost** · Skill author (codex)
10. Error writing file: Invalid JSON: Expected ',' or '}' after property value in JSON at position N (line N column N) The problem is at >>>HERE>>> below — fix this — **7.3 h/week lost** · Skill author (instructions)

## Top issues, and the fixes that are proven
A "Change" is listed only where the cause is proven (a missing file traced in the codex, a failing image host that fails ≥5× the Wix rate…). Otherwise the issue shows what was observed and what would prove a fix.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an empty error)
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 2,024/week in 1,016 sessions · 14 h/week lost · Every day · rising
Skills: single-page-design (1,297), brand-kit (289), wixel-ads (138), image-generation-and-image-edit (108), stories-creation (81), logo-edit (32)
- **single-page-design** (1,297, 64%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **brand-kit** (289, 14%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **wixel-ads** (138, 7%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.

### Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → invalid_value: Error while downloading file. 
`analyze_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 1,313/week in 935 sessions · 10 h/week lost · Every day · new
Skills: single-page-design (407), no skill (308), image-qr (113), image-generation-and-image-edit (100), stories-creation (97), brand-kit (46)
- **single-page-design** (407, 31%) — no proven fix: Not tied to where the image comes from: 190 of 779 calls with storage.googleapis.com, notagathering.com, scontent-iad6-1.cdninstagram.com image URLs failed this way (24.4%), against 48 of 6595 with Wix-hosted ones (0.7%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **image-qr** (113, 9%) — no proven fix: Not tied to where the image comes from: 190 of 779 calls with storage.googleapis.com, notagathering.com, scontent-iad6-1.cdninstagram.com image URLs failed this way (24.4%), against 48 of 6595 with Wix-hosted ones (0.7%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **image-generation-and-image-edit** (100, 8%) — no proven fix: Not tied to where the image comes from: 190 of 779 calls with storage.googleapis.com, notagathering.com, scontent-iad6-1.cdninstagram.com image URLs failed this way (24.4%), against 48 of 6595 with Wix-hosted ones (0.7%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.

### Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → Cannot fetch content from the provided URL. P
`analyze_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 1,506/week in 1,257 sessions · 25 h/week lost · Every day · falling
Skills: wixel-ads (1,141), video-creation (85), no skill (67), single-page-design (49), image-qr (35), stories-creation (27)
- **wixel-ads** (1,141, 76%) — no proven fix: Not tied to where the image comes from: 3 of 845 calls with non-Wix image URLs failed this way (0.4%), against 2 of 6530 with Wix-hosted ones (0.0%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **video-creation** (85, 6%) — no proven fix: Not tied to where the image comes from: 3 of 845 calls with non-Wix image URLs failed this way (0.4%), against 2 of 6530 with Wix-hosted ones (0.0%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **single-page-design** (49, 3%) — no proven fix: Not tied to where the image comes from: 3 of 845 calls with non-Wix image URLs failed this way (0.4%), against 2 of 6530 with Wix-hosted ones (0.0%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.

### Error loading Codex resource "resources/video/video-capability-catalog.md": UNKNOWN: document 'resources/video/video-capability-catalog.md' not found 
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 1,003/week in 843 sessions · 4.5 h/week lost · Every day · rising
Skills: wixel-ads (694), video-creation (196), video-regen (80), video-understanding (16), video-logo-animation (6), video-plan-approval (5)
- **wixel-ads** (694, 69%) — `skills/video/wixel-ads.md` lines 8, 10, 22, 24
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:529, skills/video/video.md:655 — that wording is what sends the agent looking.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (196, 20%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:529, skills/video/video.md:655 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (80, 8%) — `skills/video/video-edit.md` lines 14, 40, 42, 62
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:529, skills/video/video.md:655 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### Sequence rejected before any step ran: unknown tool "functions.edit_image" in step "gen" — it is not available in this session.
`sequence` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 527/week in 522 sessions · 6.9 h/week lost · Every day · new
Skills: single-page-design (516), stories-creation (10), brand-new (1)
- **single-page-design** (516, 98%) — no proven fix: The codex never writes `functions.edit_image`: the agent adds the prefix itself, and a skill that already shows the right call still gets it. What would prove one: The sure fix is in the tool (accept the prefix) — outside the skills.
- **stories-creation** (10, 2%) — no proven fix: The codex never writes `functions.edit_image`: the agent adds the prefix itself, and a skill that already shows the right call still gets it. What would prove one: The sure fix is in the tool (accept the prefix) — outside the skills.
- **brand-new** (1, 0%) — no proven fix: The codex never writes `functions.edit_image`: the agent adds the prefix itself, and a skill that already shows the right call still gets it. What would prove one: The sure fix is in the tool (accept the prefix) — outside the skills.

### Error loading Codex resource "resources/video/video-data-model.md": UNKNOWN: document 'resources/video/video-data-model.md' not found in current versi
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 1,067/week in 836 sessions · 8.0 h/week lost · Every day · rising
Skills: wixel-ads (678), video-creation (233), video-regen (124), video-understanding (14), video-plan-approval (7), stories-creation (6)
- **wixel-ads** (678, 64%) — `skills/video/wixel-ads.md` lines 8, 10, 22, 24
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:493, skills/video/video.md:622 — that wording is what sends the agent looking.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (233, 22%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:493, skills/video/video.md:622 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (124, 12%) — `skills/video/video-edit.md` lines 14, 40, 42, 62
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:493, skills/video/video.md:622 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### INVALID_ARGUMENT: Error invoking endpoint: [N] { \"data\": [], \"errors\": } error_json:{\"error\":\"{\  \\\"data\\\": [],\  \\\"errors\\\": \ }\",\"s
`sequence` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 499/week in 358 sessions · 5.5 h/week lost · Every day · new
Skills: single-page-design (478), image-generation-and-image-edit (7), stories-creation (6), brand-kit (2), website-create (2), doc (2)
- **single-page-design** (478, 96%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **image-generation-and-image-edit** (7, 1%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **stories-creation** (6, 1%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.

### Error loading Codex resource "resources/video/video-generation.md": UNKNOWN: document 'resources/video/video-generation.md' not found in current versi
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 796/week in 645 sessions · 2.6 h/week lost · Every day · rising
Skills: wixel-ads (546), video-creation (171), video-regen (64), video-understanding (11), video-plan-approval (4)
- **wixel-ads** (546, 69%) — `skills/video/wixel-ads.md` lines 8, 10, 22, 24
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:502, skills/video/video.md:628 — that wording is what sends the agent looking.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (171, 21%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:502, skills/video/video.md:628 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (64, 8%) — `skills/video/video-edit.md` lines 14, 40, 42, 62
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:502, skills/video/video.md:628 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### Error loading Codex resource "resources/video/video-creative-routing.md": UNKNOWN: document 'resources/video/video-creative-routing.md' not found in c
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 513/week in 471 sessions · 23 h/week lost · Every day · rising
Skills: wixel-ads (476), video-creation (31), stories-creation (4), video-regen (2)
- Not checked per skill yet.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → failedToTransferImage: Invalid value for 'referenceImages[N]' parameter. Failed to transfer the provi
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 652/week in 538 sessions · 9.7 h/week lost · Every day · rising
Skills: single-page-design (485), image-generation-and-image-edit (64), brand-kit (37), stories-creation (23), logo-edit (15), image-qr (13)
- Not checked per skill yet.

### Error loading Codex resource "resources/video/video-story-planning.md": UNKNOWN: document 'resources/video/video-story-planning.md' not found in curre
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 1,191/week in 982 sessions · 4.5 h/week lost · Every day · rising
Skills: wixel-ads (883), video-creation (251), video-regen (29), video-plan-approval (10), video-understanding (9), stories-creation (7)
- Not checked per skill yet.

### Sequence rejected before any step ran: unknown tool "functions.generate_image" in step "gen" — it is not available in this session.
`sequence` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 397/week in 396 sessions · 3.3 h/week lost · Every day · new
Skills: single-page-design (362), image-generation-and-image-edit (31), icons (2), brand-new (1), create-character (1)
- Not checked per skill yet.

### Error: Skill "site-content" not found. Check available_skills in the tool description.
`skill` · Missing file or skill · easy fix · owner: Skill author (codex) · 176/week in 176 sessions · 1.6 h/week lost · Every day · rising
Skills: site-content (143), wix-explorer (33)
- Not checked per skill yet.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: Bad request returned by OpenAI. Additional information: Your request was rejected
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 500/week in 361 sessions · 4.4 h/week lost · Every day · falling
Skills: image-generation-and-image-edit (365), stories-creation (30), single-page-design (26), image-enhance (22), image-upscale (14), logo-edit (11)
- Not checked per skill yet.

### Error writing file: Invalid JSON: Expected ',' or '}' after property value in JSON at position N (line N column N) The problem is at >>>HERE>>> below 
`write` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 575/week in 332 sessions · 7.3 h/week lost · Every day · rising
Skills: doc (247), wixel-ads (94), stories-creation (69), image-generation-and-image-edit (52), slides-creation (26), video-creation (23)
- Not checked per skill yet.

## Wait times
- `invoke_rpc · generateAvatarTake`: p50 3.7 min, p99 6.9 min, 4 hidden timeouts → model estimate: wait at most 7.5 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateVideoFromReferences` (≤5s · 1080p): p50 4.7 min, p99 13.7 min, 2 hidden timeouts → model estimate: wait at most 15.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateVideoFromReferences` (6–8s · 1080p): p50 5.0 min, p99 14.3 min, 2 hidden timeouts → model estimate: wait at most 20.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateMusic` (>12s): p50 24.3 s, p99 54.1 s, 12 hidden timeouts at 15.0 min → model estimate: wait at most 1.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · GenerateLogoImageBasedAsync`: p50 30.6 s, p99 1.7 min, 8 hidden timeouts at 15.0 min → model estimate: wait at most 1.5 min (unproven: assumes a free, independent restart)
- `invoke_workflow · 9f49f540-2617-410f-84b0-bd7d9101bf77`: p50 14.3 s, p99 6.6 min → model estimate: wait at most 1.5 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateSymphonyLogoShot`: p50 2.6 min, p99 5.7 min, 1 hidden timeouts → model estimate: wait at most 7.5 min (unproven: assumes a free, independent restart)
- `invoke_rpc · GenerateIconsAsset`: p50 35.8 s, p99 3.7 min, 11 hidden timeouts at 15.1 min → model estimate: wait at most 5.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · BuildPresentation`: p50 1.3 min, p99 2.9 min, 7 hidden timeouts at 15.2 min → model estimate: wait at most 3.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateVideoFromReferences` (>12s · 720p): p50 6.7 min, p99 14.8 min, 1 hidden timeouts → model estimate: wait at most 30.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateMusic`: p50 23.9 s, p99 10.3 min, 1 hidden timeouts at 15.0 min → model estimate: wait at most 1.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateVideoFromImageH3Max768` (9–12s): p50 50.8 s, p99 2.5 min, 1 hidden timeouts at 15.0 min → model estimate: wait at most 2.0 min (unproven: assumes a free, independent restart)

## Patterns worth a look (observations, not proven fixes)
- stories-creation takes 8.9 generations per kept output (fleet median 3.5) — not proven: Why users regenerate isn't in these numbers; open the runs with many generations first.
- Make "invoke_rpc:EligibleForGeneration → invoke_rpc:CreateIconsAsset → invoke_rpc:GenerateIconsAsset" one deterministic step — not proven: How many iterations one step would save isn't measured: turns that already use `sequence` save about 1.6, not the ~6.5 a naive count suggests. Compare this chain's turns with and without `sequence` before changing the skill.
- Make "scrape_url → list_wix_sites → invoke_rpc:ListCosts → invoke_rpc:ListVoices → …" one deterministic step — not proven: How many iterations one step would save isn't measured: turns that already use `sequence` save about 1.6, not the ~1.3 a naive count suggests. Compare this chain's turns with and without `sequence` before changing the skill.
- Make "scrape_url → list_wix_sites → invoke_rpc:ListCosts → invoke_rpc:ListVoices → …" one deterministic step — not proven: How many iterations one step would save isn't measured: turns that already use `sequence` save about 1.6, not the ~1.0 a naive count suggests. Compare this chain's turns with and without `sequence` before changing the skill.
- wixel-ads carries 217k tokens into every iteration (fleet median 121k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- video-creation carries 215k tokens into every iteration (fleet median 121k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- stories-creation carries 170k tokens into every iteration (fleet median 121k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- video-regen carries 265k tokens into every iteration (fleet median 121k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- video-understanding carries 222k tokens into every iteration (fleet median 121k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- social-media-audit carries 173k tokens into every iteration (fleet median 121k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.

## Asks that end badly
- "generate image" — 3,046/week, kept 32%, upset 22% (users upset); served by image-generation-and-image-edit (1,694), single-page-design (568), site-content (246)
- "edit image" — 1,781/week, kept 43%, upset 37% (users upset); served by image-generation-and-image-edit (1,325), no skill (136), single-page-design (116)
- "generate presentation" — 1,586/week, kept 50%, upset 20% (users upset); served by slides-creation (714), doc (322), single-page-design (165)
- "improve image quality" — 601/week, kept 66%, upset 48% (users upset); served by image-enhance (288), image-upscale (249), image-generation-and-image-edit (52)
- "edit logo" — 533/week, kept 38%, upset 46% (users upset); served by logo-edit (262), logo-create (153), no skill (32)
- "edit website" — 312/week, kept 19%, upset 16% (few outputs kept); served by no skill (175), single-page-design (50), wix-apis (33)
- "generate design" — 273/week, kept 32%, upset 21% (users upset); served by single-page-design (110), website-create (48), logo-create (44)
- "ask a question" — 252/week, kept 12%, upset 21% (few outputs kept, users upset); served by no skill (172), image-generation-and-image-edit (27), wix-apis (18)
- "edit video" — 180/week, kept 44%, upset 42% (users upset); served by video-regen (94), wixel-ads (19), stories-creation (16)
- "remove image background" — 134/week, kept 59%, upset 47% (users upset); served by image-remove-background (109), image-generation-and-image-edit (16), no skill (5)

## Major skills (last 7 days)
| Skill | Sessions/wk | Failing calls | Time lost/wk | Frustrated | Kept | Iter./turn | Top issue |
|---|---:|---:|---:|---:|---:|---:|---|
| logo-create | 13,060 | 1.2% | 33 h | 4.8% | 25% | 2.4 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| single-page-design | 12,305 | 7.2% | 64 h | 6.8% | 28% | 4.7 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-generation-and-image-edit | 8,471 | 3.7% | 20 h | 14.4% | 38% | 3.5 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| logo-edit | 3,940 | 0.9% | 25 h | 16.8% | 33% | 5.1 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| wixel-ads | 3,535 | 8.7% | 101 h | 10.1% | 25% | 9.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| website-create | 2,899 | 0.6% | 57 min | 5.6% | 23% | 4.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] { \"data\": [], \"error |
| wix-explorer | 2,828 | 15.0% | 4.3 h | 0.0% | – | 3.9 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| video-logo-animation | 2,324 | 1.9% | 48 h | 10.1% | 81% | 12.5 | Error loading Codex resource "resources/video/video-capability-catalog |
| slides-creation | 2,019 | 2.7% | 28 h | 5.0% | 52% | 6.0 | Error writing file: Invalid JSON: Expected ',' or '}' after property v |
| stories-creation | 1,920 | 4.7% | 47 h | 8.6% | 32% | 11.2 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| brand-new | 1,612 | 2.3% | 1.5 h | 2.3% | 26% | 4.3 | Sequence rejected before any step ran: unknown tool "functions.edit_im |
| video-creation | 1,538 | 7.1% | 26 h | 10.4% | 42% | 8.3 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-qr | 1,323 | 3.0% | 4.1 h | 6.0% | 70% | 4.6 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| doc | 1,193 | 9.0% | 7.8 h | 10.8% | 56% | 3.9 | INVALID_ARGUMENT: Error invoking endpoint: [N] { \"data\": [], \"error |
| brand-kit | 991 | 2.4% | 35 h | 10.0% | 15% | 19.7 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| site-content | 665 | 7.4% | 4.3 h | 2.3% | 30% | 3.1 | Error: Skill "site-content" not found. Check available_skills in the t |
| video-regen | 543 | 7.6% | 20 h | 23.3% | 43% | 6.8 | Error loading Codex resource "resources/video/video-capability-catalog |
| slides-edit | 500 | 1.8% | 1.1 h | 11.9% | 33% | 7.2 | Error writing file: Invalid JSON: Expected ',' or '}' after property v |
| image-enhance | 443 | 5.9% | 2.2 h | 26.7% | 52% | 3.2 | INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: B |
| business-card | 414 | 1.8% | 3.6 h | 10.6% | 38% | 10.0 | Error writing file: path or name is required when applying edits. |
| export-handler | 387 | 2.9% | 1.4 h | 13.1% | 67% | 5.8 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-upscale | 366 | 5.1% | 55 min | 46.2% | 82% | 3.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: B |
| image-remove-background | 325 | 2.8% | 1.1 h | 26.0% | 50% | 5.2 | Failed to invoke RPC: 'telemetry.conversationId' value must be a valid |
| publish-social-post | 314 | 1.7% | 39 min | 6.6% | 0% | 5.5 | query must be a non-empty string when provided. |
| wix-apis | 229 | 1.0% | 2 min | 7.3% | 42% | 2.2 | – |
| logo-variations | 185 | 1.8% | 25 min | 13.9% | 47% | 6.0 | Failed to invoke RPC: 'telemetry.conversationId' value must be a valid |
| image-collage | 177 | 2.5% | 1.3 h | 14.2% | 35% | 3.9 | Error writing file: Invalid JSON: Expected ',' or '}' after property v |
| pdf-processor | 168 | 3.4% | 1.2 h | 16.4% | 52% | 6.0 | Error writing file: Invalid JSON: Expected double-quoted property name |
| icons | 164 | 1.1% | 33 min | 4.5% | 12% | 6.6 | Sequence rejected before any step ran: unknown tool "functions.generat |
| brand-edit | 102 | 2.3% | 19 min | 8.7% | 32% | 4.3 | Failed to invoke RPC: Upstream exception |
