import { withTenant } from "@/lib/tenant/http";
import fs from "node:fs";
import { rootScript, tenantScriptEnv } from "@/lib/career-ops";
import { tenantRoot } from "@/lib/tenant";
import { runNodeScript } from "@/lib/core/run-node-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Orchestrates the core's own cold-start check (doctor.mjs --json) — the SAME
// source of truth the CLI uses to decide onboarding. We never reimplement the
// prerequisite list; we read the core's verdict.
async function handleGET() {
  const root = tenantRoot();
  const doctor = rootScript("doctor");
  if (!fs.existsSync(doctor)) {
    return Response.json({ available: false, onboardingNeeded: false, missing: [], warnings: [] });
  }
  const { stdout } = await runNodeScript(doctor, ["--json"], {
    cwd: root,
    timeoutMs: 10_000,
    env: tenantScriptEnv(),
  });
  try {
    const last = stdout.trim().split("\n").pop() || "{}";
    const j = JSON.parse(last);
    return Response.json({ available: true, onboardingNeeded: !!j.onboardingNeeded, missing: j.missing ?? [], warnings: j.warnings ?? [] });
  } catch {
    return Response.json({ available: false, onboardingNeeded: false, missing: [], warnings: [] });
  }
}

export const GET = withTenant(handleGET);
