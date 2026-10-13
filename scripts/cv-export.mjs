#!/usr/bin/env node
// Export cv.md to a one-page PDF resume with no AI CLI in the loop.
//
// The upstream `pdf` mode needs an agent: it reads cv.md, tailors the wording
// for a specific job, and emits the JSON payload build-cv-html.mjs renders. That
// is the right path for a tailored application, but it means there is no way to
// get "my resume, as a PDF" without spending a model call — and no way at all
// when no CLI is configured.
//
// This is the deterministic path. It parses cv.md directly, renders it through
// the same build-cv-html.mjs + generate-pdf.mjs pipeline (so the output is the
// same ATS-safe template), and trims until the render genuinely fits one page.
//
// Lives in scripts/ rather than at the repo root: root *.mjs is in
// update-system.mjs's SYSTEM_PATHS and is replaced wholesale on every update.
//
// Usage:
//   node scripts/cv-export.mjs [--out <file.pdf>] [--max-pages N]
//                              [--payload <file.json>] [--report NNN]
//                              [--keep-intermediate] [--json]

import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import { load as loadYaml } from 'js-yaml';
import { sectionKey } from '../generate-pdf.mjs';
import { platformRoot, resolveRoot } from './resolve-root.mjs';

const PLATFORM = platformRoot();
const ROOT = resolveRoot();
const CV_PATH = join(ROOT, 'cv.md');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
// Inputs stay in the repo; only the rendered PDF is relocatable.
const PAYLOAD_DIR = join(ROOT, 'output');
const CURATED_PAYLOAD = join(PAYLOAD_DIR, 'resume-master.json');

/**
 * Directory finished PDFs are written to, from `JOBBY_EXPORT_DIR`.
 *
 * Relocatable because `output/` is gitignored, disposable, and buried inside a
 * checkout — a resume that has been sent to an employer is better kept somewhere
 * the user actually browses. A relative value resolves against the repo root, so
 * the default `output` behaves exactly as before.
 *
 * `~` is expanded here because this is set by hand in `.env`, and neither Docker
 * nor `dotenv` expands a tilde — left alone it would create a literal `./~`
 * directory.
 *
 * **Inside the container this must name the mount point (`/exports`), never the
 * host path.** An unmounted host path writes into the container's own filesystem
 * and the PDF is lost when it stops.
 *
 * @returns {string} Absolute directory path.
 */
function resolveExportDir() {
  const configured = (process.env.JOBBY_EXPORT_DIR ?? '').trim();
  if (configured === '') return join(ROOT, 'output');

  let expanded = configured;
  if (configured === '~' || configured.startsWith('~/')) {
    const home = (process.env.HOME ?? process.env.USERPROFILE ?? '').trim();
    if (home === '') {
      throw new Error(`JOBBY_EXPORT_DIR is "${configured}" but HOME is unset — write the full path`);
    }
    expanded = join(home, configured.slice(1));
  } else if (configured.startsWith('~')) {
    // "~other/path" is a username expansion no shell-free reader can resolve.
    throw new Error(`JOBBY_EXPORT_DIR: cannot expand "${configured}" — write the full path`);
  }

  return resolve(ROOT, expanded);
}

const EXPORT_DIR = resolveExportDir();

/**
 * Repo-relative path inside the checkout, absolute outside it.
 *
 * Callers print this and the web UI turns it into a download link. Slicing
 * `ROOT.length` unconditionally was correct only while every export lived under
 * the repo; with `JOBBY_EXPORT_DIR` set elsewhere it cut the string at an
 * unrelated offset and reported a path that does not exist.
 *
 * @param {string} absolute - Absolute path to a rendered file.
 * @returns {string}
 */
function reportPath(absolute) {
  return absolute.startsWith(ROOT + sep) ? absolute.slice(ROOT.length + 1) : absolute;
}
const RENDER_TIMEOUT_MS = 120_000;

// Skill rows beyond this many are merged into one row rather than dropped, so a
// one-page cut never costs an ATS keyword.
const SKILL_ROWS_KEPT = 5;

// ---------------------------------------------------------------- cv.md parsing

// cv.md is the full master: it carries Responsibilities/Achievements blocks that
// restate the Experience bullets, because an agent tailoring for a specific job
// wants that redundancy to draw from. A resume must not repeat itself, so those
// blocks are dropped here and never reach the payload.
const SKIPPED_SUBSECTIONS = new Set(['responsibilities', 'achievements']);

// "|" is an equally common Role/Company (or Title/Institution) separator in
// CVs authored outside career-ops's own ingest pipeline — without it, the
// whole "role | company" string is kept as the role and the company is lost.
const DASH_SPLIT = /\s+[—–]\s+|\s+-\s+|\s*\|\s*/;

// A `**bold**` or `*italic*` line inside an Experience/Education entry is a
// date range unless proven otherwise — real CVs use either wrapping (the
// canonical ingest format documents italic; other tools commonly emit bold).
// Only fall back to treating a bold line as a bullet-group heading when it
// doesn't look like a date at all.
function unwrapEmphasis(line) {
  const bold = line.match(/^\*\*([^*].*)\*\*$/);
  if (bold) return bold[1];
  const italic = line.match(/^\*([^*].*)\*$/);
  return italic ? italic[1] : null;
}
const DATE_LIKE_RE = /\b(19|20)\d{2}\b|\b(present|current|now|today|היום|נוכחי|כיום|כעת)\b/i;

function stripInlineMarkdown(text) {
  // The template HTML-escapes every field, so markdown emphasis would render as
  // literal asterisks. Bold lead-ins ("**Golang ETL Agent:** …") are kept as
  // plain "Golang ETL Agent: …" text.
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHtmlComment(line) {
  return line.startsWith('<!--') || line.startsWith('-->');
}

/**
 * Split markdown into `## ` sections, dropping HTML comments and the
 * self-restating subsections listed above.
 *
 * @param {string} markdown - cv.md contents.
 * @returns {{ preamble: string[], sections: Map<string, string[]> }}
 */
function splitSections(markdown) {
  const preamble = [];
  const sections = new Map();
  // Original heading text per canonical key, e.g. "ניסיון תעסוקתי" for
  // `experience` — lets the PDF keep the source's own section titles instead
  // of always falling back to the (English) DEFAULT_SECTION_TITLES.
  const titles = new Map();
  let current = null;
  let skipping = false;
  let inComment = false;

  for (const raw of markdown.split('\n')) {
    const line = raw.trim();

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (isHtmlComment(line)) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }

    if (line.startsWith('## ')) {
      // "Technical Skills" → skills, "Professional Summary" → summary, so
      // payloadFromCvMarkdown can look up canonical keys.
      const heading = line.slice(3).trim();
      current = sectionKey(heading);
      if (!sections.has(current)) sections.set(current, []);
      if (!titles.has(current)) titles.set(current, heading);
      skipping = false;
      continue;
    }

    // A `###` heading ends any skipped block and may start a new one.
    if (line.startsWith('### ')) {
      skipping = SKIPPED_SUBSECTIONS.has(line.slice(4).trim().toLowerCase());
    }
    if (skipping) continue;

    if (current === null) preamble.push(line);
    else sections.get(current).push(line);
  }

  return { preamble, sections, titles };
}

// RTL scripts need the page's own `dir` flipped (see payloadFromCvMarkdown) —
// without it, block-level layout (section alignment, bullet side) stays LTR
// even though individual paragraphs of RTL text happen to render right-to-left
// on their own via the browser's per-run bidi algorithm.
const HEBREW_RE = /[֐-׿יִ-ﭏ]/;
const ARABIC_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const RTL_RE = new RegExp(`${HEBREW_RE.source}|${ARABIC_RE.source}`);

// Label -> candidate field, for preamble contact lines. The canonical ingest
// format writes `- Email: x` (leading dash, English label); a CV authored by a
// different tool (another CLI's MCP, a human editing by hand) commonly writes
// the same fact as a plain `Email: x` line, or in the CV's own language — both
// carry the same information and neither should be silently dropped.
const FIELD_LABELS = new Map([
  ['email', 'email'], ['e-mail', 'email'], ['דוא"ל', 'email'], ['דוא״ל', 'email'], ['אימייל', 'email'], ['מייל', 'email'],
  ['phone', 'phone'], ['tel', 'phone'], ['telephone', 'phone'], ['טלפון', 'phone'], ['נייד', 'phone'],
  ['location', 'location'], ['address', 'location'], ['מגורים', 'location'], ['כתובת', 'location'], ['עיר מגורים', 'location'],
  ['linkedin', 'linkedin'],
  ['whatsapp', 'whatsapp'], ['וואטסאפ', 'whatsapp'],
]);

function parseCandidate(preamble) {
  const candidate = {};
  for (const line of preamble) {
    if (line.startsWith('# ')) {
      candidate.name = stripInlineMarkdown(line.slice(2));
      continue;
    }
    // Leading "- " bullet is optional; the label can be any short run of
    // non-colon characters (Latin or not) rather than only `[A-Za-z]+`.
    const field = line.match(/^-?\s*([^:]{1,24}?)\s*:\s*(.+)$/);
    if (!field) continue;
    const key = FIELD_LABELS.get(field[1].trim().toLowerCase());
    if (!key) continue; // an unrecognized label (e.g. "שנת לידה: 1995") isn't a contact field this template renders
    const value = stripInlineMarkdown(field[2]);
    candidate[key] = value;
  }
  return candidate;
}

// The summary section holds prose, optionally followed by supporting bullets.
// Blank lines between paragraphs are ignored so a multi-paragraph summary still
// reaches the PDF; bullets after the prose stay source material for tailoring.
function parseSummary(lines) {
  const paragraph = [];
  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith('-') || line.startsWith('#') || line.startsWith('*')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }
  return stripInlineMarkdown(paragraph.join(' '));
}

// A bullet ending in this marker is expendable: the one-page trim spends it before
// touching anything unmarked. Group-size balancing (see dropOneBullet) keeps every
// theme represented but has no notion of value, so without an explicit signal a
// one-page cut can drop an open-source contribution and keep a soft-skills line.
const OPTIONAL_MARKER = /\s*<!--\s*optional\s*-->\s*$/i;

/**
 * Parse `## Experience` into payload entries, tagging each bullet with the bold
 * group heading it sits under. The group survives into trimming so a one-page
 * cut keeps every theme represented instead of amputating whichever theme
 * happens to be written last.
 *
 * @param {string[]} lines - Lines of the Experience section.
 * @returns {Array<object>}
 */
function parseExperience(lines) {
  const entries = [];
  let entry = null;
  let group = '';

  for (const line of lines) {
    if (line.startsWith('### ')) {
      const [role, rest] = line.slice(4).split(DASH_SPLIT);
      const [company, ...where] = (rest ?? '').split(',');
      entry = {
        company: stripInlineMarkdown(company ?? ''),
        role: stripInlineMarkdown(role ?? ''),
        location: stripInlineMarkdown(where.join(', ')),
        dates: '',
        bullets: [],
        groups: [],
        optional: [],
      };
      entries.push(entry);
      group = '';
      continue;
    }
    if (!entry) continue;

    // Dates are a wrapped (bold or italic) line that looks like a date range —
    // checked before the bold-heading case below, since a bold date line
    // ("**2023 - Present**") would otherwise be mistaken for a bullet group.
    const wrapped = unwrapEmphasis(line);
    if (wrapped !== null && DATE_LIKE_RE.test(wrapped)) {
      entry.dates = stripInlineMarkdown(wrapped);
      continue;
    }

    const heading = line.match(/^\*\*(.+)\*\*:?$/);
    if (heading) {
      group = stripInlineMarkdown(heading[1]);
      continue;
    }

    if (line.startsWith('- ')) {
      const raw = line.slice(2);
      const optional = OPTIONAL_MARKER.test(raw);
      // Stripped before stripInlineMarkdown so the comment can never reach the PDF.
      entry.bullets.push(stripInlineMarkdown(raw.replace(OPTIONAL_MARKER, '')));
      entry.groups.push(group);
      entry.optional.push(optional);
    }
  }

  return entries;
}

function parseEducation(lines) {
  const entries = [];
  let entry = null;

  for (const line of lines) {
    if (line.startsWith('### ')) {
      const [title, org] = line.slice(4).split(DASH_SPLIT);
      entry = {
        title: stripInlineMarkdown(title ?? ''),
        org: stripInlineMarkdown(org ?? ''),
        year: '',
        description: '',
      };
      entries.push(entry);
      continue;
    }
    if (!entry) continue;

    const wrapped = unwrapEmphasis(line);
    if (wrapped !== null) {
      // Graduation year only: "2015 – 2019, graduated 2019" is noise on a resume.
      const years = stripInlineMarkdown(wrapped).match(/\b(19|20)\d{2}\b/g);
      entry.year = years ? years[years.length - 1] : stripInlineMarkdown(wrapped);
      continue;
    }
    if (line === '') continue;
    entry.description = [entry.description, stripInlineMarkdown(line)].filter(Boolean).join(' ');
  }

  return entries;
}

function parseSkills(lines) {
  const skills = [];
  const plain = []; // bullets with no bold category label — kept, not dropped
  for (const line of lines) {
    const row = line.match(/^-\s*\*\*(.+?)\*\*\s*:?\s*(.*)$/);
    if (!row) {
      if (line.startsWith('- ')) plain.push(stripInlineMarkdown(line.slice(2)));
      continue;
    }
    const items = stripInlineMarkdown(row[2])
      .split(/\s*\|\s*/)
      .map(item => item.trim())
      .filter(Boolean)
      .join(', ');
    // cv.md writes the colon inside the bold ("**Data Engineering:**"), and the
    // template adds its own separator — strip it or the row reads "Skills::".
    const category = stripInlineMarkdown(row[1]).replace(/:$/, '');
    if (items) skills.push({ category, items });
  }
  if (plain.length > 0) skills.push({ category: '', items: plain.join(', ') });
  return skills;
}

function parseLanguages(lines, title) {
  const items = lines
    .filter(line => line.startsWith('- '))
    .map(line => stripInlineMarkdown(line.slice(2)).replace(DASH_SPLIT, ' ('))
    .map(entry => (entry.includes('(') ? `${entry})` : entry));
  return items.length > 0 ? { category: title || 'Languages', items: items.join(', ') } : null;
}

// build-cv-html.mjs renders exactly three link slots in the contact row, in this
// order, and each needs a {url, display} object — a bare string is silently
// dropped because it tests `c.linkedin.url`. The slots are just positional
// containers, so any link can go in any of them and the display text carries the
// meaning.
const LINK_SLOTS = ['linkedin', 'github', 'portfolio'];

/**
 * Turn a profile value into the {url, display} pair the HTML builder expects.
 *
 * WhatsApp accepts either a full wa.me URL or an international number. A local
 * number is rejected rather than guessed at: turning "052-7299116" into a wa.me
 * link needs a country code, and silently assuming one would publish a link that
 * reaches the wrong person.
 *
 * @param {string} kind One of linkedin | whatsapp | github | portfolio.
 * @param {string} raw Value as written in the profile or cv.md.
 * @returns {{url: string, display: string}}
 */
function linkify(kind, raw) {
  const value = raw.trim();

  if (kind === 'whatsapp') {
    const digits = value.replace(/^https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)/i, '').replace(/\D/g, '');
    if (digits === '') throw new Error(`whatsapp: no digits in "${raw}"`);
    if (digits.startsWith('0')) {
      throw new Error(
        `whatsapp: "${raw}" looks like a local number. wa.me needs the country code ` +
        '(e.g. 972527299116 for 052-7299116), so write it in full.',
      );
    }
    return { url: `https://wa.me/${digits}`, display: 'WhatsApp' };
  }

  const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  if (kind === 'linkedin') return { url, display: 'LinkedIn' };
  // Bare host+path reads better than a full URL for these two.
  return { url, display: value.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '') };
}

/**
 * Contact details from config/profile.yml, which outranks cv.md.
 *
 * cv.md is prose the CV export was parsed out of; profile.yml is the structured
 * record the rest of career-ops already treats as authoritative for identity.
 * Blank TODO fields are skipped so they never render as empty contact rows.
 *
 * @returns {object} Payload candidate fields present in the profile.
 */
function candidateFromProfile() {
  if (!existsSync(PROFILE_PATH)) return {};

  let profile;
  try {
    profile = loadYaml(readFileSync(PROFILE_PATH, 'utf-8')) ?? {};
  } catch (err) {
    throw new Error(`could not parse config/profile.yml: ${err.message}`);
  }

  const candidate = profile.candidate ?? {};
  const place = profile.location ?? {};
  const location = [place.city, place.country].map(v => String(v ?? '').trim()).filter(Boolean).join(', ');

  const scalars = Object.fromEntries(
    Object.entries({
      name: candidate.full_name,
      email: candidate.email,
      phone: candidate.phone,
      location,
      photo: candidate.photo && !candidate.photo.startsWith('/')
        ? resolve(ROOT, String(candidate.photo).trim())
        : candidate.photo,
      photo_style: candidate.photo_style,
    })
      .map(([key, value]) => [key, String(value ?? '').trim()])
      .filter(([, value]) => value !== ''),
  );

  return {
    ...scalars,
    // Raw strings, keyed by kind. assignLinkSlots() normalizes them after the
    // cv.md and profile candidates are merged, so a link from either source is
    // treated the same way.
    ...Object.fromEntries(
      Object.entries({
        linkedin: candidate.linkedin,
        whatsapp: candidate.whatsapp,
        github: candidate.github,
        portfolio: candidate.portfolio_url,
      })
        .map(([kind, value]) => [kind, String(value ?? '').trim()])
        .filter(([, value]) => value !== ''),
    ),
  };
}

/**
 * Replace kind-keyed link strings with {url, display} objects in slot order.
 *
 * Mutates and returns the candidate. Preference order puts WhatsApp second so it
 * renders beside the phone it belongs with; github and portfolio take what is
 * left, and anything beyond three links is dropped with a warning rather than
 * silently vanishing inside the HTML builder.
 *
 * @param {object} candidate Merged candidate carrying raw link strings.
 * @returns {object} The same candidate, with link slots populated.
 */
function assignLinkSlots(candidate) {
  const links = ['linkedin', 'whatsapp', 'github', 'portfolio']
    .map(kind => [kind, candidate[kind]])
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '');

  for (const kind of ['linkedin', 'whatsapp', 'github', 'portfolio']) delete candidate[kind];

  if (links.length > LINK_SLOTS.length) {
    const dropped = links.slice(LINK_SLOTS.length).map(([kind]) => kind).join(', ');
    console.warn(`cv-export: the contact row holds ${LINK_SLOTS.length} links; dropping ${dropped}`);
  }

  for (const [index, [kind, value]] of links.slice(0, LINK_SLOTS.length).entries()) {
    candidate[LINK_SLOTS[index]] = linkify(kind, value);
  }

  return candidate;
}

function payloadFromCvMarkdown(markdown) {
  const { preamble, sections, titles } = splitSections(markdown);
  const skills = parseSkills(sections.get('skills') ?? []);
  const languages = parseLanguages(sections.get('languages') ?? [], titles.get('languages'));
  if (languages) skills.push(languages);

  return {
    lang: HEBREW_RE.test(markdown) ? 'he' : ARABIC_RE.test(markdown) ? 'ar' : 'en',
    dir: RTL_RE.test(markdown) ? 'rtl' : 'ltr',
    page_format: 'a4',
    // Raw, kind-keyed links; alignContact() normalizes them for every source.
    candidate: parseCandidate(preamble),
    summary: parseSummary(sections.get('summary') ?? []),
    experience: parseExperience(sections.get('experience') ?? []),
    education: parseEducation(sections.get('education') ?? []),
    skills,
    // Renders each section under the heading the user actually wrote
    // (Hebrew, Polish, English, …) instead of always the English default.
    sections: Object.fromEntries(titles),
  };
}

// ------------------------------------------------------------------- one-pager

function totalBullets(payload) {
  return (payload.experience ?? []).reduce((sum, e) => sum + (e.bullets?.length ?? 0), 0);
}

/**
 * Remove a bullet, mutating the entry.
 *
 * @param {object} entry - Experience entry.
 * @param {number} index - Bullet index to remove.
 */
function spliceBullet(entry, index) {
  entry.bullets.splice(index, 1);
  if (Array.isArray(entry.groups)) entry.groups.splice(index, 1);
  if (Array.isArray(entry.optional)) entry.optional.splice(index, 1);
}

/**
 * Drop one bullet, chosen to protect topic coverage.
 *
 * Bullets marked `<!-- optional -->` in cv.md are spent first, last one first, so
 * the author decides what a one-page cut costs. Only once those run out does the
 * group heuristic apply: the largest bold group across all roles loses its last
 * bullet, never going below one. Tail-trimming instead would silently delete
 * whichever theme is written last in cv.md.
 *
 * @param {object} payload - Payload mutated in place.
 * @returns {boolean} True if a bullet was removed.
 */
function dropOneBullet(payload) {
  const entries = payload.experience ?? [];

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const flags = entries[i].optional ?? [];
    for (let j = flags.length - 1; j >= 0; j -= 1) {
      if (flags[j]) {
        spliceBullet(entries[i], j);
        return true;
      }
    }
  }

  const counts = new Map();

  (payload.experience ?? []).forEach((entry, entryIndex) => {
    (entry.bullets ?? []).forEach((_, bulletIndex) => {
      const group = entry.groups?.[bulletIndex] ?? '';
      const key = `${entryIndex}\u0000${group}`;
      const existing = counts.get(key) ?? { entryIndex, indexes: [] };
      existing.indexes.push(bulletIndex);
      counts.set(key, existing);
    });
  });

  let victim = null;
  for (const value of counts.values()) {
    if (value.indexes.length < 2) continue;
    // Prefer the largest group; break ties toward the older role, which carries
    // less weight on a resume.
    if (
      victim === null ||
      value.indexes.length > victim.indexes.length ||
      (value.indexes.length === victim.indexes.length && value.entryIndex > victim.entryIndex)
    ) {
      victim = value;
    }
  }

  // Every group is down to a single bullet: fall back to the oldest role's last.
  if (victim === null) {
    for (let i = (payload.experience ?? []).length - 1; i >= 0; i -= 1) {
      const bullets = payload.experience[i].bullets ?? [];
      if (bullets.length > 1) {
        victim = { entryIndex: i, indexes: [bullets.length - 1] };
        break;
      }
    }
  }
  if (victim === null) return false;

  const entry = payload.experience[victim.entryIndex];
  spliceBullet(entry, victim.indexes[victim.indexes.length - 1]);
  return true;
}

/**
 * Fold the tail of the skills list into a single row.
 *
 * A long skills list costs a line per category heading, and cv.md carries ten of
 * them. Merging the low-signal tail reclaims that vertical space while keeping
 * every keyword on the page — deleting rows outright would hand an ATS keyword
 * match away to save the same room. The Languages row is left alone: recruiters
 * scan for it by name.
 *
 * @param {object} payload - Payload mutated in place.
 * @returns {boolean} True if rows were merged.
 */
function compactSkills(payload) {
  const skills = payload.skills ?? [];
  // Matches "Languages" and "Spoken Languages" alike — a curated payload may use
  // either, and folding that row into a generic "Additional" list buries it.
  const isLanguages = row => /^(spoken\s+)?languages$/i.test((row.category ?? '').trim());
  const languages = skills.filter(isLanguages);
  const technical = skills.filter(row => !isLanguages(row));
  if (technical.length <= SKILL_ROWS_KEPT + 1) return false;

  const kept = technical.slice(0, SKILL_ROWS_KEPT);
  const merged = technical.slice(SKILL_ROWS_KEPT).map(row => row.items).join(', ');
  payload.skills = [...kept, { category: 'Additional', items: merged }, ...languages];
  return true;
}

// Escalating reductions, cheapest first. Each is attempted only after a render
// has actually overflowed, so a payload that already fits is published exactly as
// the author wrote it. The first three drop sections that restate content found
// elsewhere on the page; the fourth reclaims space without losing a keyword;
// only then are bullets sacrificed.
const REDUCTIONS = [
  ['dropped competencies', p => { if (!p.competencies?.length) return false; delete p.competencies; return true; }],
  ['dropped projects', p => { if (!p.projects?.length) return false; delete p.projects; return true; }],
  ['dropped certifications', p => { if (!p.certifications?.length) return false; delete p.certifications; return true; }],
  ['merged skill rows', compactSkills],
];

// --------------------------------------------------------------------- render

function renderPayload(payload, htmlPath, jsonPath) {
  // `groups` and `optional` are our own trimming metadata; build-cv-html.mjs must
  // not see them.
  const clean = structuredClone(payload);
  for (const entry of clean.experience ?? []) {
    delete entry.groups;
    delete entry.optional;
  }

  writeFileSync(jsonPath, `${JSON.stringify(clean, null, 2)}\n`);
  execFileSync('node', [join(PLATFORM, 'build-cv-html.mjs'), jsonPath, htmlPath], {
    cwd: PLATFORM, stdio: 'pipe', timeout: RENDER_TIMEOUT_MS, encoding: 'utf-8',
  });

  // build-cv-html.mjs strips empty Projects and Education blocks, but not
  // Competencies or Certifications (see OPTIONAL_SECTIONS in
  // cv-sections-core.mjs), so those render as bare headings over blank space —
  // roughly a tenth of the page, which is two or three bullets.
  execFileSync('node', [join(PLATFORM, 'scripts', 'tidy-cv-html.mjs'), htmlPath, '--cv', CV_PATH], {
    cwd: PLATFORM, stdio: 'pipe', timeout: RENDER_TIMEOUT_MS, encoding: 'utf-8',
  });
}

function renderPdf(htmlPath, pdfPath, { format, reportNum, strict, maxPages }) {
  const args = [join(PLATFORM, 'generate-pdf.mjs'), htmlPath, pdfPath, `--format=${format}`, `--max-pages=${maxPages}`];
  if (reportNum) args.push(`--report=${reportNum}`);
  if (strict) args.push('--strict-pages');
  return execFileSync('node', args, {
    cwd: PLATFORM, stdio: 'pipe', timeout: RENDER_TIMEOUT_MS, encoding: 'utf-8',
  });
}

/**
 * Read the page count from the PDF catalog's /Pages dictionary.
 *
 * Following the catalog reference rather than counting `/Type /Page` matches
 * keeps page-like text inside content streams from inflating the count.
 *
 * @param {string} pdfPath - Path to a rendered PDF.
 * @returns {number}
 */
function pdfPageCount(pdfPath) {
  const pdf = readFileSync(pdfPath).toString('latin1');
  const objects = new Map();
  for (const match of pdf.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    const streamIndex = match[3].search(/\bstream(?:\r?\n|\r)/);
    objects.set(`${match[1]} ${match[2]}`, streamIndex === -1 ? match[3] : match[3].slice(0, streamIndex));
  }

  const catalog = [...objects.values()].find(body => /\/Type\s*\/Catalog\b/.test(body));
  const pagesRef = catalog?.match(/\/Pages\s+(\d+)\s+(\d+)\s+R\b/);
  const pages = pagesRef ? objects.get(`${pagesRef[1]} ${pagesRef[2]}`) : null;
  const count = pages && /\/Type\s*\/Pages\b/.test(pages) ? pages.match(/\/Count\s+(\d+)\b/) : null;
  const pageCount = count ? Number(count[1]) : 0;

  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`could not read the page count from ${pdfPath}`);
  }
  return pageCount;
}

// ----------------------------------------------------------------------- main

function parseArgs(argv) {
  const options = {
    out: null, payload: null, reportNum: null, maxPages: 1,
    keepIntermediate: false, json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i += 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };

    if (arg === '--out') options.out = value();
    else if (arg === '--payload') options.payload = value();
    else if (arg === '--report') options.reportNum = value();
    else if (arg === '--max-pages') {
      const pages = Number(value());
      if (!Number.isInteger(pages) || pages < 1) throw new Error('--max-pages must be a positive integer');
      options.maxPages = pages;
    } else if (arg === '--keep-intermediate') options.keepIntermediate = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

/**
 * Overlay the profile's contact block onto a payload and normalize its links.
 *
 * Applied to every source, including hand-curated payloads. Contact details are
 * identity, not tailoring: a tailored payload has no business carrying its own
 * phone number, and when it did, the master and tailored resumes drifted into
 * different formats. The single call site is deliberate — assignLinkSlots() moves
 * kind-keyed strings into positional slots and is not idempotent.
 *
 * @param {object} payload Payload from any source.
 * @returns {object} The same payload with an aligned candidate block.
 */
function alignContact(payload) {
  payload.candidate = assignLinkSlots({ ...(payload.candidate ?? {}), ...candidateFromProfile() });
  return payload;
}

function loadPayload(options) {
  if (options.payload) {
    const path = resolve(ROOT, options.payload);
    if (!existsSync(path)) throw new Error(`payload not found: ${options.payload}`);
    return { payload: alignContact(JSON.parse(readFileSync(path, 'utf-8'))), source: options.payload };
  }

  // A curated payload is hand-written prose and always reads better than parsed
  // cv.md, so it wins when present.
  if (existsSync(CURATED_PAYLOAD)) {
    return { payload: alignContact(JSON.parse(readFileSync(CURATED_PAYLOAD, 'utf-8'))), source: 'output/resume-master.json' };
  }

  if (!existsSync(CV_PATH)) throw new Error('cv.md not found — add your CV first');
  return { payload: alignContact(payloadFromCvMarkdown(readFileSync(CV_PATH, 'utf-8'))), source: 'cv.md' };
}

/**
 * Timestamped default output path, so no export overwrites an earlier one.
 *
 * A fixed name is the wrong default for a document sent to employers: every
 * export silently replaced the previous PDF, so once cv.md changed there was no
 * copy left of what an employer had actually received. Local time in day-month
 * order with a 24h clock is what reads naturally here; minutes are included
 * because two exports within the same hour would otherwise collide again and
 * reintroduce the overwrite this exists to prevent.
 *
 * An explicit --out still wins, which is how tailored exports keep a job-specific
 * filename.
 *
 * @param {object} payload - Payload carrying the candidate name.
 * @returns {string} Absolute path under output/.
 */
function defaultOutputName(payload) {
  const name = (payload.candidate?.name || 'resume').replace(/[^\w\s-]/g, '').trim() || 'resume';
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const stamp =
    `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return join(EXPORT_DIR, `${name} - Resume ${stamp}.pdf`);
}

/**
 * Move the rendered PDF from its in-repo staging path to its final destination.
 *
 * `rename` is tried first because it is atomic, but it fails with EXDEV across
 * filesystems — and an export directory on an external drive or a network share is
 * exactly the case that motivates a configurable path — so it falls back to a
 * copy. The staging file is removed either way, so a configured export directory
 * never leaves a duplicate behind in `output/`.
 *
 * @param {string} from - Staged PDF inside the repo.
 * @param {string} to - Final destination, possibly on another filesystem.
 */
function publish(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { payload, source } = loadPayload(options);

  if (!payload.candidate?.name) throw new Error(`no candidate name found in ${source}`);
  if (!payload.experience?.length) throw new Error(`no experience entries found in ${source}`);
  payload.page_format = payload.page_format || 'a4';

  mkdirSync(EXPORT_DIR, { recursive: true });
  const finalPath = resolve(ROOT, options.out ?? defaultOutputName(payload));
  mkdirSync(dirname(finalPath), { recursive: true });

  // generate-pdf.mjs refuses to write outside its own directory (the platform
  // checkout). Render there, then move into the tenant export dir.
  const pdfPath = join(PLATFORM, 'output', basename(finalPath));
  mkdirSync(dirname(pdfPath), { recursive: true });

  const htmlPath = pdfPath.replace(/\.pdf$/i, '.html');
  const jsonPath = pdfPath.replace(/\.pdf$/i, '.payload.json');

  const trimmed = [];
  const startingBullets = totalBullets(payload);
  const pending = [...REDUCTIONS];

  let pageCount = 0;
  // Bounded: every pass either fits, spends a reduction, or drops a bullet.
  const maxAttempts = startingBullets + REDUCTIONS.length + 2;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    renderPayload(payload, htmlPath, jsonPath);
    renderPdf(htmlPath, pdfPath, {
      format: payload.page_format, reportNum: options.reportNum,
      strict: false, maxPages: options.maxPages,
    });
    pageCount = pdfPageCount(pdfPath);
    if (pageCount <= options.maxPages) break;

    // Spend the cheapest remaining reduction that actually changes something.
    let reduced = false;
    while (pending.length > 0 && !reduced) {
      const [label, step] = pending.shift();
      if (step(payload)) {
        trimmed.push(label);
        reduced = true;
      }
    }
    if (reduced) continue;
    if (!dropOneBullet(payload)) break;
  }

  if (pageCount > options.maxPages) {
    throw new Error(
      `could not fit the resume into ${options.maxPages} page(s) — still ${pageCount}. ` +
      'Shorten the summary or the longest bullets in cv.md and retry.',
    );
  }

  const droppedBullets = startingBullets - totalBullets(payload);
  if (droppedBullets > 0) trimmed.push(`${droppedBullets} bullet(s)`);

  if (!options.keepIntermediate) {
    for (const path of [htmlPath, jsonPath]) rmSync(path, { force: true });
  }

  if (pdfPath !== finalPath) publish(pdfPath, finalPath);

  const result = {
    pdf: reportPath(finalPath),
    source,
    pages: pageCount,
    format: payload.page_format,
    trimmed,
    bullets: totalBullets(payload),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  console.log(`✅ ${result.pdf}`);
  console.log(`   source: ${source} · ${pageCount} page(s) · ${result.bullets} bullets`);
  if (trimmed.length > 0) console.log(`   trimmed to fit: ${trimmed.join(', ')}`);
}

main().catch(err => {
  console.error(`cv-export: ${err.message}`);
  if (err.stderr) console.error(String(err.stderr).trim());
  process.exit(1);
});
