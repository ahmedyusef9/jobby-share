/** Named resume palettes. Keep in sync with scripts/resume-palette.mjs */

export type ResumeColors = {
  accent: string;
  accent2: string;
  wash: string;
};

export type ResumePalette = ResumeColors & { id: string; label: string };

/** Template default: teal headings + purple company/gradient. */
export const DEFAULT_PALETTE: ResumePalette = {
  id: "teal",
  label: "Teal",
  accent: "#15808e",
  accent2: "#7322c3",
  wash: "#e6f4f5",
};

export const RESUME_PALETTES: ResumePalette[] = [
  DEFAULT_PALETTE,
  { id: "navy", label: "Navy", accent: "#1e3a5f", accent2: "#3b82f6", wash: "#e8eef5" },
  { id: "emerald", label: "Emerald", accent: "#0f766e", accent2: "#14746f", wash: "#e6f4f1" },
  { id: "ink", label: "Ink", accent: "#1f2937", accent2: "#4b5563", wash: "#eef0f2" },
  { id: "burgundy", label: "Burgundy", accent: "#7f1d1d", accent2: "#b91c1c", wash: "#f8eaea" },
  { id: "blue", label: "Blue", accent: "#1d4ed8", accent2: "#0ea5e9", wash: "#e8f1fc" },
];

export const DEFAULT_ACCENT = DEFAULT_PALETTE.accent;

export function normalizeAccent(raw: string): string | null {
  const m = String(raw || "")
    .trim()
    .match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : null;
}

export function paletteById(id: string | null | undefined): ResumePalette | null {
  if (!id) return null;
  return RESUME_PALETTES.find((p) => p.id === id) ?? null;
}

export function colorsFrom(input: { palette?: string; accent?: string; accent2?: string }): ResumeColors {
  const named = paletteById(input.palette || "");
  if (named && input.palette !== "custom") return named;
  const accent = normalizeAccent(input.accent || "") || DEFAULT_PALETTE.accent;
  const accent2 = normalizeAccent(input.accent2 || "") || DEFAULT_PALETTE.accent2;
  return { accent, accent2, wash: DEFAULT_PALETTE.wash };
}

export function sameColors(a: ResumeColors, b: ResumeColors): boolean {
  return a.accent === b.accent && a.accent2 === b.accent2;
}

export function paletteIdFor(colors: ResumeColors): string {
  return RESUME_PALETTES.find((p) => sameColors(p, colors))?.id ?? "custom";
}
