#
# Copyright (C) 2026 Lin Song <linsongui@gmail.com>
#
# This work is licensed under the MIT License
# See: https://opensource.org/licenses/MIT

FROM samanhappy/mcphub:1.0.38@sha256:c8c4991f6e40a12089c6c9b9f7ae9ee67f0083d4bce401c1eb14cd602b883e20

WORKDIR /opt/src

# Install Caddy for auth proxy and curl for health checks.
# MCPHub base image is Debian Trixie with Node 22 and pnpm.
RUN set -x \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates curl jq \
    && ARCH=$(uname -m) \
    && if [ "$ARCH" = "x86_64" ]; then ARCH_LABEL="amd64"; \
       elif [ "$ARCH" = "aarch64" ]; then ARCH_LABEL="arm64"; \
       else echo "Unsupported architecture: $ARCH" >&2; exit 1; fi \
    && CADDY_VER=$(curl -fsSL "https://api.github.com/repos/caddyserver/caddy/releases/latest" \
         | jq -r '.tag_name' | tr -d 'v') \
    && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_${ARCH_LABEL}.tar.gz" \
         -o /tmp/caddy.tar.gz \
    && tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy \
    && chmod 755 /usr/local/bin/caddy \
    && rm -f /tmp/caddy.tar.gz \
    && apt-get purge -y jq \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/mcp

# Install additional MCP server packages not bundled in upstream
RUN NPM_BEFORE="$(date -u -d '7 days ago' '+%Y-%m-%dT%H:%M:%SZ')" \
    && npm install -g --before="$NPM_BEFORE" \
      @modelcontextprotocol/server-filesystem \
      @modelcontextprotocol/server-github \
      @modelcontextprotocol/server-brave-search \
      @modelcontextprotocol/server-postgres \
      @modelcontextprotocol/server-memory \
      @modelcontextprotocol/server-sequential-thinking

COPY ./run.sh /opt/src/run.sh
COPY ./manage.sh /opt/src/manage.sh
COPY ./mcp-config.cjs /opt/src/mcp-config.cjs
COPY ./LICENSE.md /opt/src/LICENSE.md
RUN chmod 755 /opt/src/run.sh /opt/src/manage.sh /opt/src/mcp-config.cjs \
    && ln -s /opt/src/manage.sh /usr/local/bin/mcp_manage

EXPOSE 3000/tcp
VOLUME ["/var/lib/mcp"]
ENTRYPOINT []
CMD ["/opt/src/run.sh"]

ARG BUILD_DATE
ARG VERSION
ARG VCS_REF
ENV IMAGE_VER=$BUILD_DATE
ENV IMAGE_FLAVOR=$VERSION

LABEL maintainer="Lin Song <linsongui@gmail.com>" \
    org.opencontainers.image.created="$BUILD_DATE" \
    org.opencontainers.image.version="$VERSION" \
    org.opencontainers.image.revision="$VCS_REF" \
    org.opencontainers.image.authors="Lin Song <linsongui@gmail.com>" \
    org.opencontainers.image.title="UplinkCrate" \
    org.opencontainers.image.description="UplinkCrate: self-hosted multi-server MCP gateway powered by MCPHub and Caddy, with Bearer token authentication, Streamable HTTP and SSE." \
    org.opencontainers.image.url="https://github.com/hwdsl2/uplinkcrate" \
    org.opencontainers.image.source="https://github.com/hwdsl2/uplinkcrate" \
    org.opencontainers.image.documentation="https://github.com/hwdsl2/uplinkcrate"
