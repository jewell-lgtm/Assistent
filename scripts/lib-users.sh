# Sourced by per-user infra scripts. Registry = $USERS_ROOT/users.json (600):
#   {"matt":{"nodePort":30880,"opsdToken":"…","apiToken":"…"}}
# Registry is host-only state — no pod mounts it, so tokens can live here.
USERS_ROOT="${USERS_ROOT:-$HOME/assistant-users}"
USERS_JSON="$USERS_ROOT/users.json"

users_list() {
  node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).join("\n"))' "$USERS_JSON"
}

# user_field <name> <field> — exits non-zero (and prints nothing) if missing
user_field() {
  node -e '
    const u = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]
    const v = u?.[process.argv[3]]
    if (v === undefined) process.exit(1)
    console.log(v)
  ' "$USERS_JSON" "$1" "$2"
}

require_user() {
  user_field "$1" nodePort >/dev/null || { echo "unknown user: $1 (not in $USERS_JSON)" >&2; exit 1; }
}
