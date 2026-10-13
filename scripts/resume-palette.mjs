// Named CV palettes + CSS overlay. templates/cv-template.html is system-layer
// and hard-codes a second purple (company names, header gradient). Upstream
// theme-style.mjs only injects accent_color, so this overlay maps a full
// palette onto the rendered HTML inside tidy-cv-html.mjs.
//
// Keep color values in sync with web/src/lib/cv/resume-palettes.ts

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { resolveRoot } from './resolve-root.mjs';

const ROOT = resolveRoot();

export const DEFAULT_PALETTE = {
  id: 'teal',
  label: 'Teal',
  accent: '#15808e',
  accent2: '#7322c3',
  wash: '#e6f4f5',
};

export const RESUME_PALETTES = [
  DEFAULT_PALETTE,
  { id: 'navy', label: 'Navy', accent: '#1e3a5f', accent2: '#3b82f6', wash: '#e8eef5' },
  { id: 'emerald', label: 'Emerald', accent: '#0f766e', accent2: '#14746f', wash: '#e6f4f1' },
  { id: 'ink', label: 'Ink', accent: '#1f2937', accent2: '#4b5563', wash: '#eef0f2' },
  { id: 'burgundy', label: 'Burgundy', accent: '#7f1d1d', accent2: '#b91c1c', wash: '#f8eaea' },
  { id: 'blue', label: 'Blue', accent: '#1d4ed8', accent2: '#0ea5e9', wash: '#e8f1fc' },
];

const HEX = /^#[0-9a-f]{6}$/;

export function normalizeHex(raw) {
  const m = String(raw || '').trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : null;
}

function named(id) {
  return RESUME_PALETTES.find((p) => p.id === id) || null;
}

function washFrom(hex) {
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return DEFAULT_PALETTE.wash;
  const mix = (c) => Math.round(((n >> c) & 255) * 0.12 + 255 * 0.88)
    .toString(16)
    .padStart(2, '0');
  return `#${mix(16)}${mix(8)}${mix(0)}`;
}

export function colorsFromStyle(style) {
  const block = style && typeof style === 'object' ? style : {};
  const id = String(block.palette || '').trim();
  const fromName = id && id !== 'custom' ? named(id) : null;
  if (fromName) return fromName;
  const accent = normalizeHex(block.accent_color) || DEFAULT_PALETTE.accent;
  const accent2 = normalizeHex(block.accent_2) || DEFAULT_PALETTE.accent2;
  return { id: id || 'custom', accent, accent2, wash: washFrom(accent) };
}

export function readProfileStyle(root = ROOT) {
  const file = join(root, 'config', 'profile.yml');
  if (!existsSync(file)) return null;
  try {
    const raw = yaml.load(readFileSync(file, 'utf8')) || {};
    const style = raw.style;
    if (!style || typeof style !== 'object') return null;
    if (!style.accent_color && !style.accent_2 && !style.palette) return null;
    return colorsFromStyle(style);
  } catch {
    return null;
  }
}

function cssBlock(colors) {
  const accent = HEX.test(colors.accent) ? colors.accent : DEFAULT_PALETTE.accent;
  const accent2 = HEX.test(colors.accent2) ? colors.accent2 : DEFAULT_PALETTE.accent2;
  const wash = HEX.test(colors.wash) ? colors.wash : DEFAULT_PALETTE.wash;
  return [
    ':root{',
    `--accent-color:${accent};`,
    `--accent-2:${accent2};`,
    `--wash:${wash};`,
    '}',
    '.header-gradient{background:linear-gradient(to right,var(--accent-color),var(--accent-2))!important}',
    'html[lang="ar"] .header-gradient{background:linear-gradient(to left,var(--accent-color),var(--accent-2))!important}',
    '.section-title{color:var(--accent-color)!important}',
    '.job-company,.project-title,.edu-org,.cert-org,.award-org{color:var(--accent-2)!important}',
    '.competency-tag,.project-badge{color:var(--accent-color)!important;background:var(--wash)!important}',
  ].join('');
}

export function injectPaletteCss(html, colors) {
  if (!html || !colors) return html;
  const inner = cssBlock(colors);
  const block = `<style id="jobby-resume-palette">${inner}</style>`;
  const stripped = html.replace(/<style id="jobby-resume-palette">[\s\S]*?<\/style>\s*/i, '');
  if (/<\/head>/i.test(stripped)) return stripped.replace(/<\/head>/i, () => `${block}\n</head>`);
  return `${block}\n${stripped}`;
}

export function applyProfilePalette(html, root = ROOT) {
  const colors = readProfileStyle(root);
  if (!colors) return html;
  return injectPaletteCss(html, colors);
}
