#!/usr/bin/env node
// Strip empty sections from a built CV / cover-letter HTML file, then reorder
// remaining sections to match cv.md. Also injects the two-color resume palette
// from config/profile.yml (headings + company names) — the HTML template
// hard-codes a second purple that theme-style.mjs cannot override.
//
// templates/cv-template.html hard-codes every section (experience → education →
// skills). templates/ is in SYSTEM_PATHS, so the template cannot be patched
// locally. generate-pdf.mjs then refuses to write a PDF whose section order
// diverges from cv.md. Post-processing the built HTML is template-agnostic and
// update-safe.
//
// Operates on the rendered output only; the payload and template are untouched.
//
// Usage: node scripts/tidy-cv-html.mjs <file.html> [--check] [--cv <cv.md>]

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { sectionKey } from '../generate-pdf.mjs';
import { applyProfilePalette } from './resume-palette.mjs';
import { resolveRoot } from './resolve-root.mjs';

const ROOT = resolveRoot();

// A section is <div class="section"> … </div> holding a .section-title plus its
// body. Matching nested divs with a regex is unsafe in general, but this runs
// only against our own generated markup, where sections are flat and uniform.
const SECTION_RE = /[ \t]*<div class="section">\s*<div class="section-title">([\s\S]*?)<\/div>([\s\S]*?)<\/div>\s*\n(?=\s*(?:<!--|<div class="section">|<\/body>|$))/g;

function isEmptyBody(body) {
  // Drop tags, comments and entity whitespace; whatever survives is real content.
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return text === '';
}

function collectSections(html) {
  return [...html.matchAll(SECTION_RE)].map((match) => ({
    html: match[0],
    title: match[1].replace(/<[^>]+>/g, '').trim(),
    key: sectionKey(match[1]),
    empty: isEmptyBody(match[2]),
    index: match.index,
    end: match.index + match[0].length,
  }));
}

function cvHeadingOrder(markdown) {
  const order = [];
  const seen = new Set();
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const key = sectionKey(heading[1]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return order;
}

function reorderKept(kept, markdown) {
  if (!markdown || kept.length < 2) return { sections: kept, moved: [] };
  const rank = new Map(cvHeadingOrder(markdown).map((key, i) => [key, i]));
  const movable = kept.filter((section) => rank.has(section.key));
  if (movable.length < 2) return { sections: kept, moved: [] };

  const queue = [...movable].sort((a, b) => rank.get(a.key) - rank.get(b.key));
  const before = movable.map((section) => section.key).join(' -> ');
  const after = queue.map((section) => section.key).join(' -> ');
  if (before === after) return { sections: kept, moved: [] };

  const next = [...queue];
  const sections = kept.map((section) => (rank.has(section.key) ? next.shift() : section));
  return { sections, moved: [before, after] };
}

function tidy(html, markdown) {
  const all = collectSections(html);
  const kept = all.filter((section) => !section.empty);
  const removed = all.filter((section) => section.empty).map((section) => section.title);
  const { sections: ordered, moved } = reorderKept(kept, markdown);

  if (all.length === 0 || (removed.length === 0 && moved.length === 0)) {
    return { html, removed, moved };
  }

  const start = all[0].index;
  const end = all[all.length - 1].end;
  const spliced = html.slice(0, start) + ordered.map((section) => section.html).join('') + html.slice(end);
  return { html: spliced, removed, moved };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const checkOnly = args.includes('--check');
  const cvFlag = args.indexOf('--cv');
  const cvPath = cvFlag >= 0 ? resolve(args[cvFlag + 1] || '') : join(ROOT, 'cv.md');
  if (!file) throw new Error('usage: node scripts/tidy-cv-html.mjs <file.html> [--check] [--cv <cv.md>]');

  const original = readFileSync(file, 'utf-8');
  const markdown = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';
  const { html: tidied, removed, moved } = tidy(original, markdown);
  const html = applyProfilePalette(tidied);

  const notes = [];
  if (removed.length) notes.push(`removed ${removed.length} empty section(s): ${removed.join(', ')}`);
  if (moved.length) notes.push(`reorder ${moved[0]} → ${moved[1]}`);
  if (html !== tidied) notes.push('applied resume palette');
  if (html === original) {
    console.log(`${file}: no empty sections`);
    return;
  }

  if (checkOnly) {
    console.log(`${file}: would ${notes.join('; ')}`);
    return;
  }

  writeFileSync(file, html);
  console.log(`${file}: ${notes.join('; ')}`);
}

try {
  main();
} catch (err) {
  console.error(`tidy-cv-html: ${err.message}`);
  process.exit(1);
}
