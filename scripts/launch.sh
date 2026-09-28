#!/bin/zsh
# Start (or restart) Skill Runs in the background and open it in the browser.
# The server replaces any copy already running (see server/singleton.js); output goes to .cache/app.log.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || echo /opt/homebrew/opt/node@22/bin/node)"
mkdir -p "$ROOT/.cache"
cd "$ROOT" || exit 1
nohup "$NODE" server/server.js --open >> "$ROOT/.cache/app.log" 2>&1 &
disown
