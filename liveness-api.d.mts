// Hand-written types for liveness-api.mjs's public surface, consumed by
// web/src/lib/mcp/tools.ts (check_liveness). A sibling .d.mts takes precedence
// over TS inferring from the .mjs body — the .mjs keeps its own `@ts-check`
// pragma and JSDoc for editor/CI purposes, unaffected by this file.

export type LivenessApiResult = {
  result: "active" | "expired" | "uncertain";
  code: string;
  reason: string;
};

export function checkLivenessViaApi(url: string): Promise<LivenessApiResult | null>;
export function isAtsPosting(url: string): boolean;
