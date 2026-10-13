import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import { addManualApplication } from "@/lib/tracker-mutate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  let body: { company?: string; role?: string; url?: string; status?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  try {
    return NextResponse.json(await addManualApplication(body));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status });
  }
}

export const POST = withTenant(handlePOST);
