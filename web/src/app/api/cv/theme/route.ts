import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { withTenant } from "@/lib/tenant/http";
import { tenantRoot } from "@/lib/tenant";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import {
  DEFAULT_PALETTE,
  RESUME_PALETTES,
  colorsFrom,
  normalizeAccent,
  paletteById,
  paletteIdFor,
} from "@/lib/cv/resume-palettes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STYLE_COLOR_KEYS = ["accent_color", "accent_2", "palette", "paper", "font_size"] as const;

// theme-style.mjs (the PDF pipeline's reader) accepts any CSS length for
// font_size — restricted to a fixed set here so the UI can offer plain
// presets and never write a value that could break page-fit or CSS syntax.
const FONT_SIZES = [
  { id: "compact", value: "10px", label: "Compact" },
  { id: "default", value: "11px", label: "Default" },
  { id: "comfortable", value: "12px", label: "Comfortable" },
  { id: "large", value: "13px", label: "Large" },
] as const;
const DEFAULT_FONT_SIZE = "11px";

function fontSizeIdFor(value: string): string {
  return FONT_SIZES.find((f) => f.value === value)?.id ?? "default";
}

function normalizeFontSize(raw: string): string | null {
  const trimmed = raw.trim();
  return FONT_SIZES.find((f) => f.id === trimmed || f.value === trimmed)?.value ?? null;
}

function profilePath(root: string): string {
  return path.join(root, "config", "profile.yml");
}

type StyleColors = { accent: string; accent2: string; palette: string; fontSize?: string };

function readStyle(yml: string): { accent?: string; accent2?: string; palette?: string; fontSize?: string } {
  try {
    const raw = yaml.load(yml) as {
      style?: { accent_color?: string; accent_2?: string; palette?: string; font_size?: string };
    };
    const style = raw?.style;
    if (!style || typeof style !== "object") return {};
    return {
      accent: normalizeAccent(String(style.accent_color ?? "")) || undefined,
      accent2: normalizeAccent(String(style.accent_2 ?? "")) || undefined,
      palette: String(style.palette ?? "").trim() || undefined,
      fontSize: normalizeFontSize(String(style.font_size ?? "")) || undefined,
    };
  } catch {
    return {};
  }
}

function upsertStyleKey(yml: string, key: string, value: string | null): string {
  const lineRe = new RegExp(`^[ \\t]*${key}:\\s*.*$`, "m");
  if (value === null) {
    return yml.replace(new RegExp(`^[ \\t]*${key}:\\s*.*\\n?`, "m"), "");
  }
  const lineValue = `${key}: ${JSON.stringify(value)}`;
  if (lineRe.test(yml)) {
    return yml.replace(lineRe, (line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? "  ";
      return `${indent}${lineValue}`;
    });
  }
  if (/^style:\s*$/m.test(yml)) {
    return yml.replace(/^style:\s*$/m, `style:\n  ${lineValue}`);
  }
  if (/^style:\s*\n/m.test(yml)) {
    return yml.replace(/^style:\s*\n/m, `style:\n  ${lineValue}\n`);
  }
  const trimmed = yml.replace(/\s*$/, "");
  return `${trimmed}\n\nstyle:\n  ${lineValue}\n`;
}

function patchStyle(yml: string, colors: StyleColors | null): string {
  let next = yml;
  if (colors === null) {
    for (const key of STYLE_COLOR_KEYS) next = upsertStyleKey(next, key, null);
    return next;
  }
  next = upsertStyleKey(next, "accent_color", colors.accent);
  next = upsertStyleKey(next, "accent_2", colors.accent2);
  next = upsertStyleKey(next, "palette", colors.palette);
  next = upsertStyleKey(next, "paper", null);
  // Absent/default font size is written as null (no line) rather than "11px",
  // so a profile that never touched font size stays byte-identical.
  next = upsertStyleKey(next, "font_size", colors.fontSize && colors.fontSize !== DEFAULT_FONT_SIZE ? colors.fontSize : null);
  return next;
}

function payload(saved: { accent?: string; accent2?: string; palette?: string; fontSize?: string }) {
  const isDefault = !saved.accent && !saved.accent2 && !saved.palette && !saved.fontSize;
  const colors = isDefault
    ? DEFAULT_PALETTE
    : colorsFrom({ palette: saved.palette, accent: saved.accent, accent2: saved.accent2 });
  const fontSize = saved.fontSize ?? DEFAULT_FONT_SIZE;
  return {
    accent: colors.accent,
    accent2: colors.accent2,
    palette: isDefault ? null : paletteIdFor(colors),
    fontSize,
    fontSizeId: fontSizeIdFor(fontSize),
    isDefault,
    defaultAccent: DEFAULT_PALETTE.accent,
    defaultAccent2: DEFAULT_PALETTE.accent2,
    defaultFontSize: DEFAULT_FONT_SIZE,
    palettes: RESUME_PALETTES,
    fontSizes: FONT_SIZES,
  };
}

async function handleGET() {
  const file = profilePath(tenantRoot());
  if (!fs.existsSync(file)) return Response.json(payload({}));
  return Response.json(payload(readStyle(fs.readFileSync(file, "utf8"))));
}

async function handlePOST(req: Request) {
  let body: { palette?: string; accent?: string; accent2?: string; fontSize?: string };
  try {
    body = (await req.json()) as { palette?: string; accent?: string; accent2?: string; fontSize?: string };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const named = paletteById(String(body.palette ?? ""));
  const colors = named
    ? named
    : colorsFrom({ accent: body.accent, accent2: body.accent2, palette: "custom" });
  const accent = normalizeAccent(colors.accent);
  const accent2 = normalizeAccent(colors.accent2);
  if (!accent || !accent2) {
    return Response.json({ error: "Use 6-digit hex colors, like #1e3a5f." }, { status: 400 });
  }

  const fontSize = body.fontSize === undefined ? DEFAULT_FONT_SIZE : normalizeFontSize(String(body.fontSize));
  if (fontSize === null) {
    return Response.json({ error: `Unknown font size — use one of: ${FONT_SIZES.map((f) => f.id).join(", ")}.` }, { status: 400 });
  }

  const palette =
    named?.id ||
    RESUME_PALETTES.find((p) => p.accent === accent && p.accent2 === accent2)?.id ||
    "custom";

  const root = tenantRoot();
  const file = profilePath(root);
  // A color pick shouldn't require having finished onboarding first — seed
  // from the same config/profile.example.yml template onboarding itself uses
  // (mirrors POST /api/profile's "no profile yet" branch) rather than refusing.
  let base = "";
  if (fs.existsSync(file)) {
    base = fs.readFileSync(file, "utf8");
  } else {
    try {
      base = fs.readFileSync(path.join(root, "config", "profile.example.yml"), "utf8");
    } catch {
      base = "";
    }
  }
  atomicWriteWithBackup(file, patchStyle(base, { accent, accent2, palette, fontSize }));
  return Response.json({ ok: true, ...payload({ accent, accent2, palette, fontSize }) });
}

async function handleDELETE() {
  const file = profilePath(tenantRoot());
  if (!fs.existsSync(file)) return Response.json(payload({}));
  atomicWriteWithBackup(file, patchStyle(fs.readFileSync(file, "utf8"), null));
  return Response.json({ ok: true, ...payload({}) });
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
export const DELETE = withTenant(handleDELETE);
