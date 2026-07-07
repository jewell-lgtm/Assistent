#!/bin/sh
# Runs ON the mini (cron/manual). Belt-and-braces for every user's userspace
# git repo: single-file `git bundle` of each bare remote, uploaded to MinIO.
# Litestream covers the sqlite dbs continuously; this covers git nightly.
# Restore: git clone userspace-<user>-<date>.bundle
set -eu
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for u in $(users_list); do
  BARE="$USERS_ROOT/$u/appspace/userspace.git"
  [ -d "$BARE" ] || { echo "$u: no bare repo yet — skipping"; continue; }
  git -C "$BARE" bundle create "$TMP/userspace.bundle" --all
  mc cp "$TMP/userspace.bundle" "assistant/assistant/userspace-bundles/userspace-$u-$(date +%Y%m%d).bundle"
  # retention: keep newest 14 per user
  mc ls assistant/assistant/userspace-bundles/ | awk '{print $NF}' | grep "^userspace-$u-" | sort -r | tail -n +15 \
    | while read -r f; do mc rm "assistant/assistant/userspace-bundles/$f"; done
  echo "backed up $u"
done
