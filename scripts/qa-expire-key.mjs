/**
 * QA-only: expire an existing MCP key by backdating its expiresAt.
 *
 * Usage:
 *   node scripts/qa-expire-key.mjs <key-name-or-prefix> [--days=7]
 *
 * Requires deploy/.env to have APPWRITE_API_KEY (or set env var).
 * Fails closed with a clear message if the key isn't found or Appwrite isn't configured.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import {
  appwriteConfigured,
  listDocuments,
  updateDocument,
  Q,
} from './appwrite-rest.mjs';
import { COL_MCP, keyStatus } from './mcp-tokens.mjs';

// Load deploy/.env explicitly so this works when run from repo root
config({ path: path.resolve('deploy', '.env'), quiet: true });
config({ path: path.resolve('.env'), quiet: true }); // fallback

function usage() {
  console.error(`
Usage: node scripts/qa-expire-key.mjs <key-name-or-prefix> [--days=N]

Makes an existing live MCP key expired by setting its expiresAt to N days ago
(default 1). Uses the same Appwrite connection as the server.

Example:
  node scripts/qa-expire-key.mjs "ChatGPT"
  node scripts/qa-expire-key.mjs jb_abc123 --days=1
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) usage();

  let target = args[0];
  const daysArg = args.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.split('=')[1]) || 1 : 1;

  if (!appwriteConfigured()) {
    console.error('✗ Appwrite not configured. Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY in deploy/.env');
    process.exit(1);
  }

  const list = await listDocuments(COL_MCP, [Q.limit(50)]);
  if (!list.length) {
    console.error('✗ No MCP keys found in the collection.');
    process.exit(1);
  }

  // Match by prefix (first 7 chars of token) or by name (case-insensitive contains)
  const key = list.find(
    (k) =>
      (k.prefix && target.startsWith(k.prefix)) ||
      String(k.name || '').toLowerCase().includes(target.toLowerCase()) ||
      (k.$id && target.startsWith(k.$id.slice(0, 7))),
  );

  if (!key) {
    console.error('✗ No key matched. Available:');
    for (const k of list) console.error(`  - ${k.name} (${k.prefix || 'no prefix'}) [${keyStatus(k.expiresAt ?? null)}]`);
    process.exit(1);
  }

  if (keyStatus(key.expiresAt ?? null) === 'expired') {
    console.log(`ℹ Key "${key.name}" (${key.prefix}) is already expired.`);
    return;
  }

  const expiresAt = new Date(Date.now() - days * 86_400_000).toISOString();
  console.log(`→ Expiring key "${key.name}" (${key.prefix}) to ${expiresAt}`);
  await updateDocument(COL_MCP, key.$id, { expiresAt });
  console.log('✓ Done. The key will now show as expired in Account → MCP and return 401 on use.');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});