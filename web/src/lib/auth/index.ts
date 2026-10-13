export { safeCallbackUrl } from "./callback-url.mjs";
export {
  anyProviderConfigured,
  anySignupProvider,
  configuredProviders,
  signInErrorMessage,
} from "./providers.mjs";

export type ConfiguredProviders = {
  operator: boolean;
  github: boolean;
  google: boolean;
  /** Appwrite-backed email + password — the method that needs no GitHub account. */
  email: boolean;
};
