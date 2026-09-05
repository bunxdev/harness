#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
BUN_VERSION="1.4.1"

if ! command -v curl >/dev/null || ! command -v unzip >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl unzip
  rm -rf /var/lib/apt/lists/*
fi

if ! command -v bun >/dev/null || [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  case "$(uname -m)" in
    x86_64)
      bun_archive="bun-linux-x64"
      bun_sha256="74c1c3bee7cd998500c8f969cd8972355ac6a07207e94a39eece1999b56ffabf"
      ;;
    aarch64 | arm64)
      bun_archive="bun-linux-aarch64"
      bun_sha256="580ce77533108dc6b10bec1721397e4f5aa44e909726da2451d483dfc5e581d6"
      ;;
    *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  temp_dir="$(mktemp -d)"
  curl -fsSL \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_archive}.zip" \
    -o "$temp_dir/bun.zip"
  printf '%s  %s\n' "$bun_sha256" "$temp_dir/bun.zip" | sha256sum -c -
  unzip -q "$temp_dir/bun.zip" -d "$temp_dir"
  mkdir -p "$BUN_INSTALL/bin"
  install -m 0755 "$temp_dir/$bun_archive/bun" "$BUN_INSTALL/bin/bun"
  rm -rf "$temp_dir"
fi

ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun

bun install --cwd /scripts/proxy --frozen-lockfile
exec bun run /scripts/proxy/index.ts
