import { NextRequest } from "next/server";
import { withTenant } from "@/lib/tenant/http";
import { mcpQrDataUrl } from "@/lib/mcp-qr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VALUE_CHARS = 4096;

async function handlePOST(req: NextRequest) {
  let body: { value?: unknown };
  try {
    body = (await req.json()) as { value?: unknown };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!value) return Response.json({ error: "value is required" }, { status: 400 });
  if (value.length > MAX_VALUE_CHARS) {
    return Response.json({ error: `value exceeds ${MAX_VALUE_CHARS} characters` }, { status: 413 });
  }
  try {
    return Response.json({ dataUrl: await mcpQrDataUrl(value) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "QR generation failed" },
      { status: 500 },
    );
  }
}

export const POST = withTenant(handlePOST);
