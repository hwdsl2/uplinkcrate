#!/bin/bash
#
# Docker script to configure and start an MCP Gateway server
#
# DO NOT RUN THIS SCRIPT ON YOUR PC OR MAC! THIS IS ONLY MEANT TO BE RUN
# IN A CONTAINER!
#
# This file is part of UplinkCrate image, available at:
# https://github.com/hwdsl2/uplinkcrate
#
# Copyright (C) 2026 Lin Song <linsongui@gmail.com>
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
[ -z "$MCP_PORT" ] && MCP_PORT=3000

# Internal port for MCPHub (Caddy proxies the user-facing port to this)
MCP_INTERNAL_PORT=3001

# Validate port
if ! check_port "$MCP_PORT"; then
  exiterr "MCP_PORT must be an integer between 1 and 65535."
fi

if [ "$MCP_PORT" = "$MCP_INTERNAL_PORT" ]; then
  exiterr "Port $MCP_INTERNAL_PORT is reserved for internal use. Please choose a different MCP_PORT."
fi

# Validate server hostname/IP
if [ -n "$MCP_HOST" ]; then
  if ! check_dns_name "$MCP_HOST" && ! check_ip "$MCP_HOST"; then
    exiterr "MCP_HOST '$MCP_HOST' is not a valid hostname or IP address."
  fi
fi

# Ensure data directory exists
DATA_DIR="/var/lib/mcp"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

API_KEY_FILE="${DATA_DIR}/.api_key"
PORT_FILE="${DATA_DIR}/.port"
INITIALIZED_MARKER="${DATA_DIR}/.initialized"
MCPHUB_CONFIG="${DATA_DIR}/mcp_settings.json"
MCPHUB_CONFIG_GENERATOR="/opt/src/mcp-config.cjs"
USAGE_STATE_DIR="${DATA_DIR}/.mcp-usage"
USAGE_BASE_URL=${MCP_USAGE_BASE_URL:-https://github.com/hwdsl2/ai-stack-extras/releases/download/v1.0.0}
data_mounted=false
data_existing=false

if grep -q " ${DATA_DIR} " /proc/mounts 2>/dev/null; then
  data_mounted=true
fi
if $data_mounted && find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .; then
  data_existing=true
fi

usage_arch() {
  local arch
  arch=$(uname -m 2>/dev/null || printf 'unknown')
  case "$arch" in
    x86_64|amd64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) printf 'other' ;;
  esac
}

write_usage_state() {
  local state_file version tmp_file
  state_file=$1
  version=$2
  mkdir -p "$USAGE_STATE_DIR"
  tmp_file=$(mktemp "$USAGE_STATE_DIR/.usage.XXXXXX")
  printf '%s\n' "$version" > "$tmp_file"
  chmod 0644 "$tmp_file" 2>/dev/null || true
  mv "$tmp_file" "$state_file"
}

fetch_usage_asset() {
  local asset base_url
  asset=$1
  base_url=${USAGE_BASE_URL%/}
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 5 -o /dev/null "$base_url/$asset" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 5 -O /dev/null "$base_url/$asset" >/dev/null 2>&1
  else
    return 1
  fi
}

read_state_value() {
  [ -r "$1" ] || return 0
  tr -d '[:space:]' < "$1"
}

report_usage_counts() {
  local current_version arch state_file last_version action

  [ "${MCP_DISABLE_USAGE_COUNTS:-0}" != "1" ] || return 0
  $data_mounted || return 0

  current_version="${IMAGE_FLAVOR:-unknown}-${IMAGE_VER:-unknown}"
  arch=$(usage_arch)

  state_file="$USAGE_STATE_DIR/mcp.version"
  last_version=$(read_state_value "$state_file")
  action=

  if [ -z "$last_version" ]; then
    if $data_existing; then
      action=upgrade
    else
      action=deploy
    fi
  elif [ "$last_version" != "$current_version" ]; then
    action=upgrade
  fi

  if [ -n "$action" ]; then
    if fetch_usage_asset "cu-v1-mcp-$action-cpu-$arch"; then
      write_usage_state "$state_file" "$current_version"
    fi
  fi
}

# Generate or load API key
if [ -n "$MCP_API_KEY" ]; then
  api_key="$MCP_API_KEY"
  printf '%s' "$api_key" > "$API_KEY_FILE"
  chmod 600 "$API_KEY_FILE"
else
  if [ -f "$API_KEY_FILE" ]; then
    api_key=$(cat "$API_KEY_FILE")
  else
    api_key="mcp-$(head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n' | head -c 48)"
    printf '%s' "$api_key" > "$API_KEY_FILE"
    chmod 600 "$API_KEY_FILE"
  fi
fi

# Save port for use by mcp_manage
printf '%s' "$MCP_PORT" > "$PORT_FILE"

# Determine server address for display
if [ -n "$MCP_HOST" ]; then
  server_addr="$MCP_HOST"
else
  public_ip=$(fetch_public_ip) || public_ip=""
  if check_ip "$public_ip"; then
    server_addr="$public_ip"
  else
    server_addr="<server ip>"
  fi
fi

echo
echo "UplinkCrate - https://github.com/hwdsl2/uplinkcrate"

if ! grep -q " /var/lib/mcp " /proc/mounts 2>/dev/null; then
  echo
  echo "Note: /var/lib/mcp is not mounted. Configuration and the API key"
  echo "      will be lost on container removal."
  echo "      Mount a Docker volume at /var/lib/mcp to persist data."
fi

# Detect first run
first_run=false
[ ! -f "$INITIALIZED_MARKER" ] && first_run=true

if $first_run; then
  echo
  echo "Starting UplinkCrate first-run setup..."
  echo "Port: $MCP_PORT"
  echo
fi

# -----------------------------------------------------------------------
# Generate MCPHub mcp_settings.json from environment variables
# -----------------------------------------------------------------------

generate_mcphub_config() {
  local tmp_config

  [ -x "$MCPHUB_CONFIG_GENERATOR" ] || exiterr "MCPHub config generator not found."
  tmp_config=$(mktemp "${MCPHUB_CONFIG}.XXXXXX") || exiterr "Could not create temporary MCPHub config."

  if ! MCP_SERVERS="$MCP_SERVERS" \
       MCP_FILESYSTEM_DIRS="$MCP_FILESYSTEM_DIRS" \
       MCP_GITHUB_TOKEN="$MCP_GITHUB_TOKEN" \
       MCP_BRAVE_API_KEY="$MCP_BRAVE_API_KEY" \
       MCP_GIT_REPO="$MCP_GIT_REPO" \
       MCP_POSTGRES_URL="$MCP_POSTGRES_URL" \
       node "$MCPHUB_CONFIG_GENERATOR" > "$tmp_config"; then
    rm -f "$tmp_config"
    exiterr "Failed to generate MCPHub config."
  fi

  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));' "$tmp_config"; then
    rm -f "$tmp_config"
    exiterr "Generated MCPHub config is not valid JSON."
  fi

  chmod 600 "$tmp_config" || {
    rm -f "$tmp_config"
    exiterr "Could not secure generated MCPHub config."
  }
  mv -f "$tmp_config" "$MCPHUB_CONFIG" || {
    rm -f "$tmp_config"
    exiterr "Could not install generated MCPHub config."
  }
}

# Only generate config when it does not already exist.
# On subsequent starts MCPHub reloads the existing file, which preserves
# properly bcrypt-hashed user passwords written by MCPHub on first run.
# To apply a new MCP_SERVERS list, remove /var/lib/mcp/mcp_settings.json.
if [ ! -f "$MCPHUB_CONFIG" ]; then
  generate_mcphub_config
fi

# Save enabled servers list for manage.sh
if [ -n "$MCP_SERVERS" ]; then
  printf '%s' "$MCP_SERVERS" > "/var/lib/mcp/.servers"
else
  printf '%s' "fetch" > "/var/lib/mcp/.servers"
fi

if $first_run; then
  touch "$INITIALIZED_MARKER"
fi

# Graceful shutdown handler
cleanup() {
  echo
  echo "Stopping UplinkCrate..."
  kill "${CADDY_PID:-}" 2>/dev/null
  kill "${MCPHUB_PID:-}" 2>/dev/null
  wait "${CADDY_PID:-}" 2>/dev/null
  wait "${MCPHUB_PID:-}" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# Start MCPHub (always bound to localhost on internal port)
export PORT="$MCP_INTERNAL_PORT"
export NODE_ENV="production"
export MCPHUB_SETTING_PATH="$MCPHUB_CONFIG"
# Pass admin password to MCPHub's initializeDefaultUser (used on first run only)
[ -n "$MCP_ADMIN_PASSWORD" ] && export ADMIN_PASSWORD="$MCP_ADMIN_PASSWORD"

# MCPHub expects to run from /app
cd /app || exiterr "MCPHub app directory /app not found."

echo "Starting MCPHub server..."
node dist/index.js &
MCPHUB_PID=$!

# Wait for MCPHub to become ready (up to 30 seconds)
wait_for_mcphub() {
  local i=0
  while [ "$i" -lt 30 ]; do
    if ! kill -0 "$MCPHUB_PID" 2>/dev/null; then
      return 1
    fi
    if curl -sf "http://127.0.0.1:${MCP_INTERNAL_PORT}/health" >/dev/null 2>&1 \
       || curl -sf "http://127.0.0.1:${MCP_INTERNAL_PORT}/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

if ! wait_for_mcphub; then
  if ! kill -0 "$MCPHUB_PID" 2>/dev/null; then
    exiterr "MCPHub failed to start. Check the container logs for details."
  else
    exiterr "MCPHub did not become ready after 30 seconds."
  fi
fi

# Start Caddy auth proxy (always enabled)
CADDY_CONFIG_FILE="${DATA_DIR}/.Caddyfile"
cat > "$CADDY_CONFIG_FILE" << CADDYEOF
:${MCP_PORT} {
  @unauthed {
    not header Authorization "Bearer ${api_key}"
    not path /health
  }
  respond @unauthed "Unauthorized" 401
  reverse_proxy 127.0.0.1:${MCP_INTERNAL_PORT} {
    header_up -X-Forwarded-For
  }
}
CADDYEOF
caddy fmt --overwrite "$CADDY_CONFIG_FILE" 2>/dev/null || true
caddy run --config "$CADDY_CONFIG_FILE" --adapter caddyfile &
CADDY_PID=$!
# Wait up to 5 seconds for Caddy to start
_i=0
while [ "$_i" -lt 5 ]; do
  kill -0 "$CADDY_PID" 2>/dev/null || break
  if curl -sf --max-time 1 "http://127.0.0.1:${MCP_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  _i=$((_i + 1))
done
if ! kill -0 "$CADDY_PID" 2>/dev/null; then
  exiterr "Caddy auth proxy failed to start."
fi
report_usage_counts

# Copy API key to shared volume if mounted (used by self-hosted-ai-stack)
if grep -q " /var/lib/mcp-shared " /proc/mounts 2>/dev/null; then
  cp "$API_KEY_FILE" /var/lib/mcp-shared/.api_key
  chmod 644 /var/lib/mcp-shared/.api_key
fi

# Display connection info
echo
echo "==========================================================="
echo "UplinkCrate API key"
echo "==========================================================="
echo "${api_key}"
echo "==========================================================="
echo
echo "Gateway endpoint: http://${server_addr}:${MCP_PORT}"
echo
echo "MCP endpoints:"
echo "  All servers:      http://${server_addr}:${MCP_PORT}/mcp"
echo "  Specific server:  http://${server_addr}:${MCP_PORT}/mcp/<server-name>"
echo "  Dashboard:        http://${server_addr}:${MCP_PORT}/"
echo
echo "To set up HTTPS, see: Using a reverse proxy"
echo "  https://github.com/hwdsl2/uplinkcrate#using-a-reverse-proxy"
echo
echo "Test with:"
echo "  curl http://${server_addr}:${MCP_PORT}/mcp \\"
echo "    -H \"Authorization: Bearer ${api_key}\""

# Show enabled servers
echo
if [ -n "$MCP_SERVERS" ]; then
  echo "Enabled MCP servers: $MCP_SERVERS"
else
  echo "Enabled MCP servers: fetch (default)"
fi
echo
echo "Manage servers: docker exec <container> mcp_manage --help"
echo
echo "Setup complete."
echo

# Wait for main process
wait "$MCPHUB_PID"
