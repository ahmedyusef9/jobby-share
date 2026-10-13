/**
 * Control characters (including CR/LF) never belong in a redirect target.
 * Checked by codepoint rather than a regex range so the source stays readable.
 * @param {string} v
 */
function hasControlChars(v) {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * `callbackUrl` reaches us as a query parameter, so it is attacker-controlled:
 * a link to /signin?callbackUrl=https://evil.example turns our own sign-in page
 * into an open redirect. Only same-origin relative paths are honoured.
 *
 * @param {unknown} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeCallbackUrl(raw, fallback = "/") {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim();
  if (!v.startsWith("/")) return fallback; // absolute URL, or no leading slash
  // "//evil.example" and "/\evil.example" are both protocol-relative to a browser.
  if (v.startsWith("//") || v.startsWith("/\\")) return fallback;
  if (hasControlChars(v)) return fallback;
  // Returning to the sign-in page after signing in would loop.
  if (v === "/signin" || v.startsWith("/signin?") || v.startsWith("/signin/")) return fallback;
  return v;
}
