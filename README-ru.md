[English](README.md) | [简体中文](README-zh.md) | [繁體中文](README-zh-Hant.md) | [Русский](README-ru.md)

# UplinkCrate

**MCP-шлюз с открытым исходным кодом для самостоятельного размещения.**

[![Статус сборки](https://github.com/hwdsl2/uplinkcrate/actions/workflows/main.yml/badge.svg)](https://github.com/hwdsl2/uplinkcrate/actions/workflows/main.yml) &nbsp;[![Docker Pulls](https://raw.githubusercontent.com/hwdsl2/badges/main/img/docker-pulls-mcp-gateway.svg)](https://hub.docker.com/r/hwdsl2/mcp-gateway) &nbsp;[![Лицензия: MIT](docs/images/license.svg)](https://opensource.org/licenses/MIT)

Предоставьте AI-клиентам аутентифицированный доступ к нескольким серверам инструментов [MCP](https://modelcontextprotocol.io/) через UplinkCrate. Шлюз работает на базе [MCPHub](https://github.com/samanhappy/mcphub) и прокси аутентификации Caddy и поддерживает Streamable HTTP и SSE, маршрутизацию серверов и панель управления вашим самостоятельно размещённым шлюзом инструментов.

> Ранее проект назывался `docker-mcp-gateway`. Его поддерживает [hwdsl2](https://github.com/hwdsl2). Docker-образ остаётся `hwdsl2/mcp-gateway`.

**Возможности:**

- **Безопасность по умолчанию:** Caddy обеспечивает аутентификацию Bearer Token для доступа к API; API-ключ автоматически генерируется при первом запуске и сохраняется в постоянном томе.
- **Шлюз для нескольких серверов:** запускает несколько MCP-серверов инструментов за единой конечной точкой HTTP
- **Маршрутизация по пути:** доступ ко всем серверам через `/mcp` или к конкретному через `/mcp/<имя>`
- **Транспорт MCP:** Поддержка Streamable HTTP + SSE — оба режима транспорта MCP
- **Встроенные MCP-серверы:** filesystem, fetch, GitHub, Brave Search, Git, PostgreSQL, memory, sequential-thinking
- **Панель управления:** веб-интерфейс на `/` для мониторинга состояния MCP-серверов
- **Настройка через env-файл:** простой файл `mcp.env`; без редактирования JSON
- **Интеграция с LiteLLM:** подключите LiteLLM, включая [GatewayCrate](https://github.com/hwdsl2/gatewaycrate), чтобы предоставить совместимым LLM доступ к инструментам MCP.
- **Автоматическая сборка:** образы автоматически собираются и публикуются через [GitHub Actions](https://github.com/hwdsl2/uplinkcrate/actions).

Также доступен в составе [Self-Hosted AI Stack](https://github.com/hwdsl2/self-hosted-ai-stack/blob/main/README-ru.md), который развёртывает полный AI-стек на собственном сервере одной командой.

> 📘 [The Self-Hosted AI Builder’s Guide](https://books2read.com/aiguide?store=amazon): практическое руководство по созданию, защите и эксплуатации собственного приватного ИИ-стека.

**Также доступно:**

- Связанные AI-сервисы: [ScribeCrate](https://github.com/hwdsl2/scribecrate/blob/main/README-ru.md), [SpeakCrate](https://github.com/hwdsl2/speakcrate/blob/main/README-ru.md), [EmbedCrate](https://github.com/hwdsl2/embedcrate/blob/main/README-ru.md), [GatewayCrate](https://github.com/hwdsl2/gatewaycrate/blob/main/README-ru.md), [InferCrate](https://github.com/hwdsl2/infercrate/blob/main/README-ru.md), [ParseCrate](https://github.com/hwdsl2/parsecrate/blob/main/README-ru.md)

## Быстрый старт

**Шаг 1.** Запустите UplinkCrate:

```bash
docker run \
    --name mcp \
    --restart=always \
    -v mcp-data:/var/lib/mcp \
    -p 3000:3000/tcp \
    -d hwdsl2/mcp-gateway
```

При первом запуске автоматически генерируется API-ключ, который отображается в логах контейнера. Все API-запросы требуют этот ключ.

> [!NOTE]
> Для развёртывания с доступом из интернета используйте [обратный прокси](#использование-обратного-прокси) для добавления HTTPS. Также замените `-p 3000:3000/tcp` на `-p 127.0.0.1:3000:3000/tcp` в команде `docker run` выше, чтобы предотвратить прямой доступ к незашифрованному порту.

**Шаг 2.** Получите API-ключ:

```bash
# Просмотр ключа в логах контейнера
docker logs mcp

# Или получение ключа для использования в скриптах
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"
```

API-ключ отображается в рамке с надписью **UplinkCrate API key**. Чтобы отобразить его снова в любое время:

```bash
docker exec mcp mcp_manage --showkey
```

**Шаг 3.** Протестируйте API:

```bash
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"

# Проверка конечной точки MCP (по умолчанию включён сервер fetch)
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer $uplink_api_key"

# Проверка работоспособности шлюза (без аутентификации)
curl http://localhost:3000/health
```

**Примечание:** Команды управления через `docker exec` (`mcp_manage`) не требуют API-ключа.

Чтобы узнать больше об использовании этого образа, читайте разделы ниже.

## Сообщество

- 📬 [Получайте новости проектов и бесплатные руководства по развёртыванию](https://selfhostedstack.beehiiv.com/subscribe?utm_campaign=ai-ru) (1–2 письма в месяц; руководства в формате PDF на английском языке)
- 💬 Присоединяйтесь к сообществу [r/selfhostedstack](https://www.reddit.com/r/selfhostedstack/) для обсуждений и демонстрации проектов
- ⭐ Поставьте звезду репозиторию, если он оказался вам полезен — это поможет другим пользователям его найти.

<details>
<summary>Самостоятельно размещаемые VPN и сетевые проекты</summary>

- [Setup IPsec VPN](https://github.com/hwdsl2/setup-ipsec-vpn/blob/master/README-ru.md)
- [IPsec VPN на Docker](https://github.com/hwdsl2/docker-ipsec-vpn-server/blob/master/README-ru.md)
- [WireGuard](https://github.com/hwdsl2/docker-wireguard/blob/main/README-ru.md)
- [OpenVPN](https://github.com/hwdsl2/docker-openvpn/blob/main/README-ru.md)
- [Headscale](https://github.com/hwdsl2/docker-headscale/blob/main/README-ru.md)

</details>

## Требования

- Сервер Linux (локальный или облачный) с установленным Docker
- Не менее 512 МБ доступной оперативной памяти
- TCP-порт 3000 (или настроенный вами) должен быть доступен

## Загрузка

Получите доверенную сборку из [реестра Docker Hub](https://hub.docker.com/r/hwdsl2/mcp-gateway/):

```bash
docker pull hwdsl2/mcp-gateway
```

Либо скачайте из [Quay.io](https://quay.io/repository/hwdsl2/mcp-gateway):

```bash
docker pull quay.io/hwdsl2/mcp-gateway
docker image tag quay.io/hwdsl2/mcp-gateway hwdsl2/mcp-gateway
```

Поддерживаемые платформы: `linux/amd64` и `linux/arm64`.

## Переменные окружения

Все переменные являются необязательными. Если они не установлены, автоматически используются безопасные значения по умолчанию.

Этот Docker-образ использует следующие переменные, которые можно объявить в файле `env` (см. [пример](mcp.env.example)):

| Переменная | Описание | По умолчанию |
|---|---|---|
| `MCP_API_KEY` | API-ключ для аутентификации запросов (автогенерируется, если не задан) | Автогенерируется |
| `MCP_PORT` | TCP-порт шлюза (1–65535) | `3000` |
| `MCP_HOST` | Имя хоста или IP, отображаемые в информации о запуске и выводе `--showkey` | Автоопределяется |
| `MCP_SERVERS` | Список MCP-серверов для включения (через запятую) | `fetch` |
| `MCP_ADMIN_PASSWORD` | Пароль администратора панели управления MCPHub (автогенерируется при первом запуске, если не задан) | Автогенерируется |
| `MCP_DISABLE_USAGE_COUNTS` | Установите `1`, чтобы отключить анонимные агрегированные счётчики использования. | *(не задано)* |

**Примечание:** В файле `env` значения можно заключать в одинарные кавычки, например `VAR='value'`. Не добавляйте пробелы вокруг `=`. Если вы изменили `MCP_PORT`, обновите флаг `-p` в команде `docker run` соответственно.

Пример использования файла `env`:

```bash
cp mcp.env.example mcp.env
# Отредактируйте mcp.env и установите значения, затем:
docker run \
    --name mcp \
    --restart=always \
    -v mcp-data:/var/lib/mcp \
    -v ./mcp.env:/mcp.env:ro \
    -p 3000:3000/tcp \
    -d hwdsl2/mcp-gateway
```

### Доступные MCP-серверы

Укажите серверы для включения в `MCP_SERVERS` (через запятую):

| Сервер | Необходимая конфигурация | Описание |
|---|---|---|
| `fetch` | — | Получение URL и извлечение содержимого |
| `filesystem` | `MCP_FILESYSTEM_DIRS` | Чтение/запись файлов в разрешённых директориях |
| `github` | `MCP_GITHUB_TOKEN` | Доступ к GitHub API (репозитории, issue, PR) |
| `brave-search` | `MCP_BRAVE_API_KEY` | Веб-поиск через Brave Search API |
| `git` | `MCP_GIT_REPO` | Инструменты Git (статус, diff, коммит, лог) |
| `postgres` | `MCP_POSTGRES_URL` | Запросы к базам данных PostgreSQL |
| `memory` | — | Граф знаний / постоянная память |
| `sequential-thinking` | — | Структурированное мышление и рассуждение |

**Пример:**

```bash
# Включить серверы filesystem, fetch и GitHub
MCP_SERVERS=filesystem,fetch,github
MCP_FILESYSTEM_DIRS=/data/docs,/data/projects
MCP_GITHUB_TOKEN=ghp_your_token_here
```

Для сервера `filesystem` примонтируйте директории хоста в контейнер:

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

Для сервера `git` примонтируйте репозиторий в контейнер и задайте `MCP_GIT_REPO`:

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

## Управление MCP-серверами

Используйте `docker exec` для управления шлюзом с помощью вспомогательного скрипта `mcp_manage`.

**Список включённых серверов:**

```bash
docker exec mcp mcp_manage --list
```

**Проверка конкретного сервера:**

```bash
docker exec mcp mcp_manage --test fetch
docker exec mcp mcp_manage --test github
```

**Статус шлюза:**

```bash
docker exec mcp mcp_manage --status
```

**Показать API-ключ:**

```bash
docker exec mcp mcp_manage --showkey
```

**Получить API-ключ** (машиночитаемый формат, для скриптов):

```bash
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"
```

**Добавление или удаление серверов во время работы:**

Используйте панель управления MCPHub (`http://<сервер>:3000/`) для добавления, настройки или удаления MCP-серверов без перезапуска контейнера. Изменения сохраняются в постоянном томе и сохраняются после перезапуска.

> [!NOTE]
> `MCP_SERVERS` применяется только при **первом запуске**, когда создаётся `mcp_settings.json`. После этого серверы следует настраивать через панель управления. При таком сбросе конфигурация серверов, сохранённая через панель управления, будет заменена. Чтобы заново применить `MCP_SERVERS`, удалите файл конфигурации и перезапустите контейнер:

```bash
docker exec mcp rm /var/lib/mcp/mcp_settings.json
docker restart mcp
```

## Использование API

Все API-запросы требуют Bearer Token. Сначала получите API-ключ:

```bash
uplink_api_key="$(docker exec mcp mcp_manage --getkey)"
```

**Конечная точка MCP (все включённые серверы):**

```bash
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer $uplink_api_key"
```

**Конечная точка MCP (конкретный сервер):**

```bash
curl http://localhost:3000/mcp/fetch \
  -H "Authorization: Bearer $uplink_api_key"
```

**Панель управления** (веб-интерфейс):

Откройте `http://localhost:3000/` в браузере с заголовком `Authorization: Bearer <key>` или используйте клиент с поддержкой инъекции заголовков.

**Проверка работоспособности** (без аутентификации):

```bash
curl http://localhost:3000/health
```

### Подключение AI-клиентов

**Cline (VS Code)** — в настройках MCP Cline:

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

**Claude Desktop** — в `claude_desktop_config.json`:

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

## Постоянное хранение данных

Все данные шлюза хранятся в Docker-томе (`/var/lib/mcp` внутри контейнера):

```
/var/lib/mcp/
├── mcp_settings.json   # Сгенерированная конфигурация MCPHub
├── .api_key            # API-ключ (автогенерируется или синхронизируется из MCP_API_KEY)
├── .initialized        # Маркер первого запуска
├── .port               # Сохранённый порт (используется mcp_manage)
├── .servers            # Список включённых серверов (используется mcp_manage)
└── .Caddyfile          # Сгенерированная конфигурация Caddy (прокси аутентификации)
```

`mcp_settings.json` генерируется из `MCP_SERVERS` только при первом запуске. При последующих перезапусках используется существующий файл, сохраняя все изменения, внесённые через панель управления.

Создавайте резервные копии Docker-тома для сохранения конфигурации и API-ключа.

## Использование docker-compose

```bash
cp mcp.env.example mcp.env
# Отредактируйте mcp.env и установите значения, затем:
docker compose up -d
docker logs mcp
```

Пример `docker-compose.yml` (уже включён):

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
      # Примонтируйте директории хоста для сервера filesystem MCP (необязательно):
      # - /path/to/docs:/data/docs:ro
      # - /path/to/code:/data/code:ro

volumes:
  mcp-data:
    name: mcp-data
```

> [!NOTE]
> Для развёртывания с доступом из интернета используйте [обратный прокси](#использование-обратного-прокси) для добавления HTTPS. Также замените `"3000:3000/tcp"` на `"127.0.0.1:3000:3000/tcp"` в файле `docker-compose.yml`, чтобы предотвратить прямой доступ к незашифрованному порту.

## Использование обратного прокси

Для развёртывания с выходом в интернет разместите обратный прокси перед UplinkCrate для обработки HTTPS-терминации. Сервер работает без HTTPS в локальной или доверенной сети, но HTTPS рекомендуется при открытом доступе к API-эндпоинту из интернета.

Используйте один из следующих адресов для доступа к контейнеру UplinkCrate из обратного прокси:

- **`mcp:3000`** — если ваш обратный прокси работает как контейнер в **той же Docker-сети**, что и UplinkCrate (например, определён в том же `docker-compose.yml`).
- **`127.0.0.1:3000`** — если ваш обратный прокси работает **на хосте** и порт `3000` опубликован (по умолчанию `docker-compose.yml` публикует его).

**Примечание:** Заголовок `Authorization: Bearer` автоматически передаётся через обратные прокси — специальная настройка не требуется.

**Пример с [Caddy](https://caddyserver.com/docs/) ([Docker-образ](https://hub.docker.com/_/caddy))** (автоматический TLS через Let's Encrypt, обратный прокси в той же Docker-сети):

`Caddyfile`:
```
mcp.example.com {
  reverse_proxy mcp:3000
}
```

**Пример с nginx** (обратный прокси на хосте):

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
        proxy_http_version 1.1;       # требуется для SSE и WebSocket
        proxy_read_timeout 300s;
        proxy_buffering    off;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
    }
}
```

После настройки обратного прокси установите `MCP_HOST=mcp.example.com` в файле `env`, чтобы в логах запуска и выводе `mcp_manage --showkey` отображался правильный URL конечной точки.

## Обновление Docker-образа

Для обновления Docker-образа и контейнера сначала [загрузите](#загрузка) последнюю версию:

```bash
docker pull hwdsl2/mcp-gateway
```

Если Docker-образ уже актуален, вы увидите:

```
Status: Image is up to date for hwdsl2/mcp-gateway:latest
```

В противном случае будет загружена последняя версия. Удалите и пересоздайте контейнер:

```bash
docker rm -f mcp
# Затем повторно выполните команду docker run из раздела «Быстрый старт» с тем же томом.
```

Ваша конфигурация и API-ключ сохраняются в томе `mcp-data`.

## Использование с другими AI-сервисами

UplinkCrate можно использовать как MCP-шлюз для инструментов в более широком self-hosted AI-стеке.

Готовые полные и облегчённые стеки Docker Compose, примеры ручного запуска через `docker run`, а также примеры голосовых, RAG- и MCP-конвейеров с SpeakCrate, EmbedCrate, GatewayCrate, InferCrate, ParseCrate и UplinkCrate см. в [Self-Hosted AI Stack](https://github.com/hwdsl2/self-hosted-ai-stack/blob/main/README-ru.md).

**Подключите UplinkCrate к GatewayCrate:**

Для GatewayCrate или другого совместимого развёртывания LiteLLM добавьте UplinkCrate как источник MCP-инструментов:

```yaml
# В конфигурации LiteLLM добавьте MCP-шлюз как источник инструментов:
mcp_servers:
  - url: http://mcp:3000/mcp
    transport: http
    headers:
      Authorization: "Bearer <uplink_api_key>"
```

## Счётчики использования

Этот образ использует публичные счётчики скачиваний GitHub Release assets для анонимной агрегированной статистики использования. Эти числа приблизительны и не являются количеством уникальных пользователей или активных установок. Образ не отправляет telemetry payload и не использует частный сборщик. Он выполняет только best-effort запрос после успешного запуска шлюза с подключённым томом `/var/lib/mcp`, а также при первом запуске другой сборки образа для этой постоянной установки. Чтобы отключить это, задайте `MCP_DISABLE_USAGE_COUNTS=1`.

## Технические подробности

- Базовый образ: `samanhappy/mcphub` (Python 3.13 + Node.js 22)
- Прокси аутентификации: [Caddy](https://caddyserver.com) (всегда активен, обеспечивает аутентификацию Bearer Token)
- Шлюз: [MCPHub](https://github.com/samanhappy/mcphub) (многосерверный MCP-концентратор)
- Внутренний порт MCPHub: `3001` (не публикуется; Caddy проксирует с `MCP_PORT`)
- Каталог данных: `/var/lib/mcp` (Docker-том)
- API шлюза: `http://localhost:3000` (или настроенный вами порт)
- Конечная точка MCP: `http://localhost:3000/mcp`
- Мультиархитектурный: `linux/amd64`, `linux/arm64`

## Лицензия

**Примечание:** Программные компоненты внутри готового образа (такие как MCPHub, Caddy и их зависимости) распространяются под лицензиями, выбранными их авторами. При использовании готового образа ответственность за соответствие лицензиям всего содержащегося в нём программного обеспечения лежит на пользователе образа.

Copyright (C) 2026 Lin Song   
Настоящая работа распространяется под [лицензией MIT](https://opensource.org/licenses/MIT).

**MCPHub** является собственностью (C) 2025 samanhappy и распространяется под [лицензией Apache 2.0](https://github.com/samanhappy/mcphub/blob/main/LICENSE).

**Caddy** является собственностью (C) 2015 Matthew Holt и авторов Caddy, и распространяется под [лицензией Apache 2.0](https://github.com/caddyserver/caddy/blob/master/LICENSE).

Этот проект представляет собой независимую Docker-конфигурацию для MCPHub и не связан с MCPHub, не одобрен и не спонсируется им.
