#!/bin/sh
# E1 version: runs on the LAPTOP. Exports the update bundle and rsyncs it to the
# mini's updates dir. (E2 moves this onto the mini behind opsd.)
set -eu
cd "$(dirname "$0")/.."

RUNTIME_VERSION=$(node -e "import('./app/app.config.ts')" 2>/dev/null || true)
RUNTIME_VERSION="1" # keep in sync with app.config.ts runtimeVersion
TS=$(date +%s)
OUT="/tmp/assistant-ota-$TS"

pnpm --filter @assistant/app exec tsc --noEmit
(cd app && npx expo export --platform android --output-dir "$OUT")

ssh mattisfrommars@mattmini.local "mkdir -p ~/assistant-data/updates/$RUNTIME_VERSION"
rsync -a "$OUT/" "mattisfrommars@mattmini.local:assistant-data/updates/$RUNTIME_VERSION/$TS/"
rm -rf "$OUT"

# retention: keep newest 5
ssh mattisfrommars@mattmini.local "cd ~/assistant-data/updates/$RUNTIME_VERSION && ls | sort | head -n -5 | xargs -I{} rm -rf {}" || true

echo "PUBLISHED update $RUNTIME_VERSION/$TS"
