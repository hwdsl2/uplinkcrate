# Authentication, upgrades and rollback

## Two credential boundaries

The bootstrap key is the effective `MCP_API_KEY`, a saved `.api_key`, or a newly
generated key when neither exists. Empty `MCP_API_KEY` does not disable auth.
Supported custom keys need not start with `mcp-`; they must be one HTTP bearer
token of at most 8192 ASCII characters, without whitespace, control characters
or wildcard syntax.

In standard self-hosted, JSON-backed deployments at the root URL:

- MCP transport routes accept the bootstrap key or a valid dashboard-created key.
  MCPHub evaluates native enabled state, scopes and owner permissions on requests.
- Dashboard, static and management routes retain the outer bootstrap gate.
  Protected management APIs also require native dashboard login/JWT. The
  bootstrap key is transport-only upstream, not a synthetic administrator or
  native system/all key. Dashboard-created MCP keys cannot replace this outer gate.
- `/health` remains public. Allowed-origin MCP browser preflights expose only
  CORS protocol metadata, not tools or application state. Actual MCP operations
  require authentication. A successful health check does not prove a connection
  or that a particular key has the requested scope.

Copy a dashboard token when it is created, not the masked value shown later.
For a key limited to `fetch`, connect to `/mcp/fetch`, not the global `/mcp`
aggregate. Group, custom, user and exclusion scopes retain native MCPHub semantics.
For example, exclusion-scoped keys may use a filtered global aggregate; they do
not regain access to excluded servers. A key limited to one group member does
not thereby gain access to all other members.

The default native header is `Authorization: Bearer <token>`. If it is changed
to a supported custom header, dashboard-created MCP keys use that header, while
the bootstrap key still works in standard `Authorization`. Conflicting or
duplicate credentials are rejected. Reserved HTTP, proxy, session and dashboard
JWT header names cannot be used for delegated native authentication.

## Saved bootstrap key validation

The saved `.api_key` must contain the exact token bytes, without a final newline.
The wrapper writes this format automatically. A manually edited file containing
whitespace or control characters, including a final LF or CRLF from an editor or
`echo`, stops startup without changing the saved key or existing settings.
A valid nonempty `MCP_API_KEY` does not bypass validation of a malformed saved
file: startup also checks the previous key for rotation and native-key collisions.

For recovery, stop the service, back up the complete data volume, and restore the
intended exact token from an authoritative source with file permissions `0600`.
Do not print the token or delete settings/native keys to recover. If the effective
nonempty `MCP_API_KEY` is independently known to be the existing bootstrap token,
with no rotation intended, you may instead remove only the malformed `.api_key`
from the writable data volume. Restart/recreate with that same configuration;
the wrapper will persist the configured token again. Follow the restart rules
under [applying settings](#applying-settings-and-rotating-the-bootstrap-key).
Do not remove the file with an empty or uncertain configured key, which could
generate a different token.

The old wrapper stripped trailing LF bytes when reading the file, so its
underlying token may already have been used by clients. Removing the file also
removes the previous-key input to rotation checks. To choose a different token,
restore the known previous token in valid form first, then follow the controlled
rotation procedure below. If the previous token is unknown, recover it from the
backup or authoritative source. Do not use file deletion to bypass collision
checks; current-bootstrap/native collisions still stop delegated startup.

## Effective policy and sessions

Transport authentication remains mandatory even if legacy settings store
`enableBearerAuth: false`. Settings display the effective enforced value;
attempts to disable it are rejected. Unrelated settings saves preserve the
underlying legacy flag for rollback.

Legacy SSE and sessionful Streamable HTTP sessions are credential-bound.
Another key cannot borrow an existing session, even when its scopes overlap.
Restarting the gateway or changing credential permissions requires a new
initialize exchange. Transparent rebuilding of an unknown session is refused
because its original ownership cannot be established. Current stateless MCP
requests also authenticate independently and isolate application state by
credential and route.

Disabling, deleting or revoking a key affects later HTTP requests. It does not
necessarily cancel already accepted operations or close an existing response.
This is not a promise of immediate open-stream termination.

Delegated authentication reads settings fail-closed. Missing, malformed or
unreadable JSON, duplicate native credentials, or collisions with a current or
just-rotated bootstrap key require operator correction. Do not erase settings
or bypass authentication to recover. Public health can remain reachable while
protected requests return an authentication-state error.

## Supported modes and network trust

`mcp_manage --status` reports `delegated` or `legacy`. Database/hosted deployments,
nonroot base paths, intentional `skipAuth`, advanced identity providers and
unsupported native header configurations retain coherent bootstrap-only legacy
behavior, or fail startup if a safe configuration cannot be established.
Dashboard-created key support is not claimed in legacy mode. Switching between
these modes requires a controlled restart; live settings changes cannot silently
open delegated transports. Full external OAuth flows are outside this fix.

Upstream-only environment variables in a shell-style `/mcp.env` must be exported
to reach MCPHub. The wrapper's documented `MCP_*` options do not require this.
MCPHub also reads `/app/.env`; exported values take precedence, and only the
literal `USE_DB=true` enables database mode when `USE_DB` is set. Status uses
the mode selected at startup, while delegated requests still check current JSON
authentication settings. Root-equivalent `BASE_PATH` values such as `/` remain
eligible for delegated mode.

MCPHub listens only on IPv4 loopback port `3001`; Caddy exposes `MCP_PORT`.
Do not publish the internal port. Processes with privileged local access or a
shared network namespace remain trusted. Loopback does not isolate the service
from another process/container in that same namespace. Keep the documented HTTPS
reverse proxy and preserve authentication and MCP streaming/session headers.

No-Origin server-to-server clients remain supported. Disallowed browser Origins
are rejected on delegated transports, not merely hidden by missing CORS headers.
Preserve the existing allowed-origin configuration for legitimate browser clients.
Allowed cross-origin browser clients can perform unauthenticated CORS preflight;
the subsequent operation still needs the appropriate bearer credential.

## Applying settings and rotating the bootstrap key

1. Back up the complete current volume and record the deployed immutable image
   reference. Keep existing volume names and mounts.
2. Change the authoritative key source. A nonempty configured `MCP_API_KEY`
   overrides a saved `.api_key`; editing only the saved file cannot override it.
3. Restart for an edited bind-mounted `/mcp.env`. For Docker/Compose environment
   changes, recreate only this container with the same volumes and configuration.
   Editing `.api_key` alone while the service is running does not reload auth.
4. Wait for readiness, check `mcp_manage --status`, and test an authenticated MCP
   connection. `mcp_manage --test <server>` performs initialize and tools listing
   against the public proxy and returns nonzero on failure. A bare GET returning
   a session error or 405 is not a successful test.
5. Refresh clients and cached consumers. GatewayCrate reads the shared key at
   startup only when no explicit `LITELLM_MCP_API_KEY` is configured. Restart it
   after the gateway and shared file are ready; update any explicit override
   separately. The shared `/var/lib/mcp-shared/.api_key` is replaced atomically.

Native keys must be distinct from bootstrap credentials. The wrapper refuses
collisions rather than deleting, changing scopes or taking ownership of native
rows. No administrator is created just to own a bootstrap key.

## Upgrade and rollback

The image pins MCPHub 1.2.2 by digest and applies a version-bound source patch
before the canonical backend build. Unexpected upstream source or mismatched
compiled policy fails closed. Caddy delegates transports only after the running
patched process confirms readiness for that startup.

MCPHub 1.2.2 migrates raw dashboard API tokens to hashes and prefixes while
retaining their usable values, IDs and scopes. New raw tokens are shown only at
creation. Personal credentials may additionally use
`mcp_settings.json.credentials.key` next to the JSON settings. Preserve the
entire volume, including that file; losing it can make encrypted personal
credentials unusable. This upgrade is not byte-for-byte settings preservation.

Rollback to MCPHub 1.0.38 needs preparation: enabled hash-only key records can
break MCP requests even with its native `enableBearerAuth: false` setting.
The old wrapper's proxy still accepts only the bootstrap key; dashboard keys
cannot authenticate through it.

Stop the service and back up the entire current volume before a downgrade.
For the standard JSON-backed configuration with the original
`enableBearerAuth: false` setting, record which hash-only entries in
`mcp_settings.json` have `enabled: true`, then set just those entries to
`enabled: false` while stopped. Retain their IDs, hashes, scopes, all other
settings and the adjacent encryption key file. Test the prepared volume with a
known-good old image on a disposable copy before using it in production.
Other configurations and newer features may need additional compatibility work.

Keep the current effective bootstrap key and refresh clients rather than
restoring an obsolete key or replacing current settings with a stale backup.
Before re-upgrading, stop the service and deliberately restore only the key
enablement changes recorded for rollback, leaving previously disabled keys
disabled. Do not reconstruct plaintext tokens or delete hashed-key records.
This preparation is a manual operation; normal startup does not disable or
re-enable keys for rollback.
