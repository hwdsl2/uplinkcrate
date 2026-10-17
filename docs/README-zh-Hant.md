[English](../README.md) | [简体中文](README-zh.md) | [繁體中文](README-zh-Hant.md) | [Русский](README-ru.md)

# UplinkCrate

**開源、自託管的 MCP 閘道。**

[![建置狀態](https://github.com/hwdsl2/uplinkcrate/actions/workflows/main.yml/badge.svg)](https://github.com/hwdsl2/uplinkcrate/actions/workflows/main.yml) &nbsp;[![Docker Pulls](https://raw.githubusercontent.com/hwdsl2/badges/main/img/docker-pulls-mcp-gateway.svg)](https://hub.docker.com/r/hwdsl2/mcp-gateway) &nbsp;[![授權條款: MIT](images/license.svg)](https://opensource.org/licenses/MIT)

透過 UplinkCrate，為 AI 用戶端提供經過驗證的多個 [MCP](https://modelcontextprotocol.io/) 工具伺服器存取。基於 [MCPHub](https://github.com/samanhappy/mcphub) 和 Caddy 驗證代理，提供 Streamable HTTP 和 SSE 存取、伺服器路由，以及自託管工具閘道的儀表板。

> 本專案原名為 `docker-mcp-gateway`，由 [hwdsl2](https://github.com/hwdsl2) 維護。Docker 映像仍為 `hwdsl2/mcp-gateway`。

**功能特色：**

- **預設安全：** Caddy 對 API 存取強制執行 Bearer Token 驗證；首次啟動時自動產生 API 金鑰，並儲存在持久化卷中。
- **多伺服器閘道：** 在單一 HTTP 端點後執行多個 MCP 工具伺服器
- **路徑路由：** 透過 `/mcp` 存取所有伺服器，或透過 `/mcp/<名稱>` 存取指定伺服器
- **MCP 傳輸模式：** 支援 Streamable HTTP + SSE 兩種 MCP 傳輸模式
- **內建 MCP 伺服器：** filesystem、fetch、GitHub、Brave Search、Git、PostgreSQL、memory、sequential-thinking
- **儀表板：** 位於 `/` 的 Web UI，用於監控 MCP 伺服器狀態
- **環境檔案設定：** 簡單的 `mcp.env` 檔案；無需編輯 JSON
- **LiteLLM 整合：** 與 LiteLLM（包括 [GatewayCrate](https://github.com/hwdsl2/gatewaycrate)）配合，為相容的 LLM 提供 MCP 工具存取。
- **自動建置：** 透過 [GitHub Actions](https://github.com/hwdsl2/uplinkcrate/actions) 自動建置和發布

也可作為 [Self-Hosted AI Stack](https://github.com/hwdsl2/self-hosted-ai-stack/blob/main/docs/README-zh-Hant.md) 的一部分使用，一條命令即可部署完整的自託管 AI 技術堆疊。

> 📘 [The Self-Hosted AI Builder’s Guide](https://books2read.com/aiguide?store=amazon) 是一本關於建置、保護和維運自己的私有 AI 技術堆疊的實用指南。

**另提供：**

- 相關 AI 服務：[ScribeCrate](https://github.com/hwdsl2/scribecrate/blob/main/docs/README-zh-Hant.md)、[SpeakCrate](https://github.com/hwdsl2/speakcrate/blob/main/docs/README-zh-Hant.md)、[EmbedCrate](https://github.com/hwdsl2/embedcrate/blob/main/docs/README-zh-Hant.md)、[GatewayCrate](https://github.com/hwdsl2/gatewaycrate/blob/main/docs/README-zh-Hant.md)、[InferCrate](https://github.com/hwdsl2/infercrate/blob/main/docs/README-zh-Hant.md)、[ParseCrate](https://github.com/hwdsl2/parsecrate/blob/main/docs/README-zh-Hant.md)

## 快速開始

**第一步。** 啟動 UplinkCrate：

```bash
docker run \
    --name mcp \
    --restart=always \
    -v mcp-data:/var/lib/mcp \
    -p 3000:3000/tcp \
    -d hwdsl2/mcp-gateway
```

首次啟動時，系統會自動產生 API 金鑰並顯示在容器日誌中。所有 API 請求均需此金鑰。

> [!NOTE]
> 對於面向網際網路的部署，請使用[反向代理](#使用反向代理)新增 HTTPS。在這種情況下，還需將 `docker run` 命令中的 `-p 3000:3000/tcp` 替換為 `-p 127.0.0.1:3000:3000/tcp`，以防止直接存取未加密的連接埠。

**第二步。** 取得 API 金鑰：

```bash
# 在容器日誌中查看金鑰
docker logs mcp

# 或取得金鑰以在腳本中使用
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"
```

API 金鑰顯示在標有 **UplinkCrate API key** 的方框中。隨時可以透過以下指令重新顯示：

```bash
docker exec mcp mcp_manage --showkey
```

**第三步。** 透過 API 測試：

```bash
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"

# 測試 MCP 端點（預設啟用 fetch 伺服器）
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer $uplink_api_key"

# 檢查閘道健康狀態（無需驗證）
curl http://localhost:3000/health
```

**注意：** `docker exec` 管理指令（`mcp_manage`）不需要 API 金鑰。

要了解有關如何使用此映像的更多資訊，請閱讀以下各節。

## 社群

- 📬 [取得專案更新與免費部署指南](https://selfhostedstack.beehiiv.com/subscribe?utm_campaign=ai-zh-hant)（每月 1–2 封電子郵件；指南為英文 PDF）
- 💬 加入 [r/selfhostedstack](https://www.reddit.com/r/selfhostedstack/) 社群，參與討論與專案展示
- ⭐ 如果你覺得本專案有用，請為儲存庫加星——這能幫助更多人發現它。

<details>
<summary>自託管 VPN 與網路專案</summary>

- [Setup IPsec VPN](https://github.com/hwdsl2/setup-ipsec-vpn/blob/master/README-zh-Hant.md)
- [Docker 上的 IPsec VPN](https://github.com/hwdsl2/docker-ipsec-vpn-server/blob/master/README-zh-Hant.md)
- [WireGuard](https://github.com/hwdsl2/docker-wireguard/blob/main/docs/README-zh-Hant.md)
- [OpenVPN](https://github.com/hwdsl2/docker-openvpn/blob/main/docs/README-zh-Hant.md)
- [Headscale](https://github.com/hwdsl2/docker-headscale/blob/main/docs/README-zh-Hant.md)

</details>

## 系統需求

- 已安裝 Docker 的 Linux 伺服器（本地或雲端）
- 至少 512 MB 可用記憶體
- TCP 連接埠 3000（或您設定的連接埠）需可存取

## 下載

從 [Docker Hub 映像倉庫](https://hub.docker.com/r/hwdsl2/mcp-gateway/)取得可信建置版本：

```bash
docker pull hwdsl2/mcp-gateway
```

也可從 [Quay.io](https://quay.io/repository/hwdsl2/mcp-gateway) 下載：

```bash
docker pull quay.io/hwdsl2/mcp-gateway
docker image tag quay.io/hwdsl2/mcp-gateway hwdsl2/mcp-gateway
```

支援平台：`linux/amd64` 和 `linux/arm64`。

## 環境變數

所有變數均為可選。如果未設定，將自動使用安全預設值。

此 Docker 映像使用以下變數，可在 `env` 檔案中宣告（參見[範例](../mcp.env.example)）：

| 變數 | 說明 | 預設值 |
|---|---|---|
| `MCP_API_KEY` | 用於驗證請求的 API 金鑰（未設定時自動產生） | 自動產生 |
| `MCP_PORT` | 閘道的 TCP 連接埠（1–65535） | `3000` |
| `MCP_HOST` | 在啟動資訊和 `--showkey` 輸出中顯示的主機名稱或 IP | 自動偵測 |
| `MCP_SERVERS` | 要啟用的 MCP 伺服器清單（逗號分隔） | `fetch` |
| `MCP_ADMIN_PASSWORD` | MCPHub 儀表板管理員帳戶密碼（未設定時首次啟動自動產生） | 自動產生 |
| `MCP_DISABLE_USAGE_COUNTS` | 設為 `1` 可停用匿名彙總使用計數。 | *（未設定）* |

**注意：** 在 `env` 檔案中，您可以將值用單引號括起來，例如 `VAR='value'`。不要在 `=` 兩側新增空格。如果您更改了 `MCP_PORT`，請相應地更新 `docker run` 指令中的 `-p` 旗標。

使用 `env` 檔案的範例：

```bash
cp mcp.env.example mcp.env
# 編輯 mcp.env 並設定您的值，然後：
docker run \
    --name mcp \
    --restart=always \
    -v mcp-data:/var/lib/mcp \
    -v ./mcp.env:/mcp.env:ro \
    -p 3000:3000/tcp \
    -d hwdsl2/mcp-gateway
```

### 可用的 MCP 伺服器

在 `MCP_SERVERS` 中列出要啟用的伺服器（逗號分隔）：

| 伺服器 | 所需設定 | 說明 |
|---|---|---|
| `fetch` | — | 擷取 URL 並提取內容 |
| `filesystem` | `MCP_FILESYSTEM_DIRS` | 在允許的目錄中讀寫檔案 |
| `github` | `MCP_GITHUB_TOKEN` | GitHub API 存取（儲存庫、Issue、PR） |
| `brave-search` | `MCP_BRAVE_API_KEY` | 透過 Brave Search API 進行網頁搜尋 |
| `git` | `MCP_GIT_REPO` | Git 儲存庫工具（狀態、diff、提交、日誌） |
| `postgres` | `MCP_POSTGRES_URL` | 查詢 PostgreSQL 資料庫 |
| `memory` | — | 知識圖譜/持久化記憶 |
| `sequential-thinking` | — | 結構化思考與推理 |

**範例：**

```bash
# 啟用 filesystem、fetch 和 GitHub 伺服器
MCP_SERVERS=filesystem,fetch,github
MCP_FILESYSTEM_DIRS=/data/docs,/data/projects
MCP_GITHUB_TOKEN=ghp_your_token_here
```

對於 `filesystem` 伺服器，需將主機目錄掛載到容器中：

```bash
docker run \
    --name mcp \
    --restart=always \
    -v mcp-data:/var/lib/mcp \
    -v ./mcp.env:/mcp.env:ro \
    -v /home/user/documents:/data/docs:ro \
    -v /home/user/projects:/data/projects \
    -p 3000:3000/tcp \
    -d hwdsl2/mcp-gateway
```

對於 `git` 伺服器，需將儲存庫掛載到容器中並設定 `MCP_GIT_REPO`：

```bash
MCP_SERVERS=git
MCP_GIT_REPO=/repo
```

```bash
docker run \
    --name mcp \
    --restart=always \
    -v mcp-data:/var/lib/mcp \
    -v ./mcp.env:/mcp.env:ro \
    -v /home/user/myrepo:/repo \
    -p 3000:3000/tcp \
    -d hwdsl2/mcp-gateway
```

## 管理 MCP 伺服器

使用 `docker exec` 透過 `mcp_manage` 輔助腳本管理閘道。

**列出已啟用的伺服器：**

```bash
docker exec mcp mcp_manage --list
```

**測試指定伺服器：**

```bash
docker exec mcp mcp_manage --test fetch
docker exec mcp mcp_manage --test github
```

**顯示閘道狀態：**

```bash
docker exec mcp mcp_manage --status
```

**顯示 API 金鑰：**

```bash
docker exec mcp mcp_manage --showkey
```

**取得 API 金鑰**（機器可讀，用於腳本）：

```bash
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"
```

**在執行時新增或移除伺服器：**

使用 MCPHub 儀表板（`http://<伺服器>:3000/`）在不重新啟動容器的情況下新增、設定或移除 MCP 伺服器。變更將儲存至持久卷並在重新啟動後保留。

> [!NOTE]
> `MCP_SERVERS` 僅在**首次執行**建立 `mcp_settings.json` 時生效。此後，請透過儀表板管理伺服器。以這種方式重設檔案，會取代透過儀表板儲存的所有伺服器設定。若要從頭重新套用 `MCP_SERVERS`，請刪除設定檔並重新啟動：

```bash
docker exec mcp rm /var/lib/mcp/mcp_settings.json
docker restart mcp
```

## 使用 API

所有 API 請求均需 Bearer Token。首先取得 API 金鑰：

```bash
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"
```

**MCP 端點（所有已啟用伺服器）：**

```bash
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer $uplink_api_key"
```

**MCP 端點（指定伺服器）：**

```bash
curl http://localhost:3000/mcp/fetch \
  -H "Authorization: Bearer $uplink_api_key"
```

**儀表板**（Web UI）：

在瀏覽器中開啟 `http://localhost:3000/`，並新增 `Authorization: Bearer <key>` 請求標頭，或使用支援標頭注入的客戶端。

**健康檢查**（無需驗證）：

```bash
curl http://localhost:3000/health
```

### 連接 AI 客戶端

**Cline（VS Code）** — 在 Cline 的 MCP 設定中：

```json
{
  "mcpServers": {
    "gateway": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer <api_key>"
      }
    }
  }
}
```

**Claude Desktop** — 在 `claude_desktop_config.json` 中：

```json
{
  "mcpServers": {
    "gateway": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer <api_key>"
      }
    }
  }
}
```

## 持久化資料

所有閘道資料儲存在 Docker 卷中（容器內的 `/var/lib/mcp`）：

```
/var/lib/mcp/
├── mcp_settings.json   # 產生的 MCPHub 設定
├── .api_key            # API 金鑰（自動產生，或從 MCP_API_KEY 同步）
├── .initialized        # 首次執行標記
├── .port               # 儲存的連接埠（供 mcp_manage 使用）
├── .servers            # 已啟用伺服器清單（供 mcp_manage 使用）
└── .Caddyfile          # 產生的 Caddy 設定（驗證代理）
```

`mcp_settings.json` 僅在首次執行時根據 `MCP_SERVERS` 產生。後續重新啟動將重複使用現有檔案，保留透過儀表板所做的任何變更。

備份 Docker 卷以保留您的設定和 API 金鑰。

## 使用 docker-compose

```bash
cp mcp.env.example mcp.env
# 編輯 mcp.env 並設定您的值，然後：
docker compose up -d
docker logs mcp
```

`docker-compose.yml` 範例（已包含）：

```yaml
services:
  mcp:
    image: hwdsl2/mcp-gateway
    container_name: mcp
    restart: always
    ports:
      - "3000:3000/tcp"  # For a host-based reverse proxy, change to "127.0.0.1:3000:3000/tcp"
    volumes:
      - mcp-data:/var/lib/mcp
      - ./mcp.env:/mcp.env:ro
      # 掛載主機目錄用於 filesystem MCP 伺服器（可選）：
      # - /path/to/docs:/data/docs:ro
      # - /path/to/code:/data/code:ro

volumes:
  mcp-data:
    name: mcp-data
```

> [!NOTE]
> 對於面向網際網路的部署，請使用[反向代理](#使用反向代理)新增 HTTPS。在這種情況下，還需將 `docker-compose.yml` 中的 `"3000:3000/tcp"` 改為 `"127.0.0.1:3000:3000/tcp"`，以防止直接存取未加密的連接埠。

## 使用反向代理

如需面向公網部署，可在 UplinkCrate 前置反向代理處理 HTTPS 終止。在本地或可信網路中使用無需 HTTPS，但將 API 端點暴露在公網時建議啟用 HTTPS。

從反向代理存取 UplinkCrate 容器時使用以下位址之一：

- **`mcp:3000`** — 如果反向代理作為容器執行在與 UplinkCrate **同一 Docker 網路**中（例如定義在同一 `docker-compose.yml` 中）。
- **`127.0.0.1:3000`** — 如果反向代理執行在**主機上**且連接埠 `3000` 已發布（預設 `docker-compose.yml` 會發布該連接埠）。

**注意：** `Authorization: Bearer` 標頭會自動通過反向代理傳遞，無需特殊設定。

**使用 [Caddy](https://caddyserver.com/docs/)（[Docker 映像檔](https://hub.docker.com/_/caddy)）的範例**（自動 Let's Encrypt TLS，反向代理在同一 Docker 網路中）：

`Caddyfile`：
```
mcp.example.com {
  reverse_proxy mcp:3000
}
```

**使用 nginx 的範例**（反向代理執行在主機上）：

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;       # SSE 和 WebSocket 所需
        proxy_read_timeout 300s;
        proxy_buffering    off;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
    }
}
```

設定反向代理後，在 `env` 檔案中設定 `MCP_HOST=mcp.example.com`，以便在啟動日誌和 `mcp_manage --showkey` 輸出中顯示正確的端點 URL。

## 更新 Docker 映像

要更新 Docker 映像和容器，請先[下載](#下載)最新版本：

```bash
docker pull hwdsl2/mcp-gateway
```

如果 Docker 映像已是最新版本，您將看到：

```
Status: Image is up to date for hwdsl2/mcp-gateway:latest
```

否則，將下載最新版本。刪除並重新建立容器：

```bash
docker rm -f mcp
# 然後使用相同的卷重新執行快速開始中的 docker run 指令。
```

您的設定和 API 金鑰保存在 `mcp-data` 卷中。

## 與其他 AI 服務搭配使用

UplinkCrate 可作為更廣泛的自託管 AI 設定中的 MCP 工具閘道。

如需完整和輕量級 Docker Compose 技術堆疊、手動 `docker run` 範例，以及結合 SpeakCrate、EmbedCrate、GatewayCrate、InferCrate、ParseCrate 和 UplinkCrate 的語音/RAG/MCP 流水線範例，請參閱 [Self-Hosted AI Stack](https://github.com/hwdsl2/self-hosted-ai-stack/blob/main/docs/README-zh-Hant.md)。

**將 UplinkCrate 連接到 GatewayCrate：**

對於 GatewayCrate 或其他相容的 LiteLLM 部署，請將 UplinkCrate 新增為 MCP 工具來源：

```yaml
# 在 LiteLLM 設定中，將 MCP 閘道新增為工具來源：
mcp_servers:
  - url: http://mcp:3000/mcp
    transport: http
    headers:
      Authorization: "Bearer <uplink_api_key>"
```

## 使用計數

此映像使用公開的 GitHub Release 資源下載次數進行匿名彙總使用計數。計數是近似值，不代表唯一使用者或活躍安裝。映像不會傳送遙測負載，也不會使用私有收集器。僅當閘道成功啟動且掛載了 `/var/lib/mcp` 卷後，才會以盡力而為方式計數；當該持久化安裝首次執行不同映像建置時，也會再次計數。若要退出，請設定 `MCP_DISABLE_USAGE_COUNTS=1`。

## 技術細節

- 基礎映像：`samanhappy/mcphub`（Python 3.13 + Node.js 22）
- 驗證代理：[Caddy](https://caddyserver.com)（始終啟用，強制執行 Bearer Token 驗證）
- 閘道：[MCPHub](https://github.com/samanhappy/mcphub)（多伺服器 MCP 集線器）
- MCPHub 內部連接埠：`3001`（未發布；Caddy 從 `MCP_PORT` 代理）
- 資料目錄：`/var/lib/mcp`（Docker 卷）
- 閘道 API：`http://localhost:3000`（或您設定的連接埠）
- MCP 端點：`http://localhost:3000/mcp`
- 多架構：`linux/amd64`、`linux/arm64`

## 授權條款

**注意：** 預建置映像中的軟體元件（如 MCPHub、Caddy 及其相依套件）遵循其各自版權持有者選擇的授權條款。與任何預建置映像的使用一樣，映像使用者有責任確保對此映像的任何使用均符合其中包含的所有軟體的相關授權條款。

版權所有 (C) 2026 Lin Song   
本作品基於 [MIT 授權條款](https://opensource.org/licenses/MIT)授權。

**MCPHub** 版權所有 (C) 2025 samanhappy，基於 [Apache 授權條款 2.0](https://github.com/samanhappy/mcphub/blob/main/LICENSE) 分發。

**Caddy** 版權所有 (C) 2015 Matthew Holt 和 Caddy 作者，基於 [Apache 授權條款 2.0](https://github.com/caddyserver/caddy/blob/master/LICENSE) 分發。

本專案是 MCPHub 的獨立 Docker 設定，與 MCPHub 沒有任何關聯、背書或贊助關係。
