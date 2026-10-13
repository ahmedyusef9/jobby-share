"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eye, FileDown, GitCommitVertical, History, Loader2, X } from "lucide-react";
import { SaveCvButton } from "@/components/save-cv-button";
import { CvPhoto } from "@/components/cv/cv-photo";
import { CvPalette } from "@/components/cv/cv-palette";

type ExportResult = {
  pdf: string;
  source: string;
  pages: number;
  trimmed: string[];
  bullets: number;
  download: string;
};

type Version = { ref: string; date: string; label: string; files: string[] };

function shortDate(iso: string) {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * Export and version controls for cv.md.
 *
 * Both actions are deliberately CLI-free. The upstream `pdf` mode needs a
 * configured AI CLI and tailors to a specific job; this exports the CV as it
 * stands, and snapshots it into the private history store that exists because
 * cv.md is gitignored and otherwise unrecoverable.
 */
export function CvToolbar({ ensureSaved }: { ensureSaved?: () => Promise<boolean> }) {
  const [busy, setBusy] = useState<"preview" | "export" | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  const [snapshotting, setSnapshotting] = useState(false);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pdfSaved, setPdfSaved] = useState<"picker" | "download" | null>(null);
  const [viewing, setViewing] = useState<{ ref: string; label: string; content: string } | null>(null);
  const ensureTheme = useRef<() => Promise<boolean>>(async () => true);
  const registerEnsureTheme = useCallback((fn: () => Promise<boolean>) => {
    ensureTheme.current = fn;
  }, []);

  const loadVersions = useCallback(async () => {
    const res = await fetch("/api/cv/history");
    const data = await res.json();
    setVersions(data.available ? (data.versions ?? []) : []);
  }, []);

  useEffect(() => {
    if (showVersions && versions === null) void loadVersions();
  }, [showVersions, versions, loadVersions]);

  async function renderPdf(kind: "preview" | "export"): Promise<ExportResult | null> {
    if (ensureSaved) {
      const saved = await ensureSaved();
      if (!saved) {
        setError("Save the CV first — preview uses what is on disk.");
        return null;
      }
    }
    const themed = await ensureTheme.current();
    if (!themed) {
      setError("Could not apply the resume colors.");
      return null;
    }
    setBusy(kind);
    setError("");
    try {
      const res = await fetch("/api/cv/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPages: 1 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "export failed");
      const next = data as ExportResult;
      setResult(next);
      setPdfSaved(null);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "export failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function previewPdf() {
    const next = await renderPdf("preview");
    if (next) setPreviewOpen(true);
  }

  async function exportPdf() {
    const next = await renderPdf("export");
    if (next) {
      setPreviewOpen(false);
      setSaveOpen(true);
    }
  }

  async function saveVersion() {
    setSnapshotting(true);
    setError("");
    try {
      const res = await fetch("/api/cv/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Attaching the last export records the exact PDF alongside the source.
        body: JSON.stringify(result ? { attach: result.pdf } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "snapshot failed");
      setVersions(null);
      setShowVersions(true);
      await loadVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "snapshot failed");
    } finally {
      setSnapshotting(false);
    }
  }

  async function view(version: Version) {
    const res = await fetch(`/api/cv/history?ref=${encodeURIComponent(version.ref)}`);
    const data = await res.json();
    if (res.ok) setViewing({ ref: version.ref, label: version.label, content: data.content ?? "" });
  }

  return (
    <div className="mt-4 rounded-2xl border border-border bg-surface/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void previewPdf()}
          disabled={busy !== null}
          title="Render the one-page PDF so you can check layout before saving"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-60 max-sm:min-h-[44px]"
        >
          {busy === "preview" ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />}
          {busy === "preview" ? "Rendering…" : "Preview"}
        </button>

        <button
          type="button"
          onClick={() => void exportPdf()}
          disabled={busy !== null}
          title="Render cv.md to a one-page PDF — no AI CLI needed"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-60 max-sm:min-h-[44px]"
        >
          {busy === "export" ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />}
          {busy === "export" ? "Rendering…" : "Export PDF (1 page)"}
        </button>

        <button
          type="button"
          onClick={saveVersion}
          disabled={snapshotting}
          title="Commit the current CV to the private version history"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-60 max-sm:min-h-[44px]"
        >
          {snapshotting ? <Loader2 className="size-3.5 animate-spin" /> : <GitCommitVertical className="size-3.5" />}
          Save version
        </button>

        <button
          type="button"
          onClick={() => setShowVersions((v) => !v)}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        >
          <History className="size-3.5" />
          {showVersions ? "Hide history" : "Version history"}
        </button>

        <span className="text-xs text-faint">Exports and history stay on this machine.</span>
      </div>

      <CvPhoto />
      <CvPalette registerEnsure={registerEnsureTheme} />

      {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
          <a href={result.download} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
            {result.pdf}
          </a>
          <SaveCvButton
            file={result.pdf}
            suggestedName={result.pdf.split("/").pop() || "cv.pdf"}
            label="Save to…"
          />
          <span>
            · {result.pages} page · {result.bullets} bullets · from {result.source}
            {result.trimmed.length > 0 && <> · trimmed to fit: {result.trimmed.join(", ")}</>}
          </span>
        </p>
      )}

      {previewOpen && result && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cv-preview-title"
        >
          <div className="flex h-[min(92vh,1100px)] w-full max-w-3xl flex-col rounded-2xl border border-border bg-surface p-4 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="cv-preview-title" className="text-sm font-medium text-foreground">
                  PDF preview
                </h2>
                <p className="mt-1 text-xs text-muted">
                  {result.pages} page · {result.bullets} bullets
                  {result.trimmed.length > 0 && <> · trimmed to fit: {result.trimmed.join(", ")}</>}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="text-faint hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <iframe
              // "#view=Fit" (a standard PDF open parameter Chrome/Edge/Firefox's
              // built-in viewers honor) fits the WHOLE page in the iframe by
              // default. Without it the viewer can open mid-page or at a zoom
              // that clips the bottom of the page — content that's really
              // there (e.g. the Skills row) reads as "missing" until the user
              // discovers they can scroll the embedded viewer.
              src={`${result.download}#view=Fit`}
              title="CV PDF preview"
              className="mt-3 min-h-0 w-full flex-1 rounded-xl border border-border bg-white"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SaveCvButton
                file={result.pdf}
                suggestedName={result.pdf.split("/").pop() || "cv.pdf"}
                variant="primary"
                label="Save PDF…"
                onSaved={() => setPreviewOpen(false)}
              />
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="text-xs text-muted hover:text-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {saveOpen && result && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cv-save-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="cv-save-title" className="text-sm font-medium text-foreground">
                  {pdfSaved ? "Saved" : "Where should this PDF go?"}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  {pdfSaved === "picker"
                    ? "It's on disk in the folder you picked."
                    : pdfSaved === "download"
                      ? "Your browser put it in the default Downloads folder."
                      : "Pick a folder and filename. Chrome and Edge open the system Save dialog; other browsers download to the default folder."}
                </p>
                <p className="mt-2 truncate font-mono text-[11px] text-faint">{result.pdf.split("/").pop()}</p>
              </div>
              <button
                type="button"
                onClick={() => setSaveOpen(false)}
                className="text-faint hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {pdfSaved ? (
                <button
                  type="button"
                  onClick={() => setSaveOpen(false)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground max-sm:min-h-[44px]"
                >
                  <Check className="size-3.5" />
                  Done
                </button>
              ) : (
                <>
                  <SaveCvButton
                    file={result.pdf}
                    suggestedName={result.pdf.split("/").pop() || "cv.pdf"}
                    variant="primary"
                    label="Choose location…"
                    onSaved={(info) => setPdfSaved(info.mode)}
                  />
                  <a
                    href={result.download}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted hover:text-brand"
                  >
                    Preview first
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showVersions && (
        <div className="mt-4 border-t border-border pt-3">
          {versions === null ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="text-xs text-muted">No versions yet. Save one to start tracking changes.</p>
          ) : (
            <ul className="space-y-1">
              {versions.map((version) => (
                <li key={version.ref} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  <code className="text-faint">{version.ref}</code>
                  <span className="text-faint">{shortDate(version.date)}</span>
                  <span className="text-foreground">{version.label}</span>
                  <button
                    type="button"
                    onClick={() => void view(version)}
                    className="text-brand transition-colors hover:underline"
                  >
                    view
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {viewing && (
        <div className="mt-4 rounded-xl border border-border bg-surface/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted">
              <code className="text-faint">{viewing.ref}</code> · {viewing.label}
            </p>
            <button type="button" onClick={() => setViewing(null)} className="text-faint hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
          <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted">
            {viewing.content}
          </pre>
        </div>
      )}
    </div>
  );
}
