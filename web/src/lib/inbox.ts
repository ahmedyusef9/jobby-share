// Pure, client-side derivations for the inbox triage view. Every signal here is
// FREE — parsed from data the raw posting already carries (URL host, title text,
// first_seen date). 🔴 None of this ranks or scores relevance; it only labels and
// buckets so the cheap facet filters can narrow the firehose with zero tokens.

import type { AtsSource } from "@/lib/explore";

/** Which ATS a posting lives on, derived from its URL host (0 tokens, no network).
 *  Matches on the registrable domain anchored at a dot boundary (host === base OR
 *  host ends with ".base") — never a bare substring, so "greenhouse.io.evil.com"
 *  or "notlever.co" can't be misread as that ATS. */
export function sourceFromUrl(url: string): AtsSource | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const domainIs = (base: string) => host === base || host.endsWith(`.${base}`);
  if (domainIs("greenhouse.io")) return "greenhouse";
  if (domainIs("lever.co")) return "lever";
  if (domainIs("ashbyhq.com")) return "ashby";
  if (domainIs("myworkdayjobs.com") || domainIs("workday.com")) return "workday";
  if (domainIs("linkedin.com")) return "linkedin";
  if (domainIs("drushim.co.il")) return "drushim";
  return null;
}

// Coarse seniority buckets, detected from the title. Ordered senior→junior so the
// facet chips read top-down; a title that matches nothing gets no tag (still shows,
// just untagged). We only ever surface buckets that actually appear in the data.
export type Seniority = "lead" | "staff" | "senior" | "mid" | "junior" | "intern";
export const SENIORITY_ORDER: Seniority[] = ["lead", "staff", "senior", "mid", "junior", "intern"];
export const SENIORITY_LABEL: Record<Seniority, string> = {
  lead: "Lead / Mgr",
  staff: "Staff+",
  senior: "Senior",
  mid: "Mid",
  junior: "Junior",
  intern: "Intern",
};

export function seniorityFromTitle(title: string): Seniority | null {
  const t = ` ${title.toLowerCase()} `;
  if (/\b(head|vp|vice president|director|chief|manager|mgr|lead)\b/.test(t)) return "lead";
  if (/\b(staff|principal|distinguished|fellow|architect)\b/.test(t)) return "staff";
  if (/\b(senior|sr\.?|snr)\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|entry|graduate|associate)\b/.test(t)) return "junior";
  if (/\b(intern|internship|working student|apprentice)\b/.test(t)) return "intern";
  // an untagged IC role sits in the broad middle
  if (/\b(engineer|developer|scientist|designer|analyst|manager|specialist|consultant)\b/.test(t)) return "mid";
  return null;
}

/** Whole days between an ISO date (YYYY-MM-DD) and now; null if unparseable. */
export function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

/** Sticky location preference for inbox — default Israel so you don't retype it. */
export const DEFAULT_LOC_PREF = "Israel";

/** Country / region options for the inbox location dropdown. */
export const COUNTRY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any country" },
  { value: "Israel", label: "Israel" },
  { value: "Remote", label: "Remote" },
  { value: "Germany", label: "Germany" },
  { value: "Netherlands", label: "Netherlands" },
  { value: "United Kingdom", label: "United Kingdom" },
  { value: "Spain", label: "Spain" },
  { value: "France", label: "France" },
  { value: "United States", label: "United States" },
  { value: "Canada", label: "Canada" },
  { value: "Europe", label: "Europe" },
];

/**
 * One-click role/tech suggestions for the search bar — tuned to a backend-leaning
 * SWE search (Python/Go/platform). Free client filter only.
 */
export const KW_SUGGESTIONS = [
  "software",
  "python",
  "golang",
  "backend",
  "platform",
  "kubernetes",
  "kafka",
  "fastapi",
  "senior",
  "staff",
  "data",
  "AI",
  "LLM",
  "infra",
] as const;

// USPS two-letter state/territory codes, for "City, ST" location strings
// (e.g. "Irving, TX", "Douglasville, GA") that name no specific major city.
const US_STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga",
  "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me", "md",
  "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj",
  "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc",
  "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
  "dc",
]);

function looksLikeUsStateCode(loc: string): boolean {
  const m = loc.match(/,\s*([a-z]{2})\b/);
  return !!m && US_STATE_CODES.has(m[1]);
}

/** US state "IL" (Illinois) — must not count as Israel country code. */
function looksLikeUsIllinois(loc: string): boolean {
  return (
    /,\s*il\b/.test(loc) ||
    /\billinois\b/.test(loc) ||
    /\bil,\s*(usa|united states|\bu\.?s\.?\b)/.test(loc) ||
    /\b(chicago|springfield|naperville|peoria|rockford|evanston|schaumburg)\b.*\bil\b/.test(loc) ||
    /\bil\b.*(chicago|springfield|naperville)/.test(loc)
  );
}

/** Israel family match: "Israel" hits Tel Aviv / Hebrew cities — never US Illinois. */
export function locationMatchesQuery(location: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const loc = (location || "").toLowerCase();

  // Israel filter (dropdown "Israel" or typed "il" / Hebrew).
  // Do NOT treat bare "IL" as Israel — that is Illinois (Chicago, IL).
  if (q === "israel" || q === "il" || q === "ישראל") {
    if (looksLikeUsIllinois(loc)) return false;
    return (
      /\bisrael\b/.test(loc) ||
      loc.includes("ישראל") ||
      /tel[\s-]?aviv|תל[\s-]?אביב/.test(loc) ||
      /yokneam|ra'?anana|raanana|rehovot|רחובות|herzliya|הרצליה|haifa|חיפה|jerusalem|ירושלים|petah|נתניה|netanya|beer[\s-]?sheva|באר/.test(
        loc,
      )
    );
  }

  if (loc.includes(q)) return true;
  if (q === "remote") return /\bremote\b|fully remote|work from home|\bwfh\b/.test(loc);
  if (q === "germany" || q === "de") return /\bgermany\b|\bdeutschland\b|\bberlin\b|\bmunich\b|\bmünchen\b|\bhamburg\b/.test(loc);
  if (q === "netherlands" || q === "nl") return /\bnetherlands\b|\bholland\b|\bamsterdam\b|\butrecht\b|\brotterdam\b/.test(loc);
  if (q === "united kingdom" || q === "uk") return /\bunited kingdom\b|\bengland\b|\blondon\b|\buk\b|\bscotland\b/.test(loc);
  if (q === "spain" || q === "es") return /\bspain\b|\bespaña\b|\bmadrid\b|\bbarcelona\b/.test(loc);
  if (q === "france" || q === "fr") return /\bfrance\b|\bparis\b|\blyon\b/.test(loc);
  if (q === "united states" || q === "usa" || q === "us") {
    return (
      /\bunited states\b|\busa\b|\bu\.?s\.?a\.?\b|\bnew york\b|\bsan francisco\b|\bseattle\b|\bchicago\b|\billinois\b/.test(
        loc,
      ) || looksLikeUsStateCode(loc)
    );
  }
  if (q === "canada" || q === "ca") return /\bcanada\b|\btoronto\b|\bvancouver\b|\bmontreal\b/.test(loc);
  if (q === "europe" || q === "eu") return /\beurope\b|\beu\b|emea|germany|netherlands|spain|france|uk|united kingdom|berlin|amsterdam|paris|london|madrid/.test(loc);
  return false;
}

/**
 * Company/role keyword match.
 * - Space-separated tokens → ANY match (OR) — good for python / software chips
 * - Prefix a token with `+` to require it (AND), e.g. `+senior python`
 */
export function keywordMatchesQuery(company: string, role: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${company} ${role}`.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const required = tokens.filter((t) => t.startsWith("+")).map((t) => t.slice(1)).filter(Boolean);
  const optional = tokens.filter((t) => !t.startsWith("+"));
  if (required.some((t) => !hay.includes(t))) return false;
  if (optional.length === 0) return true;
  return optional.some((t) => hay.includes(t));
}

// Freshness windows mirror the Explore "posted within" segmented control so the two
// surfaces feel like one system. A posting passes a window if its age ≤ the window.
export const FRESHNESS_WINDOWS = [
  { label: "24h", days: 1 },
  { label: "3d", days: 3 },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
] as const;

export type PostedSort = "desc" | "asc" | "match";
export const POSTED_SORT_LABEL: Record<PostedSort, string> = {
  desc: "Posted ↓",
  asc: "Posted ↑",
  match: "Most match",
};

/**
 * Free keyword-fit score for inbox ranking (not an A–F evaluation).
 * Counts how many positive target tokens appear in company+role; negatives subtract.
 */
export function keywordFitScore(
  company: string,
  role: string,
  positive: string[],
  negative: string[] = [],
): { score: number; hits: string[] } {
  const hay = `${company} ${role}`.toLowerCase();
  const hits: string[] = [];
  for (const raw of positive) {
    const p = raw.trim().toLowerCase();
    if (p.length < 2) continue;
    // Multi-word positives: all words should appear (loose AND).
    const parts = p.split(/\s+/).filter(Boolean);
    if (parts.every((part) => hay.includes(part))) hits.push(p);
  }
  let score = hits.length;
  for (const raw of negative) {
    const n = raw.trim().toLowerCase();
    if (n.length >= 2 && hay.includes(n)) score -= 1;
  }
  return { score: Math.max(0, score), hits };
}
