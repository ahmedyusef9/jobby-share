"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { CoMark, BrandFooter } from "@/components/co-mark";
import { AssistantConsole } from "@/components/assistant-console";
import { MobileNav } from "@/components/mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { JobsProvider } from "@/components/jobs/job-store";
import { PipelineProvider } from "@/components/pipeline/pipeline-provider";
import { ApplyProvider } from "@/components/apply/apply-provider";
import { ExploreProvider } from "@/components/explore/explore-provider";
import { FirstScoreView } from "@/components/explore/first-score-view";
import { BetaBanner } from "@/components/beta/beta-banner";
import { WorkerPills } from "@/components/jobs/worker-pills";
import { UsageMeter } from "@/components/usage-meter";
import { AccountMenu } from "@/components/account-menu";
import { ADMIN_NAV_ITEMS, isActivePath, useCanAdmin, useNavHash, useVisibleNavItems } from "@/lib/nav-items";

export function AppShell({ children }: { children: React.ReactNode }) {
  const canAdmin = useCanAdmin();
  const navItems = useVisibleNavItems();
  const pathname = usePathname();
  const hash = useNavHash();
  return (
    <JobsProvider>
      <PipelineProvider>
      <ApplyProvider>
      <ExploreProvider>
      <MobileNav />
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface/30 p-4 md:flex">
          <div className="mb-8 flex items-start justify-between gap-2 px-1">
            <Link href="/" className="flex items-center" aria-label="jobby home">
              <CoMark height={72} />
            </Link>
            <ThemeToggle />
          </div>
          <nav className="flex flex-col gap-1">
            {navItems.map(({ href, label, icon: Icon, chip }) => {
              const active = isActivePath(href, pathname, hash);
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-brand-soft text-brand-text"
                      : "text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                  {chip && (
                    <span className="ml-auto rounded-full border border-brand/30 bg-brand-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-text">
                      {chip}
                    </span>
                  )}
                </Link>
              );
            })}
              {canAdmin && (
                <>
                  <p className="mt-4 mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
                    Operator
                  </p>
                  {ADMIN_NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                    const active = isActivePath(href, pathname, hash);
                    return (
                      <Link
                        key={href}
                        href={href}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                          active
                            ? "bg-brand-soft text-brand-text"
                            : "text-muted hover:bg-surface-hover hover:text-foreground",
                        )}
                      >
                        <Icon className="size-4" />
                        {label}
                      </Link>
                    );
                  })}
                </>
              )}
          </nav>

          <WorkerPills />

          <div className="mt-auto space-y-3 pt-4">
            <UsageMeter />
            <AccountMenu />
            <BrandFooter className="px-1" />
          </div>
        </aside>
        <main className="flex-1 overflow-x-hidden">{children}</main>
        <AssistantConsole />
        <FirstScoreView />
        <BetaBanner />
      </div>
      </ExploreProvider>
      </ApplyProvider>
      </PipelineProvider>
    </JobsProvider>
  );
}
