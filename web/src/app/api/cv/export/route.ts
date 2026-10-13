import { withTenant } from "@/lib/tenant/http";
import fs from "node:fs";
import path from "node:path";
import { tenantRoot } from "@/lib/tenant";
import { generateCvPdf } from "@/lib/cv/export-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Directory the export writes to, from `JOBBY_EXPORT_DIR`.
 *
 * Must stay in step with `resolveExportDir()` in `scripts/cv-export.mjs`. It is
 * duplicated rather than imported because Next's bundler only traces modules
 * under `web/`, so a shared helper in `scripts/` cannot be imported from a route.
 *
 * Unlike the script this never throws: a request is the wrong place to fail on
 * server misconfiguration, so an unexpandable value falls back to `output/` and
 * the path check below simply refuses to serve anything outside it.
 */
function exportDir(): string {
  const root = tenantRoot();
  const configured = (process.env.JOBBY_EXPORT_DIR ?? "").trim();
  if (!configured) return path.resolve(root, "output");

  let expanded = configured;
  if (configured === "~" || configured.startsWith("~/")) {
    const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").trim();
    if (!home) return path.resolve(root, "output");
    expanded = path.join(home, configured.slice(1));
  } else if (configured.startsWith("~")) {
    return path.resolve(root, "output");
  }

  return path.resolve(root, expanded);
}

// POST — render cv.md (or a curated payload) to a one-page PDF. No AI CLI
// involved, which is the point: the upstream `pdf` mode needs an agent, so
// without this there is no way to get a plain resume PDF out of the web UI.
// The render itself lives in lib/cv/export-core so the MCP resume_generate
// tool shares exactly this behavior.
async function handlePOST(req: Request) {
  let maxPages: 1 | 2 = 1;
  try {
    const body = (await req.json()) as { maxPages?: number };
    if (body?.maxPages === 1 || body?.maxPages === 2) maxPages = body.maxPages;
  } catch {
    // No body is the normal case: default to a one-page export.
  }

  const result = await generateCvPdf(maxPages);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.error.includes("missing") ? 501 : 500 });
  }
  const { download: _download, ok: _ok, ...rest } = result;
  void _download;
  void _ok;
  return Response.json({ ok: true, ...rest, download: `/api/cv/export?file=${encodeURIComponent(result.pdf)}` });
}

// GET — download a previously exported PDF. Only files inside the export
// directory are served: the query parameter is attacker-controlled in principle,
// so it is resolved and then confirmed to still sit under that directory (a `..`
// segment, or an absolute path pointing anywhere else, fails the check rather
// than escaping). Absolute paths are accepted because an export directory
// outside the repo makes the reported path absolute.
async function handleGET(req: Request) {
  const requested = new URL(req.url).searchParams.get("file");
  if (!requested) return new Response("file required", { status: 400 });

  const dir = exportDir();
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(tenantRoot(), requested);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    return new Response("outside the export directory", { status: 403 });
  }
  if (!resolved.toLowerCase().endsWith(".pdf")) {
    return new Response("only PDFs are served", { status: 400 });
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(resolved);
  } catch {
    return new Response("not found", { status: 404 });
  }

  const asDownload =
    new URL(req.url).searchParams.get("download") === "1" ||
    new URL(req.url).searchParams.get("dl") === "1";
  const name = path.basename(resolved).replace(/"/g, "");

  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
