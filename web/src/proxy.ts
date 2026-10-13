import { auth } from "@/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { publicMcpHost } from "@/lib/mcp-public-host";

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function publicMcpGate(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path === "/favicon.ico" || path === "/favicon.png") {
    return new NextResponse(null, { status: 204 });
  }
  if (path.startsWith("/.well-known/")) {
    return NextResponse.json({ error: "oauth is not used — paste /mcp/jb_… with No authentication" }, { status: 404 });
  }
  if (path === "/") {
    if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: MCP_CORS });
    const accept = req.headers.get("accept") || "";
    if (accept.includes("text/event-stream")) {
      return new NextResponse(": connected\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...MCP_CORS },
      });
    }
    return NextResponse.json(
      {
        name: "jobby",
        version: "0.4.0",
        transport: "streamable-http",
        mcp: "/mcp",
      },
      { headers: MCP_CORS },
    );
  }
  if (path === "/mcp" || path.startsWith("/mcp/") || path === "/api/mcp" || path.startsWith("/api/mcp/") || path === "/sse") {
    return NextResponse.next();
  }
  // Dashboard deep links from MCP (tableMarkdown links.jobby) — auth still applies.
  if (
    path === "/pipeline/open" ||
    /^\/pipeline\/\d+/.test(path) ||
    path.startsWith("/signin") ||
    path.startsWith("/api/auth") ||
    path === "/api/posting" ||
    path.startsWith("/_next")
  ) {
    return NextResponse.next();
  }
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

const handler = auth((req) => {
  if (publicMcpHost(req)) {
    return publicMcpGate(req);
  }
  const path = req.nextUrl.pathname;
  if (
    path.startsWith("/signin") ||
    path.startsWith("/api/auth") ||
    path === "/api/signup" ||
    path === "/api/mcp" ||
    path.startsWith("/api/mcp/") ||
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    // Signed resume links (BL-055): the HMAC token IS the grant — the link
    // must open in a bare browser with no session, or it is worthless.
    path.startsWith("/api/resume/")
  ) {
    return NextResponse.next();
  }
  if (path.startsWith("/_next") || path.startsWith("/brand") || path === "/icon.svg") {
    return NextResponse.next();
  }
  if (!req.auth?.user) {
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    url.searchParams.set("callbackUrl", path);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export default handler;
export { handler as proxy };

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|brand/).*)"],
};
