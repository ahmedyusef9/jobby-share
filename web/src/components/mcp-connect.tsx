"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { JobbyMark } from "@/components/co-mark";
import { cn } from "@/lib/cn";

type McpKey = {
  id: string;
  name: string;
  prefix: string | null;
  scope?: string | null;
  expiresAt?: string | null;
  expiresInDays?: number | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  status: "live" | "expired";
};

type KpiBucket = { used: number; limit: number | null; remaining: number | null };

type McpInfo = {
  connected: boolean;
  prefix: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  endpoint: string | null;
  local: boolean;
  plan?: string;
  role?: string;
  maxKeys?: number;
  nameSuggestions?: string[];
  keys?: McpKey[];
  kpi?: {
    mcp: KpiBucket;
    scans: KpiBucket;
    resultsPerSource: number | null;
    priceUsd: number;
  };
  instructions?: { cursor: string; chatgpt: string; claude: string; capsLine?: string };
  capsLine?: string;
};

type McpMint = {
  url: string;
  token: string;
  endpoint: string;
  name?: string;
  serverName?: string;
  localUrl?: string;
  cursor: { mcpServers: Record<string, { url: string; headers?: { Authorization: string } }> };
  claudeCode: {
    mcpServers: Record<
      string,
      { type: string; url: string; headers: { Authorization: string } }
    >;
  };
  chatgpt?: { serverUrl: string; authentication: string; displayName?: string };
  local: boolean;
  scope?: string;
  expires?: string;
  expiresAt?: string | null;
  plan?: string;
  kpi?: McpInfo["kpi"];
  instructions?: McpInfo["instructions"];
  keys?: McpKey[];
};

type ClientTab = "cursor" | "chatgpt" | "claude";

async function readJson(r: Response) {
  const text = await r.text();
  if (!text.trim()) {
    throw new Error(r.ok ? "Empty response" : `Could not load MCP (${r.status})`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not load MCP (${r.status})`);
  }
}

const DEFAULT_SUGGESTIONS = ["ChatGPT", "Cursor", "Claude"];

function CopyLine({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className={`max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface px-3 py-2 text-[11px] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </pre>
    </div>
  );
}

function fmtDay(iso: string | null | undefined) {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function KpiBar({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const uncapped = limit == null;
  const pct = uncapped ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const tone = uncapped ? "bg-emerald-400" : pct >= 85 ? "bg-red-400" : pct >= 60 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums text-foreground">
          {uncapped ? `${used} · uncapped` : `${used} / ${limit}`}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: uncapped ? "8%" : `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  );
}

function NextSteps({
  serverName,
  local,
}: {
  serverName: string;
  local: boolean;
}) {
  return (
    <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
      <li>
        <span className="font-medium text-foreground">ChatGPT</span> — Settings → Apps &amp; Connectors
        → add the <span className="font-mono text-[11px]">ChatGPT / Claude.ai URL</span> (No
        authentication). Name the connector whatever you like in ChatGPT.
      </li>
      <li>
        <span className="font-medium text-foreground">Cursor</span> — merge the{" "}
        <span className="font-mono text-[11px]">mcpServers.{serverName}</span> block into{" "}
        <span className="font-mono text-[11px]">~/.cursor/mcp.json</span> (do not wipe other
        servers). Restart Cursor MCP, then ask the agent to call{" "}
        <span className="font-mono text-[11px]">whoami</span>.
      </li>
      <li>
        Confirm <span className="font-mono text-[11px]">whoami.tenantId</span> matches the
        signed-in tenant on this page — then Pipeline and ChatGPT share the same tracker.
      </li>
      {local ? (
        <li>
          ChatGPT needs the public HTTPS URL. Cursor can use{" "}
          <span className="font-mono text-[11px]">localhost</span> on this machine.
        </li>
      ) : null}
    </ol>
  );
}

export function McpConnectPage() {
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [minted, setMinted] = useState<McpMint | null>(null);
  const [secretOpen, setSecretOpen] = useState(true);
  const [showNext, setShowNext] = useState(false);
  const [busy, setBusy] = useState<"mint" | "rotate" | "revoke" | "refresh" | null>(null);
  // BL-075: least privilege by default — read keys cannot mutate anything.
  const [scope, setScope] = useState<"read-write" | "read">("read-write");
  const [expires, setExpires] = useState<"never" | "7d" | "30d">("30d");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ClientTab>("chatgpt");
  const [infoTenant, setInfoTenant] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/account/mcp");
    const body = (await readJson(r)) as McpInfo & { error?: string };
    if (!r.ok) throw new Error(body.error || "Could not load MCP");
    setMcp(body);
    return body;
  }, []);

  useEffect(() => {
    fetch("/api/account")
      .then(async (r) => {
        const body = (await readJson(r).catch(() => ({}))) as { tenantId?: string };
        if (r.ok && body.tenantId) setInfoTenant(body.tenantId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load()
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load MCP"))
      .finally(() => setLoaded(true));
  }, [load]);

  async function refresh() {
    if (busy) return;
    setBusy("refresh");
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh");
    } finally {
      setBusy(null);
    }
  }

  async function mint(rotate: boolean) {
    if (busy) return;
    const label = keyName.trim();
    if (!label) {
      setError("Pick or type a name first (e.g. ChatGPT or Cursor).");
      return;
    }
    if (rotate && !window.confirm("Rotate replaces every live key. Continue?")) return;
    setBusy(rotate ? "rotate" : "mint");
    setError(null);
    try {
      const r = await fetch("/api/account/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: label, rotate, scope, expires }),
      });
      const body = (await readJson(r)) as McpMint & {
        error?: string;
        prefix?: string;
        createdAt?: string;
        expiresAt?: string | null;
        expires?: string;
        scope?: string;
        name?: string;
        maxKeys?: number;
        nameSuggestions?: string[];
      };
      if (!r.ok) throw new Error(body.error || `Could not create key (${r.status})`);
      setMinted({
        url: body.url,
        token: body.token,
        endpoint: body.endpoint,
        name: body.name,
        serverName: body.serverName,
        localUrl: body.localUrl,
        cursor: body.cursor,
        claudeCode: body.claudeCode,
        chatgpt: body.chatgpt,
        local: body.local,
        scope: body.scope,
        expires: body.expires,
        expiresAt: body.expiresAt,
        plan: body.plan,
        kpi: body.kpi,
        instructions: body.instructions,
        keys: body.keys,
      });
      setSecretOpen(true);
      setShowNext(true);
      setQrDataUrl(null);
      setMcp({
        connected: true,
        prefix: body.prefix ?? body.token.slice(0, 7),
        createdAt: body.createdAt ?? new Date().toISOString(),
        lastUsedAt: body.createdAt ?? null,
        endpoint: body.endpoint,
        local: body.local,
        plan: body.plan,
        kpi: body.kpi,
        instructions: body.instructions,
        keys: body.keys,
        maxKeys: body.maxKeys ?? mcp?.maxKeys ?? 5,
        nameSuggestions: body.nameSuggestions ?? mcp?.nameSuggestions,
      });
      setKeyName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create MCP key");
    } finally {
      setBusy(null);
    }
  }

  function dismissSecret() {
    setMinted(null);
    setSecretOpen(false);
    setQrDataUrl(null);
    setShowNext(true);
  }

  async function showQr() {
    if (!minted?.url || qrBusy) return;
    setQrBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/account/mcp/qr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: minted.url }),
      });
      const body = (await readJson(r)) as { dataUrl?: string; error?: string };
      if (!r.ok || !body.dataUrl) throw new Error(body.error || "Could not generate QR code");
      setQrDataUrl(body.dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate QR code");
    } finally {
      setQrBusy(false);
    }
  }

  async function saveRename(id: string) {
    if (renaming) return;
    const name = editName.trim();
    if (!name) {
      setError("Name cannot be empty.");
      return;
    }
    setRenaming(true);
    setError(null);
    try {
      const r = await fetch("/api/account/mcp", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      const body = (await readJson(r)) as { error?: string; keys?: McpKey[] };
      if (!r.ok) throw new Error(body.error || "Could not rename");
      if (body.keys) setMcp((prev) => (prev ? { ...prev, keys: body.keys } : prev));
      else await load();
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename");
    } finally {
      setRenaming(false);
    }
  }

  async function revokeOne(id: string) {
    if (busy || revokingId) return;
    if (!window.confirm("Revoke this key? Clients using it will stop working.")) return;
    setRevokingId(id);
    setError(null);
    try {
      const r = await fetch(`/api/account/mcp?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Could not revoke");
      }
      if (minted) setMinted(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke");
    } finally {
      setRevokingId(null);
    }
  }

  async function revokeAll() {
    if (busy) return;
    if (!window.confirm("Revoke every live key for this account?")) return;
    setBusy("revoke");
    setError(null);
    try {
      const r = await fetch("/api/account/mcp", { method: "DELETE" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Could not revoke");
      }
      setMinted(null);
      setShowNext(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke");
    } finally {
      setBusy(null);
    }
  }

  const endpoint = minted?.endpoint || mcp?.endpoint;
  const local = minted?.local ?? mcp?.local ?? true;
  const kpi = minted?.kpi ?? mcp?.kpi;
  const instructions = minted?.instructions ?? mcp?.instructions;
  const keys = minted?.keys ?? mcp?.keys ?? [];
  const plan = minted?.plan ?? mcp?.plan ?? "—";
  const suggestions = mcp?.nameSuggestions?.length ? mcp.nameSuggestions : DEFAULT_SUGGESTIONS;
  const maxKeys = mcp?.maxKeys ?? 5;
  const liveKeyCount = keys.filter((key) => key.status === "live").length;
  const atCap = liveKeyCount >= maxKeys;
  const canAdd = keyName.trim().length > 0;
  const nextServer = minted?.serverName || "jobby";

  const instructionText =
    tab === "cursor"
      ? instructions?.cursor
      : tab === "chatgpt"
        ? instructions?.chatgpt
        : instructions?.claude;

  if (!loaded) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <JobbyMark height={56} className="mb-5" />
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading MCP account…
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <JobbyMark height={56} className="mb-5" />
      <h1 className="font-display text-2xl tracking-tight text-landing">MCP</h1>
      <p className="mt-1 text-sm text-muted">
        Named API keys for ChatGPT, Claude, and Cursor — same account. Pick a name, add a key,
        copy once, then connect the client.
      </p>

      {infoTenant ? (
        <p className="mt-2 font-mono text-[11px] text-faint">
          Signed-in tenant: {infoTenant}
        </p>
      ) : null}

      <section className="mt-8 rounded-xl border border-border bg-surface/50 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">KPI usage</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline disabled:opacity-60"
          >
            {busy === "refresh" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            Refresh
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Plan <span className="font-medium text-foreground">{plan}</span>
          {kpi?.priceUsd != null ? ` · label $${kpi.priceUsd}/mo` : ""}. Results/source:{" "}
          <span className="tabular-nums text-foreground">
            {kpi?.resultsPerSource == null ? "uncapped" : kpi.resultsPerSource}
          </span>
          .
        </p>
        <div className="mt-4 space-y-3">
          <KpiBar label="MCP calls today (UTC)" used={kpi?.mcp.used ?? 0} limit={kpi?.mcp.limit ?? null} />
          <KpiBar label="Host scans today (UTC)" used={kpi?.scans.used ?? 0} limit={kpi?.scans.limit ?? null} />
        </div>
        {(mcp?.capsLine || instructions?.capsLine) && (
          <p className="mt-3 font-mono text-[11px] text-faint">{mcp?.capsLine || instructions?.capsLine}</p>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-border bg-surface/50 px-4 py-4">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
          <KeyRound className="size-3.5" aria-hidden />
          API keys
        </h2>
        <p className="mt-2 text-sm text-muted">
          Up to {maxKeys} keys. Choose a name before Add (or rename later with the pencil). The
          secret is shown once — press Done when you have copied it.
        </p>

        <div className="mt-4 space-y-2">
          <label className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted" htmlFor="mcp-key-name">
            Name for new key
          </label>
          <input
            id="mcp-key-name"
            type="text"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            maxLength={32}
            placeholder="Type a name or tap a suggestion"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand max-sm:min-h-[44px]"
          />
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.18em] text-muted" htmlFor="mcp-key-scope">
            Scope
          </label>
          <select
            id="mcp-key-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "read-write" | "read")}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none"
          >
            <option value="read-write">read-write — full access</option>
            <option value="read">read — view only, cannot change anything</option>
          </select>
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.18em] text-muted" htmlFor="mcp-key-expiry">
            Expiry
          </label>
          <select
            id="mcp-key-expiry"
            value={expires}
            onChange={(e) => setExpires(e.target.value as "never" | "7d" | "30d")}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none"
          >
            <option value="30d">30 days — recommended</option>
            <option value="7d">7 days — temporary access</option>
            <option value="never">Never — trusted device only</option>
          </select>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setKeyName(s)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition max-sm:min-h-[40px]",
                  keyName === s
                    ? "border-brand bg-brand/10 text-foreground"
                    : "border-border text-muted hover:text-foreground",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void mint(false)}
            disabled={busy !== null || atCap || !canAdd}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-hover disabled:opacity-60 max-sm:min-h-[44px]"
          >
            {busy === "mint" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add key
          </button>
          {keys.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => void mint(true)}
                disabled={busy !== null || !canAdd}
                className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-60 max-sm:min-h-[44px]"
              >
                {busy === "rotate" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                Rotate all
              </button>
              <button
                type="button"
                onClick={() => void revokeAll()}
                disabled={busy !== null}
                className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-60 max-sm:min-h-[44px]"
              >
                {busy === "revoke" ? <Loader2 className="size-4 animate-spin" /> : null}
                Revoke all
              </button>
            </>
          )}
        </div>
        {!canAdd && (
          <p className="mt-2 text-xs text-faint">Tap ChatGPT / Cursor / Claude (or type a name) to enable Add key.</p>
        )}
        {atCap && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            At the {maxKeys}-key limit — revoke one before adding another.
          </p>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-[0.14em] text-muted">
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Prefix</th>
                <th className="py-2 pr-3 font-semibold">Created</th>
                <th className="py-2 pr-3 font-semibold">Expires</th>
                <th className="py-2 pr-3 font-semibold">Last used</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2 font-semibold"> </th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-4 text-muted">
                    No live key yet.
                  </td>
                </tr>
              ) : (
                keys.map((k) => (
                  <tr key={k.id} className="border-b border-border/60">
                    <td className="py-2 pr-3">
                      {editingId === k.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            maxLength={32}
                            className="min-w-[8rem] flex-1 rounded border border-border bg-surface px-2 py-1 text-sm outline-none focus:border-brand"
                            aria-label="Rename key"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveRename(k.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => void saveRename(k.id)}
                            disabled={renaming}
                            className="text-xs font-medium text-brand-text hover:underline disabled:opacity-60"
                          >
                            {renaming ? "…" : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="text-xs text-muted hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{k.name || "jobby"}</span>
                          {k.scope === "read" && (
                            <span className="ml-1 rounded bg-brand-soft px-1 text-[10px] uppercase tracking-wide text-brand-text">read</span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(k.id);
                              setEditName(k.name || "");
                            }}
                            className="text-muted hover:text-foreground"
                            aria-label={`Rename ${k.name || "key"}`}
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{k.prefix ? `${k.prefix}…` : "—"}</td>
                    <td className="py-2 pr-3 tabular-nums text-muted">{fmtDay(k.createdAt)}</td>
                    <td className="py-2 pr-3 tabular-nums text-muted">
                      {k.expiresAt ? `${fmtDay(k.expiresAt)}${k.expiresInDays != null ? ` · ${k.expiresInDays}d` : ""}` : "never"}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-muted">{fmtDay(k.lastUsedAt)}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          k.status === "expired"
                            ? "bg-red-500/15 text-red-700 dark:text-red-300"
                            : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                        )}
                      >
                        {k.status}
                      </span>
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => void revokeOne(k.id)}
                        disabled={busy !== null || revokingId !== null}
                        className="inline-flex items-center gap-1 text-xs text-muted hover:text-red-600 disabled:opacity-60"
                        aria-label={`Revoke ${k.name || "key"}`}
                      >
                        {revokingId === k.id ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Trash2 className="size-3" />
                        )}
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {minted && (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">
                  New key ready — copy now
                </p>
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                  Secret is shown once. After you paste it into ChatGPT or Cursor, press Done to
                  hide this panel.
                  {minted.name ? (
                    <>
                      {" "}
                      Entry name: <span className="font-mono">{minted.serverName || minted.name}</span>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSecretOpen((o) => !o)}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground max-sm:min-h-[40px]"
                >
                  {secretOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  {secretOpen ? "Collapse" : "Expand"}
                </button>
                <button
                  type="button"
                  onClick={dismissSecret}
                  className="inline-flex items-center gap-1 rounded-full border border-brand bg-brand/10 px-3 py-1.5 text-xs font-medium text-foreground max-sm:min-h-[40px]"
                >
                  <Check className="size-3.5" />
                  Done — I copied it
                </button>
              </div>
            </div>
            {secretOpen && (
              <div className="mt-3 space-y-3">
                <div className="rounded-lg border border-border bg-surface/60 px-3 py-2 text-xs text-muted">
                  Scope: <span className="font-mono text-foreground">{minted.scope || "read-write"}</span>
                  {" · "}
                  Expiry:{" "}
                  <span className="font-mono text-foreground">
                    {minted.expiresAt ? fmtDay(minted.expiresAt) : "never"}
                  </span>
                </div>
                <CopyLine label="ChatGPT / Claude.ai URL" value={minted.url} />
                <button
                  type="button"
                  onClick={() => void showQr()}
                  disabled={qrBusy}
                  className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-60"
                >
                  {qrBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {qrDataUrl ? "Refresh QR" : "Show QR"}
                </button>
                {qrDataUrl && (
                  <div className="w-fit rounded-xl border border-border bg-white p-2">
                    <img src={qrDataUrl} alt="QR code for this Jobby MCP connection URL" width={240} height={240} />
                  </div>
                )}
                {minted.localUrl && minted.localUrl !== minted.url && (
                  <CopyLine label="This machine (Cursor / Claude Code)" value={minted.localUrl} />
                )}
                <CopyLine label="Token only" value={minted.token} />
                <CopyLine label="Cursor — ~/.cursor/mcp.json" value={JSON.stringify(minted.cursor, null, 2)} />
                <CopyLine
                  label="Claude Code — .mcp.json"
                  value={JSON.stringify(minted.claudeCode, null, 2)}
                />
              </div>
            )}
          </div>
        )}

        {(showNext || keys.length > 0) && (
          <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                What&apos;s next
              </h3>
              {showNext && (
                <button
                  type="button"
                  onClick={() => setShowNext(false)}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
                  aria-label="Hide next steps"
                >
                  <X className="size-3.5" />
                  Hide
                </button>
              )}
            </div>
            {(showNext || !minted) && (
              <NextSteps serverName={nextServer} local={local} />
            )}
            {!showNext && minted && (
              <button
                type="button"
                onClick={() => setShowNext(true)}
                className="mt-2 text-xs font-medium text-brand-text hover:underline"
              >
                Show setup steps
              </button>
            )}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-border bg-surface/50 px-4 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
          Client instructions
        </h2>
        <p className="mt-2 text-sm text-muted">
          Auto-generated from your plan KPIs. Copy into the matching client.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["chatgpt", "ChatGPT"],
              ["claude", "Claude"],
              ["cursor", "Cursor"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition max-sm:min-h-[40px]",
                tab === id
                  ? "border-brand bg-brand/10 text-foreground"
                  : "border-border text-muted hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4">
          {instructionText ? (
            <CopyLine label={`${tab} setup`} value={instructionText} mono={false} />
          ) : (
            <p className="text-sm text-muted">Load KPIs to generate instructions.</p>
          )}
        </div>
        {!local && endpoint && (
          <p className="mt-3 font-mono text-[11px] text-faint">Public MCP origin: {endpoint}</p>
        )}
      </section>

      {error && (
        <p className="mt-4 text-sm text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** @deprecated Prefer McpConnectPage on /connect — kept name for any leftover import. */
export function McpConnect() {
  return <McpConnectPage />;
}
