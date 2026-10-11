---
name: Bug report
about: Tell us about a problem you are experiencing
title: ''
labels: ''
assignees: ''

---
**Checklist**

- [ ] I read the [README](https://github.com/hwdsl2/uplinkcrate/blob/main/README.md) or the relevant section
- [ ] I searched existing [Issues](https://github.com/hwdsl2/uplinkcrate/issues?q=is%3Aissue)
- [ ] This issue is about the UplinkCrate Docker image/config/API, not only MCPHub itself

<!---
If you found a reproducible bug in the upstream project itself, consider opening an issue upstream: [MCPHub](https://github.com/samanhappy/mcphub).
--->

**Describe the issue**
A clear and concise description of the problem.

**Deployment context**
- [ ] Standalone container
- [ ] Part of [self-hosted-ai-stack](https://github.com/hwdsl2/self-hosted-ai-stack)

**To Reproduce**
Steps to reproduce the behavior:

1. ...
2. ...

**Expected behavior**
A clear and concise description of what you expected to happen.

**Environment**
- Docker host OS: [e.g. Ubuntu 24.04]
- Hosting provider (if applicable): [e.g. AWS, GCP, home server]
- CPU architecture: [e.g. amd64, arm64]
- Image/tag: [e.g. `hwdsl2/mcp-gateway:latest`]
- Start method: [docker run / docker compose / other]
- Published port(s): [3000]

**Configuration**
Remove secrets, API keys, tokens and private URLs before posting.

- Env file or variables changed: [mcp.env / `-e` / compose `environment`]
- Docker run or compose changes:

**Service details**
- Enabled MCP servers (`MCP_SERVERS`):
- MCP client and transport/path used (`/mcp` or `/mcp/<name>`):
- Dashboard, API key, or auth behavior, if relevant:
- Management command output, if relevant (for example `docker exec mcp mcp_manage --showkey`):
- LiteLLM integration details, if relevant:
- Relevant `MCP_*` settings with secrets removed:

**Logs**
Add relevant logs with secrets removed.

```bash
docker logs mcp
```

If using Docker Compose, you can also include:

```bash
docker compose logs mcp
```

**Additional context**
Add any other context about the problem here.
