/**
 * Tailscale Funnel (JOBBY_MCP_PUBLIC_URL) must not expose the web app.
 * ChatGPT / Claude.ai dial standard HTTPS (:443) and probe GET / and
 * /.well-known on that origin — those stay MCP-only. :8443 on the same
 * hostname is the companion MCP-only Funnel (Cursor / QA), not the ChatGPT URL.
 */
export function publicMcpHost(req: { headers: { get: (n: string) => string | null } }): boolean {
  const pub = process.env.JOBBY_MCP_PUBLIC_URL?.trim();
  if (!pub) return false;
  try {
    const u = new URL(pub);
    const expectHost = u.hostname.toLowerCase();
    const expectPort = u.port && u.port !== "443" && u.port !== "80" ? u.port : "";
    const headers = [
      req.headers.get("x-forwarded-host"),
      req.headers.get("host"),
    ];
    for (const raw of headers) {
      const incoming = String(raw || "")
        .split(",")[0]
        .trim()
        .toLowerCase();
      if (!incoming) continue;
      const [host, port] = incoming.split(":");
      if (host !== expectHost) continue;
      if (!expectPort) {
        if (!port || port === "443" || port === "80" || port === "8443") return true;
        continue;
      }
      if (!port || port === expectPort) return true;
    }
    return false;
  } catch {
    return false;
  }
}
