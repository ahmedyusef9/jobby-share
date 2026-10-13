/**
 * Client setup instructions for Cursor / ChatGPT / Claude, generated from
 * the account's plan KPIs so caps in the copy match what the server enforces.
 */

/**
 * @param {{
 *   plan: string,
 *   mcpLimit: number | null,
 *   mcpUsed: number,
 *   scanLimit: number | null,
 *   scanUsed: number,
 *   resultsPerSource: number | null,
 *   endpoint: string,
 *   url?: string | null,
 *   localUrl?: string | null,
 *   local: boolean,
 *   connected: boolean,
 * }} kpi
 */
export function buildMcpClientInstructions(kpi) {
  const mcpLeft =
    kpi.mcpLimit == null ? 'unlimited (operator)' : `${Math.max(0, kpi.mcpLimit - kpi.mcpUsed)} of ${kpi.mcpLimit} left today`;
  const scanLeft =
    kpi.scanLimit == null
      ? 'unlimited (operator)'
      : `${Math.max(0, kpi.scanLimit - kpi.scanUsed)} of ${kpi.scanLimit} left today`;
  const results = kpi.resultsPerSource == null ? 'uncapped' : `${kpi.resultsPerSource}/source`;
  const caps = [
    `Plan: ${kpi.plan}`,
    `MCP tool calls: ${mcpLeft}`,
    `Host scans: ${scanLeft}`,
    `Search results: ${results}`,
  ].join(' · ');

  const chatgptUrl = kpi.url || `${kpi.endpoint}/jb_…`;
  const localUrl = kpi.localUrl || '(mint a key to get the local URL)';

  return {
    capsLine: caps,
    cursor: [
      '## Cursor',
      '',
      caps,
      '',
      '1. Mint a connect key on this page (Create / Rotate).',
      '2. Settings → MCP → Add server, or put this in `~/.cursor/mcp.json`:',
      '',
      '```json',
      JSON.stringify(
        { mcpServers: { jobby: { url: localUrl.includes('jb_') ? localUrl : 'http://localhost:3001/api/mcp?key=jb_…' } } },
        null,
        2,
      ),
      '```',
      '',
      '3. Restart Cursor. Prompts: `@jobby table …`, `@jobby score …`, `@jobby last 24h …`',
      '4. Paste the lean table + Briefs unchanged; fit below as X.X/5. See get_rules → mcpOutputContract.',
    ].join('\n'),
    chatgpt: [
      '## ChatGPT',
      '',
      caps,
      '',
      kpi.local
        ? 'ChatGPT needs a public HTTPS MCP origin (JOBBY_MCP_PUBLIC_URL). Localhost will not work.'
        : [
            '1. ChatGPT → Settings → Apps & connectors → Advanced → Developer mode ON.',
            `2. Connector URL (No authentication): ${chatgptUrl}`,
            '3. Do not use OAuth.',
            '4. New chat → `@jobby table …` or `@jobby score …` — paste table unchanged; fit as X.X/5 below.',
            '5. Output contract: tool get_rules → mcpOutputContract. Each tool call counts against MCP daily KPI.',
          ].join('\n'),
    ].join('\n'),
    claude: [
      '## Claude (Code / Claude.ai)',
      '',
      caps,
      '',
      '**Claude Code (this machine)**',
      '',
      'Put in `.mcp.json` or `claude mcp add --transport http jobby <url>` with',
      '`Authorization: Bearer jb_…`. Prefer the local `/api/mcp` URL from a minted key.',
      '',
      '**Claude.ai**',
      '',
      kpi.local
        ? 'Needs the same public HTTPS origin as ChatGPT. Use Authorization: Bearer jb_… (no ?key=).'
        : [
            `Custom connector: ${kpi.endpoint} (no query string).`,
            'Header: `Authorization: Bearer jb_…`',
            'Respect the MCP daily KPI; search rows are capped by results/source.',
          ].join('\n'),
    ].join('\n'),
  };
}
