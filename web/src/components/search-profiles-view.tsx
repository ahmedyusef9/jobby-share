"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2, Power, Save, X } from "lucide-react";
import { cn } from "@/lib/cn";

export type SearchProfile = {
  id: string;
  title: string;
  queries: string[];
  locations: string[];
  enabled: boolean;
  updatedAt: string;
};

type Draft = {
  id?: string;
  title: string;
  queries: string; // comma-separated in the form
  locations: string;
  enabled: boolean;
};

function toDraft(p: SearchProfile): Draft {
  return {
    id: p.id,
    title: p.title,
    queries: p.queries.join(", "),
    locations: p.locations.join(", "),
    enabled: p.enabled,
  };
}

function emptyDraft(): Draft {
  return { title: "", queries: "", locations: "", enabled: true };
}

export function SearchProfilesClient({
  initial,
  onChange,
}: {
  initial: SearchProfile[];
  /** Fired after every successful create/edit/enable/disable/delete, with the fresh list — lets an embedding page (e.g. Explore) keep its own copy in sync without a page reload. */
  onChange?: (profiles: SearchProfile[]) => void;
}) {
  const [profiles, setProfiles] = useState<SearchProfile[]>(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return fetch("/api/search-profiles", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.profiles)) {
          setProfiles(d.profiles);
          onChange?.(d.profiles);
        }
      })
      .catch(() => {});
  }

  function startCreate() {
    setError(null);
    setDraft(emptyDraft());
  }

  function startEdit(p: SearchProfile) {
    setError(null);
    setDraft(toDraft(p));
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.title.trim()) {
      setError("Title is required.");
      return;
    }
    const queries = draft.queries.split(",").map((s) => s.trim()).filter(Boolean);
    const locations = draft.locations.split(",").map((s) => s.trim()).filter(Boolean);
    if (queries.length === 0 && locations.length === 0) {
      setError("Provide at least one query or location.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        draft.id ? `/api/search-profiles/${draft.id}` : "/api/search-profiles",
        {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: draft.title.trim(), queries, locations, enabled: draft.enabled }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "save failed");
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(p: SearchProfile) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/search-profiles/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !p.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "toggle failed");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: SearchProfile) {
    if (!confirm(`Delete profile “${p.title}”? Existing tagged pipeline rows stay.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/search-profiles/${p.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "delete failed");
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
    {error && (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
        {error}
      </div>
    )}

    <div className="space-y-2">
      {profiles.length === 0 && !draft && (
        <div className="rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-10 text-center">
          <p className="font-display text-lg">No search profiles yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Create one per search intent — e.g. Israel roles, US remote roles. Each runs as its own isolated scan.
          </p>
        </div>
      )}

      {profiles.map((p) => (
        <div key={p.id} className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                    p.enabled
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "bg-surface-hover text-muted",
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", p.enabled ? "bg-emerald-500" : "bg-zinc-400")} />
                  {p.enabled ? "enabled" : "disabled"}
                </span>
                <h3 className="truncate font-medium text-landing">{p.title}</h3>
              </div>
              <p className="mt-1.5 text-sm text-muted">
                <span className="text-faint">queries:</span>{" "}
                <code className="text-foreground">{p.queries.join(", ") || "—"}</code>
              </p>
              <p className="mt-0.5 text-sm text-muted">
                <span className="text-faint">locations:</span>{" "}
                <code className="text-foreground">{p.locations.join(", ") || "—"}</code>
              </p>
              <p className="mt-1 font-mono text-[10px] text-faint">{p.id}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => startEdit(p)}
                disabled={busy}
                className="rounded-full border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => toggle(p)}
                disabled={busy}
                title={p.enabled ? "Disable" : "Enable"}
                className="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px] max-sm:min-w-[44px]"
              >
                <Power className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove(p)}
                disabled={busy}
                title="Delete"
                className="rounded-full border border-border p-1.5 text-faint transition-colors hover:text-red-500 disabled:opacity-50 max-sm:min-h-[44px] max-sm:min-w-[44px]"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>

    {draft && (
      <div className="rounded-2xl border border-brand/30 bg-surface/60 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-landing">{draft.id ? "Edit profile" : "New profile"}</h3>
          <button
            type="button"
            onClick={() => setDraft(null)}
            disabled={busy}
            className="rounded-full p-1 text-faint hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-3 space-y-3">
          <Field label="Title">
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="e.g. Software Engineer Israel"
              className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50 max-sm:min-h-[44px]"
            />
          </Field>
          <Field label="Queries (comma-separated keywords)">
            <input
              value={draft.queries}
              onChange={(e) => setDraft({ ...draft, queries: e.target.value })}
              placeholder="software engineer, backend"
              className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50 max-sm:min-h-[44px]"
            />
          </Field>
          <Field label="Locations (comma-separated)">
            <input
              value={draft.locations}
              onChange={(e) => setDraft({ ...draft, locations: e.target.value })}
              placeholder="Israel, Remote"
              className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm outline-none focus:border-brand/50 max-sm:min-h-[44px]"
            />
          </Field>
          <label className="inline-flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="size-4 accent-brand"
            />
            Enabled (use this profile in scans)
          </label>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={saveDraft}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save
          </button>
          <button
            type="button"
            onClick={() => setDraft(null)}
            disabled={busy}
            className="rounded-full border border-border px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
          >
            Cancel
          </button>
        </div>
      </div>
    )}

    {!draft && (
      <button
        type="button"
        onClick={startCreate}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
      >
        <Plus className="size-4" /> New profile
      </button>
    )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-faint">{label}</span>
      {children}
    </label>
  );
}
