import Link from "next/link";
import { cn } from "@/lib/cn";

/** Stacked Jobby wordmark. SVG so it stays sharp at any size. */
export function JobbyMark({
  height = 56,
  className,
}: {
  height?: number;
  className?: string;
}) {
  return (
    <img
      src="/brand/jobby-wordmark.svg"
      alt="jobby"
      height={height}
      className={cn("h-auto w-auto shrink-0 object-contain object-left", className)}
      style={{ height, width: "auto" }}
    />
  );
}

/** Copyright lockup for sidebar / drawer / page footers. */
export function BrandFooter({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      <JobbyMark height={28} />
      <p className="text-[11px] leading-relaxed text-faint">
        © {new Date().getFullYear()} Jobby
        <span className="mx-1 text-border">·</span>
        local-first
      </p>
      <p className="text-[11px] text-faint">
        <Link href="/config" className="transition-colors hover:text-foreground">
          Config
        </Link>
        <span className="mx-1 text-border">·</span>
        <Link href="/rules" className="transition-colors hover:text-foreground">
          Rules
        </Link>
      </p>
    </div>
  );
}

/** @deprecated Prefer JobbyMark — kept so older imports keep working. */
export const CoMark = JobbyMark;
