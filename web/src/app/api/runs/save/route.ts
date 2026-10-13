import { withTenant } from "@/lib/tenant/http";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { tenantRoot } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  id?: string;
  title?: string;
  subtitle?: string;
  page?: string;
  input?: string;
  kind?: string;
  result?: { score: number | null; summary: string; tone?: string };
  steps?: { kind: string; label: string; ts?: number }[];
  output?: string;
  status?: "done" | "error";
  startedAt?: number;
  endedAt?: number;
  runId?: string;
};

function runsDir(): string {
  return path.join(tenantRoot(), ".career-ops-web", "runs");
}

function safeId(id: string): string {
  return String(id).replace(/[^a-z0-9_-]/gi, "");
}

// Persist a finished worker's log as markdown (+ JSON) under a web-managed dir so
// refresh / Workers can restore history, and the CLI assistant can read past runs.
async function handlePOST(req: Request) {
  let b: Body;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const dir = runsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return NextResponse.json({ error: "mkdir failed" }, { status: 500 });
  }
  const id = safeId(b.id);
  const steps = (b.steps ?? []).map((s) => `- ${s.kind === "tool" ? `🔧 ${s.label}` : s.label}`).join("\n");
  const verdict = b.result?.score != null ? `${b.result.score}/5 — ${b.result.summary || ""}` : "—";
  const md = `# Web run · ${b.title || b.id}

- id: ${b.id}
- page: ${b.page || "-"}
- input: ${b.input || "-"}
- verdict: ${verdict}

## Steps
${steps}

## Output
${b.output || ""}
`;
  const json = {
    id: b.id,
    title: b.title || "",
    subtitle: b.subtitle,
    page: b.page,
    input: b.input,
    kind: b.kind || "evaluate",
    status: b.status || "done",
    result: b.result,
    steps: b.steps || [],
    text: b.output || "",
    startedAt: b.startedAt,
    endedAt: b.endedAt || Date.now(),
    runId: b.runId,
  };
  try {
    fs.writeFileSync(path.join(dir, `${id}.md`), md);
    fs.writeFileSync(path.join(dir, `${id}.job.json`), JSON.stringify(json));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

/** Restore a finished job after refresh when the live SSE run id is gone. */
async function handleGET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const safe = safeId(id);
  const jsonFile = path.join(runsDir(), `${safe}.job.json`);
  try {
    const raw = fs.readFileSync(jsonFile, "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    /* fall through — older runs only wrote .md */
  }

  const mdFile = path.join(runsDir(), `${safe}.md`);
  try {
    const md = fs.readFileSync(mdFile, "utf8");
    const verdictLine = md.match(/^- verdict:\s*(.+)$/m)?.[1]?.trim() || "";
    const scoreM = verdictLine.match(/([\d.]+)\s*\/\s*5/);
    const score = scoreM ? parseFloat(scoreM[1]) : null;
    const summary = verdictLine
      .replace(/^[\d.]+\s*\/\s*5\s*[—:\-|]+\s*/i, "")
      .replace(/\s*VERDICT:.*/i, "")
      .trim()
      .slice(0, 90);
    const input = md.match(/^- input:\s*(.+)$/m)?.[1]?.trim();
    const title = md.match(/^# Web run ·\s*(.+)$/m)?.[1]?.trim() || "";
    const out = md.split(/^## Output\s*$/m)[1]?.trim() || "";
    if (score == null && !out) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({
      id,
      title,
      input: input && input !== "-" ? input : undefined,
      kind: "evaluate",
      status: "done",
      result: score != null ? { score, summary, tone: score >= 4 ? "good" : score >= 3 ? "warn" : "bad" } : undefined,
      steps: [],
      text: out,
      endedAt: Date.now(),
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
