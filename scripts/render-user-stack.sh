#!/bin/sh
# render-user-stack.sh <user> [image-tag] — rendered manifest to stdout.
# Tag defaults to $USERS_ROOT/IMAGE_TAG (written by redeploy.sh).
set -eu
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

USER_NAME="$1"
require_user "$USER_NAME"
NODE_PORT=$(user_field "$USER_NAME" nodePort)
TAG="${2:-$(cat "$USERS_ROOT/IMAGE_TAG")}"

sed \
  -e "s|__USER__|$USER_NAME|g" \
  -e "s|__NODE_PORT__|$NODE_PORT|g" \
  -e "s|__IMAGE_TAG__|$TAG|g" \
  -e "s|__USERS_ROOT__|$USERS_ROOT|g" \
  infra/k8s/user-stack.template.yaml
