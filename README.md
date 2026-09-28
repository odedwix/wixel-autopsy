# Skill Run Explorer

A fast browser for every run of a Wixel agent skill (starting with `wixel-ads`). It shows each run's videos, request, scraped brand, steps and timing, errors, and the Genix graph runs behind each generation.

Status: **phase 2**. The grid, insights and the per-run deep dive are done. The drawn Genix graph view (phase 3) is next.

Open http://localhost:5178 after `npm run proxy`. Run `npm run build:player` once for the exact live player.

## UI

- **Grid** (virtualized):
  - Hovering a card plays it, with sound if S is on. Moving the mouse scrubs: the sprite frame shows instantly while the real frame seeks.
  - Badges show the video source: Exact / Assembled / Clip / Preparing.
  - Red-topped cards are runs that generated but produced no video; the card shows the first error.
  - Signals per card: downloaded (editor or agent), published, worst mood across turns, thumbs up/down, issues, out of credits. The user type (Real / Employee / Team) sits next to the time.
- **Filters:** faceted, each option with its count. Summary tiles double as one-click filters.
- **Remembered state:** everything is saved in localStorage and mirrored in the URL (`#v=…`), so a reload restores the view and any view can be shared as a link.
- **Inspect** (click or Enter):
  - Review player with a custom scrub bar: scene segments, sprite preview, `,`/`.` frame steps, speed.
  - **E** switches to the exact live composition: the product's own Remotion player, vendored from `wixel-video-client` by `npm run build:player`.
  - Tabs (keys **1–6**; **W** widens the panel):
    - **Overview:** outcome, mood by turn, request plus follow-ups, errors, scenes, identifiers.
    - **Timeline:** a waterfall of every step, with agent thinking time on its own row and user-message markers.
      - Idle gaps between turns are compressed, and agent plumbing (read / write / list) can be hidden.
      - Hovering a bar shows a tooltip; clicking a row shows the prompt, input and output media, arguments, output and error.
      - **Trace the Genix graph run** reads Temporal (only when you click) and lists each node's status, queue time, run time, cost and root cause.
    - **Scenes:** each shot next to the chain that made it, in a Picture lane (image → edit → video → voice merge) and a Voice & sound lane (TTS script → trim), with every step's prompt, model and time.
      - The chain is traced through media ids shared between one step's output and the next step's input.
    - **Brand:** the scraped site (logo, colours, fonts, screenshot) next to what the ad's text actually used, with ✓ on matches and a verdict such as "2 of 4 site colours… 0 of 5 fonts".
    - **Assets:** every piece of media in the run, grouped as uploads / website / generated images / clips / voice & music.
    - **Raw:** the normalized record per key, plus a link to the raw admin bundle.
- **Insights** (tab, or **I**): computed in the browser from the runs in view, so they follow the skill, window, filters and search, and cost nothing upstream. Per-session step stats come from one extra Trino query per day (`stepsDayQuery`), cached like the day rows.
  - Overview: finished-video rate, request → final / first clip (median, p90), average generation call, download and publish rates, frustration, cost per finished video.
  - Tools & methods, sortable: calls, failures, fail rate, average and slowest time, runs hit. Clicking a row filters to the runs where that step failed.
  - Generation models; funnel; where the time goes; top error signatures; what users asked for (classified intent plus title subjects); most repeated prompts (many users = template, one user = retrying); mood and feedback quotes; runs per day; skill versions.
  - A headline strip above the grid summarizes the top insights, and each one links to its card.
- **Keyboard:** `?` lists all shortcuts.

## Load on production systems

Every upstream call goes through `server/limits.js`: a concurrency cap and minimum spacing per system, plus rolling counters shown live in the status bar ("Upstream, 5 min").

| System | What it is | Cap | When it's called |
|---|---|---|---|
| Trino (via the admin SQL endpoint) | shared analytics cluster, not production serving | 4 concurrent, ≥250 ms apart | list, index and step queries. A day older than 3 days is cached forever, so steady state is a few queries per 3 minutes for the last 3 days |
| Wixel admin API | production BO service reading the agent's session store | 3 concurrent, ≥150 ms apart | opening a run, hovering a card for 600 ms, assembling an ad without a render. Cached forever once the session has been idle 30 minutes |
| Temporal Cloud prod namespace | shares request limits with production workers | 2 concurrent, ≥250 ms apart | only the graph-run drill-down (phase 3). Nothing in the UI calls it yet |
| Wix CDN (wixmp) | media delivery | ffmpeg, 2 builds at a time | downloading clips and renders for review copies |

## Run

```bash
npm install          # uses Wix's npm registry (.npmrc); the public one is blocked on the Wix network
npm run proxy        # http://localhost:5178
npm run pull         # warm the cache with a 50-run sample and print a coverage report
```

You need to be on the Wix network. The admin API needs no cookie from there. The Temporal key is read from `wixel-video-server/packages/ai-video-genix-grapher/.env` (`TEMPORAL_KEY`), or from `TEMPORAL_API_KEY` / `TEMPORAL_KEY_FILE`. It is never copied into this repo, and the proxy listens only on 127.0.0.1.

## API

| Route | What | Source |
|---|---|---|
| `GET /api/skills?days=30` | skills with ≥5 sessions | Trino |
| `GET /api/runs-index?skill=…&days=…` | which UTC days have runs (plus when the skill last ran, if none) | Trino (cheap: skill calls only) |
| `GET /api/runs-day?skill=…&day=YYYY-MM-DD` | one day's runs; the UI loads these 3 at a time, newest first | Trino |
| `GET /api/runs?skill=wixel-ads&days=7` | all days at once (scripts) | Trino, one query per non-empty day |
| `GET /api/session/:id` | normalized run record (`?raw=1` for the raw bundle) | admin API |
| `GET /api/trace/:workflowId` | Temporal chain + Genix graph runs with per-node data | Temporal Cloud |
| `GET /api/media/:runId?priority=1` | review-media status; queues a build if there is none | ffmpeg |
| `GET /media/:runId/review.mp4 \| poster.jpg \| sprite.jpg` | review media (Range requests supported) | local cache |
| `GET /api/trace-job/:jobId?at=<ms>` | the same trace, for a **failed** generation (only a jobId) | Temporal Cloud |

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
