"use client";

import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { Download, Loader2, Trash2 } from "lucide-react";
import { JobbyMark, BrandFooter } from "@/components/co-mark";

type AccountInfo = {
  email: string | null;
  emails: string[];
  tenantId: string;
  status: string;
  operator: boolean;
  canDelete: boolean;
  graceDays: number;
  plan?: string | null;
};

function clearTenantKeys(tenantId: string) {
  if (typeof window === "undefined") return;
  const prefix = `jobby:${tenantId}:`;
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  for (const k of keys) window.localStorage.removeItem(k);
}

export function AccountPanel() {
  const { data } = useSession();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [busy, setBusy] = useState<"export" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/account")
      .then(async (r) => {
        const body = (await r.json()) as AccountInfo & { error?: string };
        if (!r.ok) throw new Error(body.error || `Could not load account (${r.status})`);
        return body;
      })
      .then(setInfo)
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load account"));
  }, []);

  const email = info?.email || data?.user?.email || "";
  const tenant = info?.tenantId || data?.tenantId || "";

  async function handleExport() {
    if (busy) return;
    setBusy("export");
    setError(null);
    try {
      const r = await fetch("/api/account/export");
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Export failed (${r.status})`);
      }
      const blob = await r.blob();
      const name =
        r.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ||
        "jobby-export.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (busy || !info?.canDelete) return;
    setBusy("delete");
    setError(null);
    try {
      const r = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error || `Delete failed (${r.status})`);
      if (tenant) clearTenantKeys(tenant);
      await signOut({ callbackUrl: "/signin" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <JobbyMark height={56} className="mb-5" />
      <h1 className="font-display text-2xl tracking-tight text-landing">Account</h1>
      <p className="mt-1 text-sm text-muted">
        Take your data with you, or leave. Neither needs us. Connect ChatGPT / Claude / Cursor from{" "}
        <a href="/connect" className="font-medium text-brand hover:underline">
          MCP
        </a>
        .
      </p>

      {loadError && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </p>
      )}

      <section className="mt-8 rounded-xl border border-border bg-surface/50 px-4 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Export</h2>
        <p className="mt-2 text-sm text-muted">
          A zip of your CV, tracker, reports and config. Stored API keys are not included —
          those stay on the server and are deleted with the account.
        </p>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={busy !== null}
          className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-hover disabled:opacity-60 max-sm:min-h-[44px]"
        >
          {busy === "export" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy === "export" ? "Preparing…" : "Download my data"}
        </button>
      </section>

      <section className="mt-6 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-4">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-red-700 dark:text-red-300">
          <Trash2 className="size-3.5" aria-hidden />
          Delete account
        </h2>
        {info?.operator || !info?.canDelete ? (
          <p className="mt-2 text-sm text-muted">
            This sign-in is the local operator. It has no account record to delete — that is
            the single-user install path.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted">
              Type your email to confirm. You will be signed out on every device immediately.
              Your files stay recoverable for {info.graceDays} days, then they are removed
              for good — including stored keys.
            </p>
            <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              Type {email || "your email"} to confirm
            </label>
            <input
              type="email"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 text-sm outline-none transition-colors placeholder:text-faint focus:border-red-500/50"
              placeholder={email || "you@example.com"}
            />
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={busy !== null || confirmEmail.trim().length === 0}
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
            >
              {busy === "delete" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {busy === "delete" ? "Deleting…" : "Delete my account"}
            </button>
          </>
        )}
      </section>

      {error && (
        <p className="mt-4 text-sm text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}

      {tenant && (
        <p className="mt-6 font-mono text-[10px] text-faint">tenant · {tenant}</p>
      )}
      <BrandFooter className="mt-12 border-t border-border pt-6" />
    </div>
  );
}
