# Contributing

Thanks for helping improve this project. This repository maintains the UplinkCrate Docker image, powered by MCPHub and Caddy; changes that only affect multi-service orchestration belong in [self-hosted-ai-stack](https://github.com/hwdsl2/self-hosted-ai-stack).

## Before You Start

- Search existing issues and pull requests.
- Keep changes focused and easy to review.
- For upstream MCPHub or MCP server behavior, check the upstream project first.
- Do not include API keys, MCP tokens, private tool configuration, logs with secrets, or credentials.

## Pull Requests

- Update `README.md`, env examples, or compose examples when behavior changes.
- Include the Docker image/tag, architecture, and MCP client path tested.
- For upstream version changes, link the upstream release, tag, or commit.

## Testing

Test the smallest relevant path before opening a PR, for example:

- Build or run the image when Dockerfile/runtime behavior changes.
- Exercise the MCP endpoint, auth proxy, or helper script touched by the change.
- Check tool configuration behavior when changing MCPHub defaults.
- Run ShellCheck when editing shell scripts.
