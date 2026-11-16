# Authentication regression checks

Select **test** in GitHub Actions, choose **Run workflow**, and select a branch.
The [test workflow](../test.yml) runs ShellCheck and the
[image checks](../mcp_gateway_test.yml) without publishing images. Image checks
require a disposable Linux environment with Docker and Docker Compose.

Checks cover authentication, startup, upgrades and MCP client compatibility on
AMD64 and ARM64. See [authentication and rollback guidance](../../../docs/authentication.md)
for migration limits.
