/** Canonical href for opening a role’s detail page (one place — inbox, workers, links). */
export function rolePageHref(opts: {
  n?: string | null;
  url?: string | null;
  company?: string;
  role?: string;
}): string {
  const n = opts.n ? String(parseInt(opts.n, 10)) : "";
  if (n && !Number.isNaN(Number(n))) return `/pipeline/${n}`;
  const sp = new URLSearchParams();
  if (opts.url) sp.set("url", opts.url);
  if (opts.company) sp.set("company", opts.company);
  if (opts.role) sp.set("role", opts.role);
  const qs = sp.toString();
  return qs ? `/pipeline/open?${qs}` : "/pipeline";
}
