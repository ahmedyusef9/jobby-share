---
name: tailscale-serve
description: >-
  Point Tailscale Serve/Funnel at Jobby Compose. Use when ChatGPT/Claude/Cursor
  cannot reach the MCP URL, after .ports.yml compose-web changes, or when
  enabling HTTPS on this machine's *.ts.net name. Backend is always
  127.0.0.1:<compose-web>, never 3001.
---

# Tailscale Serve / Funnel (jobby)

Load `.cursor/rules/48-tailscale-serve.mdc` and `.ports.yml` first. Product
runtime is Compose (`47-docker-first`). Issue: JOBBY-BL-082 / #87.

## Read the host port

```bash
# compose-web from .ports.yml (do not hardcode)
python3 -c "import re; print(re.search(r'compose-web:\\s*(\\d+)', open('.ports.yml').read()).group(1))"
```

Call that value `$WEB`. Compose must already publish `127.0.0.1:$WEB:3000`.

```bash
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB}/signin"
# expect 200
```

If that is not 200, fix Compose. Do not touch Tailscale yet.

## Apply the mapping

`$HOST` = this machine’s MagicDNS (`tailscale status --json` → `Self.DNSName`).

**ChatGPT / Claude.ai (standard HTTPS, no port in the URL).** Keep OmniRoute
on `/`. MCP paths only:

```bash
tailscale funnel --bg --https=443 --set-path=/mcp "http://127.0.0.1:${WEB}/mcp"
tailscale funnel --bg --https=443 --set-path=/api/mcp "http://127.0.0.1:${WEB}/api/mcp"
tailscale funnel --bg --https=443 --set-path=/sse "http://127.0.0.1:${WEB}/sse"
tailscale funnel --bg --https=443 --set-path=/.well-known "http://127.0.0.1:${WEB}/.well-known"
```

**Cursor / QA MCP-only origin (explicit port — ChatGPT rejects this):**

```bash
tailscale funnel --bg --https=8443 "http://127.0.0.1:${WEB}"
```

**Full-app QA origin (optional, separate port):**

```bash
tailscale funnel --bg --https=8444 "http://127.0.0.1:${WEB}"
```

Tailnet-only (no public internet) — same backends with `tailscale serve`
instead of `funnel`. ChatGPT still needs Funnel.

## Confirm

```bash
tailscale funnel status
# :443 MCP paths and :8443 / :8444 must show http://127.0.0.1:<compose-web>
# not :3001

curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/event-stream' \
  "https://${HOST}/api/mcp"
# 200 or 401 — not 502, not OmniRoute HTML

curl -s -o /dev/null -w '%{http_code}' "https://${HOST}:8443/signin"
# 200 — 502 means the Funnel backend is down or still on :3001
```

Set `JOBBY_MCP_PUBLIC_URL=https://${HOST}` (no `:8443`) in `deploy/.env`,
rebuild web, then **re-mint** Connect keys so ChatGPT snippets omit the port.

## Leave alone

| Listener | Backend | Owner |
|---|---|---|
| `:443` `/` | OmniRoute (or other gateway) | not Jobby |
| `:10000` | other local service | not Jobby |
| `your-gateway:8443` | OmniRoute `/v1` + MCP | other machine |

## Clients

- ChatGPT: Funnel one-link `https://<host>/mcp/<key>` (no port, no OAuth).
- Claude.ai: same `:443` URL.
- Cursor (public): `:8443/mcp/<key>`, or `/api/mcp` + `Authorization: Bearer <key>`.
- Cursor (on tailnet): Serve URL is enough.
- Never put the key in an issue or chat. Rotate if it leaked.

## Disable (this machine’s Jobby ports only)

```bash
tailscale funnel --https=8443 off
tailscale funnel --https=8444 off
# do not turn off :443 / unless you intend to drop OmniRoute paths too
```
