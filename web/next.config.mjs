/** @type {import('next').NextConfig} */
const nextConfig = {
  // Two lockfiles exist on purpose (repo root + web/), so Next would infer the
  // repo root as the workspace root. On Windows that misinference can send
  // Turbopack's postcss workers into an unbounded respawn loop that exhausts
  // all RAM (vercel/next.js#92978) — hence the upstream pin to web/.
  //
  // But the middleware (proxy.ts → auth.ts) and app routes (layout.tsx →
  // job-store → score-fairness) re-export shared logic from ../scripts/*.mjs,
  // which is OUTSIDE web/. Turbopack's middleware does not honour
  // experimental.externalDir, so the only way those `../../../scripts/*`
  // imports resolve in `next dev` is for the Turbopack root to include the
  // repo root. The Windows OOM does not occur on macOS/Linux, so off-Windows
  // we expand the root to the repo root; Windows keeps the pin and uses the
  // standalone docker build (JOBBY_STANDALONE=1), which bundles scripts/ in.
  turbopack: {
    root: process.platform === "win32" ? import.meta.dirname : new URL("..", import.meta.url).pathname,
  },
  // Lets app routes (not middleware) import ../scripts/*.mjs without the
  // repo-root expansion above; kept for the Windows path and as a
  // belt-and-braces measure.
  experimental: { externalDir: true },
  // Docker / Railway images use `output: 'standalone'` (see deploy/Dockerfile.web).
  ...(process.env.JOBBY_STANDALONE === "1" || process.env.DOCKER_BUILD === "1"
    ? { output: "standalone" }
    : {}),
  // BullMQ / ioredis are Node-native — keep them out of the edge bundle.
  // pdfjs-dist must stay a real node_modules package too: it loads its worker
  // via a runtime-computed path, which webpack bundling breaks (the worker
  // file ends up nowhere near the bundled chunk that references it).
  serverExternalPackages: ["bullmq", "ioredis", "pdfjs-dist"],
  // File tracing for the standalone build only copies files it can see
  // statically imported — pdfjs-dist's worker is loaded via a runtime-computed
  // path, so it never gets traced on its own. Force it in explicitly.
  outputFileTracingIncludes: {
    "/api/cv/ingest": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  // Allow a throwaway build dir (e.g. BUILD_DIST=.next-prod) so a production
  // `next build` can run without clobbering a live `next dev` .next.
  ...(process.env.BUILD_DIST ? { distDir: process.env.BUILD_DIST } : {}),
};

export default nextConfig;
