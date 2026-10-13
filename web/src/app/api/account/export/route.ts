import { withTenant } from "@/lib/tenant/http";
import { tenantId } from "@/lib/tenant";
import { exportTenantArchive } from "@/lib/account-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET — zip of this tenant's directory, minus stored keys.
 * Tenant id is taken from the session only.
 */
async function handleGET() {
  try {
    const archive = exportTenantArchive(tenantId());
    return new Response(new Uint8Array(archive.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archive.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : "export failed";
    return Response.json({ error: message }, { status });
  }
}

export const GET = withTenant(handleGET);
