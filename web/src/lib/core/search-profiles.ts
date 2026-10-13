// Web/TS surface for the shared search-profiles store. Canonical logic lives in
// `scripts/search-profiles.mjs` (pure JS, importable by the CLI too — FR-005: web
// and CLI share one store). This module re-exports it with TS types so the web app
// gets type-checking without a second copy of the logic.

export {
  PROFILES_REL,
  PROFILE_ID_RE,
  newId,
  profilesPath,
  loadProfiles,
  listProfiles,
  getProfile,
  createProfile,
  upsertProfile,
  patchProfile,
  deleteProfile,
  enabledProfiles,
  validateProfile,
} from "../../../../scripts/search-profiles.mjs";

export type SearchProfile = {
  id: string;
  title: string;
  queries: string[];
  locations: string[];
  enabled: boolean;
  updatedAt: string;
};

export type SearchProfileStore = { version: number; profiles: SearchProfile[] };
