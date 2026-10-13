import { withTenant } from "@/lib/tenant/http";
import { pipelineSummary } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read fresh local files

// Exposes the user's pipeline (inbox + tracker) to the client so the assistant
// can resolve "all the Anthropic ones" to concrete postings CLIENT-SIDE — the
// model only ever emits a company name, never URLs (no hallucination, no tokens).
async function handleGET() {
  const s = pipelineSummary();
  return Response.json({
    inbox: s.inbox,
    applications: s.applications,
    reportUrls: s.reportUrls,
    root: s.root,
    rootExists: s.rootExists,
  });
}

export const GET = withTenant(handleGET);
