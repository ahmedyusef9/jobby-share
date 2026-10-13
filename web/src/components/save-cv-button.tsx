"use client";

import { useState } from "react";
import { FileDown, FileText, Loader2 } from "lucide-react";
import { downloadCvPdf } from "@/lib/download-cv";

type Props = {
  company?: string;
  file?: string | null;
  suggestedName?: string;
  /** Compact toolbar style vs prominent CTA after generate. */
  variant?: "button" | "primary";
  label?: string;
  className?: string;
  onSaved?: (info: { mode: "picker" | "download" }) => void;
};

/**
 * One-click Save As for a tailored CV. Uses the OS file picker when the browser
 * supports it (Chrome/Edge); otherwise downloads to the browser's default folder.
 */
export function SaveCvButton({
  company,
  file,
  suggestedName,
  variant = "button",
  label = "Save PDF…",
  className = "",
  onSaved,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");

  if (!company && !file) return null;

  const onClick = async () => {
    setBusy(true);
    setHint("");
    try {
      const res = await downloadCvPdf({
        company,
        file: file || undefined,
        suggestedName,
        pickLocation: true,
      });
      if (res.error === "cancelled") {
        setHint("");
        return;
      }
      if (!res.ok) {
        setHint(res.error || "Could not download");
        return;
      }
      setHint(res.mode === "picker" ? "Saved" : "Downloaded");
      if (res.mode) onSaved?.({ mode: res.mode });
    } catch (err) {
      setHint(err instanceof Error ? err.message : "Could not download");
    } finally {
      setBusy(false);
    }
  };

  const base =
    variant === "primary"
      ? "inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300 max-sm:min-h-[44px]"
      : "inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]";

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <button type="button" onClick={() => void onClick()} disabled={busy} className={base} title="Choose where to save this PDF">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />}
        {busy ? "Saving…" : label}
      </button>
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </span>
  );
}

export function ViewCvLink({ company, file }: { company?: string; file?: string | null }) {
  if (!company && !file) return null;
  const qs = new URLSearchParams();
  if (file) qs.set("file", file);
  else if (company) qs.set("company", company);
  return (
    <a
      href={`/api/cv-pdf?${qs}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]"
    >
      <FileText className="size-3.5" /> View
    </a>
  );
}
