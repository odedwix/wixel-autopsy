# Skill Run Explorer

A fast, local browser for every run of any Wixel agent skill. It shows what each run made (videos, images, logos, docs, slides…) along with:
- the request, the scraped brand, and every step with its timing
- errors, user mood and feedback
- the Genix graph runs behind each generation

The Insights tab summarizes the skill as a whole: failure rates, timings, top errors, what users asked for, and more.

Built in three levels: a grid of runs → a run's deep dive → the Genix graph run behind a generation. Start with `npm start` or the **Skill Runs** app on the Desktop.

## Install (new machine)

```bash
git clone https://github.com/odedwix/skill-run-explorer.git   # private — ask Oded for access
cd skill-run-explorer
npm run setup        # checks everything, installs, creates .env, builds the Desktop launcher
npm start            # (re)starts the app and opens http://localhost:5178
```

### What you need

| | Needed for | How |
|---|---|---|
| **Wix network** (office or VPN) | everything: the npm registry, the Wixel admin API, and Trino through it | no cookie or personal token needed from inside the network |
| **Node 20+** | the app | `brew install node@22` |
| ffmpeg *(optional)* | review videos and hover scrubbing | `brew install ffmpeg` |
| Temporal API key *(optional)* | "Open graph run" (Genix graph runs) | `TEMPORAL_API_KEY=` in `.env`. It's a **production secret**: get your own from the Wixel/Genix team, and never commit or share it |
| wixel-video-client checkout *(optional)* | the exact live product player (**E**) | clone `wix-private/wixel-video-client` to `~/dev/` (or set `WIXEL_VIDEO_CLIENT`), then `npm run build:player` |
| Python Pillow *(optional, macOS)* | the Desktop launcher icon | `pip3 install pillow` |

The run list, details, timeline, scenes, brand, assets and insights work with just the Wix network and Node. Missing optional pieces switch off with a hint in the UI.

Settings live in `.env` (gitignored; template in `.env.example`): `PORT`, `CACHE_MAX_GB`, `TEMPORAL_API_KEY` / `TEMPORAL_KEY_FILE`, `WIXEL_VIDEO_CLIENT`.

**Data handling:** the app shows what the Wixel admin page shows, including end users' emails and prompts. It's for Wix staff only. The proxy listens on 127.0.0.1 only, and data is cached in `.cache/`, capped by `CACHE_MAX_GB` (default 3 GB, least-recently-used entries evicted first). Shared links and summaries never include end-user emails.

## Run

```bash
npm install          # uses Wix's npm registry (.npmrc); the public one is blocked on the Wix network
npm start            # (re)starts the app and opens http://localhost:5178
npm run proxy        # same, without opening the browser
npm run pull         # warm the cache with a 50-run sample and print a coverage report
```

## Any skill, any output

Not every skill makes video. A run's **outputs** are the top-level assets its session wrote, taken from the `TURN_UPDATED_ASSETS` session events (asset id, type, name, snapshot) and joined to `v1_asset_crud` for thumbnails and publishes and to `users_193` for downloads.
- **Output profile:** each skill gets one, learned from its runs and shown in the tab row, e.g. "Makes: Logo 97% · Image 11% · Video 3%". Each type is a filter.
- **Cards** show the skill's main output type with a type badge and an "N outputs" count. Hovering plays video outputs; for other types it flips through the run's outputs. The card shape is **Auto** by default: logos and images 1:1, slides 16:9, docs 3:4, video 9:16.
- **The details panel** shows non-video outputs as a gallery: the selected output, a strip of all outputs, and pages for docs and slides.
- **Result filter:** Produced output / Tried, no output / Never tried. "Tried" means a media job, an image tool or an asset write.
- **Busy skills are sampled.** Above about 400 sessions a day, a deterministic sample is taken: sessions whose id starts with certain hex characters. The status bar shows the share. Heavy days are also split into hour windows when a query times out.
- **Stale work is cancelled.** Switching skill or window drops the old selection's queued Trino queries.

## UI

- **Grid** (virtualized). The first tab is named after the skill's main output (Videos / Logos / Slides…).
  - **Video outputs:** hovering a card plays it, with sound if S is on. Moving the mouse scrubs: the sprite frame shows instantly while the real frame seeks. Badges show the video source: Exact / Assembled / Clip / Preparing.
  - **Other outputs:** hovering flips through everything the run made, and a type badge and "N outputs" count sit on the card.
  - **Runs that tried but produced nothing** have a red top edge and show the first error. Hovering the error icon lists every failing step with its message.
  - **Signals per card:** downloaded (editor or agent), published, worst mood across turns, thumbs up/down, issues, out of credits. The user type (Real / Employee / Team) sits next to the time.
- **Filters:** faceted, each option with its count. Summary tiles double as one-click filters.
- **Remembered state:** everything is saved in localStorage and mirrored in the URL (`#v=…`), so a reload restores the view and any view can be shared as a link.
- **Inspect** (click or Enter):
  - **Video runs:** a review player with a custom scrub bar (scene segments, sprite preview, `,`/`.` frame steps, speed). **E** switches to the exact live composition: the product's own Remotion player, vendored from `wixel-video-client` by `npm run build:player`.
  - **Other runs:** an output gallery with a large view, a strip of all outputs, and pages for docs and slides. The arrow keys step through outputs.
  - **Share** in the header (see Sharing below).
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
- **Sharing.** The app runs on localhost, so its own links only open for people running Skill Runs; every share also offers links that work for anyone.
  - **A run** (Share in its header): copy the app link, the Wixel admin link (anyone with BO access), or the output's public link (exact render, published page or image). There's also a text summary and an email draft (`mailto:`). End-user emails are never included.
  - **Insights** (Share insights): copy the app link with the same filters, copy a text summary (numbers, failing tools, top errors, asks, unhappy-user quotes), email it, or **Export PDF** through the print dialog ("Save as PDF"; links stay clickable and URLs are printed).
- **Skill picker** (⌘K): searchable, with the 5 most recently viewed skills on top.
- **Time windows** are rolling (1h / 24h / 3d / … from now) rather than UTC calendar days.
- **Loading feedback:** a progress bar under the header, per-second status, and a "Trino is busy" note when queries queue.
- **Filters that don't fit a skill** are removed automatically, with a toast that says what was removed. That covers both single values that match nothing and combinations that together match nothing (the most restrictive filter goes first).
- **Error icon on a card:** hovering it lists the failing steps with their messages.
- **Keyboard:** `?` lists all shortcuts.

## Project layout

| Path | What |
|---|---|
| `server/server.js` | HTTP server: API routes, static files, media with Range support, single-instance takeover |
| `server/queries.js` | All Trino SQL: skills, runs index, per-day runs / events / steps (hour windows + sampling) |
| `server/runs.js` | Day loading, caching, sampling, per-run outputs and signals, employee detection |
| `server/admin.js` · `server/normalize.js` | Wixel admin API client; session → run record (steps, lineage, brand, asset tree) |
| `server/temporal.js` | Temporal traces → graph runs (per-node data, failed-job lookup) |
| `server/media.js` · `server/player.js` | Review videos (ffmpeg) and the live product player input |
| `server/limits.js` · `server/context.js` · `server/cache.js` · `server/cache-gc.js` | Upstream limiters and load counters, request cancellation, disk cache, size cap |
| `web/js/app.js` | Boot, loading, filters panel, summary, keyboard |
| `web/js/grid.js` · `inspect.js` · `timeline.js` · `deep.js` · `graph.js` | Grid, details panel, timeline, scenes / brand / assets / raw, graph run |
| `web/js/insights.js` · `share.js` · `skillpicker.js` · `ui.js` · `filters.js` · `state.js` | Insights, sharing, skill picker, tooltips / toasts / popovers, facets, persisted state |
| `scripts/` | `setup.sh`, `launch.sh`, `make-launcher.sh`, `make-icon.py`, `build-player.sh`, `pull-sample.js` |

## Load on production systems

Every upstream call goes through `server/limits.js`: a concurrency cap and minimum spacing per system, plus rolling counters shown live in the status bar ("Upstream, 5 min").

| System | What it is | Cap | When it's called |
|---|---|---|---|
| Trino (via the admin SQL endpoint) | shared analytics cluster, not production serving | 4 concurrent, ≥250 ms apart | list, index and step queries. A day older than 3 days is cached forever, so steady state is a few queries per 3 minutes for the last 3 days |
| Wixel admin API | production BO service reading the agent's session store | 3 concurrent, ≥150 ms apart | opening a run, hovering a card for 600 ms, assembling an ad without a render. Cached forever once the session has been idle 30 minutes |
| Temporal Cloud prod namespace | shares request limits with production workers | 2 concurrent, ≥250 ms apart | only when you open a graph run or a nodes table. Each trace is about 3–5 calls, cached forever once finished |
| Wix CDN (wixmp) | media delivery | ffmpeg, 2 builds at a time | downloading clips and renders for review copies |

## API

| Route | What | Source |
|---|---|---|
| `GET /api/skills?days=30` | skills with ≥5 sessions | Trino |
| `GET /api/runs-index?skill=…&days=…` | which UTC days have runs (plus when the skill last ran, if none) | Trino (cheap: skill calls only) |
| `GET /api/runs-day?skill=…&day=YYYY-MM-DD&n=<sessions>` | one day's runs; the UI loads these 3 at a time, newest first. `n` (from the index) turns on sampling for busy days | Trino |
| `GET /api/runs?skill=wixel-ads&days=7` | all days at once (scripts) | Trino, one query per non-empty day |
| `GET /api/session/:id` | normalized run record (`?raw=1` for the raw bundle) | admin API |
| `GET /api/trace/:workflowId` | Temporal chain + Genix graph runs with per-node data | Temporal Cloud |
| `GET /api/media/:runId?priority=1` | review-media status; queues a build if there is none | ffmpeg |
| `GET /media/:runId/review.mp4 \| poster.jpg \| sprite.jpg` | review media (Range requests supported) | local cache |
| `GET /api/trace-job/:jobId?at=<ms>` | the same trace, for a **failed** generation (only a jobId) | Temporal Cloud |
| `GET /api/media-batch?ids=a,b,…` | review-media status for the cards on screen | local |
| `GET /api/player-input/:runId?root=<assetId>` | the live product player's input, built from the asset tree | admin API |
| `GET /_api/wixel-viewer-bundle-server/bundles?…` | same-origin pass-through for the player's component bundles | manage.wix.com (public) |
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
- **Employee flag.** `prod.wt_accounts.base.mail_domain` doesn't identify employees, and scanning that table takes about 25 s. Only the Wixel team list (`sandbox.www.slides_employees_team`) is checked in the list. "Employee" status will come from the session's user email.
- **Finished ad → review media** (`server/media.js`). The source is chosen in this order:
  1. The exact render from a UI download (`events.dbo.users_193` evid 19 `asset_url`).
  2. The exact render from the agent's `download` tool (`links.wixel.com/link/<id>/raw` → `wixel-render/<id>.mp4`).
  3. Otherwise, assembled with ffmpeg from the asset tree, using wixel-video-bm's timeline rules:
     - hard cuts in `layout.order.indexInParent` order
     - each scene plays `frameDuration − trim_start − trim_end` frames at **24 fps**, starting at `trim_start`
     - voice comes only from clips with volume > 0
     - the music bed gets its trims, shift, volume and fades
     - **text overlays and captions are missing** from assembled media
  4. Otherwise, the last generated clip.

  The output is 540p H.264 with a keyframe every 12 frames (smooth scrubbing), AAC, faststart, plus a poster and a 60-frame sprite. It takes about 2–8 s per ad.
- **Signals in the list** (query v3):
  - sentiment per turn (`neutral` / `positive` / `confused` / `frustrated`)
  - thumbs up/down and their tags
  - out-of-credits and model stream errors (`v1_session_event_crud`)
  - agent downloads, UI downloads, publishes and the finished-ad thumbnail (`v1_asset_crud`)
  - employee = account missing from `prod.wt_accounts.base` (the vizion rule), cached per account
