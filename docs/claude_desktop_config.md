# Connecting Claude Desktop / Cowork to Engram

Engram serves MCP over **Streamable HTTP** at `http://100.88.70.118:3456/mcp`
(the Tailscale IP of the Windows dev server, `STIGMERGYLABS`). Both machines are
on Tailscale, so no port forwarding is needed — but the server must be running
and the Mac must be on the tailnet.

> MagicDNS is enabled on this tailnet, so `http://stigmergylabs.tailc44383.ts.net:3456/mcp`
> works too and survives the node being reassigned a different Tailscale IP. The
> config below uses the MagicDNS hostname for that reason; the raw IP works
> interchangeably.

## 1. Get the auth token

On the server (PowerShell):

```powershell
Select-String -Path C:\Users\rdpuser\Documents\dev\engram\config.json -Pattern auth_token
```

Copy the token value.

## 2. Add the server to Claude Desktop

> **Fully quit Claude Desktop first** (Cmd+Q, or `osascript -e 'quit app "Claude"'`
> — not just closing the window). While the app is running it rewrites
> `claude_desktop_config.json` from its in-memory state on quit, so edits made
> with the app open get clobbered and the change appears not to "take."

Edit `claude_desktop_config.json` on the Mac
(`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://stigmergylabs.tailc44383.ts.net:3456/mcp",
        "--allow-http",
        "--header",
        "Authorization: Bearer PASTE_TOKEN_HERE"
      ]
    }
  }
}
```

> **Why the `mcp-remote` wrapper and not a native `url` entry?** The macOS
> Claude Desktop build only launches `command`/stdio servers from
> `claude_desktop_config.json`. A bare `"url"` + `"headers"` entry (the native
> Streamable HTTP form) is **silently ignored** there — the app logs nothing and
> the tools never appear. `mcp-remote` is a small stdio-to-HTTP bridge that the
> app *can* spawn, and it forwards to Engram's Streamable HTTP endpoint. The raw
> IP (`http://100.88.70.118:3456/mcp`) also works, but the MagicDNS hostname
> survives the node being reassigned a different Tailscale IP.

Restart Claude Desktop. The nine Engram tools (`get_review_queue`,
`reveal_item`, `record_review`, `create_item`, `update_item`, `retire_item`,
`list_items`, `get_stats`, `scan_vault`) should appear.

## 3. Smoke test

In a chat: *"Use engram get_stats."* You should get back active item counts.
Or from the Mac (or any other machine on the tailnet):

```bash
curl http://100.88.70.118:3456/health
# { "ok": true, "items": N, "db": "connected" }
```

On the server itself, use PowerShell — `curl` there is an alias for
`Invoke-WebRequest`, which does not take curl's flags:

```powershell
(Invoke-WebRequest http://127.0.0.1:3456/health -UseBasicParsing).Content
```

## Notes

- `/health` needs no auth; `/mcp` returns `401` without the bearer token.
- The token lives only in `config.json` on the server (gitignored) and in the
  Mac's Claude Desktop config. Rotate by changing both and restarting engram.
- Checking or restarting the pm2 process needs an **elevated** PowerShell — the
  daemon runs in session 0, so an ordinary shell fails with `EPERM \\.\pipe\rpc.sock`.
  Call node against the pm2 entry point rather than `pm2.cmd` (see `~\.claude\CLAUDE.md`):

  ```powershell
  & "C:\Program Files\nodejs\node.exe" `
    "C:\Users\rdpuser\AppData\Roaming\npm\node_modules\pm2\bin\pm2" restart engram
  ```

- If tools don't appear, confirm the Mac can reach the host:
  `curl http://100.88.70.118:3456/health` from the Mac.
- Check `~/Library/Logs/Claude/mcp-server-engram.log` on the Mac. A healthy
  start shows `Server started and connected successfully` followed by an
  `initialize` → `tools/list` exchange. `ECONNREFUSED` there means the host is
  reachable but engram isn't listening (server down or wrong host); **no engram
  lines at all** usually means the config used a native `url` entry the app
  ignored — switch to the `mcp-remote` form above.
