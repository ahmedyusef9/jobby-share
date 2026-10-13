import { withTenant } from "@/lib/tenant/http";
import { CAP, can, currentAccount, denialReason } from "@/lib/entitlements";
import { listRuns } from "@/lib/run-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunsPayload = {
  available: boolean;
  runs: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
};

const readRuns = listRuns as unknown as (opts: {
  tenantId?: string;
  limit?: number;
}) => Promise<RunsPayload>;

/**
 * `GET /api/admin/runs` — what has run on this instance (M7 phase 2).
 *
 * Operator only, and metadata only. The rows come from `job_events`, which
 * cannot hold a URL, CV, report or company, and `foldRuns` copies a closed
 * allowlist on the way out — so this endpoint stays a view of run *shape* even
 * if that collection grows an attribute later.
 *
 * `?tenantId=` narrows to one account; `?limit=` bounds the read.
 */
async function handleGET(req: Request) {
  const actor = currentAccount();
  if (!can(actor, CAP.ADMIN_CONSOLE)) {
    // Same posture as the rest of /admin: a member is told nothing about what
    // lives here.
    return Response.json({ error: denialReason(actor, CAP.ADMIN_CONSOLE) }, { status: 403 });
  }

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId")?.trim() || undefined;
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) ? limitRaw : 200;

  try {
    const payload = await readRuns({ tenantId, limit });
    return Response.json(payload);
  } catch (e) {
    // An unreachable ledger is reported as unavailable, never as "nothing ran" —
    // those are opposite answers and only one of them is reassuring.
    return Response.json(
      {
        available: false,
        runs: [],
        summary: { total: 0 },
        error: e instanceof Error ? e.message : "could not read the job ledger",
      },
      { status: 503 },
    );
  }
}

export const GET = withTenant(handleGET);
