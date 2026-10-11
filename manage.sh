#!/bin/bash
#
# https://github.com/hwdsl2/uplinkcrate
#
# Copyright (C) 2026 Lin Song <linsongui@gmail.com>
#
# This work is licensed under the MIT License
# See: https://opensource.org/licenses/MIT

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

MCP_DATA="/var/lib/mcp"
API_KEY_FILE="${MCP_DATA}/.api_key"
PORT_FILE="${MCP_DATA}/.port"
SERVERS_FILE="${MCP_DATA}/.servers"

exiterr() { echo "Error: $1" >&2; exit 1; }

show_usage() {
  local exit_code="${2:-1}"
  if [ -n "$1" ]; then
    echo "Error: $1" >&2
  fi
  cat 1>&2 <<'EOF'

UplinkCrate - Server Management
https://github.com/hwdsl2/uplinkcrate

Usage: docker exec <container> mcp_manage [options]

Options:
  --list                 list enabled MCP servers
  --test <server>        test connectivity to a specific MCP server
  --showkey              show the API key and endpoint
  --getkey               output the API key (machine-readable, no decoration)
  --status               show gateway health and server status

  -h, --help             show this help message and exit

Examples:
  docker exec mcp mcp_manage --list
  docker exec mcp mcp_manage --test fetch
  docker exec mcp mcp_manage --status
  docker exec mcp mcp_manage --showkey
  docker exec mcp mcp_manage --getkey

EOF
  exit "$exit_code"
}

check_container() {
  if [ ! -f "/.dockerenv" ] && [ ! -f "/run/.containerenv" ] \
    && [ -z "$KUBERNETES_SERVICE_HOST" ] \
    && ! head -n 1 /proc/1/sched 2>/dev/null | grep -q '^run\.sh '; then
    exiterr "This script must be run inside a container (e.g. Docker, Podman)."
  fi
}

load_config() {
  if [ -z "$MCP_PORT" ]; then
    if [ -f "$PORT_FILE" ]; then
      MCP_PORT=$(cat "$PORT_FILE")
    else
      MCP_PORT=3000
    fi
  fi

  if [ -z "$MCP_API_KEY" ]; then
    if [ -f "$API_KEY_FILE" ]; then
      MCP_API_KEY=$(cat "$API_KEY_FILE")
    fi
  fi

  if [ -f "$SERVERS_FILE" ]; then
    ENABLED_SERVERS=$(cat "$SERVERS_FILE")
  else
    ENABLED_SERVERS="fetch"
  fi

  # mcp_manage communicates with MCPHub directly on the internal port
  MCPHUB_BASE="http://127.0.0.1:3001"
}

check_server() {
  if ! curl -sf "${MCPHUB_BASE}/" >/dev/null 2>&1; then
    exiterr "MCPHub is not responding. Is the container running?"
  fi
}

parse_args() {
  list_servers=0
  test_server=0
  show_status=0
  show_key=0
  get_key=0

  server_arg=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --list)
        list_servers=1
        shift
        ;;
      --test)
        test_server=1
        server_arg="$2"
        shift; shift
        ;;
      --status)
        show_status=1
        shift
        ;;
      --showkey)
        show_key=1
        shift
        ;;
      --getkey)
        get_key=1
        shift
        ;;
      -h|--help)
        show_usage "" 0
        ;;
      *)
        show_usage "Unknown parameter: $1"
        ;;
    esac
  done
}

check_args() {
  local action_count
  action_count=$((list_servers + test_server + show_status + show_key + get_key))

  if [ "$action_count" -eq 0 ]; then
    show_usage
  fi
  if [ "$action_count" -gt 1 ]; then
    show_usage "Specify only one action at a time."
  fi

  if [ "$test_server" = 1 ] && [ -z "$server_arg" ]; then
    exiterr "Missing server name. Usage: --test <server>"
  fi
}

do_list_servers() {
  echo
  echo "Enabled MCP servers:"
  echo
  _IFS_ORIG="$IFS"
  IFS=','
  for _server in $ENABLED_SERVERS; do
    IFS="$_IFS_ORIG"
    _server=$(printf '%s' "$_server" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    [ -z "$_server" ] && continue
    echo "  - $_server"
  done
  IFS="$_IFS_ORIG"
  echo
  echo "MCP endpoint for all servers: http://<server-ip>:${MCP_PORT}/mcp"
  echo "MCP endpoint for specific:    http://<server-ip>:${MCP_PORT}/mcp/<server-name>"
  echo
}

do_test_server() {
  echo
  echo "Testing MCP server '${server_arg}'..."
  echo

  # Check if the server is in the enabled list
  found=false
  _IFS_ORIG="$IFS"
  IFS=','
  for _server in $ENABLED_SERVERS; do
    IFS="$_IFS_ORIG"
    _server=$(printf '%s' "$_server" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    if [ "$_server" = "$server_arg" ]; then
      found=true
      break
    fi
    IFS=','
  done
  IFS="$_IFS_ORIG"

  if ! $found; then
    echo "Server '${server_arg}' is not in the enabled servers list."
    echo "Enabled servers: ${ENABLED_SERVERS}"
    echo
    return 1
  fi

  # Try to reach the server-specific MCP endpoint
  local url="${MCPHUB_BASE}/mcp/${server_arg}"
  local http_code
  http_code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null)

  if [ "$http_code" = "200" ] || [ "$http_code" = "405" ]; then
    echo "Server '${server_arg}' is reachable (HTTP ${http_code})."
  elif [ -n "$http_code" ] && [ "$http_code" != "000" ]; then
    echo "Server '${server_arg}' responded with HTTP ${http_code}."
    echo "It may still be starting up or may have a configuration issue."
  else
    echo "Server '${server_arg}' is not reachable."
    echo "Check the container logs for errors."
  fi
  echo
}

do_status() {
  echo
  echo "MCP Gateway Status"
  echo "==================="
  echo

  # Check MCPHub health
  local health_code
  health_code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 5 "${MCPHUB_BASE}/" 2>/dev/null)

  if [ "$health_code" = "200" ]; then
    echo "MCPHub:  running (HTTP 200)"
  else
    echo "MCPHub:  not responding (HTTP ${health_code:-000})"
  fi

  # Check Caddy
  local caddy_code
  caddy_code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${MCP_PORT}/" 2>/dev/null)

  if [ "$caddy_code" = "200" ] || [ "$caddy_code" = "401" ]; then
    echo "Caddy:   running (HTTP ${caddy_code})"
  else
    echo "Caddy:   not responding (HTTP ${caddy_code:-000})"
  fi

  echo
  echo "Enabled MCP servers: ${ENABLED_SERVERS}"
  echo "Port: ${MCP_PORT}"
  echo
}

do_get_key() {
  if [ -z "$MCP_API_KEY" ]; then
    exit 1
  fi
  printf '%s' "$MCP_API_KEY"
}

do_show_key() {
  echo
  if [ -z "$MCP_API_KEY" ]; then
    echo "No API key found."
    echo
    return
  fi
  echo "==========================================================="
  echo "UplinkCrate API key"
  echo "==========================================================="
  echo "${MCP_API_KEY}"
  echo "==========================================================="
  echo
  echo "Gateway endpoint:  http://<server-ip>:${MCP_PORT}"
  echo "MCP all servers:   http://<server-ip>:${MCP_PORT}/mcp"
  echo "Dashboard:         http://<server-ip>:${MCP_PORT}/"
  echo
}

check_container
load_config
parse_args "$@"
check_args

if [ "$show_key" = 1 ]; then
  do_show_key
  exit 0
fi

if [ "$get_key" = 1 ]; then
  do_get_key
  exit 0
fi

check_server

if [ "$list_servers" = 1 ]; then
  do_list_servers
  exit 0
fi

if [ "$test_server" = 1 ]; then
  do_test_server
  exit 0
fi

if [ "$show_status" = 1 ]; then
  do_status
  exit 0
fi