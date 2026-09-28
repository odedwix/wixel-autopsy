#!/bin/zsh
# One-time setup for a new machine: npm run setup
# Checks what's needed, installs dependencies, and reports which optional features are on.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
ok() { print -P "  %F{green}✓%f $1"; }
warn() { print -P "  %F{yellow}!%f $1"; }
bad() { print -P "  %F{red}✗%f $1"; }
FAIL=0

echo "Skill Runs setup"
echo

# 1. Node
if command -v node >/dev/null; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$NODE_MAJOR" -ge 20 ]; then ok "Node $(node -v)"; else bad "Node $(node -v) — need 20+ (brew install node@22)"; FAIL=1; fi
else
  bad "Node not found — brew install node@22"; FAIL=1
fi

# 2. Wix network (npm registry + admin API are only reachable from the office or VPN)
if curl -s -o /dev/null -m 10 -w '%{http_code}' https://npm.dev.wixpress.com/ | grep -qE '^(200|30.)$'; then ok "Wix npm registry reachable"; else bad "Can't reach npm.dev.wixpress.com — connect to the Wix VPN"; FAIL=1; fi
CODE=$(curl -s -o /dev/null -m 20 -w '%{http_code}' 'https://bo.wix.com/_api/wixel-agent-admin/api/sessions?limit=1')
if [ "$CODE" = "200" ]; then ok "Wixel admin API reachable"; else bad "Wixel admin API returned $CODE — you need the Wix network (office/VPN)"; FAIL=1; fi

[ "$FAIL" = 1 ] && { echo; echo "Fix the ✗ items above and run npm run setup again."; exit 1; }

# 3. Dependencies
echo
npm install --no-fund --no-audit --loglevel=error && ok "Dependencies installed" || { bad "npm install failed"; exit 1; }

# 4. Settings file
[ -f .env ] || { cp .env.example .env; ok "Created .env from .env.example (edit it to add optional keys)"; }

# 5. Optional pieces
echo
echo "Optional features:"
if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then ok "ffmpeg — smooth review videos + hover scrubbing"; else warn "ffmpeg missing — review videos off. Install: brew install ffmpeg"; fi
if node -e "import('./server/config.js').then(m=>process.exit(m.config.temporal.apiKey?0:1))"; then ok "Temporal key — Genix graph runs"; else warn "No Temporal key — graph runs off. Add TEMPORAL_API_KEY to .env (ask the Wixel/Genix team; it's a prod secret)"; fi
sh scripts/build-player.sh >/dev/null 2>&1
if [ -f .cache/vendor/iframe-bootstrap.js ]; then ok "Product player — exact live composition (E)"; else warn "Product player off — needs a wixel-video-client checkout (set WIXEL_VIDEO_CLIENT in .env), then npm run build:player"; fi

# 6. Desktop launcher (macOS)
if [ "$(uname)" = "Darwin" ] && command -v osacompile >/dev/null; then
  if python3 -c "import PIL" 2>/dev/null; then
    sh scripts/make-launcher.sh >/dev/null && ok "Desktop launcher: ~/Desktop/Skill Runs.app"
  else
    warn "Desktop launcher skipped (needs Python Pillow: pip3 install pillow) — use npm start"
  fi
fi

echo
echo "Done. Start it with:  npm start   (or double-click Skill Runs on your Desktop)"
