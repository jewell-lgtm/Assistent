#!/bin/sh
# Emit per-user Caddy vhosts to stdout (written to $USERS_ROOT/caddy-users.caddy
# and scp'd to the VPS by user-add/remove; VPS Caddyfile needs a one-time
# `import /etc/caddy/caddy-users.caddy`). flush_interval -1: never buffer SSE.
set -eu
cd "$(dirname "$0")/.."
. scripts/lib-users.sh

DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-assistant.wire.mattjewell.co.uk}"
WG_MINI_IP="${WG_MINI_IP:-10.100.0.2}"

for u in $(users_list); do
  port=$(user_field "$u" nodePort)
  cat <<EOF
$u.$DOMAIN_SUFFIX {
	reverse_proxy $WG_MINI_IP:$port {
		flush_interval -1
	}
}
EOF
done
