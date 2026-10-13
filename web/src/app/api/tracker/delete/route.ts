import { withTenant } from "@/lib/tenant/http";
import { deleteApplication } from "@/lib/tracker-mutate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  let body: { n?: string | number; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  try {
    return Response.json(await deleteApplication(String(body.n ?? "").trim(), !!body.dryRun));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status });
  }
}

export const POST = withTenant(handlePOST);
