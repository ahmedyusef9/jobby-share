/**
 * Overlay a search profile onto Explorer filters (M2).
 *
 * Queries become title positives; locations become the allow-list. Recency,
 * sources, excludes, and scan depth stay on the Explore form so every profile
 * pass shares one board window.
 *
 * Pure — no fs — so tests and the Next scanner share one function.
 *
 * @param {Record<string, unknown>} filters
 * @param {{ queries?: string[], locations?: string[] }} profile
 */
export function applyProfileToFilters(filters, profile) {
  return {
    ...filters,
    positive: [...(profile.queries ?? [])],
    allow: [...(profile.locations ?? [])],
  };
}
