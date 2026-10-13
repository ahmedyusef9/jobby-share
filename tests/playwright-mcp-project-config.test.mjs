import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, ROOT } from './helpers.mjs';

console.log('\nPlaywright MCP — project configuration');

const configPath = join(ROOT, '.cursor', 'mcp.json');

if (!existsSync(configPath)) {
  fail('.cursor/mcp.json exists');
} else {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const server = config.mcpServers?.playwright;
  const args = server?.args ?? [];

  server?.command === 'npx'
    ? pass('Playwright MCP starts through npx')
    : fail('Playwright MCP command must be npx');

  args.includes('@playwright/mcp@0.0.80')
    ? pass('Playwright MCP package is pinned to 0.0.80')
    : fail('Playwright MCP package must be pinned to 0.0.80');

  args.includes('--extension')
    ? pass('Playwright MCP reuses the attended browser through extension mode')
    : fail('Playwright MCP must use --extension for manual QA');
}
