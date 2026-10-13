/**
 * Tracker score / notes helpers shared by web MCP tools and tests.
 */

/** Accept X.X/5, bare 0–5, or N/100 (ChatGPT drafts) → canonical X.X/5 or "". */
export function normalizeTrackerScore(raw) {
  if (raw == null || raw === '') return '';
  const s = String(raw).trim();
  if (!s || s === 'N/A' || s === '—' || s === '-') return '';
  const per100 = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*100$/i);
  if (per100) {
    const n = Math.max(0, Math.min(100, Number(per100[1])));
    return `${(n / 20).toFixed(1)}/5`;
  }
  const per5 = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*5$/i);
  if (per5) {
    const n = Math.max(0, Math.min(5, Number(per5[1])));
    return `${n.toFixed(1)}/5`;
  }
  const bare = Number(s);
  if (Number.isFinite(bare)) {
    if (bare > 5 && bare <= 100) return `${(bare / 20).toFixed(1)}/5`;
    if (bare >= 0 && bare <= 5) return `${bare.toFixed(1)}/5`;
  }
  return '';
}

/** Pull posting URL from notes (`url=https://…`). */
export function urlFromNotes(notes) {
  const m = String(notes ?? '').match(/\burl=(https?:\/\/\S+)/i);
  return m ? m[1].replace(/[.,;)]+$/, '') : null;
}
