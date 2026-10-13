import { withTenant } from "@/lib/tenant/http";
import fs from "node:fs";
import path from "node:path";
import { platformRoot, tenantRoot } from "@/lib/tenant";
import { runNodeScript } from "@/lib/core/run-node-script";
import { tenantScriptEnv } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HISTORY_TIMEOUT_MS = 30_000;

// Mirrors the tracked set in scripts/cv-history.mjs. Anything outside it is
// rejected before reaching git, so `ref`/`file` cannot be used to read arbitrary
// paths out of the history repo.
const VIEWABLE = new Set(["cv.md", "profile.yml", "modes/_profile.md"]);
const REF_PATTERN = /^[0-9a-zA-Z^~@{}/.\-]{1,64}$/;

function localScript(nameNoExt: string): string {
  return path.join(platformRoot(), "scripts", `${nameNoExt}.mjs`);
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runNodeScript(localScript("cv-history"), args, {
    cwd: tenantRoot(),
    timeoutMs: HISTORY_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: tenantScriptEnv(),
  });
}

function unavailable() {
  return Response.json({ available: false, versions: [] });
}

// GET — list snapshots, or return one file's contents at a given snapshot.
async function handleGET(req: Request) {
  if (!fs.existsSync(localScript("cv-history"))) return unavailable();

  const params = new URL(req.url).searchParams;
  const ref = params.get("ref");

  if (ref) {
    if (!REF_PATTERN.test(ref)) return Response.json({ error: "bad ref" }, { status: 400 });
    const file = params.get("file") ?? "cv.md";
    if (!VIEWABLE.has(file)) return Response.json({ error: "file not tracked" }, { status: 400 });

    const result = await run(["show", ref, "--file", file]);
    if (result.code !== 0) {
      return Response.json({ error: result.stderr.trim() || "could not read that snapshot" }, { status: 404 });
    }
    return Response.json({ ok: true, ref, file, content: result.stdout });
  }

  const result = await run(["list", "--json", "--limit", "40"]);
  if (result.code !== 0) return unavailable();
  try {
    return Response.json({ available: true, versions: JSON.parse(result.stdout.trim() || "[]") });
  } catch {
    return unavailable();
  }
}

// POST — take a snapshot. Optionally attaches an exported PDF so the history
// records the artefact that was actually sent, not just the source cv.md.
async function handlePOST(req: Request) {
  if (!fs.existsSync(localScript("cv-history"))) {
    return Response.json({ error: "scripts/cv-history.mjs is missing" }, { status: 501 });
  }

  let label = "";
  let attach = "";
  try {
    const body = (await req.json()) as { label?: string; attach?: string };
    label = (body?.label ?? "").trim().slice(0, 120);
    attach = (body?.attach ?? "").trim();
  } catch {
    // Unlabelled snapshot: the script falls back to a timestamp.
  }

  const args = ["snapshot", "--json"];
  if (label) args.push("--label", label);
  if (attach) {
    // Same containment rule as the export download: only output/ PDFs.
    const outputDir = path.resolve(tenantRoot(), "output");
    const resolved = path.resolve(outputDir, path.relative("output", attach) || attach);
    if (!resolved.startsWith(outputDir + path.sep) || !resolved.toLowerCase().endsWith(".pdf")) {
      return Response.json({ error: "attachment must be a PDF inside output/" }, { status: 400 });
    }
    args.push("--attach", path.relative(tenantRoot(), resolved));
  }

  const result = await run(args);
  if (result.code !== 0) {
    return Response.json({ error: result.stderr.trim() || "snapshot failed" }, { status: 500 });
  }
  try {
    return Response.json({ ok: true, ...JSON.parse(result.stdout.trim() || "{}") });
  } catch {
    return Response.json({ error: "could not read the snapshot result" }, { status: 500 });
  }
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
