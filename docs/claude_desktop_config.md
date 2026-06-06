# Connecting Claude Desktop / Cowork to Engram

Engram serves MCP over **Streamable HTTP** at `http://100.109.128.123:3456/mcp`
(the Ubuntu server's Tailscale IP). Both machines are on Tailscale, so no port
forwarding is needed — but the server must be running (`pm2 status engram`) and
the Mac must be on the tailnet.

## 1. Get the auth token

On the server:

```bash
grep auth_token ~/Documents/dev/engram/config.json
```

Copy the token value.

## 2. Add the server to Claude Desktop

Edit `claude_desktop_config.json` on the Mac
(`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "engram": {
      "url": "http://100.109.128.123:3456/mcp",
      "headers": {
        "Authorization": "Bearer PASTE_TOKEN_HERE"
      }
    }
  }
}
```

Restart Claude Desktop. The nine Engram tools (`get_review_queue`,
`reveal_item`, `record_review`, `create_item`, `update_item`, `retire_item`,
`list_items`, `get_stats`, `scan_vault`) should appear.

## 3. Smoke test

In a chat: *"Use engram get_stats."* You should get back active item counts.
Or from any shell on the tailnet:

```bash
curl http://100.109.128.123:3456/health
# { "ok": true, "items": N, "db": "connected" }
```

## Notes

- `/health` needs no auth; `/mcp` returns `401` without the bearer token.
- The token lives only in `config.json` (mode 600) on the server and in the
  Mac's Claude Desktop config. Rotate by changing both and `pm2 restart engram`.
- If tools don't appear, confirm the Mac can reach the IP: `curl http://100.109.128.123:3456/health` from the Mac.
