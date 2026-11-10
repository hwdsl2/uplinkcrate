# Authentication regression checks

These checks cover UplinkCrate's authentication policy, container startup and MCP
client compatibility using synthetic credentials and local echo tools.

## Running the checks

Maintainers can select **test** in GitHub Actions, choose **Run workflow**, and
select the branch to check. The [test workflow](../test.yml) runs ShellCheck and
the [reusable image checks](../mcp_gateway_test.yml) without publishing images.

Use a disposable Linux environment with Docker and Docker Compose for image
checks. The reusable workflow defines the setup and commands for native amd64
and arm64 runners. Cleanup targets containers, volumes and temporary files
created by the tests.

## Coverage

- Unit checks (`*.test.mjs`): credentials, startup modes, routes, headers,
  session identity, shell helpers and build inputs. Focused upstream Jest suites
  also exercise native authentication and scope behavior.
- [Policy runtime](check_policy_runtime.mjs) and
  [downstream query checks](check_query_boundary.mjs): real MCPHub/Caddy requests,
  native scopes, sessions, revocation, dashboard JWT isolation and CORS. The
  downstream observer directly checks transport JWT removal.
- Image checks: environment-file precedence, readiness, IPv4/IPv6 listener
  isolation, proxy headers, failed startup, saved-key recovery, obsolete proxy
  configuration cleanup and service lifetime.
- [Upgrade checks](check_image_upgrade.mjs): old-version startup, upgrade and
  candidate restart, preserving credentials and settings and calling a retained
  tool. Downgrades across the key migration need separate preparation; see the
  [rollback limits](../../../docs/authentication.md#upgrade-and-rollback).
- Consumer checks: ARM64 Compose with bind-mounted configuration and
  [AnythingLLM credential switching](check_anythingllm_client.mjs), plus
  [GatewayCrate shared-key configuration](check_shared_consumer.py), rotation
  and explicit overrides.

AnythingLLM coverage uses its pinned client module and the real MCP SDK; it does
not start the full UI. GatewayCrate coverage checks its generated MCP connection
settings and a protocol exchange, rather than every LiteLLM MCP operation.

## Maintenance notes

- The entrypoint requires Bash 5.1+ for `wait -n` with explicit child PIDs.
- Delegated authentication rereads settings so revocation, permission changes
  and invalid state take effect on later requests. Stored native token hashes
  are reused; raw tokens require hashing. Any caching change must preserve this
  behavior rather than depend only on TTLs, file mtimes or watcher events.
- Recheck downstream query-token removal when upgrading Express. Authorization
  tests alone do not establish that the token was removed.
- Publication workflows require the reusable checks but rebuild separately.
  Latest-Caddy discovery can select a different release during publication.

## Test inputs

The [Dockerfile](../../../Dockerfile) pins MCPHub and verifies the selected Caddy
archive against its release checksums. The [source patch](../../../policy/apply.mjs)
checks upstream input hashes, and startup checks compiled-policy integrity.

The [image workflow](../mcp_gateway_test.yml) builds a previous-version fixture
from a recorded wrapper revision, MCPHub 1.0.38 and the candidate's verified
Caddy. GatewayCrate uses `hwdsl2/litellm-server`. Resolved image identities are
logged. AnythingLLM's source revision and checksum are recorded and verified,
with its MIT license retained.
Keep dependency-backed execution inside the disposable test environment;
version pins and checksums do not replace isolation.
