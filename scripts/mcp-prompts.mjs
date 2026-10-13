/** Built-in MCP prompts — ChatGPT may surface these beside tools. */
import { MCP_OUTPUT_CONTRACT_SHORT, MCP_OUTPUT_MODES } from './mcp-output-contract.mjs';

export const MCP_PROMPTS = [
  {
    name: 'table',
    description: `Search jobs — ${MCP_OUTPUT_MODES.table}`,
    arguments: [
      { name: 'query', description: 'Role, company, or skills (e.g. Intel software engineer Python)', required: true },
      { name: 'country', description: 'Country or region (default Israel)', required: false },
      { name: 'since_days', description: 'Recency window in days (default 7)', required: false },
    ],
  },
  {
    name: 'score',
    description: `Search jobs — ${MCP_OUTPUT_MODES.score}`,
    arguments: [
      { name: 'query', description: 'Role, company, or skills', required: true },
      { name: 'country', description: 'Country or region (default Israel)', required: false },
      { name: 'since_days', description: 'Recency window in days (default 7)', required: false },
    ],
  },
  {
    name: 'last_24h',
    description: `Jobs posted in the last 24 hours — ${MCP_OUTPUT_MODES.last_24h}`,
    arguments: [
      { name: 'query', description: 'Role, company, or skills', required: true },
      { name: 'country', description: 'Country or region (default Israel)', required: false },
    ],
  },
  {
    name: 'intel',
    description: 'Intel roles in Israel — same table contract as `table`.',
    arguments: [
      { name: 'query', description: 'Optional extra keywords beyond Intel', required: false },
      { name: 'since_days', description: 'Recency window in days (default 30)', required: false },
    ],
  },
];

export function promptsListResult() {
  return {
    prompts: MCP_PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  };
}

function tablePromptText({ query, country, sinceDays, mode = 'table' }) {
  const since = String(sinceDays ?? '').trim();
  const sinceArg = since ? `, since_days=${since}` : ', since_days=7';
  const sinceLine = since
    ? ` Posted filter: last ${since} day(s). Mark rows outside that window as stale if Posted proves older.`
    : ' Use since_days 7 unless the person asked otherwise.';
  const fitLine =
    mode === 'table'
      ? 'Do not add fit scores unless the user asked.'
      : 'After the table and Briefs: fit scores in the same row order as X.X/5 (label as Assistant fit score), then a short Top Matches section.';
  return [
    `Use Jobby tool job_table with query="${query}", country="${country}"${sinceArg}.`,
    'Paste the tool output verbatim — lean table (Company, Role, Location, Posted, Posting, Jobby) and Briefs when present.',
    'Do not create a second summary table.',
    fitLine,
    MCP_OUTPUT_CONTRACT_SHORT,
    sinceLine,
  ].join(' ');
}

/**
 * @param {string} name
 * @param {Record<string, string>} args
 */
export function promptGetResult(name, args = {}) {
  const key = String(name || '').trim();
  const query = String(args.query ?? '').trim();
  const country = String(args.country ?? 'Israel').trim() || 'Israel';
  const since = String(args.since_days ?? '').trim();

  if (key === 'table' || key === 'score') {
    if (!query) return { error: 'query required' };
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: tablePromptText({ query, country, sinceDays: since, mode: key }),
          },
        },
      ],
    };
  }

  if (key === 'last_24h') {
    if (!query) return { error: 'query required' };
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Use Jobby tool job_table with query="${query}", country="${country}", since_days=1.`,
              'Paste the returned table and Briefs unchanged.',
              'Split rows: in-window (Posted within 24h) vs stale/out-of-window if Posted is older or missing.',
              'Then Assistant fit scores as X.X/5 in table order, then Top Matches.',
              MCP_OUTPUT_CONTRACT_SHORT,
            ].join(' '),
          },
        },
      ],
    };
  }

  if (key === 'intel') {
    const q = query ? `Intel ${query}` : 'Intel software engineer backend python infrastructure';
    const days = since || '30';
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Use Jobby tool job_table with query="${q}", country="Israel", since_days=${days}, sources=["linkedin","drushim"].`,
              'Paste the returned table and Briefs unchanged. Fit commentary below as X.X/5 only when asked.',
              MCP_OUTPUT_CONTRACT_SHORT,
            ].join(' '),
          },
        },
      ],
    };
  }

  return { error: `unknown prompt: ${key}` };
}
