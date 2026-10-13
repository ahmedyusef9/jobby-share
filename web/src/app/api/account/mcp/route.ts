import { withTenant } from "@/lib/tenant/http";
import { tenantId } from "@/lib/tenant";
import {
  createToken,
  listTokens,
  renameToken,
  revokeToken,
  serverNameFromLabel,
  MAX_MCP_KEYS,
  MCP_NAME_SUGGESTIONS,
} from "@/lib/mcp-tokens";
import { currentAccount, planLimits, isOperator } from "@/lib/entitlements";
import { mcpUsageToday } from "@/lib/mcp-quota";
import { countToday, scanDailyLimit } from "@/lib/scan-quota";
import { buildMcpClientInstructions } from "@/lib/mcp-instructions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicOrigin() {
  return process.env.JOBBY_MCP_PUBLIC_URL?.trim().replace(/\/$/, "") || "";
}

function localOrigin(req: Request) {
  const env = process.env.AUTH_URL?.trim().replace(/\/$/, "");
  if (env) return env;
  return new URL(req.url).origin;
}

function originFrom(req: Request) {
  return publicOrigin() || localOrigin(req);
}

function isLocalOrigin(origin: string) {
  const pub = publicOrigin();
  if (pub && origin === pub) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return true;
    const host = u.hostname;
    return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
  } catch {
    return true;
  }
}

function snippets(req: Request, token: string, label: string) {
  const origin = originFrom(req);
  const local = localOrigin(req);
  const endpoint = `${origin}/mcp`;
  const url = `${origin}/mcp/${token}`;
  const localUrl = `${local}/api/mcp?key=${token}`;
  const server = serverNameFromLabel(label);
  return {
    endpoint,
    url,
    localUrl,
    local: isLocalOrigin(origin),
    name: label,
    serverName: server,
    cursor: {
      mcpServers: {
        [server]: {
          url: `${local}/api/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    claudeCode: {
      mcpServers: {
        [server]: {
          type: "http",
          url: `${local}/api/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    chatgpt: {
      serverUrl: url,
      authentication: "none",
      displayName: label,
    },
  };
}

type TokenRow = {
  id: string;
  name: string;
  prefix: string | null;
  scope?: string | null;
  expiresAt?: string | null;
  expiresInDays?: number | null;
  expired?: boolean;
  status?: string;
  createdAt: string | null;
  lastUsedAt: string | null;
};

function keysPayload(tokens: TokenRow[]) {
  return tokens.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope || "read-write",
    expiresAt: t.expiresAt ?? null,
    expiresInDays: t.expiresInDays ?? null,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    status: t.status === "expired" || t.expired ? ("expired" as const) : ("live" as const),
  }));
}

async function kpiPayload(req: Request, tokenUrl?: string | null, localUrl?: string | null) {
  const account = currentAccount();
  const tid = tenantId();
  const origin = originFrom(req);
  const limits = planLimits(account);
  const mcp = await mcpUsageToday(tid, account);
  let scanUsed = 0;
  try {
    if (tid !== 'default') scanUsed = await countToday(tid);
  } catch {
    scanUsed = 0;
  }
  const scanLimit = isOperator(account) ? null : scanDailyLimit(process.env, account);
  const plan = account.plan ?? "alpha";
  const endpoint = `${origin}/mcp`;
  const local = isLocalOrigin(origin);
  const instructions = buildMcpClientInstructions({
    plan,
    mcpLimit: mcp.limit,
    mcpUsed: mcp.used,
    scanLimit,
    scanUsed,
    resultsPerSource: limits?.results ?? null,
    endpoint,
    url: tokenUrl ?? null,
    localUrl: localUrl ?? null,
    local,
    connected: Boolean(tokenUrl),
  });
  return {
    plan,
    role: account.role ?? "member",
    kpi: {
      mcp: {
        used: mcp.used,
        limit: mcp.limit,
        remaining: mcp.limit == null ? null : Math.max(0, mcp.limit - mcp.used),
      },
      scans: {
        used: scanUsed,
        limit: scanLimit,
        remaining: scanLimit == null ? null : Math.max(0, scanLimit - scanUsed),
      },
      resultsPerSource: limits?.results ?? null,
      priceUsd: limits?.priceUsd ?? 0,
    },
    instructions,
    capsLine: instructions.capsLine,
  };
}

async function handleGET(req: Request) {
  const origin = originFrom(req);
  const tokens = (await listTokens(tenantId())) as TokenRow[];
  const live = tokens[0] ?? null;
  const kpi = await kpiPayload(req);
  return Response.json({
    connected: tokens.length > 0,
    prefix: live?.prefix ?? null,
    createdAt: live?.createdAt ?? null,
    lastUsedAt: live?.lastUsedAt ?? null,
    endpoint: `${origin}/mcp`,
    local: isLocalOrigin(origin),
    maxKeys: MAX_MCP_KEYS,
    nameSuggestions: MCP_NAME_SUGGESTIONS,
    keys: keysPayload(tokens),
    ...kpi,
  });
}

async function handlePOST(req: Request) {
  let body: { name?: string; rotate?: boolean; scope?: string; expires?: string } = {};
  try {
    const raw = await req.text();
    if (raw.trim()) {
      body = JSON.parse(raw) as { name?: string; rotate?: boolean; scope?: string; expires?: string };
    }
  } catch {
    const err = new Error("invalid JSON body");
    (err as { status?: number }).status = 400;
    throw err;
  }
  const minted = await createToken(tenantId(), {
    name: body.name,
    rotate: Boolean(body.rotate),
    scope: body.scope === "read" ? "read" : "read-write",
    expires: body.expires === "7d" || body.expires === "30d" ? body.expires : "never",
  });
  const snip = snippets(req, minted.token, minted.name);
  const kpi = await kpiPayload(req, snip.url, snip.localUrl);
  const tokens = (await listTokens(tenantId())) as TokenRow[];
  return Response.json({
    ...snip,
    ...kpi,
    token: minted.token,
    prefix: minted.prefix,
    createdAt: minted.createdAt,
    expiresAt: minted.expiresAt,
    expires: minted.expires,
    scope: minted.scope,
    name: minted.name,
    id: minted.id,
    shownOnce: true,
    maxKeys: MAX_MCP_KEYS,
    nameSuggestions: MCP_NAME_SUGGESTIONS,
    keys: keysPayload(tokens),
    connected: true,
  });
}

async function handlePATCH(req: Request) {
  let body: { id?: string; name?: string } = {};
  try {
    body = (await req.json()) as { id?: string; name?: string };
  } catch {
    const err = new Error("invalid JSON body");
    (err as { status?: number }).status = 400;
    throw err;
  }
  const updated = await renameToken(tenantId(), String(body.id || ""), body.name);
  const tokens = (await listTokens(tenantId())) as TokenRow[];
  return Response.json({
    ok: true,
    key: { ...updated, status: "live" as const },
    keys: keysPayload(tokens),
  });
}

async function handleDELETE(req: Request) {
  const url = new URL(req.url);
  let id = url.searchParams.get("id")?.trim() || "";
  if (!id) {
    try {
      const raw = await req.text();
      if (raw.trim()) {
        const body = JSON.parse(raw) as { id?: string };
        id = String(body.id || "").trim();
      }
    } catch {
      /* revoke all */
    }
  }
  const result = await revokeToken(tenantId(), id || undefined);
  return Response.json({ ok: true, ...result });
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
export const PATCH = withTenant(handlePATCH);
export const DELETE = withTenant(handleDELETE);
