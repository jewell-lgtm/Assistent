#!/bin/sh
# E1 version: runs on the LAPTOP. Exports the update bundle and rsyncs it to the
# mini's updates dir. (E2 moves this onto the mini behind opsd.)
set -eu
cd "$(dirname "$0")/.."

RUNTIME_VERSION="1" # keep in sync with app.config.ts runtimeVersion
TS=$(date +%s)
OUT="/tmp/assistant-ota-$TS"

# apiToken flows into extra.expoClient via `expo config` below — set -a so
# plain KEY=value lines get exported to the expo child process, not just this shell
set -a
[ -f .DONOTCOMMIT/secrets.env ] && . ./.DONOTCOMMIT/secrets.env
set +a

node scripts/gen-userspace.mjs
pnpm --filter @assistant/app exec tsc --noEmit
if ls userspace/features/*/app.tsx >/dev/null 2>&1; then
  pnpm --filter @assistant/app exec tsc --noEmit -p ../scripts/uscheck/app.json
fi
if ls userspace/features/*/server.ts >/dev/null 2>&1; then
  pnpm --filter @assistant/server exec tsc --noEmit -p ../scripts/uscheck/server.json
fi
(cd app && npx expo export --platform android --output-dir "$OUT")
# OTA manifest serves this as extra.expoClient (Constants.expoConfig on device)
(cd app && npx expo config --json --type public > "$OUT/expoConfig.json")

ssh mattisfrommars@mattmini.local "mkdir -p ~/assistant-data/updates/$RUNTIME_VERSION"
rsync -a "$OUT/" "mattisfrommars@mattmini.local:assistant-data/updates/$RUNTIME_VERSION/$TS/"
rm -rf "$OUT"

# retention: keep newest 5
ssh mattisfrommars@mattmini.local "cd ~/assistant-data/updates/$RUNTIME_VERSION && ls | sort -r | tail -n +6 | xargs -I{} rm -rf {}" || true

echo "PUBLISHED update $RUNTIME_VERSION/$TS"
