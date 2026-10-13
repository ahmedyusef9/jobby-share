import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import { detectClis, openCodexLogin, openCursorLogin } from "@/lib/clis";
import { currentAccount, engineDeniedResponse, isOperator } from "@/lib/entitlements";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Detects which agnostic CLIs are installed on THIS machine (local-first). The
// web delegates career-ops to one of these in headless mode, on the user's own
// auth/tokens — no API key needed.
//
// ?health=1 runs a live Codex/Cursor quota/auth probe (can take ~10–25s). Default
// is install+version only so Config paints instantly.
async function handleGET(req: Request) {
  const health = new URL(req.url).searchParams.get("health") === "1";
  const clis = detectClis({ health });
  // Members only see engines they can actually run. Listing OpenCode here is how
  // a leftover Config pick used to look legitimate while still billing the host.
  if (isOperator(currentAccount())) return NextResponse.json({ clis, zeroKey: false });
  // Zero-key rule (BL-058): members run no AI engines through jobby — the
  // engine list is empty rather than a filtered one, so no card can render.
  // zeroKey tells the UI to point refusal copy at MCP instead of Config.
  return NextResponse.json({ clis: [], zeroKey: true });
}

/** Open Codex or Cursor login windows on this machine (Config "Sign in"). */
async function handlePOST(req: Request) {
  let body: { action?: string; cliId?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const denied = engineDeniedResponse(body.cliId);
  if (denied) return denied;
  if (body.action === "login" && body.cliId === "codex") {
    const r = openCodexLogin();
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }
  if (body.action === "login" && body.cliId === "cursor") {
    const r = openCursorLogin();
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }
  return NextResponse.json({ error: "unsupported action" }, { status: 400 });
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
