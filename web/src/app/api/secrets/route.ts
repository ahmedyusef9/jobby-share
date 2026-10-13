import { withTenant } from "@/lib/tenant/http";
import { tenantId } from "@/lib/tenant";
import { HOST_ENGINE_DENIAL, currentAccount, isOperator } from "@/lib/entitlements";
import {
  PROVIDER_ENV,
  deleteTenantKey,
  isMultiTenant,
  listTenantKeys,
  setTenantKey,
} from "@/lib/key-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type KeyMeta = {
  provider: string;
  last4: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  keyVersion: number;
};

/**
 * GET — which providers this tenant has attached, and the last 4 characters so a
 * key can be recognised. Never the key itself, and never another tenant's state:
 * every answer is derived from the caller's own encrypted store.
 */
async function handleGET() {
  const keys = listTenantKeys(tenantId()) as KeyMeta[];
  const byProvider = Object.fromEntries(keys.map((k) => [k.provider, k]));
  return Response.json({
    multiTenant: isMultiTenant(),
    providers: Object.keys(PROVIDER_ENV).map((provider) => ({
      provider,
      attached: Boolean(byProvider[provider]),
      last4: byProvider[provider]?.last4 ?? null,
      updatedAt: byProvider[provider]?.updatedAt ?? null,
      lastUsedAt: byProvider[provider]?.lastUsedAt ?? null,
    })),
  });
}

/**
 * POST — save or rotate this tenant's provider keys.
 * Body: { openrouter?, openai?, anthropic?, gemini? } — a null or empty string
 * removes that provider's key.
 *
 * Operator only (JOBBY-BL-090 / zero-key rule): a host provider key funds engines
 * a member may never spawn, so the paste-key path that stores one must be closed
 * before the body is even parsed — the Config UI hiding the field is not the gate.
 */
async function handlePOST(req: Request) {
  if (!isOperator(currentAccount())) {
    return Response.json({ error: HOST_ENGINE_DENIAL }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const id = tenantId();
  const saved: string[] = [];
  const removed: string[] = [];

  for (const provider of Object.keys(PROVIDER_ENV)) {
    if (!(provider in body)) continue;
    const raw = body[provider];
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      if (deleteTenantKey(id, provider)) removed.push(provider);
      continue;
    }
    if (typeof raw !== "string") {
      return Response.json({ error: `${provider} must be a string` }, { status: 400 });
    }
    setTenantKey(id, provider, raw);
    saved.push(provider);
  }

  if (saved.length === 0 && removed.length === 0) {
    return Response.json({ error: "no known provider keys in request" }, { status: 400 });
  }
  return Response.json({ ok: true, saved, removed });
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
