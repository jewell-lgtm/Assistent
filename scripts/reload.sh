#!/bin/sh
# Runs ON the mini (via opsd). FAST per-user userspace reload: commit the
# user's userspace -> typecheck gate -> restart THEIR pod. No docker build, no
# pnpm install — userspace is hostPath-mounted at /repo/userspace and
# gen-userspace regenerates the registry at boot. Seconds, not minutes.
# usage: reload.sh <user> [msg]
set -eu
export PATH="/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

U="${1:?usage: reload.sh <user> [msg]}"
MSG="${2:-reload}"
require_user "$U"
NODE_PORT=$(user_field "$U" nodePort)
US="$USERS_ROOT/$U/userspace"
BARE="$USERS_ROOT/$U/appspace/userspace.git"

# Point the shared checkout's userspace at this user's tree. The uscheck
# tsconfigs hardcode ../../userspace — a symlink is the only zero-edit way to
# retarget them. Sound ONLY under opsd's single global busy lock.
ln -sfn "$US" userspace

if [ -d "$US/.git" ] && [ -n "$(git -C "$US" status --porcelain)" ]; then
  git -C "$US" add -A && git -C "$US" commit -m "$MSG"
fi
# keep the bare remote current — server-side pushes only fire on server-side
# commits, so host-side commits (this script's, redeploy's) push here
if [ -d "$US/.git" ] && [ -d "$BARE" ]; then
  git -C "$US" push "$BARE" HEAD:main || true
fi

# same gate the deploy path runs: broken userspace server TS never reaches the
# pod (core tsc can't see the cast dynamic import, so this is the backstop).
if ls userspace/features/*/server.ts >/dev/null 2>&1; then
  pnpm --filter @assistant/server exec tsc --noEmit -p ../scripts/uscheck/server.json
fi

kubectl -n "assistant-$U" rollout restart deploy/assistant-server
if ! kubectl -n "assistant-$U" rollout status deploy/assistant-server --timeout=120s; then
  echo "ROLLOUT FAILED — undoing" >&2
  kubectl -n "assistant-$U" rollout undo deploy/assistant-server
  exit 1
fi
curl -fsS --retry 5 --retry-delay 2 "http://localhost:$NODE_PORT/healthz"
echo
echo "RELOADED $U"
