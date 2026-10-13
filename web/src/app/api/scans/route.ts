import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import { tenantRoot } from "@/lib/tenant";
import { completion, isProductive, listProgress, readProgress } from "@/lib/scan-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Progress = {
  scanId: string;
  tenantId: string | null;
  kind: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  counts: Record<string, number>;
  sources: Record<string, { total: number; scanned: number; matches: number; done: boolean }>;
  // Present only on a run that reached the evaluation stage (JOBBY-BL-055): how
  // many postings were eligible, and how many the run actually paid to read.
  prefilter?: { pending: number; selected: number; dropped: number; deferred: number; budget: number };
  recent?: unknown[];
};

// The shared module is plain JS; these read helpers only need the shape above.
const percentOf = completion as unknown as (p: Progress) => number | null;
const productiveOf = isProductive as unknown as (p: Progress) => boolean;

/**
 * Scan progress, computed from what the scanner actually emitted (JOBBY-BL-054).
 *
 * Reads only this tenant's directory, so scoping needs no extra check — a scan
 * record for another account is not reachable from here at all.
 *
 * `GET /api/scans` — the recent list
 * `GET /api/scans?id=…` — one scan, including its event tail
 */
async function handleGET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const root = tenantRoot();

  if (id) {
    const found = readProgress(root, id) as Progress | null;
    if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({
      ...found,
      completion: percentOf(found),
      productive: productiveOf(found),
    });
  }

  const rows = (listProgress(root, 20) as Progress[]).map((row) => ({
    scanId: row.scanId,
    kind: row.kind,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    counts: row.counts,
    prefilter: row.prefilter ?? null,
    completion: percentOf(row),
    // The headline: effort spent against anything found. A finished scan that is
    // not productive is the failure this endpoint exists to make visible.
    productive: productiveOf(row),
  }));
  return NextResponse.json({ scans: rows });
}

export const GET = withTenant(handleGET);
