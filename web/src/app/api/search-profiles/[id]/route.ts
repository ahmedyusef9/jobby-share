import { withTenant } from "@/lib/tenant/http";
import { tenantRoot } from "@/lib/tenant";
import { upsertProfile, patchProfile, deleteProfile } from "@/lib/core/search-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-profile CRUD. PUT upserts (idempotent), PATCH partial-updates (incl. enable
// toggle), DELETE removes. Unknown id → 404 (cross-tenant guesses too — never 403).

async function handlePUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { title?: string; queries?: string[]; locations?: string[]; enabled?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  try {
    const profile = upsertProfile(tenantRoot(), id, body);
    return Response.json({ profile });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 400;
    return Response.json({ error: e instanceof Error ? e.message : "error" }, { status });
  }
}

async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  try {
    const profile = patchProfile(tenantRoot(), id, body);
    return Response.json({ profile });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 400;
    return Response.json({ error: e instanceof Error ? e.message : "error" }, { status });
  }
}

async function handleDELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    deleteProfile(tenantRoot(), id);
    return new Response(null, { status: 204 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 400;
    return Response.json({ error: e instanceof Error ? e.message : "error" }, { status });
  }
}

export const PUT = withTenant(handlePUT);
export const PATCH = withTenant(handlePATCH);
export const DELETE = withTenant(handleDELETE);
