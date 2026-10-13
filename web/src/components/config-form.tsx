"use client";

import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  TerminalSquare,
  Terminal,
  Loader2,
  CircleDashed,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { lsReadJson, lsWriteJson } from "@/lib/storage";
import { JobbyMark, BrandFooter } from "@/components/co-mark";

type CliHealth = {
  model: string | null;
  status: "ok" | "quota" | "auth" | "unknown";
  detail: string | null;
  fixUrl: string | null;
  canOpenLogin: boolean;
};

type Cli = {
  id: string;
  name: string;
  run: string;
  url: string;
  installed: boolean;
  path: string | null;
  version?: string | null;
  scoringReady?: boolean;
  model?: string | null;
  health?: CliHealth | null;
};

type Mode = "cli" | "key" | "manual";

const PROVIDERS = [
  { id: "openrouter", label: "OpenRouter (recommended)" },
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google (Gemini)" },
] as const;

/**
 * @param canUseCli whether this account may pick an in-container CLI.
 *
 * Operator only: the CLIs in the image authenticate with logins baked into the
 * container, and a host provider key funds engines a member may never spawn.
 * Members score in their own ChatGPT / Claude / Cursor via MCP on /connect.
 */
export function ConfigForm({ canUseCli = true }: { canUseCli?: boolean }) {
  const [mode, setMode] = useState<Mode>(canUseCli ? "cli" : "manual");
  const [clis, setClis] = useState<Cli[] | null>(null);
  const [cliId, setCliId] = useState<string>("");
  const [provider, setProvider] = useState("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [logos, setLogos] = useState(true);
  const [saved, setSaved] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [clisError, setClisError] = useState<string | null>(null);
  const [allowApiKey, setAllowApiKey] = useState(false);
  const [secretsHint, setSecretsHint] = useState<string | null>(null);

  useEffect(() => {
    const v = lsReadJson<{ mode?: string; cliId?: string; provider?: string; logos?: boolean }>("config", {});
    if (canUseCli && (v.mode === "cli" || v.mode === "key")) setMode(v.mode as Mode);
    if (v.cliId) setCliId(v.cliId);
    if (v.provider) setProvider(v.provider);
    if (typeof v.logos === "boolean") setLogos(v.logos);
    fetch("/api/secrets")
      .then((r) => r.json())
      .then((d: { providers?: Array<{ provider: string; attached: boolean; last4: string | null }> }) => {
        const attached = (d.providers ?? []).filter((p) => p.attached);
        setAllowApiKey(attached.length > 0);
        if (attached.length > 0) {
          // Last 4 only — the key itself never leaves the server.
          setSecretsHint(attached.map((p) => `${p.provider} ····${p.last4 ?? ""}`).join(", "));
        }
      })
      .catch(() => {});
  }, []);

  // Fast install detect, then live health (model / quota / auth) before Save.
  useEffect(() => {
    let cancelled = false;
    setClisError(null);
    fetch("/api/clis")
      .then(async (r) => {
        if (!r.ok) throw new Error(`CLI detect failed (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        const list: Cli[] = d.clis ?? [];
        setClis(list);
        setCliId(
          (prev) =>
            prev ||
            list.find((c) => c.id === "claude" && c.installed)?.id ||
            list.find((c) => c.id === "opencode" && c.installed)?.id ||
            list.find((c) => c.installed)?.id ||
            "",
        );
        setHealthLoading(true);
        return fetch("/api/clis?health=1")
          .then(async (r) => {
            if (!r.ok) throw new Error(`CLI health failed (${r.status})`);
            return r.json();
          })
          .then((h) => {
            if (cancelled) return;
            const healthy: Cli[] = h.clis ?? list;
            setClis(healthy);
            setCliId((prev) => {
              const cur = healthy.find((c) => c.id === prev);
              if (cur?.scoringReady) return prev;
              return healthy.find((c) => c.scoringReady)?.id || prev;
            });
          });
      })
      .catch((e) => {
        if (!cancelled) {
          setClis([]);
          setClisError(e instanceof Error ? e.message : "Could not reach /api/clis — is the local server running?");
        }
      })
      .finally(() => {
        if (!cancelled) setHealthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    let nextCli = cliId;
    if (mode === "key") {
      nextCli = "openrouter";
      setCliId("openrouter");
      if (apiKey.trim()) {
        // Save under the selected provider only. Sending the same key under every
        // provider name would attach an OpenAI key as an Anthropic key too.
        const field = provider === "google" ? "gemini" : provider;
        const r = await fetch("/api/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: apiKey.trim() }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          setClisError(e.error || "Could not save API key");
          return;
        }
        setSecretsHint(`${field} key saved — encrypted, visible only to this account`);
        setAllowApiKey(true);
        setApiKey("");
      }
    }
    lsWriteJson("config", { mode, cliId: nextCli, provider, logos });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function openCliLogin(id: "codex" | "cursor") {
    setLoginBusy(true);
    try {
      await fetch("/api/clis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", cliId: id }),
      });
    } finally {
      setLoginBusy(false);
    }
  }

  const installed = clis?.filter((c) => c.installed) ?? [];
  const selected = clis?.find((c) => c.id === cliId) ?? null;
  const selectedBlocked =
    !!selected?.health && selected.health.status !== "ok" && selected.health.status !== "unknown";
  const codexModel = clis?.find((c) => c.id === "codex")?.model || "—";

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <JobbyMark height={56} className="mb-5" />
      <h1 className="font-display text-2xl tracking-tight text-landing">Config</h1>
      <p className="mt-1 text-sm text-muted">
        {canUseCli
          ? "Run jobby on your own AI, right on your computer. Your CV and data never leave your machine."
          : "Zero-key release: jobby runs no AI models for members. Connect ChatGPT or Claude under MCP and score or edit your CV there on your own subscription."}
      </p>
      <p className="mt-2 text-sm text-muted">
        House rules (MUST / SHOULD / HINT) live in{" "}
        <a href="/rules" className="font-medium text-brand hover:underline">
          Rules
        </a>
        . ChatGPT / Claude / Cursor keys and KPI meters live under{" "}
        <a href="/connect" className="font-medium text-brand hover:underline">
          MCP
        </a>
        .
      </p>

      {!canUseCli && (
        <div className="mt-6 rounded-xl border border-border bg-surface/50 px-4 py-3 text-sm text-muted">
          Nothing to configure here. Your assistant connects at{" "}
          <a href="/connect" className="font-medium text-brand hover:underline">
            Account → MCP
          </a>{" "}
          — one URL with your personal Connect key. Jobs, CV and scores all flow through it.
        </div>
      )}

      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        AI Engine
      </label>
      <div className={cn("grid gap-2", canUseCli ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {canUseCli && (
          <ModeCard active={mode === "cli"} onClick={() => setMode("cli")} icon={Terminal} title="Use an AI tool you have" hint="Recommended" />
        )}
        {canUseCli && (
          <ModeCard
            active={mode === "key"}
            onClick={() => setMode("key")}
            icon={KeyRound}
            title="Paste an AI key"
            hint={canUseCli ? (allowApiKey ? "OpenRouter / cloud" : "POC") : "Your key, your spend"}
          />
        )}
        <ModeCard active={mode === "manual"} onClick={() => setMode("manual")} icon={TerminalSquare} title="No setup needed" hint="Coming soon" disabled />
      </div>

      <div className="mt-6">
        {canUseCli && mode === "cli" && (
          <div>
            <p className="mb-1 text-sm text-muted">
              jobby uses an AI tool available in <span className="text-foreground">this runtime&apos;s PATH</span>.
              Claude / Codex / Cursor show Install when they aren&apos;t present here (normal in Docker — they are not baked into the image).
            </p>
            <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-faint">
              For compose/Railway: pick <span className="text-foreground">OpenCode</span> (in-image) or{" "}
              <span className="text-foreground">Paste an AI key</span> (OpenRouter). Host-only CLIs work with local{" "}
              <span className="font-mono">next dev</span>, not the container.
              {healthLoading && (
                <span className="inline-flex items-center gap-1 text-muted">
                  <Loader2 className="size-3 animate-spin" /> checking login / quota…
                </span>
              )}
            </p>
            {clisError && (
              <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-100">
                {clisError}
              </div>
            )}
            {clis === null ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Checking what&apos;s on your computer…
              </div>
            ) : (
              <div className="space-y-2">
                {installed.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                    No AI CLI detected in this runtime&apos;s PATH. In Docker/Railway, OpenCode is baked into the image —
                    rebuild/restart if you expect it. Or use <span className="text-foreground">Paste an AI key</span>{" "}
                    (OpenRouter).{" "}
                    <a href="https://career-ops.org/docs/free-ai-engine" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">
                      Free engine docs <ExternalLink className="size-3" />
                    </a>
                  </div>
                )}
                {clis.map((c) => {
                  const isSelected = c.id === cliId;
                  const blocked = c.health?.status === "quota" || c.health?.status === "auth";
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm transition-colors",
                        isSelected
                          ? blocked
                            ? "border-amber-500/50 bg-amber-500/10"
                            : "border-brand/50 bg-brand-soft"
                          : c.installed
                            ? "border-border bg-surface/50"
                            : "border-border/60 bg-surface/20",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        {c.installed ? (
                          blocked ? (
                            <AlertTriangle className="size-4 shrink-0 text-amber-500" />
                          ) : (
                            <Check className="size-4 shrink-0 text-emerald-400" />
                          )
                        ) : (
                          <CircleDashed className="size-4 shrink-0 text-faint" />
                        )}
                        <button
                          type="button"
                          disabled={!c.installed}
                          onClick={() => setCliId(c.id)}
                          className={cn(
                            "flex flex-1 flex-col items-start gap-0.5 text-left max-sm:min-h-[44px]",
                            c.installed ? "" : "cursor-default",
                          )}
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={cn("font-medium", isSelected ? "text-foreground" : c.installed ? "" : "text-muted")}>
                              {c.name}
                            </span>
                            <span className="font-mono text-xs text-faint">{c.run}</span>
                            {c.model && (
                              <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted">
                                {c.model}
                              </span>
                            )}
                            {c.scoringReady && (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                                Live OK · Score / PDF
                              </span>
                            )}
                            {c.health?.status === "ok" && !c.scoringReady && (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                                Live OK
                              </span>
                            )}
                            {c.installed && !c.health && (c.id === "claude" || c.id === "codex" || c.id === "cursor" || c.id === "ollama") && (
                              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-faint">
                                Checking live…
                              </span>
                            )}
                            {c.health?.status === "quota" && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
                                Out of credits
                              </span>
                            )}
                            {c.health?.status === "auth" && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
                                {c.id === "ollama" ? "Unreachable" : c.id === "openrouter" ? "Needs key" : "Needs login"}
                              </span>
                            )}
                            {c.installed && !c.scoringReady && !c.health && c.id !== "claude" && c.id !== "codex" && c.id !== "cursor" && c.id !== "ollama" && c.id !== "openrouter" && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
                                May not save reports
                              </span>
                            )}
                            {c.health?.status === "unknown" && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
                                Not verified for Score
                              </span>
                            )}
                          </span>
                          {c.version && <span className="font-mono text-[11px] text-faint">{c.version}</span>}
                        </button>
                        {c.installed ? (
                          <span className="hidden max-w-[28%] shrink-0 truncate text-xs text-faint sm:block">{c.path}</span>
                        ) : (
                          <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center justify-center gap-1 text-xs text-brand hover:underline max-sm:min-h-[44px]">
                            Install <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                      {c.health?.detail && c.health.status !== "ok" && (
                        <div className="ml-7 space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
                          <p className="leading-relaxed">{c.health.detail}</p>
                          <div className="flex flex-wrap gap-2">
                            {c.health.fixUrl && (
                              <a href={c.health.fixUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                                Open usage / account <ExternalLink className="size-3" />
                              </a>
                            )}
                            {c.health.canOpenLogin && (c.id === "codex" || c.id === "cursor") && (
                              <button
                                type="button"
                                disabled={loginBusy}
                                onClick={() => void openCliLogin(c.id as "codex" | "cursor")}
                                className="inline-flex items-center gap-1 font-medium text-brand hover:underline disabled:opacity-50"
                              >
                                {loginBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                                Open {c.id === "cursor" ? "Cursor" : "Codex"} login window
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {selectedBlocked && (
                  <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
                    Selected engine can&apos;t Score right now. Pick a Live OK option (Claude, Cursor, OpenCode, or OpenRouter) or fix the blocker above before Save.
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  Claude Score uses <span className="font-mono text-muted">JOBBY_CLAUDE_MODEL</span> (default{" "}
                  <span className="font-mono">sonnet</span>). Codex uses{" "}
                  <span className="font-mono text-muted">~/.codex/config.toml</span> <span className="font-mono">model</span>{" "}
                  (yours: <span className="font-mono">{codexModel}</span>). Cursor Agent uses{" "}
                  <span className="font-mono text-muted">JOBBY_CURSOR_MODEL</span> (default{" "}
                  <span className="font-mono">composer-2.5-fast</span>). Ollama uses OpenCode →{" "}
                  <span className="font-mono text-muted">JOBBY_OLLAMA_BASE_URL</span> /{" "}
                  <span className="font-mono text-muted">JOBBY_OLLAMA_MODEL</span>. Container POC: OpenCode is in-image;
                  API key mode uses OpenRouter. With <span className="font-mono">REDIS_URL</span>, Score runs on the BullMQ worker.
                </p>
              </div>
            )}
          </div>
        )}

        {mode === "key" && canUseCli && (
          <div className="space-y-5">
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Provider</label>
              <div className="grid gap-2 sm:grid-cols-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      "rounded-xl border px-4 py-2.5 text-left text-sm transition-colors",
                      provider === p.id
                        ? "border-brand/50 bg-brand-soft text-foreground"
                        : "border-border bg-surface/50 text-muted hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-faint">
                Scoring currently routes through <span className="font-mono">openrouter-runner.mjs</span> (set OpenRouter
                key). Other providers are stored for later wiring.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Paste an AI key</label>
              <p className="mb-2 text-xs text-faint">
                Encrypted at rest and readable only by this account — never sent to the browser again, never shared with other users.
                {secretsHint ? ` · ${secretsHint}` : ""}
              </p>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-or-v1-… or sk-…"
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
              />
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
            The easiest way in — no keys, nothing to set up. On the roadmap.
          </div>
        )}
      </div>

      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Appearance</label>
      <button
        type="button"
        onClick={() => setLogos((v) => !v)}
        className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-surface/50 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">Company logos</span>
          <span className="mt-0.5 block text-xs text-faint">
            Show each company&apos;s real logo. Fetched once through your local server and cached on disk.
          </span>
        </span>
        <span className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", logos ? "bg-brand" : "bg-surface-hover")}>
          <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform", logos ? "translate-x-[1.375rem]" : "translate-x-0.5")} />
        </span>
      </button>

      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={mode !== "key" && !!selectedBlocked}
          title={mode !== "key" && selectedBlocked ? "Fix the selected CLI blocker first" : undefined}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
        >
          {saved ? <Check className="size-4" /> : null}
          {saved ? "Saved" : "Save config"}
        </button>
        <span className="text-xs text-faint">Local-first · health checked before Save</span>
      </div>
      <BrandFooter className="mt-12 border-t border-border pt-6" />
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-2 rounded-xl border px-4 py-3 text-left transition-colors max-sm:min-h-[44px]",
        disabled && "cursor-not-allowed opacity-50",
        active ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/50 hover:bg-surface-hover",
      )}
    >
      <Icon className={cn("size-4", active ? "text-brand" : "text-muted")} />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-[11px] text-faint">{hint}</span>
    </button>
  );
}
