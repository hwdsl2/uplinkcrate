# Changelog

Notable changes to UplinkCrate are documented here.

## 2026-11-09

Release: `2026.11.1`

### Fixed

- Support dashboard-created MCP keys and their native scopes in standard
  self-hosted JSON/root-path deployments without replacing the bootstrap key.
- Keep authentication mandatory, bind sessions to credentials, protect
  management routes separately, and isolate the internal listener on loopback.
- Make management probes perform authenticated MCP exchanges and report failures.
- Stop both services and fail the wrapper if either child exits unexpectedly,
  allowing container restart policies to recover.
- Remove the obsolete generated `.Caddyfile` after successful startup; warn
  without stopping the service if a mount or permissions prevent removal.

### Changed

- Upgrade MCPHub from 1.0.38 to pinned 1.2.2. Retain Caddy's latest-release lookup
  and verify the selected architecture's archive against that release's checksums.
- MCPHub hashes existing dashboard tokens without changing their usable values.
  Preserve the entire data volume; older upstream versions cannot read the hashes.
  Downgrading to 1.0.38 requires [manual key preparation](docs/authentication.md#upgrade-and-rollback).
- Reject malformed saved `.api_key` files, including trailing LF/CRLF bytes
  introduced by manual editing, rather than silently trimming the credential.
  See [validation and recovery](docs/authentication.md#saved-bootstrap-key-validation).
- Unsupported deployment modes retain observable bootstrap-only legacy behavior
  or stop if startup is unsafe. See [authentication notes](docs/authentication.md).

## 2026-10-24

Release: `2026.10.1`

### Changed

- Established the first tagged source release. Docker images continue to update
  independently through existing moving tags.

## 2026-10-10

### Changed

- Rebranded as UplinkCrate (formerly `docker-mcp-gateway`); the Docker image
  name remains `hwdsl2/mcp-gateway`.

## 2026-07-09

### Added

- Added anonymous aggregate deployment/upgrade counts. Opt out with
  `MCP_DISABLE_USAGE_COUNTS=1`.

## 2026-06-25

### Fixed

- Fixed generated MCP configuration for paths, connection strings, and
  credentials containing quotes or backslashes. Configuration is validated
  before being saved; existing configuration files remain preserved.

## Earlier notable changes

- Added an authenticated MCP gateway with persistent configuration, API key
  sharing with stack services, and management commands for keys and server status.
- Added environment-based configuration for filesystem, fetch, GitHub,
  search, Git, PostgreSQL, memory, and sequential-thinking MCP servers.
