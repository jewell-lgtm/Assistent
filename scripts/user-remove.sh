#!/bin/sh
# Runs ON the mini, by the admin. Tears down a user's stack. ARCHIVES the data
# dir (never purges — pi-agent holds oauth tokens, appspace holds their db).
# usage: user-remove.sh <name>
set -eu
export PATH="/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

U="${1:?usage: user-remove.sh <name>}"
require_user "$U"

kubectl delete namespace "assistant-$U" --ignore-not-found

node -e '
  const fs = require("fs")
  const [file, u] = process.argv.slice(1)
  const users = JSON.parse(fs.readFileSync(file, "utf8"))
  delete users[u]
  fs.writeFileSync(file + ".tmp", JSON.stringify(users, null, 2))
  fs.renameSync(file + ".tmp", file)
' "$USERS_JSON" "$U"
chmod 600 "$USERS_JSON"

scripts/render-caddy-users.sh > "$USERS_ROOT/caddy-users.caddy"
if [ -n "${CADDY_SSH:-}" ]; then
  scp "$USERS_ROOT/caddy-users.caddy" "$CADDY_SSH:/etc/caddy/caddy-users.caddy"
  ssh "$CADDY_SSH" "sudo systemctl reload caddy"
else
  echo "caddy: CADDY_SSH unset — push $USERS_ROOT/caddy-users.caddy to the VPS manually"
fi
scripts/render-litestream.sh > "$USERS_ROOT/litestream.yml"
scripts/restart-litestream.sh || echo "litestream: restart failed — run scripts/restart-litestream.sh manually" >&2

mkdir -p "$USERS_ROOT/.archive"
DEST="$USERS_ROOT/.archive/$U-$(date +%Y%m%d%H%M%S)"
mv "$USERS_ROOT/$U" "$DEST"
chmod 700 "$DEST"
echo "REMOVED $U (data archived at $DEST)"
