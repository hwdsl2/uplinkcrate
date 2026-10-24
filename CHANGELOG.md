# Changelog

Notable changes to UplinkCrate are documented here.

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
