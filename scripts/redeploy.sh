#!/bin/sh
# Runs ON the mini (via opsd, ADMIN-ONLY). CORE redeploy: commit core (if
# dirty) -> build image once -> roll EVERY user's pod against it. Per-user
# userspace commits ride reload.sh, not this. One broken user must not block
# the rest: gate/roll failures are collected, exit non-zero if any.
# usage: redeploy.sh [msg]
set -eu
export PATH="/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

MSG="${1:-deploy}"
if [ -n "$(git status --porcelain)" ]; then
  git add -A && git commit -m "$MSG"
fi

pnpm install --frozen-lockfile

SHA=$(git rev-parse --short HEAD)
docker build -t "assistant-server:$SHA" --build-arg "GIT_SHA=$SHA" -f server/Dockerfile .
echo "$SHA" > "$USERS_ROOT/IMAGE_TAG" # user-add renders new stacks from this

FAILED=""
for u in $(users_list); do
  echo "--- rolling $u ---"
  ln -sfn "$USERS_ROOT/$u/userspace" userspace
  # gate: broken userspace server TS never reaches the pod (see reload.sh)
  if ls userspace/features/*/server.ts >/dev/null 2>&1 \
    && ! pnpm --filter @assistant/server exec tsc --noEmit -p ../scripts/uscheck/server.json; then
    echo "GATE FAILED for $u — not rolling their pod" >&2
    FAILED="$FAILED $u(gate)"
    continue
  fi
  scripts/render-user-stack.sh "$u" "$SHA" | kubectl apply -f -
  # a userspace-only change never alters $SHA, so apply alone can no-op —
  # force a restart so every pod boots freshly against its mounted userspace
  kubectl -n "assistant-$u" rollout restart deploy/assistant-server
  if ! kubectl -n "assistant-$u" rollout status deploy/assistant-server --timeout=180s; then
    echo "ROLLOUT FAILED for $u — undoing" >&2
    kubectl -n "assistant-$u" rollout undo deploy/assistant-server
    FAILED="$FAILED $u(rollout)"
    continue
  fi
  sleep 1
  curl -fsS --retry 5 --retry-delay 2 "http://localhost:$(user_field "$u" nodePort)/healthz" || FAILED="$FAILED $u(healthz)"
  echo
done

[ -z "$FAILED" ] || { echo "DEPLOY $SHA FINISHED WITH FAILURES:$FAILED" >&2; exit 1; }
echo "DEPLOYED $SHA to all users"
