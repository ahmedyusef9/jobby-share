import { withTenant } from "@/lib/tenant/http";
import { tenantRoot } from "@/lib/tenant";
import { listProfiles, createProfile } from "@/lib/core/search-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Search profiles (M2) — the tenant's named query source. All routes are
// withTenant: tenant id comes from the verified session only, never the body
// (FR-002). Cross-tenant id guesses return 404, not 403, to avoid leakage.

async function handleGET() {
  const profiles = listProfiles(tenantRoot());
  return Response.json({ profiles });
}

async function handlePOST(req: Request) {
  let body: { title?: string; queries?: string[]; locations?: string[]; enabled?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  try {
    const profile = createProfile(tenantRoot(), body);
    return Response.json({ profile }, { status: 201 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 400;
    return Response.json({ error: e instanceof Error ? e.message : "error" }, { status });
  }
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
