#!/bin/sh
# Runs ON the mini. Commit (if dirty) -> typecheck gate -> build -> rollout -> health gate -> undo on failure.
set -eu
export PATH="/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
cd "$(dirname "$0")/.."

MSG="${1:-deploy}"
if [ -n "$(git status --porcelain)" ]; then
  git add -A && git commit -m "$MSG"
fi
if [ -d userspace/.git ] && [ -n "$(git -C userspace status --porcelain)" ]; then
  git -C userspace add -A && git -C userspace commit -m "$MSG"
fi
# keep the bare remote current (host-side commits don't ride the server push)
if [ -d userspace/.git ] && [ -d "$HOME/assistant-data/appspace/userspace.git" ]; then
  git -C userspace push "$HOME/assistant-data/appspace/userspace.git" HEAD:main || true
fi

pnpm install --frozen-lockfile
# gate: broken userspace server TS never reaches the pod — core tsc doesn't
# follow the codegen's `as string`-cast import, so this is the only backstop
# for the server self-mod path (Pi writes a module -> pod restart -> boot regen)
if ls userspace/features/*/server.ts >/dev/null 2>&1; then
  pnpm --filter @assistant/server exec tsc --noEmit -p ../scripts/uscheck/server.json
fi

SHA=$(git rev-parse --short HEAD)
docker build -t "assistant-server:$SHA" --build-arg "GIT_SHA=$SHA" -f server/Dockerfile .
sed "s/IMAGE_TAG/$SHA/" infra/k8s/assistant.yaml | kubectl apply -f -
# a userspace-only self-mod commit never changes $SHA (userspace is a separate
# repo), so kubectl apply alone sees an identical spec and never rolls a new
# pod — but gen-userspace.mjs only regenerates the feature registry at boot.
# Force a restart every time so a pod is always freshly booted against
# whatever's currently on disk at /repo/userspace.
kubectl -n assistant rollout restart deploy/assistant-server
if ! kubectl -n assistant rollout status deploy/assistant-server --timeout=180s; then
  echo "ROLLOUT FAILED — undoing" >&2
  kubectl -n assistant rollout undo deploy/assistant-server
  exit 1
fi
sleep 1
curl -fsS --retry 5 --retry-delay 2 http://localhost:30880/healthz
echo
echo "DEPLOYED $SHA"
