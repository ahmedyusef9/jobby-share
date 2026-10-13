# MCP Funnel runbook

Use Tailscale Funnel to make Jobby reachable by clients outside the tailnet.

ChatGPT and Claude.ai only dial **standard HTTPS (`:443`)** and reject an explicit
port such as `:8443`. The connector URL is `https://<machine>.<tailnet>.ts.net/mcp/<key>`
with no port. `:443` `/` stays OmniRoute; only MCP paths proxy to Compose.
`:8443` is the MCP-only origin for clients that accept a port (Cursor / QA).
Use `:8444` for external-vantage browser E2E because the MCP host intentionally
returns 404 for dashboard and account routes.

## Configure and enable

Set both public origins in `deploy/.env`:

```dotenv
AUTH_URL=http://127.0.0.1:<compose-web>   # from .ports.yml — never 3001
JOBBY_MCP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
JOBBY_APP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8444
```

Rebuild the web service after changing either origin, then re-mint Connect keys because generated connection and download links include the configured origin.

Read `.ports.yml` `compose-web` first. Call it `$WEB`. Compose must publish `127.0.0.1:$WEB:3000`. Skill: `.cursor/skills/tailscale-serve/SKILL.md`.

```bash
# ChatGPT / Claude.ai (no port in the URL). Keep OmniRoute on /
tailscale funnel --bg --https=443 --set-path=/mcp "http://127.0.0.1:${WEB}/mcp"
tailscale funnel --bg --https=443 --set-path=/api/mcp "http://127.0.0.1:${WEB}/api/mcp"
tailscale funnel --bg --https=443 --set-path=/sse "http://127.0.0.1:${WEB}/sse"
tailscale funnel --bg --https=443 --set-path=/.well-known "http://127.0.0.1:${WEB}/.well-known"

# MCP-only origin for Cursor / QA (ChatGPT will not accept this port)
tailscale funnel --bg --https=8443 "http://127.0.0.1:${WEB}"

# Full app origin used only for external-vantage release QA
tailscale funnel --bg --https=8444 "http://127.0.0.1:${WEB}"

tailscale funnel status
```

Disable exposure with:

```bash
tailscale funnel --https=8443 off
tailscale funnel --https=8444 off
```

Do not turn off `:443` `/` unless you intend to drop OmniRoute.

Tailscale provisions and renews the HTTPS certificate for the `*.ts.net` Funnel endpoint. Keep the machine enrolled, Funnel enabled, and Tailscale running. If certificate or TLS checks fail, verify `tailscale status`, `tailscale funnel status`, system time, and the machine's tailnet DNS name before recreating the Funnel.

## Verify from outside the tailnet

Run these commands from a machine or network that is not using the tailnet:

```bash
curl -fsS -H 'Accept: text/event-stream' \
  "https://<machine>.<tailnet>.ts.net/api/mcp"
curl -fsS "https://<machine>.<tailnet>.ts.net:8443/"
```

The first command returns an SSE comment beginning with `: connected`. The `:443` root (`/`) may still show OmniRoute — that is expected.

Run the complete Playwright suite through the public origin:

```bash
JOBBY_E2E_BASE_URL="https://<machine>.<tailnet>.ts.net:8444" \
JOBBY_MCP_PUBLIC_URL="https://<machine>.<tailnet>.ts.net" \
JOBBY_E2E_EMAIL="<member-email>" \
JOBBY_E2E_PASSWORD="<member-a-password>" \
JOBBY_E2E_MEMBER_B_EMAIL="<member-b-email>" \
JOBBY_E2E_MEMBER_B_PASSWORD="<member-b-password>" \
JOBBY_OPERATOR_SECRET="<operator-secret>" \
JOBBY_E2E_MCP_KEY="<member-connect-key>" \
npm run test:e2e
```

The full suite uses `JOBBY_E2E_BASE_URL` for dashboard/auth/API journeys. The dedicated Funnel tests use `JOBBY_MCP_PUBLIC_URL` when provided, so the release gate proves both the full public app and the ChatGPT origin.

## Connect clients

Mint a scoped key under **Account → MCP**. Prefer a short expiry and the minimum required scope.

### ChatGPT

Create a custom connector and paste the one-link URL shown by Jobby (no port):

```text
https://<machine>.<tailnet>.ts.net/mcp/<key>
```

Do not use `:8443`. ChatGPT rejects custom ports. Do not use OAuth.

### Cursor

Add the Streamable HTTP endpoint as a remote MCP server. On this tailnet, loopback `/api/mcp` is fine; from outside, `:8443` or the `:443` `/mcp/<key>` URL both work:

```json
{
  "mcpServers": {
    "jobby": {
      "url": "https://<machine>.<tailnet>.ts.net/mcp/<key>"
    }
  }
}
```

### Claude

**Claude.ai only dials standard HTTPS (`:443`)** and does not accept explicit ports. Use the same URL as ChatGPT:

```text
https://<machine>.<tailnet>.ts.net/mcp/<key>
https://<machine>.<tailnet>.ts.net/api/mcp   (with Authorization: Bearer <key>)
```

Claude Desktop and Claude Code can also dial `:8443` with `Authorization: Bearer <key>`.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| Timeout, connection refused, or **HTTP 502** | Funnel backend is down or still on a stale host port (`3001`) | Confirm Compose on `.ports.yml` `compose-web`, then remap Funnel (see `tailscale-serve` skill) |
| ChatGPT will not add the connector | URL includes `:8443` | Use `https://<host>/mcp/<key>` with no port |
| Root shows OmniRoute | Client probed `:443` `/` | Expected. MCP is `/mcp` and `/api/mcp`. `/.well-known` must map to Jobby |
| `401 unauthorized` | Key is stale, revoked, or expired | Re-mint under Account → MCP and update the client/test secret |
| Generated links point to localhost or `:8443` | Public origin still has a port or was absent | Set `JOBBY_MCP_PUBLIC_URL` with no port, rebuild web, and re-mint |
| SSE probe returns HTML | Wrong route or reverse-proxy mapping | Request `/api/mcp` with `Accept: text/event-stream` on `:443` (no port) |
| TLS/certificate error | Tailscale state, clock, or tailnet hostname is stale | Check Funnel status, machine enrollment, DNS name, and system time |
| Tests work locally but fail publicly | A test or deployment path still uses loopback | Set `JOBBY_E2E_BASE_URL` to the Funnel origin and inspect the first failed request/trace |
