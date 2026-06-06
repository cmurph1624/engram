# Engram

Consolidation & recall MCP server (SRS V2). The deterministic core: item registry, FSRS scheduling, vault note read/write. See `CONTEXT.md` for the full picture.

## Setup

### 1. Databases (peer auth — no password)

```bash
createdb engram
createdb engram_test    # used by integration tests
```

Both are owned by the `claudedev` OS user and reachable only via the local Unix socket. The server applies schema migrations automatically on boot.

### 2. Config

```bash
cp config.example.json config.json
# edit config.json: set auth_token to `openssl rand -hex 32`
chmod 600 config.json
```

### 3. Install & build

```bash
npm install
npm run build      # tsc -> dist/
```

## Run

```bash
npm start                                    # node dist/server.js
# or under pm2 (production):
~/.npm-global/bin/pm2 start dist/server.js --name engram && ~/.npm-global/bin/pm2 save
```

## Test

```bash
npm test           # all unit + integration tests (node:test via tsx)
npm run test:unit  # pure-logic units only (no DB required)
```

Integration tests require the `engram_test` database to exist.

## Health check

```bash
curl http://localhost:3456/health      # { "ok": true, "items": N, "db": "connected" }
```

The `/mcp` endpoint requires `Authorization: Bearer <auth_token>`; `/health` does not.

## Connecting from the Mac

See `docs/claude_desktop_config.md` for the `mcpServers` snippet, and `docs/review_playbook.md` for the daily-review and session-checkpoint conversation flows.
