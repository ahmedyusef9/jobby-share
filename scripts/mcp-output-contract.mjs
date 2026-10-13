/**
 * Jobby MCP output contract — procedural rules for how hosts must present
 * explore_jobs / job_table / list_applications results. Loaded on initialize,
 * echoed in tool footers, and intended for modes/_custom.md (via get_rules).
 */

export const MCP_OUTPUT_CONTRACT_VERSION = 1;

/** Full contract — also suitable for modes/_custom.md ## MCP job search output */
export const MCP_OUTPUT_CONTRACT = `JOBBY RESPONSE CONTRACT

When the user invokes @jobby / job_table / explore_jobs / list_applications:

1. Preserve the exact markdown table returned by the tool — unchanged order, columns, and links.
2. Never reconstruct, reorder, rename, or replace that table.
3. Never create a second jobs table unless the user explicitly asks for a different format.
4. After the table (and Briefs when present), provide fit analysis separately below.
5. Fit scores use X.X/5 only — never /100 in the presentation layer.
6. Clearly label scores:
   - Jobby tracker score — only when the tool row includes Score (tracker/list_applications).
   - Assistant fit score — when you infer fit; prefix as "Assistant fit score" or "My fit score".
7. Search/explore rows have no Jobby score column — do not invent one in the table.
8. For "last 24h" / since_days=1: only call rows "last 24h" when Posted falls inside the window.
9. If since_days filters loosely and older rows appear, mark them stale/out-of-window — do not mix them into "last 24h".
10. When results hit the plan cap, state "showing X of Y" from the footer — do not imply the list is exhaustive.
11. For "all jobs", use the highest limit the plan allows and report how many were actually returned.

Output modes (user intent):
- table — exact tool table + Briefs; no extra tables.
- score — exact table + Briefs, then fit scores in table order as X.X/5, then optional Top Matches.
- last_24h — same as score, but split in-window vs stale rows when Posted proves otherwise.`;

/** Compact line for initialize + tool descriptions */
export const MCP_OUTPUT_CONTRACT_SHORT =
  'Preserve explore/job_table tables verbatim; fit analysis below as X.X/5; label assistant scores; respect Posted for last-24h; state plan caps.';

export const MCP_OUTPUT_MODES = {
  table: 'Exact Jobby table + Briefs only. No second table. No fit scores unless asked.',
  score:
    'Exact table + Briefs, then fit scores in the same row order (X.X/5), then a short Top Matches section.',
  last_24h:
    'Exact table + Briefs; split in-window vs stale by Posted timestamp; then fit scores (X.X/5) and Top Matches.',
};

/** Markdown block for modes/_custom.template.md / update_rules */
export const MCP_CUSTOM_MD_SECTION = `## MCP job search output

${MCP_OUTPUT_CONTRACT}
`;

/** @param {string} md */
export function hasMcpOutputSection(md) {
  return /##\s+MCP job search output/i.test(String(md || ''));
}

/** Instructions field on MCP initialize */
export function mcpInitializeInstructions() {
  return [
    'Built-in prompts: `table`, `score`, `last_24h`, `intel`. Tools: `job_table` / `explore_jobs` → ONE lean table (Company, Role, Location, Posted, Posting, Jobby) + Briefs.',
    MCP_OUTPUT_CONTRACT_SHORT,
    'Full contract: tool `get_rules` → mcpOutputContract, or house rules in modes/_custom.md.',
  ].join(' ');
}
