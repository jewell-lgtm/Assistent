#!/bin/sh
# Runs ON the mini, once, by a human. Self-hosted S3 (MinIO in an OrbStack
# docker container, LAN/localhost only) + litestream continuously replicating
# the appspace sqlite db into it. Idempotent: safe to re-run.
#
# Secrets: put MINIO_ROOT_USER / MINIO_ROOT_PASSWORD in
# ~/assistant-secrets.env first (chmod 600). Litestream reuses them.
set -eu
export PATH="/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"

SECRETS="$HOME/assistant-secrets.env"
DATA="$HOME/assistant-data"
[ -f "$SECRETS" ] || { echo "create $SECRETS with MINIO_ROOT_USER + MINIO_ROOT_PASSWORD first" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$SECRETS"; set +a

# ---- MinIO container (data on the host, port 9000 loopback+LAN) -----------
mkdir -p "$DATA/minio"
if ! docker ps --format '{{.Names}}' | grep -q '^assistant-minio$'; then
  docker rm -f assistant-minio 2>/dev/null || true
  docker run -d --name assistant-minio --restart unless-stopped \
    -p 9000:9000 -p 9001:9001 \
    -e MINIO_ROOT_USER="$MINIO_ROOT_USER" \
    -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
    -v "$DATA/minio:/data" \
    minio/minio server /data --console-address ":9001"
  echo "minio: started"
else
  echo "minio: already running"
fi

# ---- bucket ----------------------------------------------------------------
command -v mc >/dev/null || brew install minio-mc
mc alias set assistant http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing assistant/assistant

# ---- litestream ------------------------------------------------------------
command -v litestream >/dev/null || brew install litestream
mkdir -p "$DATA/appspace"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# litestream reads creds from env; run detached like opsd (launchd needs BTM
# approval on this mini — see plan.md E2 findings — so nohup is the pattern)
if ! pgrep -f "litestream replicate" >/dev/null; then
  LITESTREAM_ACCESS_KEY_ID="$MINIO_ROOT_USER" \
  LITESTREAM_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
  nohup litestream replicate -config "$REPO_DIR/infra/minio/litestream.yml" \
    > "$DATA/litestream.log" 2>&1 &
  echo "litestream: started (log: $DATA/litestream.log)"
else
  echo "litestream: already running"
fi

echo "OK — verify with: mc ls assistant/assistant/appspace-db/"
