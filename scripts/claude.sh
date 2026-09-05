#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.261}"
if ! command -v curl >/dev/null || ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl docker.io
  rm -rf /var/lib/apt/lists/*
fi

export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null || \
  [[ "$(claude --version 2>/dev/null)" != "$CLAUDE_CODE_VERSION (Claude Code)" ]]; then
  curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION"
fi

if [[ "$(claude --version 2>/dev/null)" != "$CLAUDE_CODE_VERSION (Claude Code)" ]]; then
  printf 'Expected Claude Code %s, got %s\n' \
    "$CLAUDE_CODE_VERSION" "$(claude --version 2>/dev/null || printf 'unavailable')" >&2
  exit 1
fi

ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude

claude --version
exec tail -f /dev/null
