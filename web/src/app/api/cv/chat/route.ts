import { withTenant } from "@/lib/tenant/http";
import { CAP, modelAccessDenied } from "@/lib/model-access";
import { NextResponse } from "next/server";
import { completeCvChat } from "@/lib/cv/complete-cv-chat";
import {
  CV_CHAT_RETRY,
  CV_CHAT_SYSTEM,
  extractProposedCv,
  looksLikePositioning,
  summarizeCvDiff,
} from "@/lib/cv/propose-cv-edit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_CV = 180_000;
const MAX_INSTRUCTION = 4_000;

/**
 * Propose a revised cv.md. Never writes disk — the editor Accepts into the
 * textarea; Save (POST /api/cv) persists.
 */
async function handlePOST(req: Request) {
  // CV chat is a model call. It already reads only this tenant's own key, so it
  // could never spend the operator's — but nothing checked whether the plan
  // includes it, or whether the account has a key at all.
  const denied = await modelAccessDenied(undefined, CAP.CV_CHAT);
  if (denied) return denied;

  let body: { instruction?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const instruction = String(body.instruction || "").trim();
  const content = String(body.content || "");
  if (!instruction) return NextResponse.json({ error: "instruction required" }, { status: 400 });
  if (!content.trim()) {
    return NextResponse.json({ error: "Load or paste a CV first." }, { status: 400 });
  }
  if (instruction.length > MAX_INSTRUCTION) {
    return NextResponse.json({ error: "instruction too long" }, { status: 413 });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CV) {
    return NextResponse.json({ error: "CV too large" }, { status: 413 });
  }

  const userContent = `CURRENT CV:\n\`\`\`markdown\n${content}\n\`\`\`\n\nUSER REQUEST:\n${instruction}`;

  try {
    let { text, via } = await completeCvChat([
      { role: "system", content: CV_CHAT_SYSTEM },
      { role: "user", content: userContent },
    ]);
    let parsed = extractProposedCv(text);
    if (!parsed) {
      return NextResponse.json(
        { error: "The model did not return a full CV. Try a more specific request.", raw: text.slice(0, 500) },
        { status: 422 },
      );
    }

    let diff = summarizeCvDiff(content, parsed.markdown);
    if (looksLikePositioning(instruction) && diff.lines < 8) {
      const retry = await completeCvChat([
        { role: "system", content: CV_CHAT_SYSTEM },
        { role: "user", content: userContent },
        { role: "assistant", content: text },
        { role: "user", content: CV_CHAT_RETRY },
      ]);
      const retried = extractProposedCv(retry.text);
      if (retried) {
        const retryDiff = summarizeCvDiff(content, retried.markdown);
        if (retryDiff.lines >= diff.lines) {
          parsed = retried;
          diff = retryDiff;
          via = `${retry.via}+retry`;
        }
      }
    }

    if (parsed.markdown === content || diff.lines === 0) {
      return NextResponse.json({
        unchanged: true,
        summary: parsed.summary,
        via,
      });
    }
    return NextResponse.json({
      proposed: parsed.markdown,
      summary: parsed.summary,
      via,
      diff,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "chat failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export const POST = withTenant(handlePOST);
