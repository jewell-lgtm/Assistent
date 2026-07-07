#!/bin/sh
# Restart litestream against the generated per-user config. nohup (not
# launchd) is deliberate — BTM approval friction on this mini; accepted
# consequence: dies on reboot, restart manually or from user-add.
set -eu
export PATH="/opt/homebrew/bin:$PATH"

USERS_ROOT="${USERS_ROOT:-$HOME/assistant-users}"
SECRETS="$HOME/assistant-secrets.env"
CONFIG="$USERS_ROOT/litestream.yml"
[ -f "$SECRETS" ] || { echo "missing $SECRETS (MINIO_ROOT_USER/PASSWORD)" >&2; exit 1; }
[ -f "$CONFIG" ] || { echo "missing $CONFIG — run render-litestream.sh first" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$SECRETS"
set +a

pkill -f "litestream replicate" 2>/dev/null || true
sleep 1
LITESTREAM_ACCESS_KEY_ID="$MINIO_ROOT_USER" \
LITESTREAM_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
nohup litestream replicate -config "$CONFIG" \
  > "$HOME/assistant-data/litestream.log" 2>&1 &
echo "litestream: restarted with $CONFIG"
