/**
 * cv.md → PDF rendering core (BL-055). Shared by the web export route and the
 * MCP `resume_generate` tool so they cannot drift: same Chromium render, same
 * queue path, same failure messages.
 *
 * No AI CLI involved, which is the point: zero-key members get a real PDF from
 * their markdown without any model call.
 */
import fs from "node:fs";
import path from "node:path";
import { platformRoot, tenantId, tenantRoot } from "@/lib/tenant";
import { runNodeScript } from "@/lib/core/run-node-script";
import { loadPersistedRun, newRunId } from "@/lib/core/run-store";
import { enqueueRun, getQueuedRunState, queueEnabled } from "@/lib/queue/jobby-queue";
import { tenantScriptEnv } from "@/lib/career-ops";

// The trim loop re-renders through Chromium once per bullet it has to drop, so
// a long CV legitimately takes tens of seconds on the first export.
const EXPORT_TIMEOUT_MS = 180_000;

export type ExportResult = {
  pdf: string;
  source: string;
  pages: number;
  format: string;
  trimmed: string[];
  bullets: number;
};

export type GenerateCvPdfResult =
  | ({ ok: true; download: string } & ExportResult)
  | { ok: false; error: string };

/**
 * Absolute path to a script under scripts/.
 *
 * The `.mjs` is assembled from the bare name rather than written as a literal:
 * Next's bundler statically traces `.mjs` string literals passed to execFile as
 * module imports and fails the production build.
 */
function localScript(nameNoExt: string): string {
  return path.join(platformRoot(), "scripts", `${nameNoExt}.mjs`);
}

function parseExportJson(raw: string): ExportResult | null {
  const lines = raw.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(t) as ExportResult;
      if (parsed?.pdf) return parsed;
    } catch {
      /* next */
    }
  }
  return null;
}

function exportFailureMessage(raw: string): string {
  const compact = raw.replace(/[╔╗╚╝║═]/g, " ").replace(/\s+/g, " ").trim();
  if (/playwright install|Executable doesn't exist|browserType\.launch/i.test(compact)) {
    return "PDF export needs Chromium. On Docker Compose it runs on the worker — rebuild/restart that service. On the host: npx playwright install chromium";
  }
  if (/timed out waiting for worker|did not pick up/i.test(compact)) {
    return "PDF export is queued but the worker did not finish. Check that `docker compose` worker is running.";
  }
  return compact.slice(-500) || "export failed";
}

async function waitForWorkerExport(runId: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snap = loadPersistedRun(runId);
    if (snap?.finished) return snap;
    const queued = await getQueuedRunState(runId, tenantId());
    if (queued?.state === "failed") {
      throw new Error(queued.failedReason || "worker failed");
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("timed out waiting for worker");
}

/** Render this tenant's cv.md to a PDF. 1 or 2 pages. */
export async function generateCvPdf(maxPages: 1 | 2 = 1): Promise<GenerateCvPdfResult> {
  const root = tenantRoot();
  const script = localScript("cv-export");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "scripts/cv-export.mjs is missing" };
  }

  // Compose web has no Chromium. The Playwright worker does — same path as
  // Score/PDF jobs when REDIS_URL is set.
  if (queueEnabled()) {
    const runId = newRunId();
    try {
      await enqueueRun({
        runId,
        kind: "cv-export",
        input: String(maxPages),
        cliId: "opencode",
        tenantId: tenantId(),
        createdAt: Date.now(),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "enqueue failed" };
    }

    try {
      const snap = await waitForWorkerExport(runId, EXPORT_TIMEOUT_MS);
      const terminal = snap.snapshot?.terminal;
      if (terminal?.type === "error") {
        return {
          ok: false,
          error: exportFailureMessage(String(terminal.msg || "export failed")),
        };
      }
      const result = parseExportJson(snap.snapshot?.text || "");
      if (!result) {
        // The exporter often explains itself in a step label
        // ("cv-export: no experience entries found in cv.md") — prefer that
        // over the dispatcher's generic missing_pdf verdict.
        const steps = (snap.snapshot?.steps ?? []) as Array<{ label?: string }>;
        const diag = [...steps].reverse().find((st) => /cv-export:\s/.test(String(st?.label || "")));
        return { ok: false, error: diag ? String(diag.label).trim() : "could not read the export result" };
      }
      return {
        ok: true,
        ...result,
        download: `/api/cv/export?file=${encodeURIComponent(result.pdf)}`,
      };
    } catch (e) {
      return { ok: false, error: exportFailureMessage(e instanceof Error ? e.message : "export failed") };
    }
  }

  const run = await runNodeScript(script, ["--json", "--max-pages", String(maxPages)], {
    cwd: root,
    timeoutMs: EXPORT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: tenantScriptEnv(),
  });

  if (run.code !== 0) {
    const detail = (run.stderr || run.stdout).trim().split("\n").slice(-4).join("\n");
    return { ok: false, error: exportFailureMessage(detail || "export failed") };
  }

  try {
    const result = parseExportJson(run.stdout);
    if (!result) throw new Error("empty");
    return {
      ok: true,
      ...result,
      download: `/api/cv/export?file=${encodeURIComponent(result.pdf)}`,
    };
  } catch {
    return { ok: false, error: "could not read the export result" };
  }
}
