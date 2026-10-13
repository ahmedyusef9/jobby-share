"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Loader2, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/cn";

type MarkKind = "MUST" | "SHOULD" | "HINT";

const MARK_STYLE: Record<MarkKind, string> = {
  MUST: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  SHOULD: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  HINT: "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200",
};

/** Rewrite MUST:/SHOULD:/HINT: line prefixes into preview chips. */
function renderMarkedPreview(src: string): string {
  return src.replace(
    /^(\s*[-*]?\s*)(MUST|SHOULD|HINT)\s*:\s*(.+)$/gim,
    (_m, lead: string, kind: string, rest: string) =>
      `${lead}**[${kind}]** ${rest.trim()}`,
  );
}

function countMarks(src: string): Record<MarkKind, number> {
  const out: Record<MarkKind, number> = { MUST: 0, SHOULD: 0, HINT: 0 };
  for (const m of src.matchAll(/\b(MUST|SHOULD|HINT)\s*:/gi)) {
    const k = m[1].toUpperCase() as MarkKind;
    out[k] += 1;
  }
  return out;
}

/**
 * Edit modes/_custom.md — procedural house rules agents already read.
 * Mark lines with MUST: / SHOULD: / HINT: for visual priority in the preview.
 */
export function RulesEditor() {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(true);
  const [seeded, setSeeded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/custom")
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content ?? "");
        setExists(d.exists ?? false);
        setSeeded(!!d.seeded);
      })
      .finally(() => setLoaded(true));
  }, []);

  const marks = useMemo(() => countMarks(content), [content]);
  const preview = useMemo(() => renderMarkedPreview(content), [content]);

  async function save(confirmEmpty = false) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, confirmEmpty }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error?.includes("empty wipe") && !content.trim()) {
          if (window.confirm("Clear all house rules? This cannot be undone easily.")) {
            await save(true);
          }
          return;
        }
        setError(data.error || "Save failed");
        return;
      }
      setDirty(false);
      setExists(true);
      setSeeded(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  function insertMark(kind: MarkKind) {
    const snippet = `\n- ${kind}: `;
    setContent((c) => (c.trimEnd() + snippet));
    setDirty(true);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/config" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Config
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">House rules</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Edit <code className="text-foreground">modes/_custom.md</code> — procedural rules agents follow
            (how to work, not who you are). Local-only; survives system updates.
            {!exists && loaded && (
              <span className="ml-1 text-faint">
                {seeded ? "Seeded from template — Save to create your file." : "No file yet — start typing."}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
          className={cn(
            "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
            dirty
              ? "bg-brand text-brand-foreground hover:bg-brand-200"
              : "border border-border bg-surface text-muted",
          )}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-faint">Insert mark:</span>
        {(["MUST", "SHOULD", "HINT"] as MarkKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => insertMark(k)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide max-sm:min-h-[44px]",
              MARK_STYLE[k],
            )}
            title={`${k} rules are stronger guidance for agents`}
          >
            {k}
            {marks[k] > 0 ? ` · ${marks[k]}` : ""}
          </button>
        ))}
        <span className="text-[11px] text-faint">
          Prefix a bullet: <code>MUST:</code> / <code>SHOULD:</code> / <code>HINT:</code>
        </span>
      </div>

      {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-3 rounded-xl border border-border/60 bg-surface/20 px-3 py-2 text-[11px] text-muted">
        <strong className="text-foreground">Examples</strong>
        <ul className="mt-1 list-inside list-disc space-y-0.5">
          <li>
            <code>MUST: CV PDFs are one page — use cv-export.mjs until page count ≤ 1.</code>
          </li>
          <li>
            <code>SHOULD: Prefer a dense one-pager (~90%+ filled); restore optional bullets before shipping sparse.</code>
          </li>
          <li>
            <code>HINT: Drop projects before experience when trimming for one page.</code>
          </li>
        </ul>
        <p className="mt-1.5 text-faint">
          Facts about you belong in <Link href="/cv" className="text-brand hover:underline">cv.md</Link> /{" "}
          <code>_profile.md</code> — not here.
        </p>
      </div>

      {!loaded ? (
        <div className="mt-6 text-sm text-muted">Loading…</div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            placeholder="- MUST: …&#10;- SHOULD: …&#10;- HINT: …"
            className="min-h-[60vh] w-full resize-none rounded-2xl border border-border bg-surface/50 p-4 font-mono text-sm leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand/40"
          />
          <article className="report-prose min-h-[60vh] overflow-auto rounded-2xl border border-border bg-surface/30 p-5">
            {content.trim() ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  strong: ({ children }) => {
                    const t = String(children);
                    if (t === "[MUST]" || t === "[SHOULD]" || t === "[HINT]") {
                      const kind = t.slice(1, -1) as MarkKind;
                      return (
                        <span
                          className={cn(
                            "mr-1 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                            MARK_STYLE[kind],
                          )}
                        >
                          {kind}
                        </span>
                      );
                    }
                    return <strong>{children}</strong>;
                  },
                }}
              >
                {preview}
              </ReactMarkdown>
            ) : (
              <p className="text-muted">Preview appears here.</p>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
