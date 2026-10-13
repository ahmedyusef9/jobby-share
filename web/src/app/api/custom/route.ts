import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { platformRoot, tenantRoot } from "@/lib/tenant";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function customPath() {
  return path.join(tenantRoot(), "modes", "_custom.md");
}

function templatePath() {
  return path.join(platformRoot(), "modes", "_custom.template.md");
}

const MAX_BYTES = 400_000;

function readOrSeed(): { content: string; exists: boolean; seeded: boolean } {
  try {
    return { content: fs.readFileSync(customPath(), "utf8"), exists: true, seeded: false };
  } catch {
    /* missing — seed from template when present */
  }
  try {
    const seeded = fs.readFileSync(templatePath(), "utf8");
    return { content: seeded, exists: false, seeded: true };
  } catch {
    return { content: "", exists: false, seeded: false };
  }
}

/** House rules file — modes/_custom.md (user layer, local-only). */
async function handleGET() {
  const { content, exists, seeded } = readOrSeed();
  return NextResponse.json({ content, exists, seeded });
}

async function handlePOST(req: Request) {
  let body: { content?: string; confirmEmpty?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "rules file is too large" }, { status: 413 });
  }
  if (!body.content.trim() && !body.confirmEmpty) {
    return NextResponse.json(
      { error: "empty wipe blocked — pass confirmEmpty:true to clear the file" },
      { status: 400 },
    );
  }
  try {
    fs.mkdirSync(path.dirname(customPath()), { recursive: true });
    const bak = atomicWriteWithBackup(customPath(), body.content);
    return NextResponse.json({ ok: true, backedUp: !!bak });
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
