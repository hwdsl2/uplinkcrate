"""Run inside the disposable GatewayCrate container, never on a workstation."""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml


expected = sys.argv[1]
assert expected in ("current", "stale")
config = yaml.safe_load(Path("/etc/litellm/config.yaml").read_text())
entry = config["mcp_servers"]["docker_mcp_gateway"]
shared = Path("/var/lib/mcp-shared/.api_key").read_text()
assert entry["url"] == "http://mcp:3000/mcp"
assert entry["transport"] == "http" and entry["auth_type"] == "bearer_token"
assert (entry["auth_value"] == shared) == (expected == "current"), "Unexpected shared-key delivery state"


def request(body, headers=None, method="POST"):
    req = urllib.request.Request(
        entry["url"],
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + entry["auth_value"],
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **(headers or {}),
        },
        method=method,
    )
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read().decode()


def rpc(text):
    if text.lstrip().startswith("{"):
        return json.loads(text)
    for line in text.splitlines():
        if line.startswith("data:"):
            value = json.loads(line[5:])
            if "id" in value:
                return value
    raise AssertionError("Missing MCP response")


status, headers, body = request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {},
    "clientInfo": {"name": "shared-consumer-check", "version": "1.0"},
}})
if expected == "stale":
    assert status == 401, "Cached or explicit obsolete credentials must be rejected"
else:
    assert status == 200 and rpc(body)["result"]["serverInfo"]
    session = headers.get("mcp-session-id")
    assert session
    headers = {"Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-03-26"}
    try:
        status, _, _ = request({"jsonrpc": "2.0", "method": "notifications/initialized"}, headers)
        assert status in (200, 202, 204)
        status, _, body = request({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, headers)
        assert status == 200 and rpc(body)["result"]["tools"]
    finally:
        request(None, headers, method="DELETE")
print("PASS: GatewayCrate generated configuration and MCP exchange have the expected credential state")
