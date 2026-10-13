import { withTenant } from "@/lib/tenant/http";
import { BATCH_STATE, batchSummary, listBatches, openBatch, setBatchState, setCapacity } from "@/lib/batches";
import {
  currentConfigSource,
  currentConfigVersion,
  getConfig,
  patchActiveConfig,
  refreshConfig,
} from "@/lib/app-config";
import { CAP, can, currentAccount, denialReason } from "@/lib/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function denyUnlessOperator(capability: string) {
  const actor = currentAccount();
  if (can(actor, capability)) return null;
  return Response.json({ error: denialReason(actor, capability) }, { status: 403 });
}

function publicBatch(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    batchId: row.batchId ?? row.$id ?? null,
    state: row.state ?? null,
    capacity: row.capacity ?? 0,
    plan: row.plan ?? null,
    appVersion: row.appVersion ?? null,
    configVersion: row.configVersion ?? null,
  };
}

async function handleGET() {
  const denied = denyUnlessOperator(CAP.ADMIN_CONSOLE);
  if (denied) return denied;

  await refreshConfig({ force: true });
  const config = (await getConfig()) as { signupOpen?: boolean; defaultPlan?: string };
  const open = await openBatch();
  const batches = (await listBatches()) as Array<Record<string, unknown>>;
  const currentId = String(
    open?.batchId ??
      batches.find((b) => b.state === "full")?.batchId ??
      batches[0]?.batchId ??
      "",
  );
  const summary = currentId ? await batchSummary(currentId) : null;

  return Response.json({
    config: {
      version: currentConfigVersion(),
      source: currentConfigSource(),
      signupOpen: config.signupOpen !== false,
      defaultPlan: config.defaultPlan ?? null,
    },
    batch: summary
      ? {
          ...publicBatch(summary.batch as Record<string, unknown>),
          taken: summary.capacity.taken,
          remaining: summary.capacity.remaining,
          total: summary.capacity.total,
        }
      : null,
    batches: batches.map((b) => publicBatch(b)),
  });
}

/**
 * PATCH — operator levers that must work on a second instance with no shared file.
 * Body: { capacity?: number, signupOpen?: boolean, batchState?: "open" | "closed", batchId?: string }
 */
async function handlePATCH(req: Request) {
  const denied = denyUnlessOperator(CAP.ADMIN_MANAGE_ACCOUNTS);
  if (denied) return denied;

  let body: {
    capacity?: unknown;
    signupOpen?: unknown;
    batchState?: unknown;
    batchId?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const changed: string[] = [];

  if (body.signupOpen !== undefined) {
    if (typeof body.signupOpen !== "boolean") {
      return Response.json({ error: "signupOpen must be true or false" }, { status: 400 });
    }
    const published = await patchActiveConfig(
      { signupOpen: body.signupOpen },
      body.signupOpen ? "Operator opened sign-ups" : "Operator paused sign-ups",
    );
    if (!published.ok) {
      return Response.json({ error: published.errors?.join("; ") ?? "config publish failed" }, { status: 400 });
    }
    changed.push("signupOpen");
  }

  const open = await openBatch();
  const batches = (await listBatches()) as Array<{ batchId?: string; $id?: string }>;
  const batchId =
    typeof body.batchId === "string" && body.batchId.trim()
      ? body.batchId.trim()
      : String(open?.batchId ?? batches[0]?.batchId ?? batches[0]?.$id ?? "");

  if (body.capacity !== undefined) {
    const n = Number(body.capacity);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return Response.json({ error: "capacity must be a whole number" }, { status: 400 });
    }
    if (!batchId) return Response.json({ error: "no batch to update" }, { status: 404 });
    const r = await setCapacity(batchId, n);
    if (!r.ok) return Response.json({ error: r.error ?? "capacity not changed" }, { status: 400 });
    changed.push("capacity");
  }

  if (body.batchState !== undefined) {
    const allowed = [BATCH_STATE.OPEN, BATCH_STATE.CLOSED] as string[];
    if (typeof body.batchState !== "string" || !allowed.includes(body.batchState)) {
      return Response.json({ error: "batchState must be open or closed" }, { status: 400 });
    }
    if (!batchId) return Response.json({ error: "no batch to update" }, { status: 404 });
    const r = await setBatchState(batchId, body.batchState);
    if (!r.ok) return Response.json({ error: r.error ?? "batch state not changed" }, { status: 400 });
    changed.push("batchState");
  }

  if (changed.length === 0) {
    return Response.json({ error: "nothing to change" }, { status: 400 });
  }
  return Response.json({ ok: true, changed });
}

export const GET = withTenant(handleGET);
export const PATCH = withTenant(handlePATCH);
