#!/usr/bin/env node
/**
 * Run an agent Score/PDF/research job: spawn in-container CLI or openrouter-runner.
 * Persists progress under tenants/{id}/.career-ops-web/runs/{runId}.json
 * (same shape the web UI polls).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { accountForTenantStrict } from "../../scripts/accounts.mjs";
import { HOST_ENGINE_DENIAL, isOperator, mayUseEngine } from "../../scripts/entitlements.mjs";
import { migrateDefaultTenant, platformRoot, jobProviderEnv, tenantChildEnv, tenantRoot, workerTenantId } from "./tenant-root.mjs";

function runsDir() {
  return path.join(tenantRoot(), ".career-ops-web", "runs");
}

function snapshotPath(runId) {
  const safe = String(runId).replace(/[^a-z0-9_-]/gi, "");
  return path.join(runsDir(), `${safe}.json`);
}

function writeSnap(runId, kind, snapshot, finished, extra = {}) {
  fs.mkdirSync(runsDir(), { recursive: true });
  const payload = {
    id: runId,
    kind,
    finished,
    createdAt: extra.createdAt || Date.now(),
    endedAt: finished ? Date.now() : undefined,
    snapshot,
  };
  fs.writeFileSync(snapshotPath(runId), JSON.stringify(payload));
}

/**
 * Dispatcher writes the real terminal after artifact checks. The CLI process
 * must not mark a run finished — a VERDICT line is not a report.
 */
export function patchRunSnapshot(runId, kind, patch = {}) {
  if (!runId) return;
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(snapshotPath(runId), 'utf8'));
  } catch {
    existing = { id: runId, kind, createdAt: Date.now(), snapshot: { steps: [], text: '', terminal: null } };
  }
  const snapshot = {
    ...(existing.snapshot || {}),
    ...(patch.snapshot || {}),
  };
  writeSnap(runId, existing.kind || kind, snapshot, patch.finished !== false, {
    createdAt: existing.createdAt,
  });
}

function findBin(bin) {
  const home = process.env.HOME || "/root";
  const dirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    "/usr/local/bin",
    "/usr/bin",
    path.join(home, ".opencode/bin"),
    path.join(home, ".local/bin"),
    "/opt/homebrew/bin",
  ];
  const names = bin === "cursor-agent" ? ["cursor-agent", "cursor"] : [bin];
  for (const name of names) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function buildPrompt(kind, input, today) {
  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target and report: what it is, why it is impressive, and how to leverage it in their job search. Be specific.\n\nEnd with EXACTLY one final line: VERDICT: {0-5}/5 — {why, ≤12 words}\n\nTarget: ${input}`;
  }
  if (kind === "pdf") {
    return `Generate the ATS-tailored CV PDF for application #${input}. Follow modes/pdf.md. End with VERDICT: {5|1}/5 — {path}\nToday: ${today}`;
  }
  if (kind === "fix-portal") {
    return `Repair the ATS slug for company "${input}" using verify-portals.mjs. End with VERDICT: {5|1}/5 — {what changed}`;
  }
  const scripts = process.env.CAREER_OPS_ROOT || "/data";
  return `You are running the OFFICIAL career-ops job evaluation HEADLESS. Today is ${today}. Follow ${scripts}/modes/oferta.md EXACTLY.
The working directory is this tenant's workspace: cv.md, config/profile.yml, reports/, data/ are HERE. Do not read /data/cv.md or other tenants/.
Career-ops scripts live at ${scripts}. Run them as \`node ${scripts}/reserve-report-num.mjs\` (same for doctor.mjs, merge-tracker.mjs). Never \`node doctor.mjs\` from this directory.
Persist: reserve-report-num.mjs → reports/{num}-*.md → batch/tracker-additions/ → node ${scripts}/merge-tracker.mjs.
Never submit applications. Do not touch /dev. A run without a written report and a VERDICT line has failed.

End with EXACTLY one final line:
VERDICT: {score}/5 — {reason ≤12 words}

Posting URL: ${input}`;
}

function resolveEngine(cliId) {
  if (cliId === "openrouter" || cliId === "api-key") {
    const runner = path.join(platformRoot(), "openrouter-runner.mjs");
    if (!fs.existsSync(runner)) {
      const fallback = path.join(platformRoot(), "openrouter-runner.mjs");
      if (!fs.existsSync(fallback)) throw new Error("openrouter-runner.mjs not found");
      return { mode: "openrouter", bin: process.execPath, args: [fallback] };
    }
    return { mode: "openrouter", bin: process.execPath, args: [runner] };
  }
  const map = {
    claude: "claude",
    codex: "codex",
    cursor: "cursor-agent",
    opencode: "opencode",
    ollama: "opencode",
    gemini: "gemini",
  };
  const binName = map[cliId] || cliId;
  const bin = findBin(binName);
  if (!bin) throw new Error(`CLI '${cliId}' not found in container PATH`);
  return { mode: "cli", bin, cliId };
}

function cliArgs(engine, kind, prompt) {
  const { mode, bin, cliId, args: base } = engine;
  if (mode === "openrouter") {
    // openrouter-runner evaluate <url|text>
    const input = prompt.includes("Posting URL:")
      ? prompt.split("Posting URL:").pop().trim()
      : prompt;
    return { bin: process.execPath, args: [...base.slice(1), "evaluate", input] };
  }
  if (cliId === "claude") {
    return {
      bin,
      args: [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep",
        "--disallowedTools",
        "Task,NotebookEdit",
      ],
    };
  }
  if (cliId === "codex") {
    return {
      bin,
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--sandbox",
        "workspace-write",
        "-c",
        'approval_policy="never"',
        "-c",
        "sandbox_workspace_write.network_access=true",
        prompt,
      ],
    };
  }
  if (cliId === "ollama") {
    const model = process.env.JOBBY_OLLAMA_MODEL || "qwen3:8b";
    return {
      bin,
      args: ["run", "--format", "json", "--auto", "--pure", "-m", `ollama/${model}`, "--dir", tenantRoot(), prompt],
    };
  }
  // opencode / gemini / default
  if (bin.includes("opencode") || cliId === "opencode") {
    const model = process.env.OPENCODE_MODEL?.trim() || "omniroute/auto/best-coding";
    return {
      bin,
      args: ["run", "--format", "json", "--auto", "--pure", "-m", model, "--dir", tenantRoot(), prompt],
    };
  }
  return { bin, args: ["-p", prompt] };
}

/**
 * Plain cv.md → PDF. No AI CLI — Chromium lives on this image, not on web.
 */
async function executeCvExport(job) {
  migrateDefaultTenant();
  const { runId, input, createdAt } = job.data;
  if (!runId) throw new Error("runId required");

  const maxPages = Math.max(1, Math.min(3, Number.parseInt(String(input || "1"), 10) || 1));
  const script = path.join(platformRoot(), "scripts", "cv-export.mjs");
  const steps = [];
  let text = "";
  const push = (ev) => {
    steps.push(ev);
    if (steps.length > 500) steps.splice(0, steps.length - 500);
    writeSnap(runId, "cv-export", { steps, text, terminal: null }, false, { createdAt });
  };

  if (!fs.existsSync(script)) {
    const msg = "scripts/cv-export.mjs missing under CAREER_OPS_ROOT";
    writeSnap(runId, "cv-export", { steps, text, terminal: { type: "error", msg } }, true, { createdAt });
    throw new Error(msg);
  }

  push({ type: "status", label: `Exporting CV PDF (max ${maxPages} page)` });

  await new Promise((resolve, reject) => {
    const nodePath = ["/app/node_modules", process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    const child = spawn(process.execPath, [script, "--json", "--max-pages", String(maxPages)], {
      cwd: tenantRoot(),
      env: tenantChildEnv({
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright",
        NODE_PATH: nodePath,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", (c) => {
      text = (text + c.toString()).slice(-16_000);
      writeSnap(runId, "cv-export", { steps, text, terminal: null }, false, { createdAt });
    });
    child.stderr?.on("data", (c) => {
      const s = c.toString();
      stderr += s;
      const label = s.replace(/[╔╗╚╝║═]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      if (label) push({ type: "status", label });
    });
    child.on("error", (err) => {
      writeSnap(
        runId,
        "cv-export",
        { steps, text, terminal: { type: "error", msg: err.message } },
        true,
        { createdAt },
      );
      reject(err);
    });
    child.on("close", (code) => {
      writeSnap(
        runId,
        "cv-export",
        { steps, text, terminal: { type: "exited", code } },
        false,
        { createdAt },
      );
      resolve({ ok: true, code });
    });
  });

  return { runId, ok: true };
}

/**
 * The account this job belongs to (JOBBY-BL-049).
 *
 * Fails closed: a tenant the index does not know about resolves to an inactive
 * `unknown` account that may run no engine at all. It used to fall back to
 * `operatorAccount()`, so an unreadable accounts.json would have handed every job
 * operator privileges — a gate answering "you are the owner" when it does not
 * know is the wrong way round.
 */
async function jobAccount() {
  return accountForTenantStrict(workerTenantId());
}

/**
 * OmniRoute lives on the dispatcher. Members must not inherit it (D-010).
 */
export function operatorSandboxEnv(account, env = process.env) {
  if (!isOperator(account)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of [
    "JOBBY_OMNIROUTE_BASE_URL",
    "OMNIROUTE_BASE_URL",
    "JOBBY_OMNIROUTE_API_KEY",
    "OMNIROUTE_API_KEY",
    "OPENCODE_MODEL",
  ]) {
    const v = env[key]?.trim();
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Operator Score used to spawn OpenCode, which walks up to the git root, loads
 * the career-ops skill, and spends a dozen tool rounds re-reading oferta.md.
 * The runner already scores a URL in one model call. Remap only operator
 * evaluate+opencode jobs; OmniRoute credentials stay off member jobs (D-010).
 * `omniroute/` is an OpenCode provider prefix — the wire model is `auto/best-coding`.
 */
export function operatorEvaluateOneshot(kind, cliId, account, env = process.env) {
  if (kind !== "evaluate" || cliId !== "opencode") return null;
  if (!isOperator(account)) return null;
  const base = (env.JOBBY_OMNIROUTE_BASE_URL || env.OMNIROUTE_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  const key = (env.JOBBY_OMNIROUTE_API_KEY || env.OMNIROUTE_API_KEY || "").trim();
  if (!base || !key) return null;
  const model = (env.OPENCODE_MODEL?.trim() || "auto/best-coding").replace(/^omniroute\//, "");
  return {
    engineCli: "openrouter",
    model,
    env: {
      OPENROUTER_API_KEY: key,
      OPENROUTER_API_URL: `${base}/chat/completions`,
      CAREER_OPS_MODEL: model,
      OPENROUTER_TIMEOUT_MS: env.OPENROUTER_TIMEOUT_MS?.trim() || "120000",
    },
  };
}

export async function executeRun(job) {
  if (job.data?.kind === "cv-export") return executeCvExport(job);
  migrateDefaultTenant();
  const { runId, kind = "evaluate", input, cliId, createdAt } = job.data;
  if (!runId || !input) throw new Error("runId and input required");
  if (!cliId) throw new Error("cliId required");
  const account = await jobAccount();
  if (!mayUseEngine(account, cliId)) {
    writeSnap(
      runId,
      kind,
      { steps: [], text: "", terminal: { type: "error", msg: HOST_ENGINE_DENIAL } },
      true,
      { createdAt },
    );
    throw new Error(HOST_ENGINE_DENIAL);
  }

  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt(kind, input, today);
  const steps = [];
  let text = "";
  const push = (ev) => {
    steps.push(ev);
    if (steps.length > 500) steps.splice(0, steps.length - 500);
    writeSnap(runId, kind, { steps, text, terminal: null }, false, { createdAt });
  };

  push({ type: "status", label: `Worker starting ${cliId} · ${kind}` });

  const oneshotPlan = operatorEvaluateOneshot(kind, cliId, account);
  let engineCli = cliId;
  const oneshot = oneshotPlan?.env ?? {};
  if (oneshotPlan) {
    engineCli = oneshotPlan.engineCli;
    push({
      type: "status",
      label: `Score · one model call (${oneshotPlan.model}) — not the OpenCode agent loop`,
    });
  }

  let engine;
  try {
    engine = resolveEngine(engineCli);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeSnap(
      runId,
      kind,
      { steps, text, terminal: { type: "error", msg } },
      true,
      { createdAt },
    );
    throw e;
  }

  const { bin, args } = cliArgs(engine, kind, prompt);
  // For openrouter, fix args: resolveEngine returns args: [runner] and cliArgs rebuilds wrong
  let finalBin = bin;
  let finalArgs = args;
  if (engine.mode === "openrouter") {
    finalBin = process.execPath;
    const runner = engine.args[0];
    const urlOrInput = input;
    finalArgs = [runner, kind === "pdf" ? "evaluate" : "evaluate", urlOrInput];
    if (kind !== "evaluate" && kind !== "research") {
      // openrouter only supports evaluate/pipeline/scan well — fall through for evaluate
    }
  }

  fs.mkdirSync(path.join(tenantRoot(), ".home"), { recursive: true });
  push({ type: "status", label: `Spawning ${path.basename(finalBin)}` });

  const childExtra =
    engineCli === "opencode" || engineCli === "ollama"
      ? { OPENCODE_PURE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" }
      : {};

  await new Promise((resolve, reject) => {
    const child = spawn(finalBin, finalArgs, {
      cwd: tenantRoot(),
      env: tenantChildEnv({ ...jobProviderEnv(engineCli), ...childExtra, ...oneshot }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buf = "";
    const onChunk = (chunk, isErr) => {
      const s = chunk.toString();
      if (isErr) {
        push({ type: "status", label: s.trim().slice(0, 200) || "stderr" });
        return;
      }
      buf += s;
      text = (text + s).slice(-16_000);
      // Try stream-json lines
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (j.type === "assistant" || j.message?.role === "assistant") {
            const content = j.message?.content || j.content || "";
            const str = typeof content === "string" ? content : JSON.stringify(content).slice(0, 500);
            if (str) push({ type: "text", text: str.slice(0, 400) });
          } else if (j.type === "tool_use" || j.name) {
            push({ type: "tool", name: j.name || j.type });
          } else {
            push({ type: "status", label: (j.type || "event").slice(0, 80) });
          }
        } catch {
          plain: {
            if (t.length < 300) push({ type: "status", label: t });
          }
        }
      }
      writeSnap(runId, kind, { steps, text, terminal: null }, false, { createdAt });
    };

    child.stdout?.on("data", (c) => onChunk(c, false));
    child.stderr?.on("data", (c) => onChunk(c, true));
    child.on("error", (err) => {
      writeSnap(
        runId,
        kind,
        { steps, text, terminal: { type: "error", msg: err.message } },
        true,
        { createdAt },
      );
      reject(err);
    });
    child.on("close", (code) => {
      writeSnap(
        runId,
        kind,
        { steps, text, terminal: { type: "exited", code } },
        false,
        { createdAt },
      );
      resolve({ ok: true, code });
    });
  });

  return { runId, ok: true };
}
