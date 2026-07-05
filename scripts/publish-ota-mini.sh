#!/bin/sh
# Runs ON the mini (via opsd). Typecheck gate -> expo export -> updates dir.
set -eu
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."

RUNTIME_VERSION="1" # keep in sync with app.config.ts
TS=$(date +%s)
DEST="$HOME/assistant-data/updates/$RUNTIME_VERSION"

pnpm install --frozen-lockfile
# gate: broken userspace/app TS never ships
pnpm --filter @assistant/app exec tsc --noEmit
(cd app && npx expo export --platform android --output-dir "/tmp/ota-$TS")

mkdir -p "$DEST"
mv "/tmp/ota-$TS" "$DEST/$TS"

# retention: keep newest 5
cd "$DEST" && ls | sort -r | tail -n +6 | xargs -I{} rm -rf {} || true

echo "PUBLISHED update $RUNTIME_VERSION/$TS"
