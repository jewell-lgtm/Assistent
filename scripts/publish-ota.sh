#!/bin/sh
# LAPTOP variant: export the update bundle and rsync it to a USER's updates
# dir on the mini. (The normal path is publish-ota-mini.sh via opsd.)
# usage: publish-ota.sh <user>
set -eu
cd "$(dirname "$0")/.."

U="${1:?usage: publish-ota.sh <user>}"
RUNTIME_VERSION="1" # keep in sync with app.config.ts runtimeVersion
TS=$(date +%s)
OUT="/tmp/assistant-ota-$TS"
MINI="mattisfrommars@mattmini.local"

node scripts/gen-userspace.mjs
pnpm --filter @assistant/app exec tsc --noEmit
if ls userspace/features/*/app.tsx >/dev/null 2>&1; then
  pnpm --filter @assistant/app exec tsc --noEmit -p ../scripts/uscheck/app.json
fi
if ls userspace/features/*/server.ts >/dev/null 2>&1; then
  pnpm --filter @assistant/server exec tsc --noEmit -p ../scripts/uscheck/server.json
fi
(cd app && npx expo export --platform android --clear --output-dir "$OUT")
# OTA manifest serves this as extra.expoClient (Constants.expoConfig on device)
(cd app && npx expo config --json --type public > "$OUT/expoConfig.json")

ssh "$MINI" "mkdir -p ~/assistant-users/$U/updates/$RUNTIME_VERSION"
rsync -a "$OUT/" "$MINI:assistant-users/$U/updates/$RUNTIME_VERSION/$TS/"
rm -rf "$OUT"

# retention: keep newest 5
ssh "$MINI" "cd ~/assistant-users/$U/updates/$RUNTIME_VERSION && ls | sort -r | tail -n +6 | xargs -I{} rm -rf {}" || true

echo "PUBLISHED $U update $RUNTIME_VERSION/$TS"
