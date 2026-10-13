#!/usr/bin/env node
// Fetch a Workday job posting and save it to jds/ as bullet-preserving markdown.
//
// Workday renders job descriptions as HTML with <li><p>text</p></li>, so a naive
// tag-strip flattens every requirement into a bare paragraph. jd-skill-gap.mjs
// only reads bulleted lines inside a requirements block, so that flattening makes
// it silently report zero skills. This preserves list structure.
//
// Lives in scripts/ rather than at the repo root: root *.mjs is in
// update-system.mjs's SYSTEM_PATHS and is replaced wholesale on every update.
//
// Usage: node scripts/fetch-workday-jd.mjs <workday-job-url> [--out jds/<slug>.txt]

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const REQUEST_TIMEOUT_MS = 25_000;

// https://<tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>/job/<path>
// becomes https://<tenant>.<instance>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/job/<path>
function toCxsUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }

  const host = url.hostname;
  if (!host.endsWith('.myworkdayjobs.com')) {
    throw new Error(`not a Workday host: ${host}`);
  }

  const tenant = host.split('.')[0];
  const segments = url.pathname.split('/').filter(Boolean);
  const jobIndex = segments.indexOf('job');
  if (jobIndex === -1) throw new Error(`URL has no /job/ segment: ${rawUrl}`);

  // Everything before /job/ is [locale?, site]; the site is the last of those.
  const site = segments[jobIndex - 1];
  if (!site) throw new Error(`could not derive the career-site name from: ${rawUrl}`);

  const jobPath = segments.slice(jobIndex).join('/');
  return `https://${host}/wday/cxs/${tenant}/${site}/${jobPath}`;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#8217': '\u2019', '#8216': '\u2018',
  '#8220': '\u201C', '#8221': '\u201D', '#8211': '\u2013', '#8212': '\u2014',
};

function decodeEntities(text) {
  return text.replace(/&(#?\w+);/g, (whole, code) => {
    if (code in ENTITIES) return ENTITIES[code];
    if (/^#\d+$/.test(code)) return String.fromCodePoint(Number(code.slice(1)));
    if (/^#x[0-9a-f]+$/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
    return whole;
  });
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Workday nests a <p> inside every <li>. Strip those inner block tags first so
// list-item text survives as a single line, then treat the remaining <p> and
// <ul> boundaries as line breaks.
function htmlToMarkdown(html) {
  let out = html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
    const flat = collapse(inner.replace(/<\/?(p|div|br)[^>]*>/gi, ' ').replace(/<[^>]+>/g, ''));
    return flat ? `\n- ${flat}\n` : '\n';
  });

  // <b> headings become markdown headings so requirement-block detection works.
  out = out.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
    const flat = collapse(inner.replace(/<[^>]+>/g, ''));
    return flat ? `\n\n### ${flat}\n` : '';
  });

  out = out.replace(/<\/?(p|div|ul|ol|br|h[1-6])[^>]*>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);

  return out
    .split('\n')
    .map(line => (line.startsWith('- ') ? `- ${collapse(line.slice(2))}` : collapse(line)))
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugify(title) {
  return String(title || 'job')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  if (!url) throw new Error('usage: node scripts/fetch-workday-jd.mjs <workday-job-url> [--out <path>]');

  const outFlag = args.indexOf('--out');
  const explicitOut = outFlag !== -1 ? args[outFlag + 1] : null;
  if (outFlag !== -1 && !explicitOut) throw new Error('--out requires a path');

  const res = await fetch(toCxsUrl(url), {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; career-ops)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Workday returned HTTP ${res.status} for ${url}`);

  const info = (await res.json()).jobPostingInfo;
  if (!info) throw new Error(`no jobPostingInfo in the Workday response for ${url}`);

  const body = htmlToMarkdown(info.jobDescription || '');
  const header = [
    `TITLE: ${info.title || ''}`,
    `LOCATION: ${info.location || ''}`,
    `POSTED: ${info.startDate || ''}`,
    `JOB_ID: ${info.jobReqId || ''}`,
    `URL: ${info.externalUrl || url}`,
    info.timeType ? `TIME_TYPE: ${info.timeType}` : null,
  ].filter(Boolean).join('\n');

  const outPath = explicitOut || `jds/${slugify(info.title)}.txt`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${header}\n\n${body}\n`);

  const bullets = (body.match(/^- /gm) || []).length;
  console.log(`${outPath} — ${info.title} | ${info.location} | ${bullets} bullets`);
}

main().catch(err => {
  console.error(`fetch-workday-jd: ${err.message}`);
  process.exit(1);
});
