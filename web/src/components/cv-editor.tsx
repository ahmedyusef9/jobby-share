"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { CvToolbar } from "@/components/cv/cv-toolbar";
import { CvChat } from "@/components/cv/cv-chat";
import { CvIngest } from "@/components/cv/cv-ingest";

export function CvEditor() {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showReplace, setShowReplace] = useState(false);

  useEffect(() => {
    fetch("/api/cv")
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content ?? "");
        setExists(d.exists ?? false);
      })
      .finally(() => setLoaded(true));
  }, []);

  async function save(): Promise<boolean> {
    if (!dirty && exists) return true;
    setSaving(true);
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) return false;
      setDirty(false);
      setExists(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">CV editor</h1>
          <p className="mt-1 text-sm text-muted">
            Edit <code className="text-foreground">cv.md</code> with live preview.
            {!exists && loaded && (
              <span className="ml-1 text-faint">No cv.md yet — upload a resume below, or start typing.</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loaded && exists && (
            <button
              type="button"
              onClick={() => setShowReplace((v) => !v)}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
            >
              {showReplace ? "Cancel" : "Upload / replace resume"}
            </button>
          )}
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
      </div>

      <CvToolbar ensureSaved={save} />
      {loaded && (!exists || showReplace) && (
        <div className="mt-6">
          {exists && (
            <p className="mb-2 text-xs text-faint">
              This replaces your current cv.md (a backup of the previous version is kept automatically).
            </p>
          )}
          <CvIngest
            onSaved={() => {
              setShowReplace(false);
              void fetch("/api/cv")
                .then((r) => r.json())
                .then((d) => {
                  setContent(d.content ?? "");
                  setExists(d.exists ?? false);
                  setDirty(false);
                });
            }}
          />
        </div>
      )}
      <CvChat
        content={content}
        onApply={(markdown) => {
          setContent(markdown);
          setDirty(true);
        }}
      />

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
            dir="auto"
            placeholder="# Your Name&#10;&#10;## Summary&#10;..."
            className="min-h-[60vh] w-full resize-none rounded-2xl border border-border bg-surface/50 p-4 font-mono text-sm leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand/40"
          />
          <article className="report-prose min-h-[60vh] overflow-auto rounded-2xl border border-border bg-surface/30 p-5">
            {content.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            ) : (
              <p className="text-muted">Preview appears here.</p>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
