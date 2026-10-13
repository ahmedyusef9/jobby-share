"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import {
  DEFAULT_PALETTE,
  RESUME_PALETTES,
  normalizeAccent,
  paletteIdFor,
  sameColors,
  type ResumeColors,
} from "@/lib/cv/resume-palettes";

type FontSizeOption = { id: string; value: string; label: string };

type ThemeState = {
  accent: string;
  accent2: string;
  palette: string | null;
  fontSize: string;
  fontSizeId: string;
  fontSizes: FontSizeOption[];
  isDefault?: boolean;
};

function asColors(raw: { accent?: string; accent2?: string }): ResumeColors {
  return {
    accent: normalizeAccent(raw.accent || "") || DEFAULT_PALETTE.accent,
    accent2: normalizeAccent(raw.accent2 || "") || DEFAULT_PALETTE.accent2,
    wash: DEFAULT_PALETTE.wash,
  };
}

const DEFAULT_FONT_SIZE_ID = "default";

/**
 * Resume PDF palette. Each preset sets both template colors: headings
 * (teal by default) and company names / header-rule end (purple by default).
 * Saved to config/profile.yml `style.accent_color` + `style.accent_2`.
 */
export function CvPalette({
  registerEnsure,
}: {
  registerEnsure?: (fn: () => Promise<boolean>) => void;
}) {
  const [saved, setSaved] = useState<ResumeColors | null>(null);
  const [draft, setDraft] = useState<ResumeColors>(DEFAULT_PALETTE);
  const [fontSizes, setFontSizes] = useState<FontSizeOption[]>([]);
  const [savedFontSizeId, setSavedFontSizeId] = useState<string | null>(null);
  const [draftFontSizeId, setDraftFontSizeId] = useState(DEFAULT_FONT_SIZE_ID);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    const res = await fetch("/api/cv/theme");
    const data = (await res.json()) as ThemeState;
    const colors = asColors(data);
    setSaved(data.isDefault ? null : colors);
    setDraft(colors);
    setFontSizes(data.fontSizes ?? []);
    setSavedFontSizeId(data.isDefault ? null : data.fontSizeId);
    setDraftFontSizeId(data.fontSizeId ?? DEFAULT_FONT_SIZE_ID);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const persistRef = useRef<(next: ResumeColors) => Promise<boolean>>(async () => false);

  async function persist(next: ResumeColors, fontSizeId: string): Promise<boolean> {
    const colors = asColors(next);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/cv/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          palette: paletteIdFor(colors),
          accent: colors.accent,
          accent2: colors.accent2,
          fontSize: fontSizeId,
        }),
      });
      const data = (await res.json()) as ThemeState & { error?: string };
      if (!res.ok) throw new Error(data.error || "could not save colors");
      const stored = asColors(data);
      setSaved(stored);
      setDraft(stored);
      setSavedFontSizeId(data.fontSizeId);
      setDraftFontSizeId(data.fontSizeId);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save colors");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/cv/theme", { method: "DELETE" });
      if (!res.ok) throw new Error("could not reset colors");
      setSaved(null);
      setDraft(DEFAULT_PALETTE);
      setSavedFontSizeId(null);
      setDraftFontSizeId(DEFAULT_FONT_SIZE_ID);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not reset colors");
    } finally {
      setBusy(false);
    }
  }

  persistRef.current = (next: ResumeColors) => persist(next, draftFontSizeId);

  useEffect(() => {
    registerEnsure?.(() => {
      const have = saved || DEFAULT_PALETTE;
      const haveFontSizeId = savedFontSizeId ?? DEFAULT_FONT_SIZE_ID;
      if (sameColors(asColors(draft), asColors(have)) && draftFontSizeId === haveFontSizeId) return Promise.resolve(true);
      return persistRef.current(draft);
    });
  }, [draft, saved, draftFontSizeId, savedFontSizeId, registerEnsure]);

  const have = saved || DEFAULT_PALETTE;
  const haveFontSizeId = savedFontSizeId ?? DEFAULT_FONT_SIZE_ID;
  const dirty = !sameColors(asColors(draft), asColors(have)) || draftFontSizeId !== haveFontSizeId;
  const canReset = saved !== null || savedFontSizeId !== null;
  const activeId = paletteIdFor(draft);

  return (
    <div className="mt-3 rounded-xl border border-dashed border-border px-3 py-2">
      <p className="text-xs font-medium text-foreground">Resume styling</p>
      <p className="mt-0.5 text-[11px] text-muted">
        Headings and company names are two colors. Each swatch sets both; custom lets you pick each.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {RESUME_PALETTES.map((p) => {
          const active = sameColors(p, draft);
          return (
            <button
              key={p.id}
              type="button"
              title={p.label}
              disabled={busy}
              onClick={() => setDraft(p)}
              className="size-7 overflow-hidden rounded-full border-2 max-sm:min-h-[44px] max-sm:min-w-[44px] max-sm:rounded-full"
              style={{
                background: `linear-gradient(to right, ${p.accent} 50%, ${p.accent2} 50%)`,
                borderColor: active ? "var(--foreground, #111)" : "transparent",
                boxShadow: active ? "0 0 0 2px var(--background, #fff)" : undefined,
              }}
              aria-label={p.label}
              aria-pressed={active}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
          Headings
          <input
            type="color"
            value={draft.accent}
            disabled={busy}
            onChange={(e) => setDraft((cur) => ({ ...cur, accent: e.target.value }))}
            className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
          />
          <code className="text-faint">{draft.accent}</code>
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
          Companies
          <input
            type="color"
            value={draft.accent2}
            disabled={busy}
            onChange={(e) => setDraft((cur) => ({ ...cur, accent2: e.target.value }))}
            className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
          />
          <code className="text-faint">{draft.accent2}</code>
        </label>
        {activeId !== "custom" && (
          <span className="text-[11px] text-faint">{RESUME_PALETTES.find((p) => p.id === activeId)?.label}</span>
        )}
      </div>
      {fontSizes.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] text-muted">Font size</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {fontSizes.map((f) => (
              <button
                key={f.id}
                type="button"
                disabled={busy}
                onClick={() => setDraftFontSizeId(f.id)}
                aria-pressed={draftFontSizeId === f.id}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] max-sm:min-h-[44px] ${
                  draftFontSizeId === f.id
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border text-muted hover:border-brand/40 hover:text-brand"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void persist(draft, draftFontSizeId)}
          className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
        >
          {busy ? <Loader2 className="inline size-3 animate-spin" /> : "Set as default"}
        </button>
        <button
          type="button"
          disabled={busy || !canReset}
          onClick={() => void reset()}
          className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
        >
          <RotateCcw className="size-3" /> Reset to default
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
