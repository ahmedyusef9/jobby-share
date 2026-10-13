import Image from "next/image";

/**
 * The stacked Jobby mark, vector — the same artwork as logo/jobby-wordmark.svg,
 * served from web/public/brand because Next only serves static assets from
 * public/.
 *
 * Single-colour brand emerald, so it reads on both themes without a variant.
 */
export function BrandMark({ size = 72, className = "" }: { size?: number; className?: string }) {
  return (
    <Image
      src="/brand/jobby-wordmark.svg"
      alt="Jobby"
      width={size}
      height={size}
      priority
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: "auto" }}
    />
  );
}
