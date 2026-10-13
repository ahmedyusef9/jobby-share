import { withTenant } from "@/lib/tenant/http";
import fs from "node:fs";
import { rootScript, tenantScriptEnv } from "@/lib/career-ops";
import { tenantRoot } from "@/lib/tenant";
import { runNodeScript } from "@/lib/core/run-node-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The DEMAND loop: surface follow-ups due, via the core's own
// followup-cadence.mjs --json (the SAME calculator the CLI uses) — we never
// reimplement the cadence logic, we read its verdict (mirrors /api/doctor).
async function handleGET() {
  const script = rootScript("followup-cadence");
  if (!fs.existsSync(script)) return Response.json({ available: false, metadata: null, entries: [] });
  // No flags: followup-cadence.mjs already emits JSON by default — "--json"
  // was never a flag it recognizes (validateFlags's KNOWN_FLAGS list has no
  // such entry), so this call was silently erroring and falling into the
  // catch below on every request, permanently returning available:false.
  const { stdout } = await runNodeScript(script, [], {
    cwd: tenantRoot(),
    timeoutMs: 12_000,
    env: tenantScriptEnv(),
  });
  try {
    const start = stdout.indexOf("{");
    const j = JSON.parse(stdout.slice(start));
    const entries = Array.isArray(j.entries) ? j.entries : [];
    // Overdue first; cap for the home (full list lives in the tracker).
    const overdue = entries.filter((e: { status?: string }) => /overdue|urgent/i.test(String(e.status))).slice(0, 8);
    const top = (overdue.length ? overdue : entries).slice(0, 6);
    return Response.json({ available: true, metadata: j.metadata ?? null, entries: top });
  } catch {
    return Response.json({ available: false, metadata: null, entries: [] });
  }
}

export const GET = withTenant(handleGET);
