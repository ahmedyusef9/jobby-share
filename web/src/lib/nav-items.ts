"use client";

import { LayoutDashboard, Compass, ListChecks, Activity, Radar, BarChart3, FileText, ScrollText, Plug, Settings, ShieldCheck, Lock, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import type { ComponentType, SVGProps } from "react";

// Single source of truth for the app's primary destinations — shared by the
// desktop sidebar and the mobile nav so they can never drift.
export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  chip?: string;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Today", icon: LayoutDashboard },
  { href: "/explore", label: "Explore", icon: Compass, chip: "New" },
  { href: "/pipeline", label: "Pipeline", icon: ListChecks },
  { href: "/jobs", label: "Workers", icon: Activity },
  { href: "/portals", label: "Portals", icon: Radar },
  { href: "/search-profiles", label: "Profiles", icon: Layers },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/cv", label: "CV", icon: FileText },
  { href: "/rules", label: "Rules", icon: ScrollText },
  { href: "/connect", label: "MCP", icon: Plug, chip: "New" },
  { href: "/config", label: "Config", icon: Settings },
];

/**
 * Operator-only destinations, appended to the nav by the shells only after
 * /api/account answers canAdmin. Never render these unconditionally — a
 * member must not even see that the admin area exists.
 */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "Admin", icon: ShieldCheck },
  { href: "/admin/rbac", label: "Access", icon: Lock },
];

// D-035/BL-094: member primary nav is Today, Explore, Pipeline, CV, Rules,
// MCP. Workers/Portals/Profiles/Analytics/Config are operator-only chrome —
// Profiles' editor moved onto Explore itself (BL-091, D-036/3), Config
// degrades to a keyless page for members rather than disappearing (D-025,
// D-036/2), but the nav *link* to it is still operator-only per this issue.
const MEMBER_HIDDEN_HREFS = new Set<string>(["/jobs", "/portals", "/search-profiles", "/analytics", "/config"]);

/**
 * Primary nav, filtered for the signed-in role. Defaults to the restricted
 * (member) list until /api/account confirms operator — mirrors useCanAdmin's
 * fail-closed default so a member is never shown operator-only chrome even
 * briefly while the check is in flight. Nav hint only: every hidden route
 * re-checks the role server-side (REQ-NV-002).
 */
export function useVisibleNavItems(): NavItem[] {
  const { status } = useSession();
  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { role?: string; operator?: boolean } | null) => {
        if (!cancelled && (d?.operator || d?.role === "operator")) setIsOperator(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status]);
  return isOperator ? NAV_ITEMS : NAV_ITEMS.filter((item) => !MEMBER_HIDDEN_HREFS.has(item.href));
}

export function isActivePath(href: string, pathname: string, hash = ""): boolean {
  const [path, itemHash] = href.split("#");
  const currentHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (itemHash) return pathname.startsWith(path) && currentHash === itemHash;
  if (path === "/") return pathname === "/";
  return pathname.startsWith(path);
}

/** Nav hint only — every admin route/API re-checks the role server-side. */
export function useCanAdmin(): boolean {
  const { status } = useSession();
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
  return canAdmin;
}

export function useNavHash(): string {
  const pathname = usePathname();
  const [hash, setHash] = useState("");
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [pathname]);
  return hash;
}
