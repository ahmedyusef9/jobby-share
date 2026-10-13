/**
 * Which sign-in methods this deployment can actually complete.
 *
 * Mirrors the conditions in auth.ts: the operator provider is always registered,
 * but its authorize() returns null when JOBBY_OPERATOR_SECRET is unset — so a
 * deployment without it must show "not configured" rather than a form that
 * silently rejects every attempt.
 *
 * Read on the server. NEXT_PUBLIC_* would be inlined at build time and is wrong
 * for images configured at run time (compose / Railway variables).
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function configuredProviders(env = process.env) {
  const has = (/** @type {string} */ k) => Boolean(env[k]?.trim());
  return {
    operator: has("JOBBY_OPERATOR_SECRET"),
    github: has("AUTH_GITHUB_ID") && has("AUTH_GITHUB_SECRET"),
    google: has("AUTH_GOOGLE_ID") && has("AUTH_GOOGLE_SECRET"),
    // Email sign-up is Appwrite-backed, so it needs all three Appwrite vars.
    // This is the method that lets a tester join without owning a GitHub account.
    email:
      has("APPWRITE_ENDPOINT") && has("APPWRITE_PROJECT_ID") && has("APPWRITE_API_KEY"),
  };
}

/** @param {{operator: boolean, github: boolean, google: boolean, email?: boolean}} p */
export function anyProviderConfigured(p) {
  return p.operator || p.github || p.google || Boolean(p.email);
}

/** Methods by which a *new* person can create an account (as opposed to the operator door). */
export function anySignupProvider(p) {
  return p.github || p.google || Boolean(p.email);
}

/**
 * Auth.js error codes are not user-facing prose. Map the ones this app can
 * actually produce; anything else gets a truthful generic line.
 * @param {string | null | undefined} code
 */
export function signInErrorMessage(code) {
  switch (code) {
    case null:
    case undefined:
    case "":
      return null;
    case "CredentialsSignin":
      return "That operator secret is not correct.";
    case "AccessDenied":
      return "This account cannot sign in. If you created it while the alpha was full, or it has been suspended, get in touch.";
    case "OAuthAccountNotLinked":
      return "That email is already registered with a different sign-in method.";
    case "Configuration":
      return "Sign-in is misconfigured on the server. Check AUTH_SECRET and the provider credentials.";
    case "Verification":
      return "That sign-in link has expired. Request a new one.";
    case "OAuthSignin":
    case "OAuthCallback":
      return "The identity provider rejected the request. Try again.";
    case "SessionRequired":
      return "Please sign in to continue.";
    default:
      return "Sign-in failed. Please try again.";
  }
}
