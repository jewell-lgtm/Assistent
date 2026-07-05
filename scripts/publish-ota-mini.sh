#!/bin/sh
# Runs ON the mini (via opsd). Typecheck gate -> expo export -> updates dir.
set -eu
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."

RUNTIME_VERSION="1" # keep in sync with app.config.ts
TS=$(date +%s)
DEST="$HOME/assistant-data/updates/$RUNTIME_VERSION"

# apiToken flows into extra.expoClient via `expo config` below
[ -f .DONOTCOMMIT/secrets.env ] && . ./.DONOTCOMMIT/secrets.env

pnpm install --frozen-lockfile
node scripts/gen-userspace.mjs
# gate: broken userspace/app TS never ships (core tsconfig skips userspace →
# scripts/uscheck/*.json typecheck it explicitly)
pnpm --filter @assistant/app exec tsc --noEmit
if ls userspace/features/*/app.tsx >/dev/null 2>&1; then
  pnpm --filter @assistant/app exec tsc --noEmit -p ../scripts/uscheck/app.json
fi
if ls userspace/features/*/server.ts >/dev/null 2>&1; then
  pnpm --filter @assistant/server exec tsc --noEmit -p ../scripts/uscheck/server.json
fi
(cd app && npx expo export --platform android --output-dir "/tmp/ota-$TS")
# OTA manifest serves this as extra.expoClient (Constants.expoConfig on device)
(cd app && npx expo config --json --type public > "/tmp/ota-$TS/expoConfig.json")

mkdir -p "$DEST"
mv "/tmp/ota-$TS" "$DEST/$TS"

# retention: keep newest 5
cd "$DEST" && ls | sort -r | tail -n +6 | xargs -I{} rm -rf {} || true

echo "PUBLISHED update $RUNTIME_VERSION/$TS"
