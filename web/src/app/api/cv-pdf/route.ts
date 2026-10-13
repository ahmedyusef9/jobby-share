import { withTenant } from "@/lib/tenant/http";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { tenantRoot } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function outputDir(): string {
  return path.join(tenantRoot(), "output");
}

/**
 * Resolve a safe PDF under output/. Accepts `output/cv-….pdf` or a bare filename.
 * Rejects anything that escapes the directory.
 */
function resolveUnderOutput(requested: string): string | null {
  const root = tenantRoot();
  const dir = outputDir();
  const cleaned = requested.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!cleaned.toLowerCase().endsWith(".pdf")) return null;

  let resolved: string;
  if (path.isAbsolute(cleaned)) {
    resolved = path.resolve(cleaned);
  } else if (cleaned.startsWith("output/") || cleaned.startsWith("output" + path.sep)) {
    resolved = path.resolve(root, cleaned);
  } else {
    resolved = path.resolve(dir, path.basename(cleaned));
  }

  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

function findByCompany(company: string): string | null {
  const slug = (company.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
  if (!slug) return null;
  const dir = outputDir();
  // Match the slug at a token boundary so "Meta" doesn't serve "Metabase".
  const re = new RegExp(`(^|[^a-z0-9])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");

  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .filter((f) => re.test(f.toLowerCase()));
  } catch {
    return null;
  }
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

// Serve the tailored CV PDF the pdf mode wrote to output/cv-…-{company}-….pdf.
// ?download=1 → Content-Disposition: attachment (Save / Downloads).
// ?file=output/cv-….pdf → exact file (from worker verdict path).
async function handleGET(req: NextRequest) {
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  const fileParam = (req.nextUrl.searchParams.get("file") ?? "").trim();
  const asDownload = req.nextUrl.searchParams.get("download") === "1";

  let file: string | null = null;
  if (fileParam) {
    file = resolveUnderOutput(fileParam);
    if (!file) return new Response("file not found under output/", { status: 404 });
  } else if (company) {
    file = findByCompany(company);
    if (!file) return new Response("no tailored CV found for this offer", { status: 404 });
  } else {
    return new Response("company or file required", { status: 400 });
  }

  try {
    const buf = fs.readFileSync(file);
    const name = path.basename(file).replace(/"/g, "");
    const disposition = asDownload
      ? `attachment; filename="${name}"`
      : `inline; filename="${name}"`;
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": disposition,
        "Cache-Control": "no-store",
        "X-CV-Path": path.relative(tenantRoot(), file),
      },
    });
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}

export const GET = withTenant(handleGET);
