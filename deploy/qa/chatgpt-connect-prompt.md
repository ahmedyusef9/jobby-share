# Manual QA — ChatGPT ↔ jobby over Tailscale Funnel (#63)

Tester role: human + `user-browsermcp` (Chrome extension). Target: prove or
refute that ChatGPT now connects after the SSE-negotiation fix
(`a80f013`→`869ddb4`, live on the stack since web rebuild 2026-08-25).

If snapshot returns **Not connected**, stop and ask the tester to open the
signed-in chatgpt.com tab, click Browser MCP, then Connect. Do not use
Cursor’s built-in browser.

## Before you start

1. Your key: open http://127.0.0.1:4700/connect → copy the **funnel URL with
   key** (shape: `https://your-machine.your-tailnet.ts.net/mcp/jb_…` — **no :8443**).
2. Confirm stack is current: `docker compose -f deploy/docker-compose.yml up -d web`
   (image must include commit `869ddb4` or later).
3. ChatGPT plan must support custom connectors (Settings → Connectors →
   **Create / Add connector**; some plans call it *Developer mode*).

## Test steps

### A. Add the connector in ChatGPT (chatgpt.com, signed in)
1. Settings → Connectors → Create.
2. Name: `jobby`. URL: paste the `/mcp/jb_…` funnel URL.
3. Authentication: **No authentication**.
4. Click Create/Add.
   - ✅ EXPECT: connector created; tool list shows jobby tools (jobs_fetch,
     submit_score, resume_…).
   - ❌ If error: record the EXACT message text + which step it appeared on.

### B. Use it inside a chat
1. New chat → enable the `jobby` connector (Tools menu).
2. Prompt: *"Use jobby: fetch my stored jobs as a table."*
   - ✅ EXPECT: ONE markdown table, header
     `Company | Role | Location | Posted | Status | Score | Posting | Jobby`,
     nothing after the last row.
3. Prompt: *"How many MCP calls have I used today?"* (whoami)
   - ✅ EXPECT: a number ≤ your plan limit.

### C. Fallback variants (only if A failed)
- Try the alternate URL form: `https://…/api/mcp?key=jb_…` (still no `:8443`)
- Try creating the connector while OFF WiFi on phone LTE (rules out local DNS).

## Recording

- ALL of A+B pass → run:
  `node scripts/qa-ship.mjs 63 pass --evidence "<connector created, tools listed, jobs_fetch table returned>"`
- Any failure → do NOT close; comment on #63 with exact ChatGPT error text,
  which URL variant you used, LTE-vs-WiFi result, and screenshots.
- Do not edit code or other issues.

## Known-good references (if A fails, these isolate the layer)

| Probe | Expected | Meaning |
|-------|----------|---------|
| Browser (any machine): open the `/mcp/jb_…` URL directly | JSON server info payload | funnel + edge fine |
| `curl -X POST <url>` with initialize body | JSON-RPC result | POST path fine |
| Same two probes via phone LTE | same results | truly public |

If direct probes pass but ChatGPT still refuses → capture ChatGPT's error verbatim;
the next protocol layer to inspect is session-id echo + GET-stream semantics.
