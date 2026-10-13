// Web/TS surface for resolve-query-source. Canonical logic lives in
// `scripts/resolve-query-source.mjs` (pure JS, importable by the CLI too). This
// module re-exports it with TS types — the web app does not duplicate the resolver.

export { resolveQuerySource, PROFILES_REL } from "../../../../scripts/resolve-query-source.mjs";

export type PerProfileRun = {
  portalsPath: string;
  profileId: string;
  profileTitle: string;
};

export type ResolveResult = {
  mode: "profiles" | "portals-fallback";
  runs: PerProfileRun[];
  cleanup: () => void;
};
