#!/bin/sh
# Runs ON the mini (via opsd). The self-mod coder: codex exec confined to
# userspace/ (workspace-write sandbox = writes only under cwd). Core is
# unreachable by design — the write-surface boundary.
set -eu
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/../userspace"
PROMPT="${1:?prompt required}"
codex exec --skip-git-repo-check -s workspace-write -C . -o /tmp/agent-code-last.md "$PROMPT"
echo "---AGENT RESULT---"
cat /tmp/agent-code-last.md
