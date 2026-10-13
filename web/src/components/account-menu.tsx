"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Sign-out must not leave the previous account's UI state behind: two people on
 * one browser would inherit each other's triage and filters. Keys are namespaced
 * jobby:{tenantId}:* (see lib/storage.ts), so clearing that prefix is enough.
 */
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

function initial(label: string): string {
  const c = label.trim()[0];
  return c ? c.toUpperCase() : "?";
}

export function AccountMenu() {
  const { data, status } = useSession();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Nav hint only — /admin and every admin API re-check the role server-side.
  const [canAdmin, setCanAdmin] = useState(false);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { canAdmin?: boolean } | null) => {
        if (!cancelled && d?.canAdmin) setCanAdmin(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (status === "loading") {
    return <div className="h-9 animate-pulse rounded-xl border border-border bg-surface" aria-hidden />;
  }
  if (!data?.user) return null;

  const name = data.user.name || data.user.email || "Account";
  const email = data.user.email && data.user.email !== name ? data.user.email : null;
  const tenant = data.tenantId;

  function handleSignOut() {
    if (leaving) return;
    setLeaving(true);
    if (tenant) clearTenantKeys(tenant);
    void signOut({ callbackUrl: "/signin" });
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? panelId : undefined}
        className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-2 py-1.5 text-left transition hover:bg-surface-hover"
      >
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-brand-foreground"
        >
          {initial(name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={name}>
          {name}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-2 w-full min-w-[13rem] rounded-xl border border-border bg-surface p-1.5 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-xs font-medium" title={name}>
              {name}
            </p>
            {email && (
              <p className="truncate text-[11px] text-faint" title={email}>
                {email}
              </p>
            )}
            {tenant && (
              <p className="mt-1 truncate font-mono text-[10px] text-faint" title={`tenant ${tenant}`}>
                tenant · {tenant}
              </p>
            )}
          </div>
          <div className="my-1 h-px bg-border" aria-hidden />
          {canAdmin && (
            <Link
              href="/admin"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-surface-hover hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              Operator
            </Link>
          )}
          <Link
            href="/account"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-surface-hover hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            Account
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={leaving}
            aria-busy={leaving}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
          >
            <LogOut size={13} aria-hidden />
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
