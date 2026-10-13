"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Lock, RotateCcw, Save } from "lucide-react";
import { JobbyMark, BrandFooter } from "@/components/co-mark";

type Matrix = {
  roles: string[];
  plans: string[];
  caps: string[];
  memberCaps: string[];
  structuralCaps: string[];
  planCaps: Record<string, string[]>;
  planLimits: Record<string, { priceUsd: number; scans: number; mcp: number; results: number }>;
  overridden: boolean;
};

type AuditRow = {
  ts: string | null;
  action: string;
  actor: string;
  accountId: string | null;
  field: string | null;
  before: unknown;
  after: unknown;
};

/** Capabilities worth showing as editable — everything else is operator-only plumbing. */
const EDITABLE_CAPS = ["search_jobs", "generate_cv", "cv_chat", "score_job"];

const CAP_LABELS: Record<string, string> = {
  search_jobs: "Search jobs",
  generate_cv: "Generate CV",
  cv_chat: "CV chat",
  score_job: "Score jobs",
};

function when(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function RbacPanel() {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>> | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Monotonic id per load(): a slower earlier fetch must never overwrite the
  // state a newer one already applied (BL-061 defect — post-publish toggles
  // were swallowed by exactly this race).
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const r = await fetch("/api/admin/rbac");
      const body = (await r.json()) as {
        matrix?: Matrix;
        audit?: AuditRow[];
        error?: string;
      };
      if (!r.ok) throw new Error(body.error || `Could not load RBAC state (${r.status})`);
      if (!body.matrix) throw new Error("no matrix in response");
      if (seq !== loadSeq.current) return; // a newer load already spoke
      setMatrix(body.matrix);
      setDraft(
        Object.fromEntries(
          Object.entries(body.matrix.planCaps).map(([p, caps]) => [p, new Set(caps)]),
        ),
      );
      setAudit(body.audit ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load RBAC state");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!matrix || !draft) return false;
    return matrix.plans.some((p) => {
      const base = new Set(matrix.planCaps[p] ?? []);
      const now = draft[p] ?? new Set<string>();
      return base.size !== now.size || [...now].some((c) => !base.has(c));
    });
  }, [matrix, draft]);

  function toggle(plan: string, cap: string) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = new Set(prev[plan]);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return { ...prev, [plan]: next };
    });
  }

  async function save(planCaps: Record<string, string[]> | null) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/rbac", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCaps }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error || `Save failed (${r.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function currentDraftObject(): Record<string, string[]> | null {
    if (!draft) return {};
    return Object.fromEntries([...(matrix?.plans ?? [])].map((p) => [p, [...(draft[p] ?? [])]]));
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <JobbyMark height={56} className="mb-5" />
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Access control</h1>
          <p className="mt-1 text-sm text-muted">
            Who may do what, per plan. Changes publish a new config version — every running
            instance picks them up without a restart. Structural rules (export your data,
            delete account, anything operator-only) are not editable here, ever.
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {!matrix || !draft ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : (
        <>
          <section className="mt-8 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead className="bg-surface/60 text-[11px] uppercase tracking-[0.14em] text-muted">
                <tr>
                  <th className="px-4 py-3 font-semibold">Capability</th>
                  {matrix.plans.map((p) => (
                    <th key={p} className="px-3 py-3 font-semibold">
                      {p}
                      <span className="block font-normal normal-case tracking-normal text-faint">
                        ${matrix.planLimits[p]?.priceUsd ?? 0}/mo
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EDITABLE_CAPS.map((cap) => (
                  <tr key={cap} className="border-t border-border">
                    <td className="px-4 py-2.5 font-medium">{CAP_LABELS[cap] ?? cap}</td>
                    {matrix.plans.map((p) => {
                      const checked = draft[p]?.has(cap) ?? false;
                      return (
                        <td key={p} className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy}
                            onChange={() => toggle(p, cap)}
                            aria-label={`${CAP_LABELS[cap] ?? cap} for plan ${p}`}
                            className="size-4 accent-emerald-500"
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {matrix.structuralCaps.map((cap) => (
                  <tr key={cap} className="border-t border-border opacity-60">
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <Lock className="size-3" /> {CAP_LABELS[cap] ?? cap}
                      </span>
                    </td>
                    {matrix.plans.map((p) => (
                      <td key={p} className="px-3 py-2.5 text-faint">
                        {matrix.planCaps[p]?.includes(cap) ? "always" : "never"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!dirty || busy}
              onClick={() => void save(currentDraftObject())}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Publish changes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-60"
            >
              <RotateCcw className="size-3.5" /> Reset to release defaults
            </button>
            {matrix.overridden && !dirty && (
              <span className="text-xs text-muted">custom matrix is live</span>
            )}
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">unsaved edits</span>}
          </div>

          <h2 className="mt-10 font-display text-xl tracking-tight text-landing">Audit trail</h2>
          <p className="mt-1 text-sm text-muted">
            Every access-control mutation, newest last. Before → after is recorded so any
            change can be reconstructed.
          </p>
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            {audit.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">No mutations recorded yet.</p>
            ) : (
              <table className="w-full min-w-[40rem] text-left text-xs">
                <thead className="bg-surface/60 text-[10px] uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">When</th>
                    <th className="px-4 py-2.5 font-semibold">Action</th>
                    <th className="px-4 py-2.5 font-semibold">Actor</th>
                    <th className="px-4 py-2.5 font-semibold">Target</th>
                    <th className="px-4 py-2.5 font-semibold">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {[...audit].reverse().map((row, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="whitespace-nowrap px-4 py-2 text-muted">{when(row.ts)}</td>
                      <td className="px-4 py-2 font-mono">{row.action}</td>
                      <td className="max-w-32 truncate px-4 py-2 text-muted">{row.actor}</td>
                      <td className="max-w-32 truncate px-4 py-2 font-mono text-muted">
                        {row.accountId ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-mono text-muted">
                          {JSON.stringify(row.before) ?? "—"}
                        </span>
                        {" → "}
                        <span className="font-mono">{JSON.stringify(row.after) ?? "—"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <BrandFooter className="mt-12 border-t border-border pt-6" />
    </div>
  );
}
