# Autopsy

*Take a Wixel skill's runs apart: what it made, what went wrong, and why.*

A fast, local browser for every run of any Wixel agent skill. It shows what each run made (videos, images, logos, docs, slides…) along with:
- the request, the scraped brand, and every step with its timing
- errors, user mood and feedback
- the Genix graph runs behind each generation

The Insights tab summarizes the skill as a whole: failure rates, timings, top errors, what users asked for, and more.

Built in three levels: a grid of runs → a run's deep dive → the Genix graph run behind a generation. Start with `npm start` or the **Autopsy** app on the Desktop.

**Fleet** (the button next to the logo, or `/fleet.html`) looks at every major skill at once: what fails most, how much time each failure costs, which fixes are easy, how long each operation really takes (and the right timeout), and where the agent does work it doesn't need to. See [Fleet](#fleet-every-major-skill-at-once).

## Install (new machine)

```bash
git clone https://github.com/odedwix/wixel-autopsy.git   # private — ask Oded for access
cd wixel-autopsy
npm run setup        # checks everything, installs, creates .env, builds the Desktop launcher
npm start            # (re)starts the app and opens http://localhost:5178
```

### What you need

| | Needed for | How |
|---|---|---|
| **Wix network** (office or VPN) | everything: the npm registry, the Wixel admin API, and Trino through it | no cookie or personal token needed from inside the network |
| **Node 22+** | the app (its built-in WebSocket drives headless Chrome) | `brew install node@22` |
| ffmpeg *(optional)* | review videos and hover scrubbing | `brew install ffmpeg` |
| Temporal API key *(optional)* | "Open graph run" (Genix graph runs) | `TEMPORAL_API_KEY=` in `.env`. It's a **production secret**: get your own from the Wixel/Genix team, and never commit or share it |
| wixel-video-client checkout *(optional)* | the exact live product player (**E**) | clone `wix-private/wixel-video-client` to `~/dev/` (or set `WIXEL_VIDEO_CLIENT`), then `npm run build:player` |
| Google Chrome *(optional)* | PDF reports saved straight to Downloads (no dialog), and **Exact composition** mp4 downloads | the normal install, or `CHROME_PATH=` in `.env` |
| Python Pillow *(optional, macOS)* | the Desktop launcher icon | `pip3 install pillow` |
| wixel-agent-codex checkout *(optional)* | Fleet fix briefs that point at the exact skill / resource / schema files | clone `wix-private/wixel-agent-codex` to `~/dev/` (or set `CODEX_DIR`) |
| Claude Code CLI *(optional)* | Fleet's "Draft the fix with Claude" | `claude` on the PATH, signed in |

The run list, details, timeline, scenes, brand, assets and insights work with just the Wix network and Node. Missing optional pieces switch off with a hint in the UI.

Settings live in `.env` (gitignored; template in `.env.example`): `PORT`, `CACHE_MAX_GB`, `TEMPORAL_API_KEY` / `TEMPORAL_KEY_FILE`, `WIXEL_VIDEO_CLIENT`, `CHROME_PATH`, and for Fleet `FLEET_DIR`, `FLEET_READONLY`, `CODEX_DIR`.

**Off the Wix network?** Autopsy checks every minute whether `bo.wix.com` answers, and right away after a request fails. When it doesn't answer, a banner says so (connect the VPN), with **Check again**. Cached data keeps working.

**Data handling:** the app shows what the Wixel admin page shows, including end users' emails and prompts. It's for Wix staff only. The proxy listens on 127.0.0.1 only, and data is cached in `.cache/`, capped by `CACHE_MAX_GB` (default 3 GB, least-recently-used entries evicted first). Shared links and summaries never include end-user emails.

## Run

```bash
npm install          # uses Wix's npm registry (.npmrc); the public one is blocked on the Wix network
npm start            # (re)starts the app and opens http://localhost:5178
npm run proxy        # same, without opening the browser
npm run pull         # warm the cache with a 50-run sample and print a coverage report
```

## Any skill, any output

Not every skill makes video. A run's **outputs** are the top-level assets its counted turns wrote (see below), taken from the `TURN_UPDATED_ASSETS` session events (asset id, type, name, snapshot) and joined to `v1_asset_crud` for thumbnails and publishes and to `users_193` for downloads.
- **Output profile:** each skill gets one, learned from its runs and shown in the tab row, e.g. "Makes: Logo 97% · Image 11% · Video 3%". Each type is a filter.
- **Cards** show the skill's main output type with a type badge and an "N outputs" count. Hovering plays video outputs; for other types it flips through the run's outputs. The card shape is **Auto** by default: logos and images 1:1, slides 16:9, docs 3:4, video 9:16.
- **The details panel** shows non-video outputs as a gallery: the selected output, a strip of all outputs, and pages for docs and slides.
- **Result filter:** Produced output / Tried, no output / Never tried. "Tried" means a media job, an image tool or an asset write.
- **Busy skills are sampled.** Above about 400 sessions a day, a deterministic sample is taken: sessions whose id starts with certain hex characters. The status bar shows the share. Heavy days are also split into hour windows when a query times out.
- **Stale work is cancelled.** Switching skill or window drops the old selection's queued Trino queries.

## One skill at a time (sessions mix skills)

Most sessions use several skills: 30–40% of a skill's session turns are usually other skills'
work, such as a logo made after an ad or a slideshow after "try a slideshow instead". A session counts for the
selected skill **turn by turn**:

- The turn that loads the skill claims the session. Turns before it never count.
- **Loading a skill** happens in one of two ways. The agent calls the skill tool, or (since 2026-09-30) the platform **preloads** the skill into the session's first message (`metadata.preloadedSkillBodies`). After a preload the agent never calls the tool, so the preload counts as a load at that message. When export-handler is preloaded next to a product skill (for example single-page-design), only the product skill counts as loaded. Before this rule, the views missed about 60% of sessions from 09-30 on.
- Later turns stay with it until one loads a skill outside its **family**. That turn and the ones after it are other skills' work and are left out of runs, outputs, timing, errors and insights.
- **Family = the skill's helpers.** These are worked out from how often skills load in the same turn:
  - partners loaded in ≥3% of its turns;
  - sub-steps of those partners, meaning skills that load with them ≥50% of the time (for example wixel-ads → video-creation → video-plan-approval);
  - the shared utilities (site-content, wix-apis, export-handler), which never end a skill's turns.

  A family is pinned for 30 days per skill.
- **Outputs** are the assets the counted turns wrote, or created while those turns ran. The product often logs an asset only on a later edit turn.

The **Counting** button next to the skill shows each helper and why it's there. You can edit the family, or switch to whole sessions. Co-loading can't always tell which of two mutual partners is in charge (wixel-ads and video-creation list each other).

The run view marks the counted turns ("Counting 1 of 7 turns…"), with **Show them** to see the whole session. Cards flag sessions that also used other skills. The **Skills in the session** filter shows which skills people combine.

## User mode

Pick **Users** in the skill picker (⌘K), or click a user's email in any run, to see every session that person ran, across all skills.

The admin API lists sessions by user id only, so an email is found from sessions Autopsy has already fetched. A user id, a session id or an admin link always works.

## Downloads

**Download** (or **D**) saves any output. Autopsy picks the best source available:

| Output | What you get |
|---|---|
| Video | the exact render the user got, at full quality, else the review copy |
| Slides, doc, story (pages) | the user's own export when it's reachable; editor exports are private, so usually a PDF of the page previews (~1000px) |
| Logo, plain image | the original image file |
| Composed design (text on an image) | the design as the user saw it |

With more than one choice, **Download** (the button, the player's download icon, or **D**) opens a menu:
- **Ads without a render:**
  - **Full ad — regular:** the scenes joined with voice and music, no text overlays or captions.
  - **Full ad — exact:** as the product plays it, with text overlays, captions and music. It's rendered from the product's own player: headless Chrome seeks it frame by frame, and the audio comes from the regular copy. It takes about 2 minutes the first time and is cached after that.
- **Ads with a render:**
  - **Full ad — exact:** the file the user got.
  - **Full ad — small copy:** a 540p copy.
- **Other outputs:** the run's other outputs (logos, slides…) are listed below.

## Reports (PDF)

- **A run:** Share → **Export PDF report**. It has the facts, outputs, request, errors, the timeline (with the result-building phase), every step (with links to its output and graph run), scenes, brand and assets.
- **Insights:** Share insights → **Export PDF**.

Both keep the dark UI's colours on A4 landscape, with type about 25% larger than the app. Run references are real links: Wixel admin (for anyone with BO access), outputs and Temporal. With Chrome installed, Autopsy's server renders the PDF in headless Chrome and it downloads straight to Downloads. Without Chrome, it falls back to the print dialog. The file name carries the run name, user, run time and date (insights: skill, window and date).

## UI

- **Grid** (virtualized). The first tab is named after the skill's main output (Videos / Logos / Slides…).
  - **Video outputs:** hovering a card plays it, with sound if S is on. Moving the mouse scrubs: the sprite frame shows instantly while the real frame seeks. Badges show the video source: Exact / Assembled / Clip / Preparing.
  - **Other outputs:** hovering flips through everything the run made, and a type badge and "N outputs" count sit on the card.
  - **Runs that tried but produced nothing** have a red top edge and show the first error. Hovering the error icon lists every failing step with its message.
  - **Signals per card:** downloaded (editor or agent), published, worst mood across turns, thumbs up/down, issues, out of credits. The user type (Real / Employee / Team) sits next to the time.
  - **"+N skills"** on a card: other skills also worked in that session. Hover it for which ones and how many turns were counted. In user mode, each card lists the skills its session used.
- **Filters:** faceted, each option with its count. Summary tiles double as one-click filters.
- **Remembered state:** everything is saved in localStorage and mirrored in the URL (`#v=…`), so a reload restores the view and any view can be shared as a link.
- **Inspect** (click or Enter):
  - **Video runs:** a review player with a custom scrub bar (scene segments, sprite preview, `,`/`.` frame steps, speed). **E** switches to the exact live composition: the product's own Remotion player, vendored from `wixel-video-client` by `npm run build:player`.
  - **Other runs:** an output gallery with a large view, a strip of all outputs, and pages for docs and slides. The arrow keys step through outputs.
  - **Header:** **Download** (any output type, see Downloads above), **Share** (see Sharing below). The user's email opens user mode.
  - **Skill mode:** a banner says which turns count for the skill ("Counting 1 of 7 turns…"). **Show them** includes the other skills' turns in every tab.
  - Tabs (keys **1–6**; **W** widens the panel):
    - **Overview:** outcome, mood by turn, the request (the user's own words, with injected `<HIDDEN>` context folded away) plus follow-ups, errors, scenes, identifiers.
    - **Timeline:** a waterfall of every step, with agent thinking time on its own row and user-message markers.
      - Idle gaps between turns are compressed, and agent plumbing (read / write / list) can be hidden.
      - Hovering a bar shows a tooltip; clicking a row shows the prompt, input and output media, arguments, output and error.
      - **Open graph run** opens the drawn Genix graph (below), and **Nodes table** shows the same data inline. Both read Temporal only when you click, and need a Temporal key.
    - **Scenes:** each shot next to the chain that made it, in a Picture lane (image → edit → video → voice merge) and a Voice & sound lane (TTS script → trim), with every step's prompt, model and time.
      - The chain is traced through media ids shared between one step's output and the next step's input.
    - **Brand:** the scraped site (logo, colours, fonts, screenshot) next to what the ad's text actually used, with ✓ on matches and a verdict such as "2 of 4 site colours… 0 of 5 fonts".
    - **Assets:** every piece of media in the run, grouped as uploads / website / generated images / clips / voice & music.
    - **Raw:** the normalized record per key, plus a link to the raw admin bundle.
- **Insights** (tab, or **I**): computed in the browser from the runs in view, so they follow the skill, window, filters and search, and cost nothing upstream. Per-session step stats come from one extra Trino query per day (`stepsDayQuery`), cached like the day rows.
  - Overview: output rate (produced output ÷ tried), request → final output / first generation (median, p90), average generation call, download and publish rates, frustration, cost per run with output, main output type.
  - Tools & methods, sortable: calls, failures, fail rate, average and slowest time, runs hit. Clicking a row filters to the runs where that step failed.
  - Generation models; funnel; where the time goes; top error signatures; what users asked for (classified intent plus title subjects); most repeated prompts (many users = template, one user = retrying); mood and feedback quotes; runs per day; skill versions.
  - A headline strip above the grid summarizes the top insights, and each one links to its card. Cards pack into masonry columns to keep scrolling to a minimum.
- **Genix graph run** (level 3: "Open graph run" on a timeline step, or click a step card in Scenes). A full-screen view of that generation's graph, read from Temporal only when you open it.
  - Layered left-to-right layout (longest-path layers plus barycenter ordering), with graph inputs on the left and outputs on the right.
  - Each node shows its status, a mini timing bar of when it queued and ran inside the graph, time, cost, provider and an output thumbnail. Nodes that didn't run are dashed.
  - The critical path (the chain that set the end time) is highlighted. Hovering or selecting a node lights up everything upstream and downstream.
  - The node inspector shows timings, cost, endpoint, task queue and `when` condition. Each input is labelled with its source (graph input, `← upstream.handle`, or static param). It also shows the output (media previews), the failure root cause plus the full cause chain, and a Temporal link.
  - The graph summary lists failed nodes, the critical path, the slowest and most expensive nodes, and the graph's inputs and outputs.
  - **V** switches to a waterfall of the nodes; **F** fits; **[ ]** steps through nodes; pinch or ⌘-scroll zooms; drag pans; **Esc** closes.
  - The header leads with the graph's own outcome, because a Temporal workflow can complete while a node inside it failed.
- **Sharing.** The app runs on localhost, so its own links only open for people running Autopsy; every share also offers links that work for anyone.
  - **A run** (Share in its header): copy the app link, the Wixel admin link (anyone with BO access), or the output's public link (exact render, published page or image). There's also a text summary and an email draft (`mailto:`). End-user emails are never included.
  - **Insights** (Share insights): copy the app link with the same filters, copy a text summary (numbers, failing tools, top errors, asks, unhappy-user quotes), email it, or **Export PDF** through the print dialog ("Save as PDF"; links stay clickable and URLs are printed).
- **Skill picker** (⌘K) has two tabs:
  - **Skills:** searchable, with the 5 most recently viewed skills on top.
  - **Users:** an email, user id or session link, plus the 5 most recently viewed users.
- **Counting** (next to the skill): which helpers count with the skill, why each one is there, and an editor. See "One skill at a time" above.
- **Time windows** are rolling (1h / 24h / 3d / … from now) rather than UTC calendar days.
- **Loading feedback:** a progress bar under the header, per-second status, and a "Trino is busy" note when queries queue.
- **Filters that don't fit a skill** are removed automatically, with a toast that says what was removed. That covers both single values that match nothing and combinations that together match nothing (the most restrictive filter goes first).
- **Error icon on a card:** hovering it lists the failing steps with their messages.
- **Text size** (**Aa** in the top bar, or ⌥+ / ⌥− / ⌥0): fonts and text rows scale while the layout keeps its size. Text wraps and the top bar takes a second row instead of the page zooming.
- **Timeline → building the result:** the agent writing the result into the project (`write` on `project/assets/*.json`, labelled by asset) is its own category, not plumbing.
  - The model calls that compose those edits are cyan on the thinking row.
  - A summary shows how long the build took after the last generation, split into composing, saves and checks, plus when the editor confirmed the save, and any failed saves.
- **Keyboard:** `?` lists all shortcuts.

## Fleet: every major skill at once

`/fleet.html` (or **Fleet** in the top bar). Pick a period (Today, 1 / 7 / 14 / 30 / 90 complete UTC days) and whose sessions count (**Real users** by default; Everyone; Internal). Changes are against the previous period of the same length, once that period is mostly built.

- **Overview:** sessions, failing tool calls (out of credits excluded), time lost to failures per week, hidden timeouts, frustrated turns, model iterations per turn, input tokens per iteration, agent thinking time, outputs kept, sessions with no skill. **Do these first** puts issues, timeouts and agent-design changes on one scale: hours a week given back. Plus failures per day, time lost by fix difficulty, and the major-skills leaderboard.
- **Issues:** one row per error signature × operation, across every skill it happens in, ranked by priority.
  - **Priority** = impact (time lost: failed calls + one recovery per run of failures + 10 min per session it ended + 5 min per user upset afterwards) × how fixable the class is × how concentrated it is, boosted when new or rising.
  - **Kind / fix / owner:** missing file or skill, agent misuse of a tool, rejected parameters, output failed validation, content filter, permission, interrupted by restart, hidden timeout, transient/upstream, out of credits (not a bug, hidden by default).
  - **Pattern:** a spike (most of it within 3 hours: an incident, likely upstream) vs every day (chronic). **Trend:** rate per 1k turns vs the previous period (Poisson z-test): new / rising / falling.
  - **Detail:** per day, the skills it happens in (each links to that skill's runs where the step failed), the rate per **codex version** (did a change fix it?), models, the full example error, example runs (Autopsy and admin links), and a status (accepted / fixed in version … / won't fix / duplicate, with a note) shared with everyone using the same Fleet folder.
  - **Fix per skill:** a tab for each skill the issue happens in, built from that skill's own failing calls (2 sessions, admin API, cached):
    - what its failing calls show, e.g. which hosts the failing image URLs come from (Wix media, cloud-storage links like a scraped page's screenshot, other websites);
    - the change to make in that skill's instructions;
    - where: the skill file and the exact lines that mention the tool, plus the references/resources involved (GitHub links);
    - its examples (request, error, what the agent did next);
    - **Copy prompt for Claude Code**: a ready-to-paste prompt for the wixel-agent-codex checkout, limited to that skill's files ("don't change tools, agent configs or system prompts"), with a redacted failing call and an eval case to add;
    - **Ask Claude for a suggestion** (optional, local `claude` CLI, read-only): the answer is saved in `FLEET_DIR/suggestions/` for everyone sharing the folder, tagged with the codex commit it read.

    Only kinds of error a skill can fix get suggestions (missing file, agent misuse of a tool, failed validation, content filter, rejected parameters, unclassified). Timeouts, restarts, upstream failures, permissions and credits are platform or tool work: shown as parked.
  - **Fix brief** (on demand, the whole issue): reads up to 3 example sessions (what was called, the error, what the agent did next), the Genix root cause of failed generations (Temporal, with a key), and the codex (below), then writes what's wrong, how big, where to look (exact files with GitHub links), a suggested fix, how to verify it (the rate per codex version; the eval sets mapped to the skill) and a redacted repro. Copy it as Markdown, email it, or **Draft the fix with Claude**: the local `claude` CLI, read-only tools, in the codex checkout, asked for the smallest change as a diff. Nothing is edited. The brief is redacted (no emails or phone numbers) but includes users' requests (shortened); check that's fine before sending it to Claude.
- **Wait times:** per tool · method · model · input size (clip length, resolution), across all skills: calls, failures, p50 / p90 / p99 of successes, hidden timeouts and the cap they hit, how often a retry works and how long the agent waited before retrying.
  - **Recommended wait:** the cap τ that minimizes the expected time to a success, E(τ) = E[min(T, τ)] ÷ P(T ≤ τ), over the measured durations, treating a retry as an independent fresh try and hidden timeouts as jobs that wouldn't have finished. Never below 1.5× the p95 of successes. The detail shows the histogram with p50 / p99 / today's cap / the recommendation and the E(τ) curve.
  - **Re-attach, don't restart:** a hidden timeout means the job was still running; poll the same job id instead of starting a new one (a fresh job pays again).
- **Opportunities:** where the agent works harder than it needs to, each with evidence and an estimate per week (iterations, hours, input tokens) and a guard when it could backfire:
  - **Scripted pipeline:** the same chain of ≥3 tool steps in ≥15% of a skill's turns → one deterministic step where the agent only picks the inputs.
  - **Same call every time:** an operation called ≥100 times a week with ≤5 distinct argument sets a day (e.g. `ListCosts`, `list_rpc_methods`, `GetBrandByProjectId`) → put the answer in the context.
  - **Always loaded together:** skill A loads B in ≥85% of its turns → preload or merge.
  - **File busywork:** many read/list/write calls per turn, the same file re-read.
  - **Let the tool fix it:** a validation slip the agent fixes itself on the next try ≥60% of the time → auto-correct inside the tool.
  - **Rubber-stamp approval:** ≥5% of a skill's turns are just "yes / ok" → proceed by default.
  - **Heavy context:** input tokens per iteration ≥1.4× the fleet median.
  - **Trial and error:** generations per kept output ≥1.8× the fleet median.
  - **Re-attach:** hidden timeouts (see Wait times).
- **Skills:** every skill side by side: sessions, turns, failing calls (±95% interval), failed turns, time lost, hidden timeouts, frustration, iterations per turn, tokens per iteration, thinking time, **outputs kept** (sessions whose asset was downloaded, by the editor or the agent) and generations per kept output, "yes" replies. **Pin** a skill to treat it as major.
- **Data:** each day's state (final / filling in / missing), build time, internal accounts, problems; every shift in the period; the definitions; and what Fleet can't see (rendering/export/player failures, output quality, the inside of generation graphs, client-side errors).
- **Share:** a link to the exact view, a text summary, an email, or a **PDF digest** (headless Chrome, saved to Downloads).
- **Keys:** `O` `1`–`5` tabs, `/` search, `J`/`K` next/previous row, `W` wide panel, `Esc` close, `⌥+ ⌥− ⌥0` text size.

**How skills are told apart.** All skills are read in one pass per day, turn by turn: a turn belongs to the first skill it loads, and later turns stay with that skill until one loads a skill outside its family (the same families as the single-skill view). A skill reaches a turn two ways: the agent calls the `skill` tool, or (since 2026-09-30) the platform **preloads** it into the session's first message (`metadata.preloadedSkillBodies`); both count, and with several preloaded the product skill wins over utilities like export-handler. Helpers used by everything (site-content, wix-apis) never take a turn. Sessions with no skill at all are "no skill" (about 10%). Outputs kept is session-level (credited to the session's first skill), because downloads happen in the editor, outside turns; "produced" counts asset writes (`WRITE_METERING`) and handed-over assets (`AGENT_MENTIONED_ASSETS`), since `TURN_UPDATED_ASSETS` was only logged 2026-09-16 → 09-28.

**What changed** (Overview and Data) flags a day whose failure rate, no-skill share, tokens per iteration, iterations per turn, hidden timeouts, frustration, kept outputs or sessions moved beyond the range of the 7 days before it, and names any codex version that took over ≥20% of that day's turns: the in-app alert after a deploy. That is how the 2026-09-30 switch to preloaded skills was found: before preloads were counted, sessions with no skill load jumped from 15% to 58% overnight.

**Measured vs estimated.** Counts, durations, recoveries, tokens, versions and outcomes are measured from the agent's own entries and events. Time lost uses one stated rule: each failed call's own time, plus one recovery per run of consecutive failures: from the first failure until the next successful attempt of that operation was started in the turn (else the turn's end). Savings and recommended timeouts are estimates; each card and panel says how it was computed.

### How it's built (and why it doesn't load Trino)

- **Daily rollups, not sessions.** Each UTC day becomes one small file (`FLEET_DIR/days/YYYY-MM-DD.json`, ~1 MB) from 6 queries that read the whole day for every skill and return totals only, each under 500 rows (the endpoint re-runs a query per page): usage per skill and tool, timing per operation (mergeable histograms, so week and month percentiles stay right), failure signatures (the ~450 most common a day; the rest fold into one row per skill), work chains, outcomes, and the day's internal accounts.
- **Cost:** about a minute of Trino per day, one query at a time, at background priority (on-screen work always goes first, and it pauses while Trino is busy). A day is final 6 hours after it ends and is never queried again; today refreshes at most every 30 minutes. A week or month is the day files added up locally: no extra queries. Each query part has its own version, so a changed query re-runs only itself on days already built.
- **When Trino is busy:** after a timeout, the rest of that day's queries are skipped (the day is retried later) and the next day waits out the limiter's backoff; `npm run fleet` stops after 3 busy days in a row. Finished days are always kept.
- **Backfill:** opening a period queues its missing days (and the previous period's, for trends), newest first; the view fills in as they land. Or from the command line: `npm run fleet` (last 30 days), `npm run fleet -- --days 90`, `npm run fleet -- --day 2026-10-02 --force`.
- **The knowledge is in the repo.** `.fleet/` is committed: the day rollups (`.fleet/days/`, ~800 KB a day; example error texts have emails, phone numbers and URL query strings stripped), the decisions (`.fleet/state.json`) and saved Claude suggestions (`.fleet/suggestions/`). `npm run fleet:snapshot` writes a readable summary to `knowledge/`: `README.md` (the findings in plain words: numbers, what we learned about the data, what changed, top issues with the fix per skill, wait times, opportunities, asks that end badly, major skills, decisions) plus `fleet-7d.json`, `fleet-30d.json` and `skill-fixes.json`. It never queries Trino (the fixes per skill read a few cached sessions and the codex). Commit both after a rebuild.
- **One producer for a team.** Point everyone's `FLEET_DIR` at a shared folder. One machine builds the days (`npm run fleet:nightly` installs a macOS LaunchAgent that runs at 06:15; `-- --remove` uninstalls it); the others set `FLEET_READONLY=1` and only read. Issue statuses and pins (`FLEET_DIR/state.json`) are shared the same way.
- **Briefs** are the only per-session reads: ≤3 session bundles (admin API, cached) and ≤2 job traces (Temporal, cached) per brief, only when someone asks for it.
- **The codex** (`CODEX_DIR`, default `~/dev/wixel-agent-codex`): skills by their `name:`, files, RPC schemas, agent configs and eval mappings, read with `git show / grep / ls-tree` from the latest fetched commit (`origin/HEAD`). The working tree is never touched, so a stale checkout still reads the newest fetch (`git fetch` it now and then).

## Project layout

| Path | What |
|---|---|
| `server/server.js` | HTTP server: API routes, static files, media with Range support, single-instance takeover |
| `server/queries.js` | All Trino SQL: skills, runs index, per-day runs / events / steps (hour windows + sampling, turn scoping), skill co-load pairs |
| `server/runs.js` | Day loading, caching, sampling, per-run outputs and signals, employee detection, skill families, user runs |
| `server/pdf.js` · `server/exact.js` · `server/connectivity.js` | Headless Chrome sessions (PDF reports); Exact composition → mp4; the Wix network / VPN check |
| `web/js/report.js` · `web/player/capture.html` · `scripts/player/capture-entry.tsx` | Printable reports; the frame-by-frame player page and its bundle entry (built by `build:player`) |
| `server/users.js` · `server/asset-download.js` | Email → user index for user mode; downloads for non-video outputs (export, original image, or a PDF of the page previews) |
| `server/admin.js` · `server/normalize.js` | Wixel admin API client; session → run record (steps, lineage, brand, asset tree) and turn ownership |
| `server/temporal.js` | Temporal traces → graph runs (per-node data, failed-job lookup) |
| `server/media.js` · `server/player.js` | Review videos (ffmpeg) and the live product player input |
| `server/limits.js` · `server/context.js` · `server/cache.js` · `server/cache-gc.js` | Upstream limiters and load counters, request cancellation, disk cache, size cap |
| `web/js/app.js` | Boot, loading, filters panel, summary, keyboard |
| `web/js/grid.js` · `inspect.js` · `timeline.js` · `deep.js` · `graph.js` | Grid, details panel, timeline, scenes / brand / assets / raw, graph run |
| `web/js/insights.js` · `share.js` · `skillpicker.js` · `family.js` · `ui.js` · `filters.js` · `state.js` | Insights, sharing, skill / user picker, what counts as a skill (Counting editor), tooltips / toasts / popovers, facets, persisted state |
| `server/fleet.js` · `server/fleet-queries.js` · `server/fleet-analyze.js` | Fleet: day files, backfill queue, the all-skill rollup SQL, and the analysis (issues, wait times, opportunities, skills) |
| `server/fleet-skillfix.js` | Fix per skill: evidence from that skill's failures, the change to its instructions, the Claude Code prompt, saved Claude suggestions |
| `server/fleet-brief.js` · `server/codex.js` | Fix briefs (evidence, codex findings, shared state, the Claude draft runner); read-only access to the wixel-agent-codex checkout |
| `web/fleet.html` · `web/js/fleet.js` · `web/js/fleet-views.js` · `web/css/fleet.css` | The Fleet page |
| `scripts/` | `setup.sh`, `launch.sh`, `make-launcher.sh`, `make-icon.py`, `build-player.sh`, `pull-sample.js`, `fleet-rollup.js` (`npm run fleet`), `fleet-snapshot.js` (`npm run fleet:snapshot`), `fleet-nightly.sh` |
| `.fleet/` · `knowledge/` | Fleet's committed knowledge: day rollups, decisions, saved suggestions; the readable snapshot |

## Load on production systems

Every upstream call goes through `server/limits.js`: a concurrency cap and minimum spacing per system, plus rolling counters shown live in the status bar ("Upstream, 5 min").

- **On-screen work first.** Work nobody is waiting on (background refreshes of cached recent days) runs at background priority: at most one slot, and only when nothing on screen is queued. It's skipped while Trino is busy; the next view of that data tries again.
- **Backoff.** Three Trino timeouts within 2 minutes put the lane at 2 queries at a time, 1.2 s apart, for 3 minutes. The status bar says so ("easing off") instead of looking stuck.
- **Cancelled when you move on.** Switching skill or window drops the old view's queued queries.

| System | What it is | Cap | When it's called |
|---|---|---|---|
| Trino (via the admin SQL endpoint) | shared analytics cluster, not production serving | 4 concurrent, ≥250 ms apart | list, index and step queries, plus one skill co-load query a day (families). A day older than 3 days is cached forever per skill and family, so steady state is a few queries per 3 minutes for the last 3 days. Editing a family re-queries that skill's days |
| Trino, Fleet rollups | same cluster | 1 background slot, one query at a time | 6 queries (~1 min) per UTC day, once: final days are never re-queried, today at most every 30 min. Nothing per session |
| Wixel admin API | production BO service reading the agent's session store | 3 concurrent, ≥150 ms apart | opening a run, hovering a card for 600 ms, assembling an ad without a render, building a download, listing a user's sessions (user mode; cached 2 min). Session details are cached forever once the session has been idle 30 minutes |
| Temporal Cloud prod namespace | shares request limits with production workers | 2 concurrent, ≥250 ms apart | only when you open a graph run or a nodes table. Each trace is about 3–5 calls, cached forever once finished |
| Wix CDN (wixmp) | media delivery | ffmpeg, 2 builds at a time | downloading clips and renders for review copies |

## API

| Route | What | Source |
|---|---|---|
| `GET /api/skills?days=30` | skills with ≥5 sessions | Trino |
| `GET /api/runs-index?skill=…&days=…` | which UTC days have runs (plus when the skill last ran, if none) | Trino (cheap: skill calls only) |
| `GET /api/runs-day?skill=…&day=YYYY-MM-DD&n=<sessions>&fam=` | one day's runs, counting the skill's turns only; the UI loads these 3 at a time, newest first. `n` (from the index) turns on sampling for busy days. `fam`: `default` (computed family), `all` (whole sessions) or a comma list | Trino |
| `GET /api/family?skill=` | the skill's family (helpers counted with it) and why each is in it | Trino (cached) |
| `GET /api/resolve-user?q=` | email / user id / session link → user | local index, admin API |
| `GET /api/user-runs?user=&days=` | every session one user ran, any skill | admin API, Trino |
| `GET /api/runs?skill=wixel-ads&days=7` | all days at once (scripts) | Trino, one query per non-empty day |
| `GET /api/session/:id?skill=&fam=` | normalized run record; with `skill`, `scope` says which turns count for it (`?raw=1` for the raw bundle) | admin API |
| `GET /api/trace/:workflowId` | Temporal chain + Genix graph runs with per-node data | Temporal Cloud |
| `GET /api/media/:runId?priority=1` | review-media status; queues a build if there is none | ffmpeg |
| `GET /media/:runId/review.mp4 \| poster.jpg \| sprite.jpg` | review media (Range requests supported) | local cache |
| `GET /download/:runId?name=` | save the video: the full-quality exact render when there is one (streamed through), else the review copy | render CDN / local cache |
| `GET /download/:runId?src=review\|exact` | the 540p review copy, or the rendered Exact composition | local cache |
| `GET /api/exact/:runId?start=1` | Exact composition status; `start=1` renders it (headless Chrome + ffmpeg) | local, Wix CDN |
| `GET /api/report.pdf?kind=run\|insights&view=#v=…&name=` | a report as a PDF download, rendered by headless Chrome from the app's own report view | local |
| `GET /api/connectivity?fresh=1` | whether bo.wix.com answers (Wix network / VPN) | admin API |
| `GET /api/frame?url=` | one still from a clip, for printed reports | Wix CDN, ffmpeg |
| `GET /download-asset/:runId/:assetId?name=` | save any other output: the user's export if reachable, the original image, or a PDF of its page previews | Wix CDN, ffmpeg |
| `GET /api/trace-job/:jobId?at=<ms>` | the same trace, for a **failed** generation (only a jobId) | Temporal Cloud |
| `GET /api/media-batch?ids=a,b,…` | review-media status for the cards on screen | local |
| `GET /api/player-input/:runId?root=<assetId>` | the live product player's input, built from the asset tree | admin API |
| `GET /_api/wixel-viewer-bundle-server/bundles?…` | same-origin pass-through for the player's component bundles | manage.wix.com (public) |
| `GET /api/fleet?days=7&today=0&aud=real\|all\|internal&end=` | the Fleet view for a period (and the previous one, for trends); queues missing days | day files (Trino when building) |
| `GET /api/fleet/status?days=` · `GET /api/fleet/build?days=` | which days are built; queue days for building | local |
| `GET /api/fleet/brief/:issue?days=&aud=&traces=1` | a fix brief for one issue | admin API, Temporal, codex (git) |
| `GET /api/fleet/skillfix/:issue?skill=&days=&aud=` | what to change in one skill for one issue, and a Claude Code prompt | admin API, codex (git) |
| `POST /api/fleet/skillfix/:issue/claude?skill=` · `GET` | ask the local `claude` CLI for that change (stored in FLEET_DIR/suggestions) | local |
| `GET/POST /api/fleet/state` | issue statuses, dismissed / accepted ideas, pinned skills (shared via FLEET_DIR) | local |
| `POST /api/fleet/draft/:issue` · `GET` | draft the fix with the local `claude` CLI (read-only, in the codex checkout) | local |
| `GET /api/health` | what this install can do (Temporal key, ffmpeg, player), plus cache use | local |
| `GET /api/load` | upstream calls in the last 5 minutes, the media queue, and cache use | local |

## Where the data comes from, and the limits

- **Trino** goes through the admin API's SQL endpoint: `POST https://bo.wix.com/_api/wixel-agent-admin/api/analytics/session-entries` with `{mode:'sql', sql, limit, offset}`.
  - Limits: 500 rows per call, 30 s of Trino time, and 64 KB of SQL.
  - Each `offset` page re-runs the whole query, so queries should return fewer than 500 rows.
  - That's why runs are queried one UTC day at a time (about 12 s per day, 4 in parallel). A day older than 3 days is cached forever.
  - The last few days are served from cache immediately and refreshed in the background (stale-while-revalidate, every 3 minutes). A warm 7-day list for wixel-ads is about 2.2k runs and loads in about 65 ms.
- **Session detail** comes from `GET …/sessions?sessionId=`, `…/sessions/:id/session-entries`, `…/session-events` and `…/project-assets`. That's about 5 s cold, then cached forever once the session has been idle for 30 minutes.
- **Linking a generation to its graph run.** An `invoke_rpc` tool result carries:
  - `processJob.jobResult.workflow_id`
  - `result_url` (the mp4)
  - the graph id, inside `description`
  - `durationMs`, which is real, because the tool waits for the job to finish.

  In Temporal, `WorkflowId STARTS_WITH '<wid>'` returns `StartGraphExecutionWorkflow` → `<wid>-genix` → `<wid>-genix-<reqId>` (`execute_graph_v2`). The `run_graph_spec` workflow (id = `reqId`) is where everything else lives:
  - The **full graph spec** is in its start input, so no Genix API call is needed.
  - Each child workflow gives one node's input, output, timing and failure.
  - `costIncurred` signals give each node's cost.

  A typical trace is about 60 KB and takes about 2.5 s cold.
- **Failed generations.** Their tool result has only a `jobId`. The parent workflow's input carries `job_id`, so `/api/trace-job` searches failed `StartGraphExecutionWorkflow` runs started within 3 minutes of the tool call and matches on it (about 3 s). The node's `rootCause` is the bottom of the failure chain, e.g. `MiniMax H3 Max does not accept settings`.
- **Matching nodes to the spec.** Temporal child events don't carry the Genix node id, so nodes are matched on workflow type. Ties are broken by params (`matchConfidence`).
- **Employee flag.** `prod.wt_accounts.base.mail_domain` doesn't identify employees. The vizion rule is used instead: an account missing from `prod.wt_accounts.base` is an employee. The Wixel team list (`sandbox.www.slides_employees_team`) wins over that, and results are cached per account.
- **Turn scoping in SQL.** Trino inlines each CTE every time it's referenced, so a second reference re-scans the entries table. The runs query therefore works out turn ownership with window functions over its single scan. The events query returns each event's turn, and `runs.js` keeps the counted ones (`owned_turns`).
- **Asset events are unreliable per turn.** A deck built in turn 1 is often reported only by a later edit turn. Outputs are therefore credited by creation time within the counted turns as well as by the events.
- **Users.** The admin API lists sessions by `userId` only; there is no email filter, and no warehouse table this app reads has emails. Emails resolve from session metadata Autopsy has already fetched (`.cache/meta`, local only).
- **Exports.** A user's own export (`users_193` `asset_url` for slides and docs) is private (403). Only renders are public, so page outputs download as a PDF of their previews.
- **Finished ad → review media** (`server/media.js`). The source is chosen in this order:
  1. The exact render from a UI download (`events.dbo.users_193` evid 19 `asset_url`).
  2. The exact render from the agent's `download` tool (`links.wixel.com/link/<id>/raw` → `wixel-render/<id>.mp4`).
  3. Otherwise, assembled with ffmpeg from the asset tree, using wixel-video-bm's timeline rules:
     - hard cuts in `layout.order.indexInParent` order
     - each scene plays `frameDuration − trim_start − trim_end` frames at **24 fps**, starting at `trim_start`
     - voice comes from clips with volume > 0, plus any root voiceover (`tts`) and music (`audio-timeline`) tracks, mixed with their shift, trim and volume
     - the music bed gets its trims, shift, volume and fades
     - **text overlays and captions are missing** from assembled media
  4. Otherwise, the last generated clip.

  The output is 540p H.264 with a keyframe every 12 frames (smooth scrubbing), AAC, faststart, plus a poster and a 60-frame sprite. It takes about 2–8 s per ad.
- **Signals in the list** (counted turns only):
  - sentiment per turn (`neutral` / `positive` / `confused` / `frustrated`)
  - thumbs up/down and their tags
  - out-of-credits and model stream errors (`v1_session_event_crud`)
  - agent downloads, UI downloads, publishes and the finished-ad thumbnail (`v1_asset_crud`)
  - employee = account missing from `prod.wt_accounts.base` (the vizion rule), cached per account
