# Connecting Claude Desktop to Engram

Engram serves MCP over **Streamable HTTP** at `http://<host>:3456/mcp`, where `<host>` is
wherever the server runs. A private network such as Tailscale works well: the port never has to
be exposed to the internet, and every `/mcp` request still has to carry the bearer token.

## 1. Get the auth token

It is the `auth_token` value in `config.json` on the server.

## 2. Add the server to Claude Desktop

> **Fully quit Claude Desktop first** (Cmd+Q, not just closing the window). The app rewrites
> `claude_desktop_config.json` from memory when it quits, so edits made while it is open get
> overwritten.

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://<host>:3456/mcp",
        "--allow-http",
        "--header",
        "Authorization: Bearer PASTE_TOKEN_HERE"
      ]
    }
  }
}
```

> **Why `mcp-remote` instead of a native `url` entry?** The macOS Claude Desktop build only
> launches `command` (stdio) servers from this file. A bare `"url"` + `"headers"` entry is
> silently ignored: nothing is logged and the tools never appear. `mcp-remote` is a small
> stdio-to-HTTP bridge the app can spawn, and it forwards to Engram's HTTP endpoint.
> `--allow-http` is only appropriate on a private network; put TLS in front otherwise.

Restart Claude Desktop. The ten Engram tools (`get_review_queue`, `reveal_item`,
`record_review`, `create_item`, `update_item`, `retire_item`, `delete_item`, `list_items`,
`get_stats`, `scan_vault`) should appear.

## 3. Smoke test

In a chat: *"Use engram get_stats."* You should get back item counts. Or from any machine that
can reach the host:

```bash
curl http://<host>:3456/health
# { "ok": true, "items": N, "db": "connected" }
```

## Troubleshooting

- `/health` needs no auth; `/mcp` returns `401` without the bearer token.
- The token lives in `config.json` on the server and in the client config. To rotate it,
  change both and restart Engram.
- Check `~/Library/Logs/Claude/mcp-server-engram.log`. A healthy start shows
  `Server started and connected successfully`, then an `initialize` → `tools/list` exchange.
  `ECONNREFUSED` means the host is reachable but Engram isn't listening. **No engram lines at
  all** usually means the config used a native `url` entry the app ignored; switch to the
  `mcp-remote` form above.
