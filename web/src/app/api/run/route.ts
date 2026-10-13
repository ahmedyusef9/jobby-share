import { withTenant } from "@/lib/tenant/http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCli, cliSpawnEnv, tenantHasKey } from "@/lib/clis";
import { CAP, currentAccount, HOST_SCORE_DEFERRED, isOperator } from "@/lib/entitlements";
import { modelAccessDenied } from "@/lib/model-access";
import { readMemory } from "@/lib/career-ops";
import { platformRoot, tenantId, tenantRoot } from "@/lib/tenant";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { createRun, emit, endRun, getStopReason, hasRun, killRun, loadPersistedRun, newRunId, subscribe, type RunEvent } from "@/lib/core/run-store";
import { enqueueRun, getQueuedRunState, queueEnabled } from "@/lib/queue/jobby-queue";
import { isScoreFairnessError } from "@/lib/score-fairness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 960; // Ollama Score can run ~15 min; keep above JOBBY_RUN_TIMEOUT_MS defaults

/**
 * Stream a worker-owned run by polling the disk snapshot the worker writes.
 *
 * `owner` is passed in rather than read here: this streams from inside a
 * ReadableStream that outlives the request, where the ambient tenant context is
 * already gone.
 */
function streamQueuedRun(runId: string, owner: string): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: RunEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          closed = true;
        }
      };
      send({ type: "status", label: "Queued for worker…" });
      let lastSteps = 0;
      let lastTextLen = 0;
      let lastQueueKey = "";
      const started = Date.now();
      const maxMs = Number(process.env.JOBBY_RUN_TIMEOUT_MS) || 900_000;

      while (!closed && Date.now() - started < maxMs) {
        const qState = await getQueuedRunState(runId, owner);
        if (qState?.state === "failed") {
          send({
            type: "error",
            msg: qState.failedReason || "Worker failed",
          });
          closed = true;
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          return;
        }
        const waiting =
          qState?.state === "waiting" || qState?.state === "delayed";
        if (waiting) {
          const pos = qState.queuePosition;
          const key = `waiting:${pos ?? "?"}`;
          if (key !== lastQueueKey) {
            lastQueueKey = key;
            const label =
              pos != null ? `Queued (position #${pos})` : "Queued — waiting for the dispatcher";
            send({ type: "queue", state: "waiting", position: pos ?? null, label });
            send({ type: "status", label });
          }
        } else if (qState?.state === "active" && lastQueueKey !== "active") {
          lastQueueKey = "active";
          send({ type: "queue", state: "active", position: null, label: "Evaluating…" });
        }

        const snap = loadPersistedRun(runId);
        if (snap) {
          const steps = snap.snapshot?.steps || [];
          for (let i = lastSteps; i < steps.length; i++) send(steps[i] as RunEvent);
          lastSteps = steps.length;
          const text = String(snap.snapshot?.text || "");
          if (text.length > lastTextLen) {
            send({ type: "text", text: text.slice(lastTextLen) });
            lastTextLen = text.length;
          }
          if (snap.finished || snap.snapshot?.terminal) {
            const term = snap.snapshot?.terminal;
            if (term) send(term as RunEvent);
            else send({ type: "done" });
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
            return;
          }
        }

        await new Promise((r) => setTimeout(r, 800));
      }
      if (!closed) {
        send({ type: "error", msg: "Timed out waiting for worker" });
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Run-Id": runId,
      "X-Jobby-Queue": "1",
    },
  });
}

// The web ORCHESTRATES the real career-ops engine — it does NOT reimplement it.
// kind "evaluate" runs the REAL modes/oferta.md and persists the canonical
// artifacts (A–F report + tracker row) via the SAME scripts the CLI uses
// (reserve-report-num.mjs → reports/ → batch/tracker-additions/ → merge-tracker.mjs),
// so a web evaluation is byte-identical to a CLI one (single source of truth, no
// drift). kind "research" stays read-only. Streams progress as NDJSON events.
function buildPrompt(kind: string, input: string, memory: string, today: string): string {
  const mem = memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "";
  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
  }
  if (kind === "pdf") {
    return `You are generating the user's ATS-optimized, TAILORED CV PDF for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode — follow modes/pdf.md EXACTLY (do not improvise a format).
1. Read modes/pdf.md, cv.md, config/profile.yml, and the evaluation report at reports/${input}-*.md (for the JD keywords + analysis).
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Fill templates/cv-template.html's {{...}} placeholders with the tailored content; write the HTML to /tmp/cv-{candidate}-{company}.html (candidate = the profile name in kebab-case).
4. Render the PDF: \`node generate-pdf.mjs /tmp/cv-{candidate}-{company}.html output/cv-{candidate}-{company}-${today}.pdf --format={letter for US/Canada companies, else a4}\`.
5. Update the tracker: in data/applications.md, change the PDF column for row #${input} from ❌ to ✅.
Do not submit anything anywhere.

End with EXACTLY one final line: VERDICT: {5 if the PDF was written, else 1}/5 — {the output/ path, ≤12 words}`;
  }
  if (kind === "fix-portal") {
    return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine):
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
  }
  // evaluate (default) — run the REAL oferta mode + persist canonically
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/oferta.md and follow it EXACTLY (blocks A–F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.${mem}

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${input}`;
}

async function handlePOST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId } = body;
  if (!input || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  /*
   * Engine + own-key + plan, in one place (JOBBY-BL-048).
   *
   * Key presence is asked of this tenant's store, never of the shared process env.
   * During the POC every account is on `alpha` so the plan half always passes;
   * setting JOBBY_DEFAULT_PLAN=free later closes it for new signups with no code
   * change.
   */
  const actor = currentAccount();
  if (kind === "evaluate" && !isOperator(actor)) {
    return new Response(JSON.stringify({ error: HOST_SCORE_DEFERRED }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const denied = await modelAccessDenied(
    cliId,
    kind === "evaluate" ? CAP.SCORE_JOB : kind === "pdf" ? CAP.GENERATE_CV : undefined,
  );
  if (denied) return denied;
  if (cliId === "openrouter" && !tenantHasKey("openrouter")) {
    return new Response(
      JSON.stringify({ error: "No OpenRouter key on this account — add one in Config." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const { spec, binPath } = resolved;

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs" };
  const required = needsScript[kind];
  if (required && !fs.existsSync(path.join(platformRoot(), required))) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "pdf") && !fs.existsSync(path.join(tenantRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Redis queue path: enqueue for deploy/worker and stream disk snapshots.
  if (queueEnabled()) {
    const runId = newRunId();
    createRun(runId, kind, null);
    emit(runId, { type: "status", label: `Enqueued · ${cliId} · ${kind}` });
    try {
      await enqueueRun({ runId, kind, input, cliId, tenantId: tenantId(), createdAt: Date.now() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "enqueue failed";
      emit(runId, { type: "error", msg });
      endRun(runId);
      const status = isScoreFairnessError(e) ? (e as { status?: number }).status || 429 : 503;
      const code = isScoreFairnessError(e) ? (e as { code?: string }).code : undefined;
      return new Response(JSON.stringify({ error: msg, code }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return streamQueuedRun(runId, tenantId());
  }

  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt(kind, input, readMemory(), today);

  const isClaude = cliId === "claude";
  const isCodex = cliId === "codex";
  const isCursor = cliId === "cursor";
  const isOllama = cliId === "ollama";
  // Tool scope by kind (comma-separated lists; disallowedTools is the hard
  // guardrail). 'evaluate' runs the REAL mode + persists canonical artifacts →
  // it needs Write + Bash (reserve-report-num / merge-tracker / write the
  // report). 'research' stays read-only. Task (sub-agents) is always blocked
  // (runaway cost). NEVER auto-submits — that is a prompt-level guarantee.
  const tools =
    kind === "evaluate" || kind === "fix-portal" || kind === "pdf"
      ? { allowed: "Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep", disallowed: "Task,NotebookEdit" }
      : { allowed: "Read,WebFetch,WebSearch,Glob,Grep", disallowed: "Bash,Write,Edit,NotebookEdit,Task" };
  // Claude's default model can be out of credits while the named ones still have
  // quota, which fails every run here for a reason that looks like broken auth.
  // JOBBY_CLAUDE_MODEL pins a model with quota; unset keeps the account default.
  const claudeModel = process.env.JOBBY_CLAUDE_MODEL?.trim();
  const persist = kind === "evaluate" || kind === "fix-portal" || kind === "pdf";
  const args = isClaude
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
       "--permission-mode", "acceptEdits",
       ...(claudeModel ? ["--model", claudeModel] : []),
       "--allowedTools", tools.allowed,
       "--disallowedTools", tools.disallowed]
    : spec.args(prompt, { persist });

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (a CLI without write auth silently no-ops).
  const reportsDir = path.join(tenantRoot(), "reports");
  const countReports = () => {
    try {
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  const persists = kind === "evaluate";
  const reportsBefore = persists ? countReports() : 0;
  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;

  // stdin MUST be ignored: Codex treats an open pipe as "read more prompt from
  // stdin" and stalls ("Reading additional input from stdin...") until EOF.
  const child = spawn(binPath, args, {
    cwd: tenantRoot(),
    env: cliSpawnEnv(cliId),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runId = newRunId();
  createRun(runId, kind, child);

  // Everything below is wired to the RUN, not to this response. It runs exactly
  // once no matter how many clients attach, detach or reload, which is what makes
  // a reload survivable: the child reports into the store and nothing about an
  // HTTP disconnect can reach it.
  let buf = "";
  let emittedText = false; // any assistant text delta → the CLI actually ran
  let sawError = false;
  // Complete stdout lines that aren't stream-json. These are the CLI talking in
  // plain text ("You're out of usage credits.") — the one case where the real
  // reason for a failed run never reaches stderr, so keep it for the error path.
  const plainStdout: string[] = [];
  let lastTokens = 0; // per-run token cost from the Claude result event (#6) — local only
  let lastCostUsd: number | null = null;
  let lastThinkingAt = 0;
  // The ONLY thing that stops a run early now, so it doubles as the ceiling on what
  // an abandoned run can spend. A real A–G evaluation that has to web-search the
  // company runs well past 5 minutes — the old 285s killed one *after* it had already
  // written its report and merged the tracker row, losing only the verdict, which is
  // the worst possible place to cut. Both stay under `maxDuration` above.
  // Local Ollama (qwen3) is slower than frontier cloud models — give Score more room.
  const defaultKillMs = kind === "pdf" ? 720_000 : isOllama ? 900_000 : 600_000;
  const killMs = Number(process.env.JOBBY_RUN_TIMEOUT_MS) || defaultKillMs;
  const killer = setTimeout(() => {
    killRun(runId, "timeout");
  }, killMs);

  const send = (ev: RunEvent) => emit(runId, ev);

  // Keep the NDJSON stream + UI alive while OpenCode/Ollama think for minutes
  // without emitting events (buffered JSON until a step finishes).
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (!hasRun(runId)) return;
    const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
    send({
      type: "status",
      label: isOllama
        ? `Ollama still working · ${mins}m (qwen can take several minutes before the first tool)`
        : `Still working · ${mins}m`,
      heartbeat: true,
    });
  }, 15_000);

  // Immediate phase so the UI isn't blank while the CLI boots (can be 10–30s).
  send({
    type: "status",
    label:
      kind === "evaluate"
        ? isOllama
          ? `Starting ollama · full A–F evaluation (local model — first progress can take 2–5+ min)`
          : `Starting ${cliId} · full A–F evaluation (fetch JD → score vs CV → write report → merge tracker)`
        : `Starting ${cliId} · ${kind}`,
  });

  /** Map Cursor stream-json tool_call payload keys → career-ops tool names. */
  const cursorToolName = (toolCall: Record<string, unknown> | undefined): string | null => {
    if (!toolCall) return null;
    const key = Object.keys(toolCall).find((k) => /ToolCall$/i.test(k));
    if (!key) return null;
    const map: Record<string, string> = {
      readToolCall: "Read",
      writeToolCall: "Write",
      editToolCall: "Edit",
      shellToolCall: "Bash",
      grepToolCall: "Grep",
      globToolCall: "Glob",
      lsToolCall: "Glob",
      deleteToolCall: "Edit",
      webFetchToolCall: "WebFetch",
      webfetchToolCall: "WebFetch",
      webSearchToolCall: "WebSearch",
      websearchToolCall: "WebSearch",
      awaitToolCall: "Bash",
    };
    return map[key] || key.replace(/ToolCall$/i, "");
  };

  const cursorToolDetail = (toolCall: Record<string, unknown> | undefined): string | null => {
    if (!toolCall) return null;
    const key = Object.keys(toolCall).find((k) => /ToolCall$/i.test(k));
    if (!key) return null;
    const body = toolCall[key] as { args?: Record<string, unknown>; description?: string } | undefined;
    if (!body) return null;
    if (typeof body.description === "string" && body.description.trim()) return body.description.trim().slice(0, 100);
    const a = body.args || {};
    if (typeof a.path === "string") return String(a.path).split("/").slice(-2).join("/");
    if (typeof a.command === "string") return String(a.command).slice(0, 80);
    if (typeof a.pattern === "string") return String(a.pattern).slice(0, 60);
    if (typeof a.url === "string") return String(a.url).slice(0, 80);
    if (typeof a.query === "string") return String(a.query).slice(0, 60);
    return null;
  };

  child.stdout.on("data", (d: Buffer) => {
    if (isCodex) {
      // Codex exec --json → JSONL ThreadEvents (thread.*/turn.*/item.*/error).
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as {
            type?: string;
            message?: string;
            item?: { type?: string; text?: string; content?: string; command?: string; changes?: unknown };
            error?: { message?: string };
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cached_input_tokens?: number;
              cache_write_input_tokens?: number;
            };
          };
          if (ev.type === "thread.started" || ev.type === "turn.started") {
            send({ type: "status", label: "Agent ready" });
          } else if (ev.type === "error" || ev.type === "turn.failed") {
            sawError = true;
            const msg = ev.message || ev.error?.message || "Codex run failed";
            send({ type: "error", msg: String(msg).slice(0, 240) });
          } else if (ev.type === "item.started" || ev.type === "item.completed") {
            const item = ev.item || {};
            const t = item.type || "";
            if (t === "command_execution") {
              send({ type: "tool", name: item.command ? `Bash` : "Bash" });
              if (item.command) send({ type: "status", label: String(item.command).slice(0, 80) });
            } else if (t === "file_change") {
              send({ type: "tool", name: "Write" });
            } else if (t === "web_search" || t === "mcp_tool_call") {
              send({ type: "tool", name: t === "web_search" ? "WebSearch" : "MCP" });
            } else if (t === "agent_message") {
              const text = item.text || item.content || "";
              if (text) {
                emittedText = true;
                send({ type: "text", text: String(text) });
              }
            }
          } else if (ev.type === "turn.completed" && ev.usage) {
            const u = ev.usage;
            lastTokens =
              (u.input_tokens || 0) +
              (u.output_tokens || 0) +
              (u.cached_input_tokens || 0) +
              (u.cache_write_input_tokens || 0);
          }
        } catch {
          if (plainStdout.length < 5) plainStdout.push(line.slice(0, 200));
          // Non-JSON noise — surface as text so the UI isn't blank.
          emittedText = true;
          send({ type: "text", text: line + "\n" });
        }
      }
      return;
    }
    if (isCursor) {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as {
            type?: string;
            subtype?: string;
            text?: string;
            model?: string;
            message?: { content?: Array<{ type?: string; text?: string }> };
            tool_call?: Record<string, unknown>;
            result?: string;
            is_error?: boolean;
            usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
          };
          if (ev.type === "system" && ev.subtype === "init") {
            send({ type: "status", label: ev.model ? `Cursor ready · ${ev.model}` : "Cursor Agent ready" });
          } else if (ev.type === "thinking" && ev.subtype === "delta" && ev.text) {
            // Throttle thinking spam — show a short planning crumb every ~4s.
            const now = Date.now();
            if (now - lastThinkingAt > 4000) {
              lastThinkingAt = now;
              send({ type: "status", label: `Planning: ${String(ev.text).trim().slice(0, 90)}` });
            }
          } else if (ev.type === "tool_call" && ev.subtype === "started") {
            const name = cursorToolName(ev.tool_call) || "Tool";
            send({ type: "tool", name });
            const detail = cursorToolDetail(ev.tool_call);
            if (detail) send({ type: "status", label: detail });
          } else if (ev.type === "assistant" && ev.message?.content) {
            for (const part of ev.message.content) {
              if (part?.type === "text" && part.text) {
                emittedText = true;
                send({ type: "text", text: part.text });
              }
            }
          } else if (ev.type === "result") {
            if (ev.is_error) {
              sawError = true;
              send({ type: "error", msg: String(ev.result || "Cursor Agent failed").slice(0, 240) });
            } else if (ev.result) {
              emittedText = true;
              send({ type: "text", text: String(ev.result) });
            }
            if (ev.usage) {
              lastTokens =
                (ev.usage.inputTokens || 0) +
                (ev.usage.outputTokens || 0) +
                (ev.usage.cacheReadTokens || 0) +
                (ev.usage.cacheWriteTokens || 0);
            }
          }
        } catch {
          if (/usage limit|ActionRequiredError|out of usage credits/i.test(line)) {
            sawError = true;
            send({ type: "error", msg: line.slice(0, 240) });
          } else if (plainStdout.length < 5) {
            plainStdout.push(line.slice(0, 200));
          }
        }
      }
      return;
    }
    if (isOllama) {
      // OpenCode --format json → step_start / text / tool / step_finish events.
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as {
            type?: string;
            part?: {
              type?: string;
              text?: string;
              reason?: string;
              tool?: string;
              state?: { status?: string; input?: Record<string, unknown>; title?: string };
              tokens?: {
                total?: number;
                input?: number;
                output?: number;
                reasoning?: number;
              };
            };
            error?: { message?: string };
            message?: string;
          };
          const t = ev.type || "";
          const part = ev.part || {};
          if (t === "step_start") {
            send({ type: "status", label: "OpenCode → Ollama ready" });
          } else if (t === "text" && part.text) {
            emittedText = true;
            send({ type: "text", text: String(part.text) });
          } else if (t === "tool" || part.type === "tool") {
            const name = part.tool || part.state?.title || "Tool";
            send({ type: "tool", name: String(name).slice(0, 40) });
            const input = part.state?.input;
            if (input) {
              const detail =
                (typeof input.path === "string" && input.path) ||
                (typeof input.command === "string" && input.command) ||
                (typeof input.url === "string" && input.url) ||
                (typeof input.pattern === "string" && input.pattern) ||
                null;
              if (detail) send({ type: "status", label: String(detail).slice(0, 100) });
            }
          } else if (t === "step_finish" && part.tokens) {
            const u = part.tokens;
            lastTokens = (u.input || 0) + (u.output || 0) + (u.reasoning || 0);
          } else if (t === "error") {
            sawError = true;
            send({
              type: "error",
              msg: String(ev.message || ev.error?.message || "OpenCode/Ollama error").slice(0, 240),
            });
          }
        } catch {
          if (plainStdout.length < 5) plainStdout.push(line.slice(0, 200));
          emittedText = true;
          send({ type: "text", text: line + "\n" });
        }
      }
      return;
    }
    if (!isClaude) {
      emittedText = true;
      send({ type: "text", text: d.toString() });
      return;
    }
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "stream_event") {
          const e = ev.event;
          if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
            send({ type: "tool", name: e.content_block.name });
          } else if (e?.type === "content_block_delta" && e.delta?.text) {
            emittedText = true;
            send({ type: "text", text: e.delta.text });
          }
        } else if (ev.type === "system" && ev.subtype === "init") {
          send({ type: "status", label: "Agent ready" });
        } else if (ev.type === "rate_limit_event" && ev.rate_limit_info?.status === "rejected") {
          // Quota refusal. It arrives as a well-formed event and produces no
          // assistant text, so without this branch the run only shows up as a
          // non-zero exit and gets reported as a possible auth/install problem.
          // Note this is per-MODEL: the default can be out of credits while
          // the named models still work (see JOBBY_CLAUDE_MODEL above).
          sawError = true;
          const info = ev.rate_limit_info;
          send({
            type: "error",
            msg: info.errorCode === "credits_required" || info.overageDisabledReason === "out_of_credits"
              ? "Claude is out of usage credits for this model. Buy credits, or set JOBBY_CLAUDE_MODEL to a model that still has quota (sonnet/haiku/opus) and restart the web UI."
              : `Claude refused the request: ${info.errorCode || "rate limited"}.`,
          });
        } else if (ev.type === "result") {
          // Capture the per-run cost; the authoritative "done" is sent on close
          // (so the honesty gate decides done-vs-error first). Tokens = the same
          // formula /api/usage uses: input + output + cache-creation.
          const u = ev.usage || {};
          lastTokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (typeof ev.total_cost_usd === "number") lastCostUsd = ev.total_cost_usd;
        }
      } catch {
        // A newline-terminated line is never a partial frame — partials stay
        // in `buf` until their newline arrives — so this is real plain text.
        if (plainStdout.length < 5) plainStdout.push(line.slice(0, 200));
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    const s = d.toString();
    // Codex logs non-fatal cache/MCP noise on stderr at ERROR level. Don't mark
    // the whole run failed for those — only real auth/quota/refusal lines.
    if (/codex_models_manager::cache|rmcp::transport::worker/i.test(s)) {
      // Surface as status so the UI shows it without failing the honesty gate.
      const one = s.trim().split("\n")[0]?.slice(0, 180);
      if (one) send({ type: "status", label: one });
      return;
    }
    // OpenCode prints structured logs to stderr; "error" as a substring in INFO
    // lines must not abort the live UI stream.
    if (isOllama && /^\s*timestamp=.*\blevel=(DEBUG|INFO|WARN)\b/m.test(s)) {
      return;
    }
    if (/\b(error|denied|fatal|unauthorized|forbidden|not authenticated|usage limit|out of usage credits)\b/i.test(s) &&
        !/\blevel=(DEBUG|INFO|WARN)\b/i.test(s)) {
      sawError = true;
      send({ type: "error", msg: s.trim().slice(0, 200) });
    }
  });
  child.on("error", (e) => {
    clearInterval(heartbeat);
    send({ type: "error", msg: e.message });
    clearTimeout(killer);
    if (writeToken !== null) releaseTrackerWrite(writeToken);
    endRun(runId);
  });
  child.on("close", (code) => {
    clearInterval(heartbeat);
    clearTimeout(killer);
    // Released HERE, on the worker actually exiting — not on client disconnect.
    // The merge runs inside the child, so releasing on disconnect freed the lock
    // while the worker was still writing and let a row delete race the merge.
    if (writeToken !== null) releaseTrackerWrite(writeToken);

    const wroteReport = countReports() > reportsBefore;
    const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
    // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
    // real output, AND (for evaluations) a report actually written. Anything else
    // is surfaced — an errored run must never be banked as a confident score.
    const plainReason = plainStdout.join(" ").trim().slice(0, 200);
    const stopped = getStopReason(runId);
    if (stopped) {
      // We ended it, so the exit code says nothing about the CLI's health. Checked
      // first: otherwise a deliberate stop is reported as a possible install or
      // auth failure, which sends you debugging a working setup.
      send({
        type: "error",
        msg: stopped === "timeout"
          ? `Stopped after ${Math.round(killMs / 60_000)} min — the run hit its time limit.${wroteReport ? " A report was written before it stopped." : ""}`
          : "Stopped.",
      });
    } else if (!emittedText && !sawError && !cleanExit) {
      send({
        type: "error",
        msg: plainReason
          ? `The CLI exited with an error: ${plainReason}`
          : "The CLI exited with an error — is it installed and authenticated?",
      });
    } else if (!emittedText && !sawError) {
      send({
        type: "error",
        msg: plainReason
          ? `The CLI produced no usable output: ${plainReason}`
          : "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)",
      });
    } else if (persists && !wroteReport) {
      // The worker ran but never wrote the report/tracker row (e.g. a CLI
      // without file-write authorization) — surface it instead of a fake score.
      send({
        type: "error",
        msg: isCodex
          ? "Codex finished without writing a report (check sandbox/quota). Re-run, or use Claude Code / Cursor Agent for Score/PDF."
            : isCursor
            ? "Cursor Agent finished without writing a report. Check auth/quota and that --force can write under the career-ops root."
            : isOllama
              ? "Ollama/OpenCode finished without writing a report. The model may have stalled — Retry, or use Claude/Cursor for Score."
            : "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code, Codex, and Cursor Agent.",
      });
    } else if (!cleanExit || sawError) {
      // Produced output (maybe even a report) but did NOT finish cleanly — flag it
      // instead of recording a confident score off a half-finished run.
      send({ type: "error", msg: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." });
    } else {
      send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
    }
    endRun(runId);
  });

  return streamRun(runId);
}

// Attach a response to a run. Used for both the initial POST and a reattach after
// a reload. cancel() only detaches — stopping a run is an explicit DELETE.
function streamRun(runId: string): Response {
  const enc = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      unsubscribe = subscribe(runId, (ev) => {
        if (closed) return;
        if (ev === null) {
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        try {
          controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        } catch {
          // Client is gone; stop writing but leave the run alone.
          closed = true;
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      // How the client learns which run to reattach to after a reload.
      "X-Run-Id": runId,
    },
  });
}

// Reattach to a run in progress (or one that finished within the retention window,
// so a reload right at the end still collects the result).
async function handleGET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return new Response(JSON.stringify({ error: "id required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!hasRun(id)) {
    // Unknown id: never started, or disk snapshot missing after a long GC.
    return new Response(JSON.stringify({ error: "unknown or expired run" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  // hasRun() hydrates from `.career-ops-web/runs/{id}.json` after refresh/HMR.
  return streamRun(id);
}

// Explicit stop. Needed now that closing the tab no longer kills the worker.
async function handleDELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return new Response(JSON.stringify({ error: "id required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ stopped: killRun(id) }), {
    headers: { "Content-Type": "application/json" },
  });
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
export const DELETE = withTenant(handleDELETE);
