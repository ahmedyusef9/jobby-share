import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import { updateApplicationStatus } from "@/lib/tracker-mutate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(req: Request) {
  let body: { n?: string; ns?: string[]; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const ns = Array.isArray(body.ns)
    ? body.ns.map((x) => String(x).trim()).filter(Boolean)
    : body.n
      ? [String(body.n).trim()]
      : [];
  if (!ns.length || typeof body.status !== "string" || !body.status.trim()) {
    return NextResponse.json({ error: "n/ns and status required" }, { status: 400 });
  }
  try {
    return NextResponse.json(updateApplicationStatus(ns, body.status));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status });
  }
}

export const POST = withTenant(handlePOST);
