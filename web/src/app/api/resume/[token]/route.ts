/**
 * Signed resume download links (BL-055). Serves /api/resume/{token} — no
 * session, no Connect key: the token IS the grant, HMAC-signed and expiring
 * (see scripts/resume-links.mjs).
 *
 * The token's tenant always wins: the file is resolved inside THAT tenant's
 * directory via tenantRootFor (validated id, traversal-checked) and nowhere
 * else. Request-scoped session context is deliberately not used here — a link
 * must open in a bare browser.
 */
import fs from "node:fs";
import path from "node:path";
import { verifyResumeLink } from "../../../../../../scripts/resume-links.mjs";
import { tenantRootFor } from "../../../../../../scripts/resolve-root.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = [
  { test: /^cv\.md$/, type: "text/markdown; charset=utf-8", name: "cv.md" },
  {
    // Real export filenames contain spaces ("Ahmad Abo Alhija - Resume.pdf") —
    // only forbid separators; traversal is re-checked against the tenant root below.
    test: /^(output|uploads)\/[^/\\]+\.pdf$/i,
    type: "application/pdf",
    name: null, // from filename
  },
];

function resolveFor(tenantId: string, file: string): string | null {
  const spec = ALLOWED.find((a) => a.test.test(file));
  if (!spec) return null;
  let root: string;
  try {
    root = tenantRootFor(tenantId);
  } catch {
    return null; // invalid tenant id in a forged token
  }
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const grant = verifyResumeLink(token);
  if (!grant) {
    return new Response("This link has expired or is invalid. Ask for a fresh one.", {
      status: 410,
    });
  }

  const resolved = resolveFor(grant.tenantId, grant.file);
  if (!resolved) return new Response("Not found", { status: 404 });

  const spec = ALLOWED.find((a) => a.test.test(grant.file))!;
  const filename = spec.name ?? path.basename(resolved);
  const body = fs.readFileSync(resolved);
  const disposition =
    new URL(req.url).searchParams.get("download") === "1" ? "attachment" : "inline";
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": spec.type,
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
