#!/bin/sh
# ONE-SHOT migration runbook: turn the legacy single-tenant stack into user
# "matt" under the per-user layout. Runs ON the mini, by a human, AFTER the
# per-user scripts + opsd v2 have been rsync'd over. ~5 min downtime.
# Fresh tokens — install the generic APK and re-pair the phone afterwards.
set -eu
export PATH="/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

if [ -f "$USERS_JSON" ] && user_field matt nodePort >/dev/null 2>&1; then
  echo "matt already migrated?" >&2
  exit 1
fi
kubectl -n assistant get deploy assistant-server >/dev/null || { echo "no legacy stack found" >&2; exit 1; }

echo "== capturing legacy state"
TAG=$(kubectl -n assistant get deploy assistant-server -o jsonpath='{.spec.template.spec.containers[0].image}' | cut -d: -f2)
API_TOKEN=$(openssl rand -hex 24)
OPSD_TOKEN=$(openssl rand -hex 24)

echo "== stopping writers (litestream, pod)"
pkill -f "litestream replicate" 2>/dev/null || true
kubectl -n assistant scale deploy/assistant-server --replicas=0
kubectl -n assistant wait --for=delete pod -l app=assistant-server --timeout=120s || true

echo "== moving data into the per-user layout"
mkdir -p "$USERS_ROOT"
mv "$HOME/assistant-data/appspace" "$USERS_ROOT/matt-appspace-tmp"
mv "$HOME/assistant-data/updates" "$USERS_ROOT/matt-updates-tmp"
mkdir -p "$USERS_ROOT/matt"
mv "$USERS_ROOT/matt-appspace-tmp" "$USERS_ROOT/matt/appspace"
mv "$USERS_ROOT/matt-updates-tmp" "$USERS_ROOT/matt/updates"
mv "$HOME/.pi/agent" "$USERS_ROOT/matt/pi-agent"
ln -s "$USERS_ROOT/matt/pi-agent" "$HOME/.pi/agent" # host-side `pi` keeps working
# the checkout's userspace becomes matt's; leave a symlink for the swap dance
mv "$HOME/assistant/userspace" "$USERS_ROOT/matt/userspace"
ln -sfn "$USERS_ROOT/matt/userspace" "$HOME/assistant/userspace"

echo "== writing registry + IMAGE_TAG"
[ -f "$USERS_JSON" ] || { echo '{}' > "$USERS_JSON"; chmod 600 "$USERS_JSON"; }
node -e '
  const fs = require("fs")
  const [file, apiToken, opsdToken] = process.argv.slice(1)
  const users = JSON.parse(fs.readFileSync(file, "utf8"))
  users.matt = { nodePort: 30880, apiToken, opsdToken }
  fs.writeFileSync(file + ".tmp", JSON.stringify(users, null, 2))
  fs.renameSync(file + ".tmp", file)
' "$USERS_JSON" "$API_TOKEN" "$OPSD_TOKEN"
chmod 600 "$USERS_JSON"
echo "$TAG" > "$USERS_ROOT/IMAGE_TAG"

echo "== deleting legacy namespace (frees 30880), creating assistant-matt"
kubectl delete namespace assistant
kubectl create namespace assistant-matt --dry-run=client -o yaml | kubectl apply -f -
kubectl -n assistant-matt create secret generic assistant-secrets \
  --from-literal=API_TOKEN="$API_TOKEN" --from-literal=OPSD_TOKEN="$OPSD_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
scripts/render-user-stack.sh matt | kubectl apply -f -
kubectl -n assistant-matt rollout status deploy/assistant-server --timeout=180s
curl -fsS --retry 10 --retry-delay 3 http://localhost:30880/healthz
echo

echo "== opsd v2"
cp infra/opsd/opsd.mjs "$HOME/opsd/opsd.mjs"
launchctl kickstart -k "gui/$(id -u)/uk.mattjewell.assistant-opsd"

echo "== regenerating litestream + caddy"
scripts/render-litestream.sh > "$USERS_ROOT/litestream.yml"
scripts/restart-litestream.sh
scripts/render-caddy-users.sh > "$USERS_ROOT/caddy-users.caddy"
if [ -n "${CADDY_SSH:-}" ]; then
  scp "$USERS_ROOT/caddy-users.caddy" "$CADDY_SSH:/etc/caddy/caddy-users.caddy"
  ssh "$CADDY_SSH" "sudo systemctl reload caddy"
else
  echo "caddy: CADDY_SSH unset — push $USERS_ROOT/caddy-users.caddy manually"
fi

echo
echo "MIGRATED. Install the generic APK and pair with:"
printf '{"v":1,"u":"https://matt.%s","t":"%s","n":"matt"}\n' "${DOMAIN_SUFFIX:-assistant.wire.mattjewell.co.uk}" "$API_TOKEN"
echo "Then verify: a self-mod task publishes into $USERS_ROOT/matt/updates/1/<ts> and reloads assistant-matt."
