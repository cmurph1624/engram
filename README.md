# Engram

Consolidation & recall MCP server (SRS V2). The deterministic core: item registry, FSRS scheduling, vault note read/write. See `CONTEXT.md` for the full picture.

## Setup

Commands below are PowerShell, for the Windows host this runs on (`STIGMERGYLABS`).

### 1. Databases

```powershell
createdb -h 127.0.0.1 -U claudedev engram
createdb -h 127.0.0.1 -U claudedev engram_test    # used by integration tests
```

Windows PostgreSQL has no Unix socket, so the Ubuntu setup's peer auth is unavailable: both
databases are owned by the `claudedev` **role** and reached over TCP with a password. The
password is read from `%APPDATA%\postgresql\pgpass.conf`, so these commands do not prompt —
but that path is per-user, so anything running as another account must be given `PGPASSWORD`
explicitly. The server applies schema migrations automatically on boot.

### 2. Config

```powershell
Copy-Item config.example.json config.json

# generate an auth_token (openssl is not on PATH here)
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
-join ($b | ForEach-Object { $_.ToString('x2') })

# restrict to the owner — the NTFS equivalent of chmod 600
icacls config.json /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

Then edit `config.json` and set `auth_token`, `database_url`, `test_database_url`, and
`vault_path` (see the table in `CONTEXT.md`).

> ⚠️ Edit it in an **editor**, not with `Set-Content` or `Out-File` — both write a UTF-8 BOM,
> which `JSON.parse` rejects with a `SyntaxError` that points nowhere useful. If you must write
> it from a script, use
> `[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.

### 3. Install & build

```powershell
npm install
npm run build      # tsc -> dist/
```

## Run

```powershell
npm start          # node dist/server.js
```

In production it runs under pm2 as the app `engram`, declared in
`Documents\dev\server-config\ecosystem.config.js` — so it is started from there, not with an
ad-hoc `pm2 start`:

```powershell
# elevated PowerShell: the daemon lives in session 0, and an ordinary shell
# fails with EPERM \\.\pipe\rpc.sock
& "C:\Program Files\nodejs\node.exe" `
  "C:\Users\rdpuser\AppData\Roaming\npm\node_modules\pm2\bin\pm2" `
  start "C:\Users\rdpuser\Documents\dev\server-config\ecosystem.config.js" --only engram
```

Call node against the pm2 entry point rather than `pm2.cmd`; the npm shim falls back to a bare
`node` lookup that fails in an elevated shell. Run `pm2 save` after any change, since
`dump.pm2` is what the boot-time `pm2 resurrect` task replays.

## Test

```powershell
npm test           # all unit + integration tests (node:test via tsx)
npm run test:unit  # pure-logic units only (no DB required)
```

Integration tests require the `engram_test` database to exist.

## Health check

```powershell
(Invoke-WebRequest http://localhost:3456/health -UseBasicParsing).Content
# { "ok": true, "items": N, "db": "connected" }
```

`curl` on Windows is an alias for `Invoke-WebRequest` and rejects curl's flags. From the Mac,
real `curl` against the tailnet address works — see `docs/claude_desktop_config.md`.

The `/mcp` endpoint requires `Authorization: Bearer <auth_token>`; `/health` does not.

## Connecting from the Mac

See `docs/claude_desktop_config.md` for the `mcpServers` snippet, and `docs/review_playbook.md` for the daily-review and session-checkpoint conversation flows.
