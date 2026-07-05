#!/bin/sh
# Runs ON the mini. FAST userspace reload: commit userspace -> typecheck gate ->
# restart pod. NO docker build, NO pnpm install — userspace is hostPath-mounted
# at /repo/userspace and gen-userspace regenerates the registry at boot, so a
# userspace-only self-mod (every Pi coding run) just needs a fresh pod against
# the same image. Seconds, not the minutes a full redeploy's docker build costs.
# (Core code changes still go through redeploy.sh, which rebuilds the image.)
set -eu
export PATH="/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
cd "$(dirname "$0")/.."

MSG="${1:-reload}"
if [ -d userspace/.git ] && [ -n "$(git -C userspace status --porcelain)" ]; then
  git -C userspace add -A && git -C userspace commit -m "$MSG"
fi

# same gate the deploy path runs: broken userspace server TS never reaches the
# pod (core tsc can't see the cast dynamic import, so this is the backstop).
if ls userspace/features/*/server.ts >/dev/null 2>&1; then
  pnpm --filter @assistant/server exec tsc --noEmit -p ../scripts/uscheck/server.json
fi

kubectl -n assistant rollout restart deploy/assistant-server
if ! kubectl -n assistant rollout status deploy/assistant-server --timeout=120s; then
  echo "ROLLOUT FAILED — undoing" >&2
  kubectl -n assistant rollout undo deploy/assistant-server
  exit 1
fi
curl -fsS --retry 5 --retry-delay 2 http://localhost:30880/healthz
echo
echo "RELOADED"
