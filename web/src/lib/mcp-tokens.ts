/**
 * MCP token store for the web app. Implementation lives in scripts/mcp-tokens.mjs.
 */
export {
  COL_MCP,
  TOKEN_PREFIX,
  MAX_MCP_KEYS,
  MCP_NAME_SUGGESTIONS,
  createToken,
  hashToken,
  listTokens,
  looksLikeToken,
  mintSecret,
  normalizeKeyName,
  renameToken,
  resolveToken,
  revokeToken,
  serverNameFromLabel,
  tokenDocumentId,
  touchToken,
} from "../../../scripts/mcp-tokens.mjs";
