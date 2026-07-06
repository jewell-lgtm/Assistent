#!/bin/sh
# Runs ON the mini (cron/manual). Belt-and-braces for the userspace git repo:
# a single-file `git bundle` of the bare remote, uploaded to MinIO. Litestream
# covers the sqlite db continuously; this covers the git side nightly.
# Restore: git clone userspace-<date>.bundle
set -eu
export PATH="/opt/homebrew/bin:$PATH"

BARE="$HOME/assistant-data/appspace/userspace.git"
[ -d "$BARE" ] || { echo "no bare repo at $BARE yet — nothing to back up"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$BARE" bundle create "$TMP/userspace.bundle" --all
mc cp "$TMP/userspace.bundle" "assistant/assistant/userspace-bundles/userspace-$(date +%Y%m%d).bundle"
# retention: keep newest 14
mc ls assistant/assistant/userspace-bundles/ | awk '{print $NF}' | sort -r | tail -n +15 \
  | while read -r f; do mc rm "assistant/assistant/userspace-bundles/$f"; done
echo "backed up userspace bundle"
