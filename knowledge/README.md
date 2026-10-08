# Autopsy Fleet — what we know

Generated 2026-10-08 11:56 UTC from the Fleet day rollups (`.fleet/days`). Last 7 days: 2026-10-01 → 2026-10-07 (7 days built); last 30 days: 30 days built. Real users only. Codex: origin/HEAD @ 8c5ad630 (2026-10-08).

Counts, durations, recoveries, tokens and outcomes are measured from the agent's own entries. "Time lost" = each failed call's time plus one recovery per run of consecutive failures (until the next successful attempt started, else the turn's end). Savings and recommended timeouts are estimates. Definitions: README → Fleet.

## The week in numbers
- 71,081 sessions, 123,151 turns, 699,104 tool calls
- 4.3% of tool calls fail (out of credits excluded); 523 h a week lost to failures
- 198 hidden timeouts (the tool returned while its job was still running)
- 9.1% of turns frustrated; 4.6 model iterations per turn; 124k input tokens per iteration
- Outputs kept (downloaded): 33% of sessions that produced one; 12% generated but wrote nothing
- 7.3% of sessions used no skill

## Things we learned about the data
- **Skills are preloaded since 2026-09-30.** The platform puts skills into the session's first message (`metadata.preloadedSkillBodies`) instead of the agent calling the `skill` tool: sessions with a skill-tool call fell from ~85% to ~40% overnight, across every agent. Fleet and Autopsy's per-skill views count both.
- **What a session made:** `TURN_UPDATED_ASSETS` was logged 2026-09-16 → 09-28 and again from 10-05. Main sessions' writes are in `WRITE_METERING`; sub-agents (campaigns: `session_type` SUB) don't log it, so the `write` tool's own results (they name the asset id) are the reliable record. Assets that merely appear in a shared project are not a session's output.
- **Fix suggestions are shown only when proven** (an audit on 2026-10-07 found most generated ones were guesses): a missing file traced in the codex, or an image host failing ≥5× the Wix rate across every call. "Same call every time" was wrong for ListCosts (it returns each user's credits: 313 calls, 50 different answers).
- **Hidden timeouts:** several tools (`generateMusic`, `poll_process_job`, `Generate*Async`, `BuildPresentation`) report success after ~15 minutes while the job is still `IN_PROGRESS`.
- **`ask_user` "User cancelled the question"** is how questions normally resolve — not a failure.
- **The admin SQL endpoint** now answers the whole result at once and ignores `limit` / `offset` (seen 2026-10-08). Autopsy stops at the first page that holds more than it asked for; before that, every query over 500 rows ran again for each 500-row page and repeated its rows.
- **Agent models:** iterations run on gpt-6-luna, gpt-6.1-sol, gemini-3.8-flash and gemini-3.0-flash (main turns) and claude-sonnet-5-5 (sub-agents); the mix changes by skill and by day. Every iteration re-reads the whole context — typically 80–320k input tokens, 85–97% cached — to write a few hundred tokens.
- **Preloaded skills** put the skill body into the first message (4k–132k tokens), and every file the agent reads stays in the context for the rest of the session.
- **Paying users:** Wixel's own plans per account are in `prod.wixel.accounts_dim` (Basic / Pro / Max / Top-Up; ~1,058 paying of ~554k accounts on 2026-10-08).

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
1. Error loading Codex resource "resources/video/video-creative-routing.md": UNKNOWN: document 'resources/video/video-creative-routing.md' not found in current ver — **23 h/week lost** · Skill author (codex)
2. Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → Cannot fetch content from the provided URL. Please ensu — **21 h/week lost** · Model catalog / tool owner
3. task_id: <id> Sub-agent timed out: it ran for N minutes without finishing and was cancelled. This was NOT a user stop, so do not wait for anyone. Split the work — **17 h/week lost** · Platform / provider
4. INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an empty error) — **14 h/week lost** · Model catalog / tool owner
5. Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → invalid_value: Error while downloading file. Upstream s — **11 h/week lost** · Model catalog / tool owner
6. INTERNAL: Error invoking endpoint: [N] → providerError: ideogram . Additional information below. — **10.0 h/week lost** · Platform / provider
7. task_id: <id> Error running sub-agent: Google proxy request failed (N): "…"utf-N\">  <meta name=\"viewport\" content=\"…">  <meta name=\"robots\" content=\"noin — **8.9 h/week lost** · Triage
8. Error loading Codex resource "resources/video/video-data-model.md": UNKNOWN: document 'resources/video/video-data-model.md' not found in current version for bas — **7.6 h/week lost** · Skill author (codex)
9. Error writing file: Invalid JSON: Expected ',' or '}' after property value in JSON at position N (line N column N) The problem is at >>>HERE>>> below — fix this — **7.2 h/week lost** · Skill author (instructions)
10. Error writing file: Invalid JSON: Expected ',' or '}' after property value in JSON at position N (line N column N) The problem is at >>>HERE>>> below — fix — **6.8 h/week lost** · Skill author (instructions)

## Top issues, and the fixes that are proven
A "Change" is listed only where the cause is proven (a missing file traced in the codex, a failing image host that fails ≥5× the Wix rate…). Otherwise the issue shows what was observed and what would prove a fix.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an empty error)
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 2,028/week in 1,024 sessions · 14 h/week lost · Every day
Skills: single-page-design (1,308), brand-kit (300), wixel-ads (134), image-generation-and-image-edit (105), stories-creation (78), logo-edit (28)
- **single-page-design** (1,308, 64%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **brand-kit** (300, 15%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **wixel-ads** (134, 7%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.

### Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → invalid_value: Error while downloading file. 
`analyze_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 1,459/week in 1,070 sessions · 11 h/week lost · Every day · rising
Skills: single-page-design (422), no skill (348), image-qr (148), stories-creation (112), image-generation-and-image-edit (102), brand-kit (58)
- **single-page-design** (422, 29%) — no proven fix: Not tied to where the image comes from: 189 of 714 calls with storage.googleapis.com, scontent-iad3-2.cdninstagram.com, scontent-iad3-1.cdninstagram.com image URLs failed this way (26.5%), against 7 of 6062 with Wix-hosted ones (0.1%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **image-qr** (148, 10%) — no proven fix: Not tied to where the image comes from: 189 of 714 calls with storage.googleapis.com, scontent-iad3-2.cdninstagram.com, scontent-iad3-1.cdninstagram.com image URLs failed this way (26.5%), against 7 of 6062 with Wix-hosted ones (0.1%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **stories-creation** (112, 8%) — no proven fix: Not tied to where the image comes from: 189 of 714 calls with storage.googleapis.com, scontent-iad3-2.cdninstagram.com, scontent-iad3-1.cdninstagram.com image URLs failed this way (26.5%), against 7 of 6062 with Wix-hosted ones (0.1%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.

### INVALID_ARGUMENT: Error invoking endpoint: [N] { \"data\": [], \"errors\": } error_json:{\"error\":\"{\  \\\"data\\\": [],\  \\\"errors\\\": \ }\",\"s
`sequence` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 666/week in 459 sessions · 6.6 h/week lost · Every day · rising
Skills: single-page-design (640), stories-creation (9), image-generation-and-image-edit (7), brand-kit (4), website-create (2), doc (2)
- **single-page-design** (640, 96%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **stories-creation** (9, 1%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.
- **image-generation-and-image-edit** (7, 1%) — no proven fix: The error doesn't name a parameter (INVALID_ARGUMENT / [400] wraps every provider error). What would prove one: Compare the failing and the successful calls: one parameter or value in ≥70% of the failures, failing ≥5× more often, that the skill prescribes.

### Error loading Codex resource "resources/video/video-capability-catalog.md": UNKNOWN: document 'resources/video/video-capability-catalog.md' not found 
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 953/week in 798 sessions · 4.1 h/week lost · Some days · rising
Skills: wixel-ads (694), video-creation (160), video-regen (70), video-understanding (16), video-plan-approval (5), single-page-design (4)
- **wixel-ads** (694, 73%) — skill file not found
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:531, skills/video/video.md:656 — that wording is what sends the agent looking.
  - Seen: wixel-ads's file doesn't mention `read` by name; the call likely comes from a reference it includes, or from the agent improvising.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (160, 17%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:531, skills/video/video.md:656 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (70, 7%) — `skills/video/video-edit.md` lines 14, 40, 42, 44
  - Seen: resources/video/video-capability-catalog.md is not in the codex, but references/video/video-capability-catalog.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:531, skills/video/video.md:656 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### Sequence rejected before any step ran: unknown tool "functions.edit_image" in step "gen" — it is not available in this session.
`sequence` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 481/week in 476 sessions · 6.2 h/week lost · Every day · rising
Skills: single-page-design (472), stories-creation (8), brand-new (1)
- **single-page-design** (472, 98%) — no proven fix: The codex never writes `functions.edit_image`: the agent adds the prefix itself, and a skill that already shows the right call still gets it. What would prove one: The sure fix is in the tool (accept the prefix) — outside the skills.
- **stories-creation** (8, 2%) — no proven fix: The codex never writes `functions.edit_image`: the agent adds the prefix itself, and a skill that already shows the right call still gets it. What would prove one: The sure fix is in the tool (accept the prefix) — outside the skills.
- **brand-new** (1, 0%) — no proven fix: The codex never writes `functions.edit_image`: the agent adds the prefix itself, and a skill that already shows the right call still gets it. What would prove one: The sure fix is in the tool (accept the prefix) — outside the skills.

### Error loading Codex resource "resources/video/video-data-model.md": UNKNOWN: document 'resources/video/video-data-model.md' not found in current versi
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 1,010/week in 787 sessions · 7.6 h/week lost · Some days · rising
Skills: wixel-ads (678), video-creation (193), video-regen (111), video-understanding (14), video-plan-approval (7), stories-creation (4)
- **wixel-ads** (678, 67%) — skill file not found
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:495, skills/video/video.md:623 — that wording is what sends the agent looking.
  - Seen: wixel-ads's file doesn't mention `read` by name; the call likely comes from a reference it includes, or from the agent improvising.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (193, 19%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:495, skills/video/video.md:623 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (111, 11%) — `skills/video/video-edit.md` lines 14, 40, 42, 44
  - Seen: resources/video/video-data-model.md is not in the codex, but references/video/video-data-model.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:495, skills/video/video.md:623 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUMENT: Error invoking endpoint: [N] → Cannot fetch content from the provided URL. P
`analyze_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 1,014/week in 865 sessions · 21 h/week lost · Every day · falling
Skills: wixel-ads (937), video-creation (42), no skill (25), stories-creation (4), single-page-design (4), image-remove-background (2)
- **wixel-ads** (937, 92%) — no proven fix: Not tied to where the image comes from: 18 of 57 calls with scontent-iad3-2.cdninstagram.com, scontent-iad3-1.cdninstagram.com, scontent-iad6-1.cdninstagram.com image URLs failed this way (31.6%), against 3 of 6067 with Wix-hosted ones (0.0%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **video-creation** (42, 4%) — no proven fix: Not tied to where the image comes from: 18 of 57 calls with scontent-iad3-2.cdninstagram.com, scontent-iad3-1.cdninstagram.com, scontent-iad6-1.cdninstagram.com image URLs failed this way (31.6%), against 3 of 6067 with Wix-hosted ones (0.0%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.
- **stories-creation** (4, 0%) — no proven fix: Not tied to where the image comes from: 18 of 57 calls with scontent-iad3-2.cdninstagram.com, scontent-iad3-1.cdninstagram.com, scontent-iad6-1.cdninstagram.com image URLs failed this way (31.6%), against 3 of 6067 with Wix-hosted ones (0.0%), over the last day. What would prove one: A host class failing ≥5× the Wix rate and holding ≥70% of the failures (≥20) would prove it; otherwise it's the provider or a transient fetch.

### Error loading Codex resource "resources/video/video-generation.md": UNKNOWN: document 'resources/video/video-generation.md' not found in current versi
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 759/week in 615 sessions · 2.5 h/week lost · Some days · rising
Skills: wixel-ads (546), video-creation (142), video-regen (56), video-understanding (11), video-plan-approval (4)
- **wixel-ads** (546, 72%) — skill file not found
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:504, skills/video/video.md:629 — that wording is what sends the agent looking.
  - Seen: wixel-ads's file doesn't mention `read` by name; the call likely comes from a reference it includes, or from the agent improvising.
  - Change: Reword wixel-ads's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-creation** (142, 19%) — `skills/video/video.md` lines 26, 28, 30, 36
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:504, skills/video/video.md:629 — that wording is what sends the agent looking.
  - Change: Reword video-creation's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.
- **video-regen** (56, 7%) — `skills/video/video-edit.md` lines 14, 40, 42, 44
  - Seen: resources/video/video-generation.md is not in the codex, but references/video/video-generation.md is. Files under references/ are inlined into skills at build time and can't be read at runtime, so the agent guesses a resources/ path and fails.
  - Seen: It's referred to by bare name in 2 file(s), e.g. skills/video/video-edit.md:504, skills/video/video.md:629 — that wording is what sends the agent looking.
  - Change: Reword video-regen's mention of the file so the agent stops looking for it: point at the section already inlined in the skill, or name the real runtime path under resources/.

### Tool returned while its job was still IN_PROGRESS (hidden timeout)
`poll_process_job` · Hidden timeout · medium fix · owner: Platform (tool timeouts) · 130/week in 33 sessions · 63 h/week lost · Every day · rising
Skills: slides-creation (34), stories-creation (21), brand-kit (19), logo-create (16), logo-edit (11), video-regen (8)
- Not a skill fix (Platform (tool timeouts)) — parked. The tool gave up waiting while the job was still running and reported success. Set the wait from measured timing (Wait times) and re-attach to the same job instead of starting a new one.

### Error loading Codex resource "resources/video/video-creative-routing.md": UNKNOWN: document 'resources/video/video-creative-routing.md' not found in c
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 503/week in 463 sessions · 23 h/week lost · Some days · rising
Skills: wixel-ads (476), video-creation (23), stories-creation (4)
- Not checked per skill yet.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → failedToTransferImage: Invalid value for 'referenceImages[N]' parameter. Failed to transfer the provi
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 642/week in 539 sessions · 5.5 h/week lost · Every day · rising
Skills: single-page-design (488), image-generation-and-image-edit (59), brand-kit (32), stories-creation (27), image-qr (13), logo-edit (11)
- Not checked per skill yet.

### Error loading Codex resource "resources/video/video-story-planning.md": UNKNOWN: document 'resources/video/video-story-planning.md' not found in curre
`read` · Missing file or skill · easy fix · owner: Skill author (codex) · 1,141/week in 940 sessions · 4.3 h/week lost · Some days · rising
Skills: wixel-ads (883), video-creation (206), video-regen (24), video-plan-approval (10), video-understanding (9), stories-creation (7)
- Not checked per skill yet.

### Sequence rejected before any step ran: unknown tool "functions.generate_image" in step "gen" — it is not available in this session.
`sequence` · Agent misuse of a tool · easy fix · owner: Skill author (instructions) · 352/week in 351 sessions · 3.0 h/week lost · Every day · rising
Skills: single-page-design (329), image-generation-and-image-edit (19), icons (2), brand-new (1), create-character (1)
- Not checked per skill yet.

### Error: Skill "site-content" not found. Check available_skills in the tool description.
`skill` · Missing file or skill · easy fix · owner: Skill author (codex) · 173/week in 173 sessions · 1.5 h/week lost · Every day · rising
Skills: site-content (140), wix-explorer (33)
- Not checked per skill yet.

### INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: Bad request returned by OpenAI. Additional information: Your request was rejected
`edit_image` · Rejected parameters · easy fix · owner: Model catalog / tool owner · 501/week in 354 sessions · 4.6 h/week lost · Every day · falling
Skills: image-generation-and-image-edit (347), stories-creation (39), image-enhance (25), single-page-design (25), image-upscale (14), logo-edit (14)
- Not checked per skill yet.

## Wait times
- `invoke_rpc · generateAvatarTake`: p50 3.7 min, p99 6.9 min, 4 hidden timeouts → model estimate: wait at most 7.5 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateMusic` (>12s): p50 24.5 s, p99 2.9 min, 27 hidden timeouts at 15.0 min → model estimate: wait at most 1.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateLogoShot`: p50 6.1 min, p99 11.0 min, 3 hidden timeouts → model estimate: wait at most 15.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateVideoFromImage` (≤5s): p50 1.7 min, p99 7.4 min, 2 hidden timeouts → model estimate: wait at most 7.5 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateAvatarTakeOmnihuman`: p50 2.8 min, p99 10.0 min, 2 hidden timeouts → model estimate: wait at most 10.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · GenerateIconsAsset`: p50 37.5 s, p99 3.6 min, 11 hidden timeouts at 15.1 min → model estimate: wait at most 3.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · GenerateLogoImageBasedAsync`: p50 30.8 s, p99 1.4 min, 7 hidden timeouts at 15.0 min → model estimate: wait at most 1.5 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateSymphonyLogoShot`: p50 2.6 min, p99 5.8 min, 1 hidden timeouts → model estimate: wait at most 7.5 min (unproven: assumes a free, independent restart)
- `invoke_rpc · BuildPresentation`: p50 1.3 min, p99 2.9 min, 8 hidden timeouts at 15.2 min → model estimate: wait at most 3.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateVideoFromReferences` (>12s · 720p): p50 6.9 min, p99 14.6 min, 1 hidden timeouts → model estimate: wait at most 20.0 min (unproven: assumes a free, independent restart)
- `invoke_rpc · generateMusic`: p50 24.1 s, p99 10.7 min, 2 hidden timeouts at 15.0 min → model estimate: wait at most 1.0 min (unproven: assumes a free, independent restart)
- `invoke_workflow · 001af355-3151-4b2a-ba18-45383266a049`: p50 8.7 s, p99 1.2 min → model estimate: wait at most 45.0 s (unproven: assumes a free, independent restart)

## Patterns worth a look (observations, not proven fixes)
- logo-create takes 6.0 generations per kept output (fleet median 3.2) — not proven: Why users regenerate isn't in these numbers; open the runs with many generations first.
- stories-creation takes 8.1 generations per kept output (fleet median 3.2) — not proven: Why users regenerate isn't in these numbers; open the runs with many generations first.
- brand-kit takes 5.9 generations per kept output (fleet median 3.2) — not proven: Why users regenerate isn't in these numbers; open the runs with many generations first.
- Make "scrape_url → list_wix_sites → invoke_rpc:ListCosts → invoke_rpc:ListVoices → …" one deterministic step — not proven: How many iterations one step would save isn't measured: turns that already use `sequence` save about 1.6, not the ~1.4 a naive count suggests. Compare this chain's turns with and without `sequence` before changing the skill.
- Make "invoke_rpc:EligibleForGeneration → invoke_rpc:CreateIconsAsset → invoke_rpc:GenerateIconsAsset" one deterministic step — not proven: How many iterations one step would save isn't measured: turns that already use `sequence` save about 1.6, not the ~6.5 a naive count suggests. Compare this chain's turns with and without `sequence` before changing the skill.
- wixel-ads-lite takes 6.1 generations per kept output (fleet median 3.2) — not proven: Why users regenerate isn't in these numbers; open the runs with many generations first.
- wixel-ads carries 219k tokens into every iteration (fleet median 119k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- video-creation carries 214k tokens into every iteration (fleet median 119k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- video-regen carries 265k tokens into every iteration (fleet median 119k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- video-understanding carries 220k tokens into every iteration (fleet median 119k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.
- video-plan-approval carries 247k tokens into every iteration (fleet median 119k) — not proven: Which part of the context could go isn't known from these numbers; read the skill and its resources first.

## Asks that end badly
- "generate logo" — 11,721/week, kept 25%, upset 17% (users upset); served by logo-create (11,458), no skill (59), image-generation-and-image-edit (35)
- "generate image" — 2,999/week, kept 29%, upset 22% (users upset); served by image-generation-and-image-edit (1,693), single-page-design (547), site-content (230)
- "edit image" — 1,812/week, kept 41%, upset 36% (users upset); served by image-generation-and-image-edit (1,347), no skill (143), single-page-design (110)
- "generate presentation" — 1,548/week, kept 48%, upset 19% (users upset); served by slides-creation (687), doc (303), single-page-design (162)
- "improve image quality" — 606/week, kept 67%, upset 48% (users upset); served by image-enhance (288), image-upscale (248), image-generation-and-image-edit (56)
- "edit logo" — 526/week, kept 36%, upset 45% (users upset); served by logo-edit (262), logo-create (138), no skill (38)
- "edit website" — 302/week, kept 19%, upset 13% (few outputs kept); served by no skill (181), single-page-design (36), wix-apis (35)
- "generate design" — 270/week, kept 29%, upset 17% (users upset); served by single-page-design (104), logo-create (50), website-create (45)
- "ask a question" — 261/week, kept 12%, upset 21% (few outputs kept, users upset); served by no skill (175), image-generation-and-image-edit (30), wix-apis (17)
- "generate document" — 215/week, kept 64%, upset 20% (users upset); served by doc (184), single-page-design (8), no skill (7)

## Efficiency (7 of the last 7 days measured)
Where the agent spends tokens and time beyond the work itself. Model tokens are measured; tokens read from files are estimated (characters / 4). Fleet → Efficiency has the details per skill.

| Model | Share of iterations | Tokens in / iteration | Out / iteration | Model time / iteration | Failed |
|---|---:|---:|---:|---:|---:|
| gpt-6-luna | 70% | 116k | 620 | 5.7 s | 0.3% |
| gemini-3.8-flash | 24% | 138k | 420 | 18.3 s | 0.5% |
| gpt-6.1-sol | 7% | 147k | 283 | 8.7 s | 0.7% |

Worth a look (observations, not proven fixes):
- **wixel-ads** carries 219k tokens into every iteration (median 119k); the preloaded skill alone is 48k (22%)
- **video-creation** carries 214k tokens into every iteration (median 119k); the preloaded skill alone is 131k (61%)
- **video-regen** carries 265k tokens into every iteration (median 119k); the preloaded skill alone is 117k (44%)
- **stories-creation** spends 16 h a week between status polls of running jobs
- **video-logo-animation** spends 8.9 h a week between status polls of running jobs
- **slides-creation** spends 6.2 h a week between status polls of running jobs
- **video-logo-animation** repeats `read` with identical arguments 6,968 times a week, after it already succeeded
- **video-understanding** carries 220k tokens into every iteration (median 119k); the preloaded skill alone is 2k (1%)
- **video-plan-approval** carries 247k tokens into every iteration (median 119k); the preloaded skill alone is 10k (4%)
- **brand-kit** repeats `process_svg` with identical arguments 3,973 times a week, after it already succeeded
- **brand-kit** spends 3.3 h a week between status polls of running jobs
- **logo-create** spends 3.1 h a week between status polls of running jobs

| Skill | Main model | Tokens / iteration | Cached | Iterations / turn | Preloaded skill | Read / turn | Repeated calls / wk | Polling wait / wk | After a failure, most often |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| video-regen | gpt-6-luna | 265k | 92% | 6.7 | 117k | 5k | 1,101 | 1.3 h | changed the arguments (62%) |
| video-plan-approval | gpt-6-luna | 247k | 94% | 9.4 | 10k | 11k | 98 | 31 min | changed the arguments (68%) |
| video-understanding | gpt-6-luna | 220k | 96% | 7.6 | 2k | 7k | 249 | – | changed the arguments (62%) |
| wixel-ads | gpt-6-luna | 219k | 89% | 9.7 | 48k | 29k | 6,127 | 31 min | changed the arguments (70%) |
| video-creation | gpt-6-luna | 214k | 91% | 8.3 | 131k | 10k | 2,138 | 24 min | changed the arguments (72%) |
| stories-creation | gpt-6-luna | 164k | 94% | 10.7 | 19k | 34k | 3,593 | 16 h | changed the arguments (63%) |
| slides-edit | gpt-6-luna | 162k | 93% | 6.9 | 6k | 21k | 1,055 | – | changed the arguments (64%) |
| social-media-audit | gpt-6-luna | 161k | 94% | 4.7 | 7k | 2k | 39 | – | changed the arguments (79%) |
| publish-social-post | gpt-6-luna | 155k | 94% | 5.4 | 4k | 457 | 95 | – | another tool (51%) |
| doc | gpt-6-luna | 155k | 91% | 3.9 | 40k | 9k | 481 | – | changed the arguments (66%) |
| brand-edit | gpt-6-luna | 142k | 91% | 4.1 | 21k | 300 | 13 | – | changed the arguments (50%) |
| export-handler | gpt-6-luna | 137k | 92% | 6.0 | 8k | 2k | 167 | 2 min | changed the arguments (47%) |
| pdf-processor | gpt-6-luna | 134k | 94% | 6.1 | 4k | 3k | 68 | – | changed the arguments (59%) |
| image-collage | gpt-6-luna | 131k | 92% | 4.0 | 11k | 391 | 31 | 1 min | changed the arguments (35%) |
| brand-kit | gpt-6-luna | 129k | 95% | 20.1 | 9k | 4k | 4,792 | 3.3 h | changed the arguments (48%) |
| slides-creation | gpt-6-luna | 125k | 89% | 6.0 | 33k | 2k | 316 | 6.2 h | changed the arguments (44%) |
| business-card | gpt-6-luna | 119k | 95% | 10.2 | 20k | 1k | 2,854 | – | changed the arguments (53%) |
| image-remove-background | gpt-6-luna | 119k | 94% | 5.4 | 2k | 725 | 216 | – | another tool (36%) |
| logo-variations | gpt-6-luna | 119k | 93% | 6.0 | 20k | 596 | 36 | – | changed the arguments (61%) |
| wixel-ads-lite | gpt-6.1-sol | 113k | 88% | 3.6 | 17k | 509 | 59 | 1.5 h | looked something up (38%) |
| image-generation-and-image-edit | gpt-6-luna | 109k | 93% | 3.4 | 18k | 431 | 667 | 1 min | another tool (37%) |
| single-page-design | gpt-6-luna | 109k | 93% | 4.6 | 22k | 2k | 1,322 | – | another tool (54%) |
| image-qr | gpt-6-luna | 103k | 92% | 4.4 | 12k | 944 | 212 | – | changed the arguments (64%) |
| create-character | gpt-6-luna | 101k | 88% | 5.7 | 14k | 5k | 3 | – | changed the arguments (28%) |
| brand-new | gpt-6-luna | 100k | 90% | 4.7 | 34k | 640 | 552 | – | changed the arguments (37%) |
| logo-edit | gpt-6-luna | 100k | 96% | 5.0 | 6k | 470 | 429 | 1.8 h | changed the arguments (45%) |
| video-logo-animation | gpt-6-luna | 94k | 95% | 11.8 | 18k | 2k | 7,037 | 8.9 h | another tool (35%) |
| image-upscale | gpt-6-luna | 87k | 95% | 3.0 | 761 | 166 | 12 | – | another tool (34%) |
| image-enhance | gpt-6-luna | 86k | 93% | 3.2 | 1k | 339 | 202 | – | turn ended (50%) |
| icons | gpt-6-luna | 82k | 88% | 6.3 | 10k | 539 | 18 | – | turn ended (52%) |

## Major skills (last 7 days)
| Skill | Sessions/wk | Failing calls | Time lost/wk | Frustrated | Kept | Iter./turn | Top issue |
|---|---:|---:|---:|---:|---:|---:|---|
| logo-create | 12,622 | 1.1% | 33 h | 4.8% | 26% | 2.4 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| single-page-design | 12,341 | 7.4% | 62 h | 6.9% | 25% | 4.6 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-generation-and-image-edit | 8,500 | 3.9% | 20 h | 13.9% | 35% | 3.4 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| logo-edit | 3,815 | 0.9% | 15 h | 16.6% | 33% | 5.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| wixel-ads | 3,069 | 9.0% | 98 h | 10.9% | 25% | 9.7 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| wix-explorer | 2,921 | 14.4% | 4.2 h | 0.0% | – | 3.9 | Error: Skill "site-content" not found. Check available_skills in the t |
| website-create | 2,883 | 0.6% | 1.3 h | 5.9% | 20% | 4.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] { \"data\": [], \"error |
| brand-new | 2,240 | 2.2% | 1.8 h | 1.9% | 27% | 4.7 | Sequence rejected before any step ran: unknown tool "functions.edit_im |
| video-logo-animation | 2,190 | 1.7% | 41 h | 9.5% | 76% | 11.8 | Error loading Codex resource "resources/video/video-capability-catalog |
| stories-creation | 2,060 | 4.2% | 50 h | 8.1% | 29% | 10.7 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| slides-creation | 1,963 | 2.6% | 35 h | 5.0% | 51% | 6.0 | Tool returned while its job was still IN_PROGRESS (hidden timeout) |
| video-creation | 1,499 | 6.2% | 23 h | 10.5% | 41% | 8.3 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-qr | 1,417 | 3.0% | 3.8 h | 6.1% | 73% | 4.4 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| doc | 1,175 | 9.3% | 8.3 h | 10.6% | 55% | 3.9 | INVALID_ARGUMENT: Error invoking endpoint: [N] { \"data\": [], \"error |
| brand-kit | 918 | 2.4% | 34 h | 8.7% | 13% | 20.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| wixel-ads-lite | 709 | 1.4% | 15 h | 3.6% | 26% | 3.6 | Tool returned while its job was still IN_PROGRESS (hidden timeout) |
| site-content | 707 | 6.1% | 6.3 h | 2.3% | 29% | 3.3 | Error: Skill "site-content" not found. Check available_skills in the t |
| video-regen | 583 | 6.8% | 20 h | 22.6% | 44% | 6.7 | Error loading Codex resource "resources/video/video-capability-catalog |
| slides-edit | 509 | 1.7% | 1.1 h | 11.9% | 25% | 6.9 | Error writing file: Invalid JSON: Expected ',' or '}' after property v |
| image-enhance | 450 | 6.5% | 2.5 h | 28.1% | 56% | 3.2 | INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: B |
| business-card | 405 | 1.8% | 3.4 h | 10.0% | 40% | 10.2 | Error writing file: path or name is required when applying edits. |
| export-handler | 392 | 3.2% | 1.6 h | 12.9% | 58% | 6.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] → (provider returned an |
| image-upscale | 370 | 5.0% | 54 min | 44.8% | 83% | 3.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] → providerBadRequest: B |
| publish-social-post | 327 | 1.2% | 1.5 h | 7.7% | 0% | 5.4 | Sub-agent timed out: it ran for N minutes without finishing and was ca |
| image-remove-background | 315 | 2.9% | 1.1 h | 26.3% | 51% | 5.4 | Failed to analyze image: description: INVALID_ARGUMENT: INVALID_ARGUME |
| wix-apis | 227 | 1.3% | 2 min | 6.7% | 45% | 2.2 | – |
| logo-variations | 186 | 1.8% | 25 min | 13.9% | 52% | 6.0 | Failed to invoke RPC: 'telemetry.conversationId' value must be a valid |
| image-collage | 180 | 2.3% | 1.4 h | 15.3% | 41% | 4.0 | INVALID_ARGUMENT: Error invoking endpoint: [N] { \"errors\": [ { \"cod |
| pdf-processor | 178 | 3.5% | 1.3 h | 16.6% | 59% | 6.1 | Error writing file: Invalid JSON: Expected double-quoted property name |
| icons | 156 | 1.2% | 31 min | 5.9% | 8% | 6.3 | Sequence rejected before any step ran: unknown tool "functions.generat |
