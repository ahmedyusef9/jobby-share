import { withTenant } from "@/lib/tenant/http";
import fs from "node:fs";
import path from "node:path";
import { rootScript, tenantScriptEnv } from "@/lib/career-ops";
import { tenantRoot } from "@/lib/tenant";
import { runNodeScript } from "@/lib/core/run-node-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Orchestrates the core's verify-portals.mjs (#1016) — the SAME ATS-slug
// validator the CLI uses. Catches the silent 404s that quietly drop a company
// from every future scan (= lost offers). We parse its console output; we do NOT
// reimplement the validation.
const STATUS: Record<string, "live" | "empty" | "broken" | "skipped"> = {
  "✅": "live",
  "🟡": "empty",
  "❌": "broken",
  "➖": "skipped",
};

async function handleGET() {
  const root = tenantRoot();
  const verifyPortals = rootScript("verify-portals");
  if (!fs.existsSync(verifyPortals)) {
    return Response.json({ available: false, configured: false, companies: [] });
  }
  if (!fs.existsSync(path.join(root, "portals.yml"))) {
    return Response.json({ available: true, configured: false, companies: [] });
  }

  const { stdout, stderr } = await runNodeScript(verifyPortals, [], {
    cwd: root,
    timeoutMs: 110_000,
    maxBuffer: 4 * 1024 * 1024,
    env: tenantScriptEnv(),
  });
  const combined = stdout + stderr;

  const companies: { name: string; status: string; detail: string }[] = [];
  for (const line of combined.split("\n")) {
    const m = line.match(/^\s*(✅|🟡|❌|➖)\s+(.+?)\s+—\s+(.*)$/);
    if (m) companies.push({ name: m[2].trim(), status: STATUS[m[1]] ?? "unknown", detail: m[3].trim() });
  }
  return Response.json({ available: true, configured: true, companies });
}

export const GET = withTenant(handleGET);
