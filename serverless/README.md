# Autopsy in the cloud (Wix Serverless)

This folder runs Autopsy's shared copy as a Wix Serverless app:

- **One copy for everyone.** Every page and API call goes through the same handler as the local app (`server/app.js`).
- **Staff only.** It sits behind back-office sign-in (`boAuth`).
- **Never queries Trino for readers.** It reads the daily build from cloudStore.
- **The build runs in the cloud.** A nightly job starts a chain of Time Capsule tasks that build one skill after another (`server/build.js`). Each run stops after about 10 minutes and schedules the next, because scheduled jobs mustn't run for hours.

| | |
|---|---|
| `index.js` | The builder: web functions → `server/app.js`, the 03:30 cron, the build task chain, `GET/POST /_build` |
| `Dockerfile` | The standard serverless image; turns on `ctx.boUser` |
| `templates/sdm-app-configs.json.erb` | Secrets and settings (see below) |
| `dev-cookie.cjs` | Local dev server only: a sign-in cookie for a made-up staff user |

## Run it locally (tested)

On the Wix network, with the repo's root `npm install` done:

```bash
cd serverless
corepack yarn install          # Wix registry (.yarnrc.yml)
corepack yarn start            # http://localhost:8091/serverless/test-scope
corepack yarn dev:cookie       # paste the printed line into the console of any localhost page
```

The dev server keeps cloudStore in memory, so it starts empty. Fill it with a small build (`dev.tester@wix.com` is a build admin locally):

```js
await fetch('/serverless/test-scope/_build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 3, skills: ['headshot', 'image-upscale'] }) })
```

`GET /_build` shows its progress. Two skills over 3 days took about a minute. The dev server fires crons as it starts, so the nightly build only runs where `build-enabled` is `true` (or `AUTOPSY_BUILD_ENABLED=1`).

What was checked end to end in the local runtime:
- sign-in redirects;
- a build started over `POST /_build`, run as a Time Capsule task, querying Trino and writing chunked, gzipped values to cloudStore;
- the grid, insights and a run's detail (admin API) read back under the `/serverless/test-scope/` prefix.

## Deploying (needs people and access)

1. **Move this repo into a `wix-private` Falcon monorepo.** Serverless apps must live in one, and Falcon is the only CI. The repo-relative imports (`../server`, `../web`) mean the package needs the whole repo, not just this folder.
2. **Merge after a green Falcon build.** The Wix Serverless Slack bot then offers to **Create** the app, or you can create a Node service in Dev Portal (wix-bo.com/dev).
3. **In Dev Portal:**
   - add a **service mapping** (the back-office URL);
   - set the secret `temporal-api-key`;
   - set the settings `build-enabled=true`, `build-admins` (comma-separated emails), `build-days` (default 30) and `build-min-sessions` (default 10).
4. Start the first build from `POST /_build` as a build admin, or wait for 03:30.

## Open questions for the Wixel / Serverless teams

- **PII in cloudStore.** The docs say "PII is not supported". The build holds end users' prompts, account ids and titles. Is cloudStore allowed for that, or is there an approved store?
- **Calling the admin API from a pod.** Today `bo.wix.com/_api/wixel-agent-admin/api/...` (SQL and session details) answers from the office network or VPN without a token. A pod may need a service identity.
- **Pod limits.** The defaults are 0.2 CPU and 0.5 GB. Readers keep parsed days in memory (`SNAPSHOT_MEMORY_MB`, default 400), so set it to about a third of the pod's memory.
- **Not wired yet in the cloud:**
  - **Fleet**, which still reads `FLEET_DIR` files.
  - **Review videos, PDF reports and the exact player.** These need ffmpeg, Chrome or the player build in the image. They switch themselves off when missing, as they do locally.
