import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import {
  findScanHit,
  readApplications,
  readInbox,
  reportUrlIndex,
  urlFromNotes,
} from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One posting’s durable facts for /pipeline/open — inbox row + scan-history +
// tracker join. Zero tokens. Workers jobs are only created when the user Scores.

async function handleGET(req: Request) {
  const url = new URL(req.url).searchParams.get("url")?.trim() || "";
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const norm = (u: string) =>
    u
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  const want = norm(url);

  const inboxJob = readInbox().find((j) => norm(j.url) === want) ?? null;
  const scan = findScanHit(url);
  const reportUrls = reportUrlIndex();
  const hit = reportUrls.find((r) => norm(r.url) === want);
  const apps = readApplications();
  let application =
    (hit && apps.find((a) => String(parseInt(a.n, 10)) === String(parseInt(hit.n, 10)))) || null;
  if (!application) {
    application = apps.find((a) => urlFromNotes(a.notes) && norm(urlFromNotes(a.notes)!) === want) ?? null;
  }

  return NextResponse.json({
    url,
    inPipeline: !!inboxJob && !inboxJob.done,
    inboxJob,
    scan,
    application,
  });
}

export const GET = withTenant(handleGET);
