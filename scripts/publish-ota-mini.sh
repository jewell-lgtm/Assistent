#!/bin/sh
# Runs ON the mini (via opsd). Per-user OTA publish: typecheck gate -> expo
# export against the USER's userspace -> their updates dir.
# usage: publish-ota-mini.sh <user> [msg]
set -eu
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

U="${1:?usage: publish-ota-mini.sh <user> [msg]}"
require_user "$U"

RUNTIME_VERSION="1" # keep in sync with app.config.ts
TS=$(date +%s)
DEST="$USERS_ROOT/$U/updates/$RUNTIME_VERSION"

# Retarget the shared checkout's userspace (gen-userspace scans it, metro
# watches ../userspace). Sound ONLY under opsd's single global busy lock.
ln -sfn "$USERS_ROOT/$U/userspace" userspace

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
# --clear: same path serves DIFFERENT users' trees between runs — never trust
# a bundler cache keyed on the swapped path
(cd app && npx expo export --platform android --clear --output-dir "/tmp/ota-$TS")
# OTA manifest serves this as extra.expoClient (Constants.expoConfig on device)
(cd app && npx expo config --json --type public > "/tmp/ota-$TS/expoConfig.json")

mkdir -p "$DEST"
mv "/tmp/ota-$TS" "$DEST/$TS"

# retention: keep newest 5
cd "$DEST" && ls | sort -r | tail -n +6 | xargs -I{} rm -rf {} || true

echo "PUBLISHED $U update $RUNTIME_VERSION/$TS"
