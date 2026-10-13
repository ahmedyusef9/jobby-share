import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickChildEnv } from "@/lib/child-env";
import { getKeyForJob, tenantProviderEnv, tenantSecretEnv } from "@/lib/key-store";
import { platformRoot, tenantId, tenantRoot } from "@/lib/tenant";

// Server-only (node imports). The agnostic runtimes career-ops can delegate to
// in headless mode (AGENTS.md). Install URLs from career-ops-docs.
export type CliSpec = {
  id: string;
  name: string;
  run: string;
  url: string;
  bin: string;
  /**
   * Headless argv for a single prompt. `persist` kinds (evaluate/pdf) need write
   * + network; others stay read-friendly when the CLI supports it.
   */
  args: (prompt: string, opts?: { persist?: boolean }) => string[];
};

export type CliHealth = {
  /** Model the web will ask this CLI to use (when known). */
  model: string | null;
  /** auth | quota | ok | unknown */
  status: "ok" | "quota" | "auth" | "unknown";
  /** Short human reason shown in Config before Save. */
  detail: string | null;
  /** Deep-link to fix (usage page, docs). */
  fixUrl: string | null;
  /** Whether `codex login` / similar can open a browser from the machine. */
  canOpenLogin: boolean;
};

/** Read `model = "..."` from ~/.codex/config.toml (no TOML parser dependency). */
export function readCodexConfiguredModel(): string | null {
  const fromEnv = process.env.JOBBY_CODEX_MODEL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    const m = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function readClaudeConfiguredModel(): string | null {
  return process.env.JOBBY_CLAUDE_MODEL?.trim() || "sonnet";
}

export function readCursorConfiguredModel(): string | null {
  // Account default is often a frontier model that burns Pro quota first.
  // Composer Fast is verified for headless Score on this machine; override via env.
  return process.env.JOBBY_CURSOR_MODEL?.trim() || "composer-2.5-fast";
}

/** OpenAI-compatible base URL (…/v1). Default: SSH-tunneled a remote lab host Ollama. */
export function readOllamaBaseUrl(): string {
  return process.env.JOBBY_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11435/v1";
}

/** Bare Ollama model tag (no provider/). Default: qwen3:8b on the lab tunnel. */
export function readOllamaModel(): string {
  return process.env.JOBBY_OLLAMA_MODEL?.trim() || "qwen3:8b";
}

function ollamaHostRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, "").replace(/\/$/, "");
}

/** Write `.career-ops-web/opencode-ollama.json` and return its path (OPENCODE_CONFIG). */
export function ensureOpencodeOllamaConfig(): string {
  const dir = path.join(tenantRoot(), ".career-ops-web");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "opencode-ollama.json");
  const model = readOllamaModel();
  const baseURL = readOllamaBaseUrl();
  // Cap context: career-ops prompts are large; 32k on M1 Pro unified memory
  // wedged llama-server when several Scores queued. 16k is enough for Score.
  const ctx = Number(process.env.JOBBY_OLLAMA_NUM_CTX) || 16_384;
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama (free / local)",
        options: { baseURL },
        models: {
          [model]: {
            name: model,
            limit: { context: ctx, output: 8192 },
          },
        },
      },
    },
  };
  fs.writeFileSync(dest, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return dest;
}

/**
 * Env for Score/PDF child processes — allowlist, not a copy of process.env.
 *
 * Two sources, deliberately separate:
 *   - CLI *config* (model names, config dirs, base URLs) comes from the server
 *     environment, because it is operator settings and carries no secret.
 *   - API *keys* come only from the calling tenant's encrypted store, filtered to
 *     the ones this CLI actually reads, so an OpenRouter job never sees the
 *     Anthropic key and no tenant ever sees another tenant's.
 */
export function cliSpawnEnv(cliId: string): NodeJS.ProcessEnv {
  const id = tenantId();
  const extra: Record<string, string> = {
    ...(tenantProviderEnv(cliId, id) as Record<string, string>),
    CAREER_OPS_ROOT: platformRoot(),
    JOBBY_TENANT_ID: id,
  };
  if (cliId === "ollama") {
    extra.OPENCODE_CONFIG = ensureOpencodeOllamaConfig();
    extra.OPENCODE_PURE = "1";
    extra.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  }
  return pickChildEnv(extra);
}

function ollamaOpenCodeArgs(prompt: string): string[] {
  const model = readOllamaModel();
  return [
    "run",
    "--format",
    "json",
    "--auto",
    "--pure",
    "-m",
    `ollama/${model}`,
    "--dir",
    tenantRoot(),
    prompt,
  ];
}

/** Live reachability: Ollama /api/tags must list JOBBY_OLLAMA_MODEL. */
function probeOllamaTags(): { ok: boolean; message: string } {
  const model = readOllamaModel();
  const base = readOllamaBaseUrl();
  const tagsUrl = `${ollamaHostRoot(base)}/api/tags`;
  try {
    const r = spawnSync("curl", ["-sS", "-m", "4", tagsUrl], {
      encoding: "utf8",
      timeout: 6000,
      env: pickChildEnv(),
    });
    const raw = (r.stdout || "").trim();
    if (r.status !== 0 || !raw) {
      return {
        ok: false,
        message: `Ollama not reachable at ${ollamaHostRoot(base)} — is the SSH tunnel up? (${tagsUrl})`,
      };
    }
    let names: string[] = [];
    try {
      const data = JSON.parse(raw) as { models?: Array<{ name?: string }> };
      names = (data.models || []).map((m) => m.name || "").filter(Boolean);
    } catch {
      return { ok: false, message: `Ollama tags response was not JSON from ${tagsUrl}` };
    }
    if (!names.includes(model)) {
      return {
        ok: false,
        message: `Model ${model} not on Ollama at ${ollamaHostRoot(base)}. Pulled: ${names.slice(0, 8).join(", ") || "(none)"}`,
      };
    }
    return { ok: true, message: `Live OK · ${model} @ ${ollamaHostRoot(base)}` };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : `Ollama probe failed (${tagsUrl})`,
    };
  }
}

/** Codex headless: workspace-write + network + no approval prompts + JSONL.
 *  `--ignore-user-config` keeps auth but skips ~/.codex/config.toml MCP/plugins
 *  (ChatGPT node_repl / railway / context7 need interactive OAuth and break Score).
 *  Model is re-applied via `-m` so ignore-user-config doesn't drop gpt-5.6-sol. */
function codexExecArgs(prompt: string, opts?: { persist?: boolean }): string[] {
  const sandbox = opts?.persist === false ? "read-only" : "workspace-write";
  const model = readCodexConfiguredModel();
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    ...(model ? ["-m", model] : []),
    "--sandbox",
    sandbox,
    // Never pause for TTY approvals — the web worker has no interactive stdin.
    "-c",
    'approval_policy="never"',
    // Job posting fetch / WebSearch need outbound HTTP inside the sandbox.
    "-c",
    "sandbox_workspace_write.network_access=true",
    prompt,
  ];
}

function cursorAgentArgs(prompt: string, opts?: { persist?: boolean }): string[] {
  const model = readCursorConfiguredModel();
  // Must resolve the career-ops checkout — process.cwd() is often web/.
  const workspace = tenantRoot();
  return [
    "-p",
    "--force",
    "--trust",
    "--workspace",
    workspace,
    "--sandbox",
    opts?.persist === false ? "enabled" : "disabled",
    ...(model ? ["--model", model] : []),
    // stream-json exposes tool_call / thinking events so the UI isn't stuck on "thinking…"
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    prompt,
  ];
}

export const KNOWN: CliSpec[] = [
  { id: "claude", name: "Claude Code", bin: "claude", run: "claude -p", url: "https://claude.ai/code", args: (p) => ["-p", p] },
  { id: "codex", name: "Codex", bin: "codex", run: "codex exec", url: "https://github.com/openai/codex", args: codexExecArgs },
  {
    id: "cursor",
    name: "Cursor Agent",
    bin: "cursor-agent",
    run: "cursor agent -p",
    url: "https://cursor.com",
    args: cursorAgentArgs,
  },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", run: "gemini -p", url: "https://github.com/google-gemini/gemini-cli", args: (p) => ["-p", p] },
  {
    id: "ollama",
    name: "Ollama (via OpenCode)",
    bin: "opencode",
    run: "opencode → ollama",
    url: "https://ollama.com",
    args: (p) => ollamaOpenCodeArgs(p),
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    run: "opencode run",
    url: "https://opencode.ai",
    args: (p) => {
      const model = process.env.OPENCODE_MODEL?.trim() || "omniroute/auto/best-coding";
      return ["run", "--format", "json", "--auto", "--pure", "-m", model, "--dir", tenantRoot(), p];
    },
  },
  {
    id: "openrouter",
    name: "API key (OpenRouter)",
    bin: "node",
    run: "openrouter-runner",
    url: "https://openrouter.ai",
    args: (p) => {
      // Prompt carries the URL; runner wants `evaluate <url>`. Caller overrides for spawn.
      const url = p.includes("Posting URL:") ? p.split("Posting URL:").pop()!.trim() : p;
      return [path.join(platformRoot(), "openrouter-runner.mjs"), "evaluate", url];
    },
  },
  { id: "copilot", name: "GitHub Copilot CLI", bin: "copilot", run: "copilot -p", url: "https://docs.github.com/en/copilot/github-copilot-in-the-cli", args: (p) => ["-p", p] },
  { id: "qwen", name: "Qwen CLI", bin: "qwen", run: "qwen -p", url: "https://qwen.ai/qwencode", args: (p) => ["-p", p] },
  { id: "antigravity", name: "Antigravity CLI", bin: "agy", run: "agy -p", url: "https://antigravity.google", args: (p) => ["-p", p] },
];

function searchDirs(): string[] {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".deno/bin"),
    path.join(home, ".opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/app/node_modules/.bin",
  ];
  if (process.platform === "win32") {
    // Windows CLIs frequently install under per-user AppData roots and don't
    // reliably add themselves to PATH (e.g. Antigravity → %LOCALAPPDATA%\agy\bin).
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    extra.push(
      path.join(localAppData, "agy", "bin"), // Antigravity CLI
      path.join(localAppData, "Microsoft", "WindowsApps"), // winget/Store shims
      path.join(appData, "npm"), // npm global prefix on Windows
    );
  }
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extra])];
}

// On Windows, executables carry an extension (claude.exe, claude.cmd, ...).
// Mirror the shell's PATHEXT resolution so a native-installer claude.exe is
// found, not just an extensionless npm shim. On POSIX, "" keeps the bare name.
function binCandidates(bin: string): string[] {
  if (process.platform !== "win32") return [bin];
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = pathext
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    // Only include extensions that `child_process.spawn()` can execute directly.
    .filter((e) => [".com", ".exe", ".bat", ".cmd"].includes(e.toLowerCase()));

  // Try the bare name too (some environments provide an extensionless shim).
  return [bin, ...exts.map((ext) => bin + ext)];
}

export function findBin(bin: string, dirs = searchDirs()): string | null {
  // Cursor Agent ships as both `cursor-agent` and `cursor agent` — prefer the
  // dedicated binary; fall back to the IDE CLI if that's all that's on PATH.
  const names = bin === "cursor-agent" ? ["cursor-agent", "cursor"] : [bin];
  for (const name of names) {
    for (const dir of dirs) {
      for (const candidate of binCandidates(name)) {
        const p = path.join(dir, candidate);
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch {
          /* not here */
        }
      }
    }
  }
  return null;
}

/** Cheap --version / -v probe. Confirms the binary runs; not a full auth/credits check. */
function probeVersion(binPath: string): string | null {
  for (const flag of ["--version", "-v", "version"]) {
    try {
      const r = spawnSync(binPath, [flag], { encoding: "utf8", timeout: 4000, env: pickChildEnv() });
      const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n")[0]?.trim();
      if (out && out.length < 120) return out;
    } catch {
      /* try next flag */
    }
  }
  return null;
}

function codexLoginStatus(binPath: string): { loggedIn: boolean; detail: string } {
  try {
    const r = spawnSync(binPath, ["login", "status"], { encoding: "utf8", timeout: 8000, env: pickChildEnv() });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    const loggedIn = /logged in/i.test(out) && !/not logged|logged out/i.test(out);
    return { loggedIn, detail: out.split("\n")[0]?.slice(0, 120) || (loggedIn ? "Logged in" : "Not logged in") };
  } catch {
    return { loggedIn: false, detail: "Could not read login status" };
  }
}

function cursorLoginStatus(binPath: string): { loggedIn: boolean; detail: string } {
  try {
    const viaIde = /(?:^|[/\\])cursor(?:\.exe)?$/i.test(binPath) && !/cursor-agent/i.test(binPath);
    const args = viaIde ? ["agent", "status"] : ["status"];
    const r = spawnSync(binPath, args, { encoding: "utf8", timeout: 10_000, env: pickChildEnv() });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (/not logged|please log in|invalid|expired|authentication failed/i.test(out)) {
      return { loggedIn: false, detail: out.split("\n")[0]?.slice(0, 120) || "Not logged in" };
    }
    const loggedIn = /logged in|login successful/i.test(out);
    return { loggedIn, detail: out.split("\n").find((l) => l.trim())?.slice(0, 120) || (loggedIn ? "Logged in" : "Not logged in") };
  } catch {
    return { loggedIn: false, detail: "Could not read Cursor login status" };
  }
}

/** Tiny live probe — catches usage limits before the user clicks Score. */
function probeCodexQuota(binPath: string): { ok: boolean; message: string | null } {
  try {
    const model = readCodexConfiguredModel();
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ephemeral",
      ...(model ? ["-m", model] : []),
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "Reply with exactly: OK",
    ];
    const r = spawnSync(binPath, args, {
      encoding: "utf8",
      timeout: 25_000,
      env: pickChildEnv(),
      cwd: tenantRoot(),
      input: "",
    });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const ev = JSON.parse(t) as { type?: string; message?: string; error?: { message?: string } };
        const msg = ev.message || ev.error?.message || "";
        if (ev.type === "error" || ev.type === "turn.failed") {
          if (/usage limit/i.test(msg)) return { ok: false, message: msg };
          if (/auth|login|unauthorized|not authenticated/i.test(msg)) return { ok: false, message: msg };
          if (msg) return { ok: false, message: msg };
        }
      } catch {
        /* ignore */
      }
    }
    if (/usage limit/i.test(out)) {
      const m = out.match(/You've hit your usage limit[^\n]*/);
      return { ok: false, message: m?.[0] || "Codex usage limit reached" };
    }
    if (r.status === 0 || /turn\.completed/.test(out)) return { ok: true, message: null };
    return { ok: false, message: "Codex probe failed — try `codex login` in a terminal" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, message: "Codex probe timed out" };
    return { ok: false, message: msg.slice(0, 180) };
  }
}

/** Tiny live probe — catches usage limits before the user clicks Score. */
function probeClaudeQuota(binPath: string): { ok: boolean; message: string | null; model: string | null } {
  const model = readClaudeConfiguredModel();
  try {
    const args = [
      "-p",
      "Reply with exactly: OK",
      "--output-format",
      "text",
      ...(model ? ["--model", model] : []),
    ];
    const r = spawnSync(binPath, args, {
      encoding: "utf8",
      timeout: 35_000,
      env: pickChildEnv(),
      cwd: tenantRoot(),
      input: "",
    });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    if (/out of usage credits|credits_required|rate.?limit|usage limit/i.test(out)) {
      const m = out.match(/[^\n]*(?:out of usage credits|usage limit|credits_required)[^\n]*/i);
      return { ok: false, message: m?.[0]?.trim() || "Claude is out of usage credits for this model", model };
    }
    if (/not logged|please log in|authentication|unauthorized/i.test(out)) {
      return { ok: false, message: out.split("\n").find((l) => /log|auth/i.test(l))?.slice(0, 160) || "Claude auth failed", model };
    }
    if (r.status === 0 && /\bOK\b/i.test(out)) return { ok: true, message: null, model };
    if (r.status === 0) return { ok: true, message: null, model };
    return {
      ok: false,
      message: out.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 180) || "Claude smoke probe failed",
      model,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, message: "Claude probe timed out", model };
    return { ok: false, message: msg.slice(0, 180), model };
  }
}

function probeCursorQuota(binPath: string): { ok: boolean; message: string | null; model: string | null } {
  const model = readCursorConfiguredModel();
  const viaIde = /(?:^|[/\\])cursor(?:\.exe)?$/i.test(binPath) && !/cursor-agent/i.test(binPath);
  try {
    const args = [
      ...(viaIde ? ["agent"] : []),
      "-p",
      "--mode",
      "ask",
      "--trust",
      "--workspace",
      tenantRoot(),
      ...(model ? ["--model", model] : []),
      "--output-format",
      "text",
      "Reply with exactly: OK",
    ];
    const r = spawnSync(binPath, args, {
      encoding: "utf8",
      timeout: 45_000,
      env: pickChildEnv(),
      cwd: tenantRoot(),
      input: "",
    });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    if (/usage limit|ActionRequiredError|spend limit/i.test(out)) {
      const m = out.match(/[^\n]*(?:usage limit|ActionRequiredError|Spend Limit)[^\n]*/i);
      return {
        ok: false,
        message:
          (m?.[0]?.trim() || "Cursor usage limit reached for this model") +
          (model ? ` · try another JOBBY_CURSOR_MODEL (current: ${model})` : ""),
        model,
      };
    }
    if (/not logged|please log in|invalid|expired|authentication failed/i.test(out)) {
      return { ok: false, message: out.split("\n").find((l) => /log|auth|invalid/i.test(l))?.slice(0, 160) || "Cursor auth failed", model };
    }
    if (r.status === 0 && /\bOK\b/i.test(out)) return { ok: true, message: null, model };
    if (r.status === 0) return { ok: true, message: null, model };
    return {
      ok: false,
      message: out.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 180) || "Cursor smoke probe failed — run may not persist reports",
      model,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, message: "Cursor probe timed out", model };
    return { ok: false, message: msg.slice(0, 180), model };
  }
}

function healthFor(id: string, binPath: string | null): CliHealth | null {
  if (!binPath) return null;
  if (id === "codex") {
    const model = readCodexConfiguredModel();
    const login = codexLoginStatus(binPath);
    if (!login.loggedIn) {
      return {
        model,
        status: "auth",
        detail: login.detail || "Not logged in to Codex",
        fixUrl: "https://chatgpt.com/codex",
        canOpenLogin: true,
      };
    }
    const quota = probeCodexQuota(binPath);
    if (!quota.ok) {
      const usage = /usage limit/i.test(quota.message || "");
      return {
        model,
        status: usage ? "quota" : "auth",
        detail: quota.message,
        fixUrl: usage
          ? "https://chatgpt.com/codex/settings/usage"
          : "https://chatgpt.com/codex",
        canOpenLogin: !usage,
      };
    }
    return {
      model,
      status: "ok",
      detail: `Ready · model ${model || "default"}`,
      fixUrl: null,
      canOpenLogin: false,
    };
  }
  if (id === "claude") {
    const model = readClaudeConfiguredModel();
    const quota = probeClaudeQuota(binPath);
    if (!quota.ok) {
      const usage = /out of usage credits|usage limit|credits_required|rate.?limit/i.test(quota.message || "");
      return {
        model: quota.model || model,
        status: usage ? "quota" : "auth",
        detail: quota.message,
        fixUrl: "https://claude.ai/settings/usage",
        canOpenLogin: !usage,
      };
    }
    return {
      model: quota.model || model,
      status: "ok",
      detail: `Live OK · model ${quota.model || model} (JOBBY_CLAUDE_MODEL)`,
      fixUrl: null,
      canOpenLogin: false,
    };
  }
  if (id === "cursor") {
    const model = readCursorConfiguredModel();
    const login = cursorLoginStatus(binPath);
    if (!login.loggedIn) {
      return {
        model,
        status: "auth",
        detail: login.detail || "Not logged in to Cursor Agent",
        fixUrl: "https://cursor.com",
        canOpenLogin: true,
      };
    }
    const quota = probeCursorQuota(binPath);
    if (!quota.ok) {
      const usage = /usage limit|ActionRequiredError|spend limit/i.test(quota.message || "");
      return {
        model: quota.model || model,
        status: usage ? "quota" : "auth",
        detail: quota.message,
        fixUrl: "https://cursor.com/dashboard",
        canOpenLogin: !usage,
      };
    }
    return {
      model: quota.model || model,
      status: "ok",
      detail: `Live OK · model ${quota.model || model} · auth + reply probe (JOBBY_CURSOR_MODEL)`,
      fixUrl: null,
      canOpenLogin: false,
    };
  }
  if (id === "ollama") {
    const model = `ollama/${readOllamaModel()}`;
    const probe = probeOllamaTags();
    if (!probe.ok) {
      return {
        model,
        status: "auth",
        detail: probe.message,
        fixUrl: "https://ollama.com/download",
        canOpenLogin: false,
      };
    }
    // Ensure the OpenCode provider stub exists so Score can spawn immediately.
    try {
      ensureOpencodeOllamaConfig();
    } catch (e) {
      return {
        model,
        status: "auth",
        detail: e instanceof Error ? e.message : "Could not write OpenCode Ollama config",
        fixUrl: null,
        canOpenLogin: false,
      };
    }
    return {
      model,
      status: "ok",
      detail: `${probe.message} via OpenCode (JOBBY_OLLAMA_BASE_URL / JOBBY_OLLAMA_MODEL)`,
      fixUrl: null,
      canOpenLogin: false,
    };
  }
  if (id === "opencode") {
    // In-container POC: OpenCode is the baked CLI (see deploy/Dockerfile.*).
    // No separate login probe — Score goes through `opencode run` on the worker.
    const model = process.env.OPENCODE_MODEL?.trim() || "omniroute/auto/best-coding";
    return {
      model,
      status: "ok",
      detail: `OpenCode ready · model ${model} (OPENCODE_MODEL / OpenRouter)`,
      fixUrl: null,
      canOpenLogin: false,
    };
  }
  return {
    model: null,
    status: "unknown",
    detail: "Installed — Score/PDF persistence not verified for this CLI",
    fixUrl: null,
    canOpenLogin: false,
  };
}

export function detectClis(opts?: { health?: boolean }) {
  const dirs = searchDirs();
  const wantHealth = opts?.health === true;
  // Readiness is per tenant: whether *this* account has attached a key.
  const openrouterReady = Boolean(tenantSecretEnv(tenantId()).OPENROUTER_API_KEY?.trim());
  const allowApiKey = process.env.JOBBY_ALLOW_API_KEY === "1" || openrouterReady;

  return KNOWN.map((c) => {
    if (c.id === "openrouter") {
      const installed = allowApiKey;
      const health = wantHealth
        ? openrouterReady
          ? {
              model: process.env.CAREER_OPS_MODEL || "openrouter/free",
              status: "ok" as const,
              detail: "OPENROUTER_API_KEY present — Score via openrouter-runner.mjs",
              fixUrl: null,
              canOpenLogin: false,
            }
          : {
              model: null,
              status: "auth" as const,
              detail: "Paste an OpenRouter key in Config (API key mode) or set OPENROUTER_API_KEY",
              fixUrl: "https://openrouter.ai",
              canOpenLogin: false,
            }
        : null;
      return {
        id: c.id,
        name: c.name,
        run: c.run,
        url: c.url,
        installed,
        path: installed ? path.join(platformRoot(), "openrouter-runner.mjs") : null,
        version: installed ? "openrouter-runner" : null,
        scoringReady: openrouterReady,
        model: health?.model ?? (openrouterReady ? process.env.CAREER_OPS_MODEL || "openrouter/free" : null),
        health,
      };
    }

    const found = findBin(c.bin, dirs);
    const version = found ? probeVersion(found) : null;
    const health = wantHealth && found ? healthFor(c.id, found) : null;
    const scoringCapable =
      c.id === "claude" || c.id === "codex" || c.id === "cursor" || c.id === "ollama" || c.id === "opencode";
    const scoringReady =
      !!found &&
      !!version &&
      scoringCapable &&
      (!health || health.status === "ok");
    return {
      id: c.id,
      name: c.name,
      run: c.run,
      url: c.url,
      installed: !!found,
      path: found,
      version,
      scoringReady,
      model:
        health?.model ??
        (c.id === "claude"
          ? readClaudeConfiguredModel()
          : c.id === "codex"
            ? readCodexConfiguredModel()
            : c.id === "cursor"
              ? readCursorConfiguredModel()
              : c.id === "ollama"
                ? `ollama/${readOllamaModel()}`
                : null),
      health,
    };
  });
}

/**
 * Whether the calling tenant has attached a key for this provider.
 * Replaces the old `loadApiKeySecrets()`, which answered the same question by
 * pushing every key into the shared `process.env` — see scripts/key-store.mjs.
 */
export function tenantHasKey(provider: string): boolean {
  return Boolean(getKeyForJob(tenantId(), provider));
}

export function resolveCli(id: string): { spec: CliSpec; binPath: string } | null {
  const spec = KNOWN.find((c) => c.id === id);
  if (!spec) return null;

  if (id === "openrouter") {
    const runner = path.join(platformRoot(), "openrouter-runner.mjs");
    if (!fs.existsSync(runner)) return null;
    // Resolve regardless of key presence so Config can select it; /api/run fails
    // with a clear message when the tenant has not attached a key.
    return {
      binPath: process.execPath,
      spec: {
        ...spec,
        args: (prompt) => {
          const url = prompt.includes("Posting URL:")
            ? prompt.split("Posting URL:").pop()!.trim()
            : prompt;
          return [runner, "evaluate", url];
        },
      },
    };
  }

  const binPath = findBin(spec.bin);
  if (!binPath) return null;
  // IDE CLI needs the `agent` subcommand; standalone `cursor-agent` does not.
  if (id === "cursor") {
    const viaIde = /(?:^|[/\\])cursor(?:\.exe)?$/i.test(binPath) && !/cursor-agent/i.test(binPath);
    if (viaIde) {
      return {
        binPath,
        spec: {
          ...spec,
          args: (prompt, opts) => ["agent", ...cursorAgentArgs(prompt, opts)],
        },
      };
    }
  }
  return { spec, binPath };
}

/** Spawn `codex login` so the OS opens the ChatGPT auth window. Fire-and-forget. */
export function openCodexLogin(): { ok: boolean; error?: string } {
  const bin = findBin("codex");
  if (!bin) return { ok: false, error: "codex not installed" };
  try {
    const child = spawn(bin, ["login"], {
      detached: true,
      stdio: "ignore",
      env: pickChildEnv(),
      cwd: os.homedir(),
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Spawn Cursor Agent login (browser). Prefer `cursor-agent login`. */
export function openCursorLogin(): { ok: boolean; error?: string } {
  const bin = findBin("cursor-agent");
  if (!bin) return { ok: false, error: "cursor-agent / cursor not installed" };
  const viaIde = /(?:^|[/\\])cursor(?:\.exe)?$/i.test(bin) && !/cursor-agent/i.test(bin);
  try {
    const child = spawn(bin, viaIde ? ["agent", "login"] : ["login"], {
      detached: true,
      stdio: "ignore",
      env: pickChildEnv(),
      cwd: os.homedir(),
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
