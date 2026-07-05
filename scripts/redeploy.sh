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
if ! kubectl -n assistant rollout status deploy/assistant-server --timeout=180s; then
  echo "ROLLOUT FAILED — undoing" >&2
  kubectl -n assistant rollout undo deploy/assistant-server
  exit 1
fi
sleep 1
curl -fsS --retry 5 --retry-delay 2 http://localhost:30880/healthz
echo
echo "DEPLOYED $SHA"
