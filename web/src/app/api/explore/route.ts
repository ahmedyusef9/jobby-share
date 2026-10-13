import { withTenant } from "@/lib/tenant/http";
import { NextRequest } from "next/server";
import fs from "node:fs";
import { runDiscovery } from "@/lib/core/scan";
import { rootScript } from "@/lib/career-ops";
import { parseExplorePatch, DEFAULT_FILTERS, type DiscoveredOffer, type ScanEvent } from "@/lib/explore";
import { currentAccount, planLimits } from "@/lib/entitlements";
import { tenantId, tenantRoot } from "@/lib/tenant";
import { isScanQuotaError, beginScan, endScan } from "@/lib/scan-quota";
import { listProfiles } from "@/lib/core/search-profiles";

// Discovery is HTTP-bound across many ATS boards; give it room. It is FREE —
// zero LLM tokens (the scanner only does HTTP + JSON, and --dry-run writes nothing).
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handlePOST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body → defaults */
  }

  const filters = parseExplorePatch(body, DEFAULT_FILTERS);
  const stored = listProfiles(tenantRoot());
  const enabled = stored.filter((p) => p.enabled);
  if (stored.length > 0 && enabled.length === 0) {
    return Response.json(
      { error: "All search profiles are disabled. Enable one on Profiles, or delete them to fall back to portals.yml." },
      { status: 400 },
    );
  }
  let selectedProfiles: { id: string; title: string; queries: string[]; locations: string[] }[] = [];
  if (enabled.length) {
    const wanted = new Set(filters.profileIds ?? []);
    selectedProfiles = wanted.size ? enabled.filter((p) => wanted.has(p.id)) : enabled;
    if (!selectedProfiles.length) {
      return Response.json(
        { error: "Pick at least one enabled search profile to scan." },
        { status: 400 },
      );
    }
  }

  const limits = planLimits(currentAccount());
  if (limits && filters.limitPerAts > limits.results) {
    filters.limitPerAts = limits.results;
  }

  // Guard: a data-only checkout (or pre-onboarding) has no scanner. Fail soft.
  if (!fs.existsSync(rootScript("scan-ats-full"))) {
    return Response.json(
      { error: "The discovery scanner isn't available in this checkout yet." },
      { status: 400 },
    );
  }

  let reservation: { eventId: string | null };
  try {
    reservation = await beginScan(currentAccount(), tenantId());
  } catch (err) {
    if (isScanQuotaError(err)) {
      const q = err as { message: string; code: string; status: number; used?: number; limit?: number };
      return Response.json(
        { error: q.message, code: q.code, used: q.used, limit: q.limit },
        { status: q.status },
      );
    }
    throw err;
  }

  const started = Date.now();
  const owner = tenantId();
  const eventId = reservation.eventId;
  const encoder = new TextEncoder();
  let settled = false;
  const settle = async (outcome: string) => {
    if (settled) return;
    settled = true;
    await endScan(owner, eventId, { outcome, durationMs: Date.now() - started });
  };
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* stream closed */
        }
      };
      send({ kind: "start", ats: filters.ats, sinceDays: filters.sinceDays, limit: filters.limitPerAts, free: true } satisfies ScanEvent);
      let offers: DiscoveredOffer[] = [];
      let outcome = "ok";
      try {
        offers = await runDiscovery(filters, (e: ScanEvent) => send(e), { profiles: selectedProfiles });
      } catch (err) {
        outcome = "failed";
        send({ kind: "error", message: err instanceof Error ? err.message : "discovery failed" } satisfies ScanEvent);
      }
      send({ kind: "done", count: offers.length, offers, cost: { tokens: 0, usd: 0 } } satisfies ScanEvent);
      await settle(outcome);
      controller.close();
    },
    async cancel() {
      await settle("cancelled");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export const POST = withTenant(handlePOST);
