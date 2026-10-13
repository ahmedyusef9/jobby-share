"use client";

import { useCallback, useEffect, useState, Fragment } from "react";
import Link from "next/link";
import { Activity, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { JobbyMark, BrandFooter } from "@/components/co-mark";

type AccountRow = {
  accountId: string;
  tenantId: string;
  email: string | null;
  role: string;
  plan: string;
  status: string;
  cohort: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
};

type Ops = {
  config: {
    version: string | null;
    source: string;
    signupOpen: boolean;
    defaultPlan: string | null;
  };
  batch: {
    batchId: string | null;
    state: string | null;
    capacity: number;
    taken: number;
    remaining: number;
    total: number;
    plan: string | null;
    appVersion: string | null;
  } | null;
};

type UsageEvent = {
  id: string;
  kind: string | null;
  engine: string | null;
  outcome: string | null;
  durationMs: number | null;
  tokens: number | null;
  at: string | null;
};

function when(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}

export function AdminPanel() {
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [plans, setPlans] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>(["member", "operator"]);
  const [ops, setOps] = useState<Ops | null>(null);
  const [capacityDraft, setCapacityDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [usageFor, setUsageFor] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageEvent[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [accountsRes, opsRes] = await Promise.all([
        fetch("/api/admin/accounts"),
        fetch("/api/admin/ops"),
      ]);
      const accountsBody = (await accountsRes.json()) as {
        accounts?: AccountRow[];
        plans?: string[];
        roles?: string[];
        error?: string;
      };
      const opsBody = (await opsRes.json()) as Ops & { error?: string };
      if (!accountsRes.ok) throw new Error(accountsBody.error || `Could not load accounts (${accountsRes.status})`);
      if (!opsRes.ok) throw new Error(opsBody.error || `Could not load operator state (${opsRes.status})`);
      setRows(accountsBody.accounts ?? []);
      setPlans(accountsBody.plans ?? []);
      setRoles(accountsBody.roles ?? ["member", "operator"]);
      setOps(opsBody);
      setCapacityDraft(String(opsBody.batch?.total ?? opsBody.batch?.capacity ?? ""));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load operator screen");
      setRows((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchAccount(accountId: string, change: { plan?: string; status?: string; role?: string }) {
    setBusy(accountId);
    setError(null);
    try {
      const r = await fetch("/api/admin/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, ...change }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error || `Update failed (${r.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  async function patchOps(change: { capacity?: number; signupOpen?: boolean; batchState?: string }) {
    setBusy("ops");
    setError(null);
    try {
      const r = await fetch("/api/admin/ops", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error || `Update failed (${r.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  async function loadUsage(tenantId: string) {
    if (usageFor === tenantId) {
      setUsageFor(null);
      setUsage(null);
      return;
    }
    setUsageFor(tenantId);
    setUsage(null);
    try {
      const r = await fetch(`/api/admin/usage?tenantId=${encodeURIComponent(tenantId)}`);
      const body = (await r.json()) as { events?: UsageEvent[]; error?: string };
      if (!r.ok) throw new Error(body.error || `Could not load usage (${r.status})`);
      setUsage(body.events ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load usage");
      setUsage([]);
    }
  }

  const opsBusy = busy === "ops";
  const roundOpen = ops?.batch?.state === "open";
  const signupOpen = ops?.config.signupOpen === true && roundOpen;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <JobbyMark height={56} className="mb-5" />
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Operator</h1>
          <p className="mt-1 text-sm text-muted">
            Capacity, sign-ups, accounts and usage. Nothing here is a deploy — every control
            writes to Appwrite so a second instance sees it without a shared file.
          </p>
        </div>
        <Link
          href="/admin/rbac"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-landing"
        >
          <ShieldCheck className="size-3.5" /> Access
        </Link>
        <Link
          href="/admin/runs"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-landing"
        >
          <Activity className="size-3.5" /> Runs
        </Link>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted">Capacity</p>
          <p className="mt-2 font-display text-2xl text-landing">
            {ops?.batch ? `${ops.batch.taken} / ${ops.batch.total}` : "—"}
          </p>
          <p className="mt-1 text-xs text-faint">
            {ops?.batch ? `${ops.batch.remaining} places free · ${ops.batch.batchId}` : "No batch yet"}
          </p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(capacityDraft);
              if (!Number.isInteger(n) || n < 0) {
                setError("capacity must be a whole number");
                return;
              }
              void patchOps({ capacity: n });
            }}
          >
            <input
              type="number"
              min={0}
              step={1}
              value={capacityDraft}
              onChange={(e) => setCapacityDraft(e.target.value)}
              disabled={opsBusy || !ops?.batch}
              aria-label="Capacity"
              className="w-24 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={opsBusy || !ops?.batch}
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-60"
            >
              {opsBusy ? <Loader2 className="size-3.5 animate-spin" /> : "Set"}
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted">Sign-ups</p>
          <p className="mt-2 font-display text-2xl text-landing">
            {ops ? (signupOpen ? "Open" : "Closed") : "—"}
          </p>
          <p className="mt-1 text-xs text-faint">
            Config {ops?.config.signupOpen ? "allows" : "pauses"} · round is {ops?.batch?.state ?? "none"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={opsBusy || !ops}
              onClick={() => void patchOps({ signupOpen: !ops?.config.signupOpen })}
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-60"
            >
              {ops?.config.signupOpen ? "Pause sign-ups" : "Allow sign-ups"}
            </button>
            {ops?.batch && (
              <button
                type="button"
                disabled={opsBusy}
                onClick={() => void patchOps({ batchState: roundOpen ? "closed" : "open" })}
                className="rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-60"
              >
                {roundOpen ? "Close round" : "Open round"}
              </button>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted">Config version</p>
          <p className="mt-2 font-display text-2xl text-landing">{ops?.config.version ?? "defaults"}</p>
          <p className="mt-1 text-xs text-faint">
            Source {ops?.config.source ?? "—"}
            {ops?.config.defaultPlan ? ` · new accounts get ${ops.config.defaultPlan}` : ""}
          </p>
        </div>
      </section>

      <h2 className="mt-10 font-display text-xl tracking-tight text-landing">Accounts</h2>
      <p className="mt-1 text-sm text-muted">
        Who has an account, what they may do, and when they were last here. No one&apos;s CV,
        applications or reports are visible from this page — by design.
      </p>

      {rows === null ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-8 rounded-xl border border-border bg-surface/50 px-4 py-6 text-sm text-muted">
          No accounts yet. They appear here the moment someone signs in for the first time.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[46rem] text-left text-sm">
            <thead className="bg-surface/60 text-[11px] uppercase tracking-[0.14em] text-muted">
                <tr>
                  <th className="px-4 py-3 font-semibold">User</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">Plan</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Joined</th>
                <th className="px-4 py-3 font-semibold">Last seen</th>
                <th className="px-4 py-3 font-semibold">Access</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const suspended = row.status === "suspended";
                const rowBusy = busy === row.accountId;
                const open = usageFor === row.tenantId;
                return (
                  <Fragment key={row.accountId}>
                    <tr className="border-t border-border align-middle">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void loadUsage(row.tenantId)}
                          className="text-left"
                        >
                          <div className="font-medium">{row.email ?? row.accountId}</div>
                          <div className="font-mono text-[10px] text-faint">
                            {row.tenantId}
                            {open ? " · hide usage" : " · usage"}
                          </div>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={row.role}
                          disabled={rowBusy}
                          onChange={(e) => void patchAccount(row.accountId, { role: e.target.value })}
                          aria-label={`Role for ${row.email ?? row.accountId}`}
                          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none disabled:opacity-60"
                        >
                          {roles.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={row.plan}
                          disabled={rowBusy}
                          onChange={(e) => void patchAccount(row.accountId, { plan: e.target.value })}
                          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none disabled:opacity-60"
                        >
                          {plans.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            suspended
                              ? "rounded-full bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300"
                              : "rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300"
                          }
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted">{when(row.createdAt)}</td>
                      <td className="px-4 py-3 text-muted">{when(row.lastSeenAt)}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() =>
                            void patchAccount(row.accountId, { status: suspended ? "active" : "suspended" })
                          }
                          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-surface-hover disabled:opacity-60"
                        >
                          {rowBusy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : suspended ? (
                            <ShieldCheck className="size-3.5" />
                          ) : (
                            <ShieldOff className="size-3.5" />
                          )}
                          {suspended ? "Reactivate" : "Suspend"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-border bg-surface/40">
                        <td colSpan={7} className="px-4 py-3">
                          {usage === null ? (
                            <p className="flex items-center gap-2 text-xs text-muted">
                              <Loader2 className="size-3.5 animate-spin" /> Loading usage…
                            </p>
                          ) : usage.length === 0 ? (
                            <p className="text-xs text-muted">No scan or usage events yet.</p>
                          ) : (
                            <table className="w-full text-left text-xs">
                              <thead className="text-[10px] uppercase tracking-[0.14em] text-muted">
                                <tr>
                                  <th className="py-1 font-semibold">When</th>
                                  <th className="py-1 font-semibold">Kind</th>
                                  <th className="py-1 font-semibold">Outcome</th>
                                  <th className="py-1 font-semibold">Duration</th>
                                  <th className="py-1 font-semibold">Tokens</th>
                                </tr>
                              </thead>
                              <tbody>
                                {usage.map((ev) => (
                                  <tr key={ev.id}>
                                    <td className="py-1 text-muted">{when(ev.at)}</td>
                                    <td className="py-1">{ev.kind ?? "—"}</td>
                                    <td className="py-1">{ev.outcome ?? "—"}</td>
                                    <td className="py-1 text-muted">
                                      {ev.durationMs != null ? `${Math.round(ev.durationMs / 100) / 10}s` : "—"}
                                    </td>
                                    <td className="py-1 text-muted">{ev.tokens ?? "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-xs leading-relaxed text-faint">
        Suspending signs that account out everywhere immediately and blocks sign-in. A plan
        change takes effect on their next request — authority is read per request, never from
        their session token, so it cannot go stale. A role change signs them out everywhere on
        purpose: what they are must be re-established, not inherited from a live session.
        Every mutation here is written to the audit trail (Access → audit view). Raising
        capacity (10 → 15) reopens a full round. Pausing sign-ups publishes a new config
        version; every running instance picks it up within one TTL.
      </p>

      <BrandFooter className="mt-12 border-t border-border pt-6" />
    </div>
  );
}
