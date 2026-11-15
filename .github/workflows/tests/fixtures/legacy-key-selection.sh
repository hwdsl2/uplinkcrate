#!/bin/bash
# Test-only baseline fragments from run.sh at 8f65f80294cf9e010660300c269e12bcdedd50c5.
# Retain exact env/normalization and key-selection behavior; never use at runtime.
#
# Docker script to configure and start an MCP Gateway server
#
# DO NOT RUN THIS SCRIPT ON YOUR PC OR MAC! THIS IS ONLY MEANT TO BE RUN
# IN A CONTAINER!
#
# This file is part of UplinkCrate image, available at:
# https://github.com/hwdsl2/uplinkcrate
#
# Copyright (C) 2026 Lin Song
#
# This work is licensed under the MIT License
# See: https://opensource.org/licenses/MIT

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

exiterr()  { echo "Error: $1" >&2; exit 1; }
nospaces() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
noquotes() { printf '%s' "$1" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }

check_port() {
  printf '%s' "$1" | tr -d '\n' | grep -Eq '^[0-9]+$' \
  && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

check_ip() {
  IP_REGEX='^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$'
  printf '%s' "$1" | tr -d '\n' | grep -Eq "$IP_REGEX"
}

fetch_public_ip() {
  local ip_addr ip_url
  for ip_url in https://ipv4.icanhazip.com https://api.ipify.org; do
    ip_addr=$(curl -q -4fsS --max-time 10 "$ip_url" 2>/dev/null) || continue
    ip_addr=${ip_addr%$'\r'}
    [[ "$ip_addr" != *$'\n'* && "$ip_addr" != *$'\r'* ]] || continue
    if check_ip "$ip_addr"; then
      printf '%s' "$ip_addr"
      return 0
    fi
  done
  return 1
}

check_dns_name() {
  FQDN_REGEX='^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
  printf '%s' "$1" | tr -d '\n' | grep -Eq "$FQDN_REGEX"
}

# Source bind-mounted env file if present (takes precedence over --env-file)
if [ -f /mcp.env ]; then
  # shellcheck disable=SC1091
  . /mcp.env
fi

if [ ! -f "/.dockerenv" ] && [ ! -f "/run/.containerenv" ] \
  && [ -z "$KUBERNETES_SERVICE_HOST" ] \
  && ! head -n 1 /proc/1/sched 2>/dev/null | grep -q '^run\.sh '; then
  exiterr "This script ONLY runs in a container (e.g. Docker, Podman)."
fi

# Read and sanitize environment variables
if [[ "$MCP_API_KEY" =~ [[:cntrl:]] ]]; then
  exiterr "MCP_API_KEY must not contain control characters or multiple lines."
fi
MCP_API_KEY=$(nospaces "$MCP_API_KEY")
MCP_API_KEY=$(noquotes "$MCP_API_KEY")
MCP_PORT=$(nospaces "$MCP_PORT")
MCP_PORT=$(noquotes "$MCP_PORT")
MCP_HOST=$(nospaces "$MCP_HOST")
MCP_HOST=$(noquotes "$MCP_HOST")
MCP_SERVERS=$(nospaces "$MCP_SERVERS")
MCP_SERVERS=$(noquotes "$MCP_SERVERS")

MCP_FILESYSTEM_DIRS=$(nospaces "$MCP_FILESYSTEM_DIRS")
MCP_FILESYSTEM_DIRS=$(noquotes "$MCP_FILESYSTEM_DIRS")
MCP_GITHUB_TOKEN=$(nospaces "$MCP_GITHUB_TOKEN")
MCP_GITHUB_TOKEN=$(noquotes "$MCP_GITHUB_TOKEN")
MCP_BRAVE_API_KEY=$(nospaces "$MCP_BRAVE_API_KEY")
MCP_BRAVE_API_KEY=$(noquotes "$MCP_BRAVE_API_KEY")
MCP_POSTGRES_URL=$(nospaces "$MCP_POSTGRES_URL")
MCP_POSTGRES_URL=$(noquotes "$MCP_POSTGRES_URL")
MCP_GIT_REPO=$(nospaces "$MCP_GIT_REPO")
MCP_GIT_REPO=$(noquotes "$MCP_GIT_REPO")
MCP_ADMIN_PASSWORD=$(nospaces "$MCP_ADMIN_PASSWORD")
MCP_ADMIN_PASSWORD=$(noquotes "$MCP_ADMIN_PASSWORD")

# Apply defaults

# Generate or load API key
if [ -n "$MCP_API_KEY" ]; then
  api_key="$MCP_API_KEY"
else
  if [ -f "$API_KEY_FILE" ]; then
    node "$POLICY_CLI" validate-key < "$API_KEY_FILE" \
      || exiterr "The saved API key is invalid. Restore it before restarting; it was not changed."
    # Preserve trailing newlines so malformed stored credentials are rejected,
    # not silently trimmed into a different token.
    api_key=$(cat "$API_KEY_FILE"; printf '.')
    api_key=${api_key%.}
  else
    api_key="mcp-$(head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n' | head -c 48)"
  fi
fi

if ! printf '%s' "$api_key" | node "$POLICY_CLI" validate-key; then
  exiterr "The API key must be a nonempty single HTTP bearer token. Existing key files were not changed."
fi
(umask 077; printf '%s' "$api_key" > "$POLICY_RUNTIME/bootstrap") \
  || exiterr "Could not prepare protected bootstrap credential."

# Determine server address
