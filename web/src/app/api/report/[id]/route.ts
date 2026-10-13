import { withTenant } from "@/lib/tenant/http";
import { findApplication, readReport, reportUrlIndex } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read the freshest report/tracker

// Serves ONE evaluation to the pipeline detail pane: the tracker row (score,
// status, PDF flag), the full report markdown, and the posting URL joined from
// the report header. Read-only — the canonical write paths stay in /api/run and
// set-status. Returns 404 only when neither a tracker row nor a report exists.
async function handleGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const num = parseInt(id, 10);
  if (Number.isNaN(num)) {
    return Response.json({ error: "bad report id" }, { status: 400 });
  }
  const n = String(num);
  const app = findApplication(n);
  const report = readReport(n);
  if (!app && !report) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const url = reportUrlIndex().find((r) => r.n === n)?.url ?? null;
  return Response.json({ app, report: report?.content ?? null, file: report?.file ?? null, url });
}

export const GET = withTenant(handleGET);
