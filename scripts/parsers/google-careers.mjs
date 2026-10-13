#!/usr/bin/env node
// Google Careers -> jobs-json-v1 for scan.mjs's local_parser provider.
//
// Google has no public jobs API (careers.google.com/api/* is 404/301 as of
// 2026-07-31) and the results page ships only ~2 of its jobs in server-rendered
// HTML — the rest is client-rendered, so a plain fetch returns nothing usable.
// Hence Playwright, which is already a project dependency.
//
// Google Jobs (the aggregator) is a different product and is NOT a substitute:
// JobSpy's google scraper returns 0 rows for Israel.
//
// Lives in scripts/ rather than providers/, which update-system.mjs replaces
// wholesale on every update.
//
// Usage: node scripts/parsers/google-careers.mjs --term "software engineer" [--location Israel] [--pages 3]

import { chromium } from 'playwright';

const BASE = 'https://www.google.com/about/careers/applications/';
const RESULTS = `${BASE}jobs/results/`;
const DEFAULT_PAGES = 3;
const NAV_TIMEOUT_MS = 45_000;
// The job list is client-rendered; without this settle the first page yields a
// partial list on a cold browser.
const SETTLE_MS = 2_500;

function parseArgs(argv) {
  const terms = [];
  let location = 'Israel';
  let pages = DEFAULT_PAGES;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--term') {
      const value = argv[i += 1];
      if (!value) throw new Error('--term requires a value');
      terms.push(value);
    } else if (arg === '--location') {
      const value = argv[i += 1];
      if (!value) throw new Error('--location requires a value');
      location = value;
    } else if (arg === '--pages') {
      const value = Number(argv[i += 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--pages must be a positive integer');
      pages = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (terms.length === 0) throw new Error('at least one --term is required');
  return { terms, location, pages };
}

function buildUrl(term, location, page) {
  const url = new URL(RESULTS);
  url.searchParams.set('q', term);
  if (location) url.searchParams.set('location', location);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.href;
}

// Runs in the page. Each card is an <li> holding the job link, an <h3> title and
// a material-icon run ("corporate_fare Google place Tel Aviv, Israel bar_chart …"),
// which is the only place the company and location appear as text.
function extractCards() {
  const seen = new Set();
  const rows = [];

  for (const anchor of document.querySelectorAll('a[href*="jobs/results/"]')) {
    const href = anchor.getAttribute('href');
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const card = anchor.closest('li') || anchor.parentElement;
    if (!card) continue;

    const title = card.querySelector('h3')?.innerText?.trim() || '';
    const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
    const company = text.match(/corporate_fare\s+(.+?)\s+place\s/)?.[1]?.trim() || 'Google';
    const location = text.match(/place\s+(.+?)\s+(?:bar_chart|Minimum|Preferred|About)\b/)?.[1]?.trim() || '';

    rows.push({ href, title, company, location });
  }

  return rows;
}

async function collect({ terms, location, pages }) {
  const browser = await chromium.launch();
  const byUrl = new Map();

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    for (const term of terms) {
      for (let pageNum = 1; pageNum <= pages; pageNum += 1) {
        await page.goto(buildUrl(term, location, pageNum), {
          waitUntil: 'domcontentloaded',
          timeout: NAV_TIMEOUT_MS,
        });

        try {
          await page.waitForSelector('a[href*="jobs/results/"]', { timeout: 15_000 });
        } catch {
          break; // no results for this term/page — a later page cannot have more
        }
        await page.waitForTimeout(SETTLE_MS);

        const rows = await page.evaluate(extractCards);
        if (rows.length === 0) break;

        for (const row of rows) {
          if (!row.title) continue;
          const url = new URL(row.href, BASE).href;
          byUrl.set(url, {
            title: row.title,
            url,
            company: row.company,
            location: row.location,
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  return [...byUrl.values()];
}

const jobs = await collect(parseArgs(process.argv.slice(2)));
process.stdout.write(JSON.stringify(jobs));
