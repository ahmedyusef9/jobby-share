# UI and API scenarios

Base: `{baseUrl}` (default `http://localhost:3001`). Member account from `e2e.local.json`.

**Nav click is not a pass.** After each action, snapshot and assert the product changed (count, disabled state, error copy, preview text). Click the desktop `complementary` sidebar, not the first (drawer) copy. Native `<select>`: `browser_select_option`, not `browser_click` on `<option>` (times out).

| Id | Surface | Action | Pass |
|---|---|---|---|
| S01 | `/signin` | Load page | Email + Password + **Sign in** visible (or Operator-only if email auth off — then FAIL this pack) |
| S02 | `/signin` | Tab **Sign in** | `aria-selected=true` on Sign in, not Create account |
| S03 | `/signin` | Fill Email, fill Password, click **Sign in** | Leaves `/signin`; sidebar **Today** |
| S04 | `/signin` | Tab **Create account** then back to **Sign in** | Tabs switch; no account created |
| S05 | Today | Paste a job URL, click **Evaluate** | Worker job appears; success **or** honest Config/CLI error — not a silent no-op |
| S06 | Explore | Type in **Filter results** | List companies change (not just the textbox value) |
| S07 | Explore | **Add to pipeline** on one row | Button becomes **In pipeline** (disabled); **Add all N** decrements |
| S08 | Pipeline | Set country to **Any country** via `browser_select_option` values `[""]` | Inbox rows appear; Israel default had shown **0 matches** with **INBOX N > 0** |
| S09 | Pipeline | **Shortlist** one row | Button becomes **Shortlisted** (pressed); **Score N** appears |
| S10 | Workers | Open the Evaluate job | Status/error + Activity list (Starting / Using … / Config copy) |
| S11 | Portals | **Check portal health**, wait ~60s | Counts like `N live · M broken · K tracked`, not just the button |
| S12 | Analytics | Load after a failed evaluate | **0 tracked evaluations** (does not invent scores) |
| S13 | CV | Type markdown in the editor | Live preview headings change; do **not** Save unless reversing |
| S14 | CV | Click a color swatch | Swatch pressed; heading hex changes |
| S15 | Rules | Click **MUST** | Textarea gains `- MUST:`; chip shows **MUST · 1**; do **not** Save |
| S16 | Config | Member: CLI picker disabled; click a provider | **No setup needed** disabled; provider click does not require Save |
| S17 | Account | **Download my data** | Click does not 500; delete stays disabled until email typed (do **not** type it) |
| S18 | Direct | Open `/admin` | 404 / not-found for member |
| S19 | Theme | Click theme toggle | Label flips light/dark |
| S20 | Assistant | Open **Ask**, click a suggestion chip | Prompt appears in the thread; reply **or** Config/key error |
| S21 | Sign out | Menu **Sign out** | Returns to `/signin` |
| A01 | OmniRoute | `omniroute_get_health` | `ok` / healthy, not 5xx |
| A02 | OmniRoute | `omniroute_list_models_catalog` chat | ≥1 model |
| A03 | OpenCode path | Same config as `~/.config/opencode/opencode.json`: `POST {baseURL}/chat/completions` on your-gateway-host with `model: auto/best-coding` (not `omniroute/auto/best-coding` on the wire), prompt `Reply with the single word pong.` | Reply contains `pong`. After MCP reload, Cursor `omniroute_route_request` with the same model should also return `pong` (not `Caller=anonymous`). |

Button × role matrix (every control): [rbac.md](rbac.md).

## Explore refine + sources (member)

| Id | Surface | Action | Pass |
|---|---|---|---|
| S23 | Explore | **Refine search** | Roles / Exclude / Sources / Location visible |
| S24 | Explore | Sources chips | **Greenhouse, Lever, Ashby, Workday, Drushim, LinkedIn** |
| S25 | Explore | Type `Israel` in **Only in**, Enter | Chip **Remove Israel**; URL `loc=Israel` after Re-cast |
| S26 | Explore | **Re-cast (free)** with Israel | Count changes vs unfiltered (e.g. 65 → 1); 0 tokens; skipped-ATS progress is OK |

## CV ingest vs photo

| Id | Surface | Action | Pass |
|---|---|---|---|
| S27 | `/` first-run | Paste or **Upload PDF / file** | Only when doctor phase is first-run (empty install). Pipeline data without `cv.md` still shows Today, not the drop zone |
| S28 | `/cv` | **Upload** in toolbar | Photo cropper, not resume ingest |
| S29 | `/cv` | Empty editor (“No cv.md yet”) | Resume drop zone **is** on this page; toolbar **Upload** remains the photo |

## Operator pack (after member S21)

Read secret from `deploy/.env`. Never echo it.

| Id | Surface | Action | Pass |
|---|---|---|---|
| O01 | `/signin` | **Operator sign-in** | Secret field + **Continue as operator** |
| O02 | `/signin` | Fill secret, continue | Leaves `/signin`; account menu is not the member name |
| O03 | Account menu | Open | **Operator** link present |
| O04 | `/admin` | Load | Capacity + accounts table, not 404 |
| O05 | `/config` | Load | **Use an AI tool you have** visible; OpenCode card present |
| O06 | `/jobs` | Load | Queue snapshot; may include jobs the member cannot see |

Optional (only if the user asks to spend a scan quota):

| Id | Surface | Action | Pass |
|---|---|---|---|
| S22 | Explore | Start one scan, wait for status | Quota or progress UI; no 500 |
