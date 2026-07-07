#!/bin/sh
# Runs ON the mini, by the admin. Provisions a full dedicated stack for one
# user: host dirs, bare git remote, tokens, k8s ns+secret+deployment, Caddy
# vhost, litestream entry, initial OTA bundle, pairing payload (QR).
# Requires a prior redeploy.sh (needs $USERS_ROOT/IMAGE_TAG). Do NOT run while
# opsd is busy — this script builds in the shared checkout like opsd does.
# usage: user-add.sh <name>
set -eu
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

U="${1:?usage: user-add.sh <name>}"
echo "$U" | grep -Eq '^[a-z0-9-]{1,20}$' || { echo "name must match [a-z0-9-]{1,20}" >&2; exit 1; }
DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-assistant.wire.mattjewell.co.uk}"

mkdir -p "$USERS_ROOT"
[ -f "$USERS_JSON" ] || { echo '{}' > "$USERS_JSON"; chmod 600 "$USERS_JSON"; }
if user_field "$U" nodePort >/dev/null 2>&1; then echo "user $U already exists" >&2; exit 1; fi
[ -f "$USERS_ROOT/IMAGE_TAG" ] || { echo "no $USERS_ROOT/IMAGE_TAG — run scripts/redeploy.sh once first" >&2; exit 1; }

# ---- host dirs + bare remote (pod bootstrap builds the checkout/skeleton) --
mkdir -p "$USERS_ROOT/$U/appspace" "$USERS_ROOT/$U/updates" "$USERS_ROOT/$U/pi-agent" "$USERS_ROOT/$U/userspace"
[ -d "$USERS_ROOT/$U/appspace/userspace.git" ] || git init --bare -b main "$USERS_ROOT/$U/appspace/userspace.git"

# ---- tokens + nodePort -> registry (single allocator; tmp+mv, stays 600) ---
API_TOKEN=$(openssl rand -hex 24)
OPSD_TOKEN=$(openssl rand -hex 24)
node -e '
  const fs = require("fs")
  const [file, u, apiToken, opsdToken] = process.argv.slice(1)
  const users = JSON.parse(fs.readFileSync(file, "utf8"))
  const nodePort = Math.max(30879, ...Object.values(users).map((c) => c.nodePort)) + 1
  users[u] = { nodePort, apiToken, opsdToken }
  fs.writeFileSync(file + ".tmp", JSON.stringify(users, null, 2))
  fs.renameSync(file + ".tmp", file)
  console.log(nodePort)
' "$USERS_JSON" "$U" "$API_TOKEN" "$OPSD_TOKEN" > /dev/null
chmod 600 "$USERS_JSON"
NODE_PORT=$(user_field "$U" nodePort)

# ---- k8s: ns + secret + stack ----------------------------------------------
kubectl create namespace "assistant-$U" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "assistant-$U" create secret generic assistant-secrets \
  --from-literal=API_TOKEN="$API_TOKEN" --from-literal=OPSD_TOKEN="$OPSD_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
scripts/render-user-stack.sh "$U" | kubectl apply -f -
kubectl -n "assistant-$U" rollout status deploy/assistant-server --timeout=180s
curl -fsS --retry 5 --retry-delay 2 "http://localhost:$NODE_PORT/healthz"
echo

# ---- edge: regenerate the per-user vhosts, push to the VPS if we can -------
scripts/render-caddy-users.sh > "$USERS_ROOT/caddy-users.caddy"
if [ -n "${CADDY_SSH:-}" ]; then
  scp "$USERS_ROOT/caddy-users.caddy" "$CADDY_SSH:/etc/caddy/caddy-users.caddy"
  ssh "$CADDY_SSH" "sudo systemctl reload caddy"
  echo "caddy: pushed + reloaded via $CADDY_SSH"
else
  echo "caddy: CADDY_SSH unset — copy $USERS_ROOT/caddy-users.caddy to the VPS at /etc/caddy/caddy-users.caddy and reload caddy"
  echo "       (one-time: add 'import /etc/caddy/caddy-users.caddy' to the Caddyfile)"
fi

# ---- backups: litestream entry for the new db -------------------------------
scripts/render-litestream.sh > "$USERS_ROOT/litestream.yml"
scripts/restart-litestream.sh || echo "litestream: restart failed — run scripts/restart-litestream.sh manually" >&2

# ---- initial OTA bundle (a freshly paired phone must find an update) --------
sh scripts/publish-ota-mini.sh "$U" "initial publish for $U"

# ---- BYO coding-agent creds (manual by design: oauth is interactive) --------
if [ ! -f "$USERS_ROOT/$U/pi-agent/auth.json" ]; then
  echo
  echo "PI AUTH MISSING — with $U present, run:"
  echo "  PI_CODING_AGENT_DIR=$USERS_ROOT/$U/pi-agent pi login"
  echo "(read at session creation — no pod restart needed afterwards)"
fi

# ---- pairing payload ---------------------------------------------------------
PAYLOAD=$(printf '{"v":1,"u":"https://%s.%s","t":"%s","n":"%s"}' "$U" "$DOMAIN_SUFFIX" "$API_TOKEN" "$U")
echo
echo "PAIRING PAYLOAD (paste into the app's pairing screen):"
echo "$PAYLOAD"
command -v qrencode >/dev/null && qrencode -t ansiutf8 "$PAYLOAD" || true
echo
echo "PROVISIONED $U on nodePort $NODE_PORT (https://$U.$DOMAIN_SUFFIX)"
