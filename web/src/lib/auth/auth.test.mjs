import assert from "node:assert/strict";
import test from "node:test";
import { safeCallbackUrl } from "./callback-url.mjs";
import { anyProviderConfigured, configuredProviders, signInErrorMessage } from "./providers.mjs";

test("safeCallbackUrl keeps same-origin relative paths", () => {
  assert.equal(safeCallbackUrl("/jobs"), "/jobs");
  assert.equal(safeCallbackUrl("/pipeline/12"), "/pipeline/12");
  // query strings must survive intact — an over-eager filter breaks deep links
  assert.equal(safeCallbackUrl("/explore?q=go&remote=1"), "/explore?q=go&remote=1");
});

test("safeCallbackUrl refuses off-site redirects", () => {
  assert.equal(safeCallbackUrl("https://evil.example/x"), "/");
  assert.equal(safeCallbackUrl("//evil.example"), "/");
  assert.equal(safeCallbackUrl("/\\evil.example"), "/");
  assert.equal(safeCallbackUrl("javascript:alert(1)"), "/");
  assert.equal(safeCallbackUrl("jobs"), "/");
});

test("safeCallbackUrl rejects embedded control characters", () => {
  assert.equal(safeCallbackUrl("/jobs\nSet-Cookie: x=1"), "/");
  assert.equal(safeCallbackUrl("/jo\u0000bs"), "/");
  // Trailing CR/LF is stripped by trim() before the check, which leaves a clean
  // path — normalising is the right outcome here, not a rejection.
  assert.equal(safeCallbackUrl("/jobs\r\n"), "/jobs");
});

test("safeCallbackUrl never loops back to the sign-in page", () => {
  assert.equal(safeCallbackUrl("/signin"), "/");
  assert.equal(safeCallbackUrl("/signin?error=CredentialsSignin"), "/");
});

test("safeCallbackUrl handles non-strings and honours the fallback", () => {
  assert.equal(safeCallbackUrl(undefined), "/");
  assert.equal(safeCallbackUrl(null), "/");
  assert.equal(safeCallbackUrl(["/a", "/b"]), "/");
  assert.equal(safeCallbackUrl("https://evil.example", "/home"), "/home");
});

test("configuredProviders mirrors the conditions in auth.ts", () => {
  assert.deepEqual(configuredProviders({}), {
    operator: false,
    github: false,
    google: false,
    email: false,
  });

  assert.deepEqual(configuredProviders({ JOBBY_OPERATOR_SECRET: "s3cret" }), {
    operator: true,
    github: false,
    google: false,
    email: false,
  });

  // whitespace-only is not configured
  assert.equal(configuredProviders({ JOBBY_OPERATOR_SECRET: "   " }).operator, false);

  // an OAuth provider needs BOTH halves
  assert.equal(configuredProviders({ AUTH_GITHUB_ID: "id" }).github, false);
  assert.equal(configuredProviders({ AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "sec" }).github, true);
  assert.equal(configuredProviders({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "sec" }).google, true);
});

test("anyProviderConfigured drives the not-configured notice", () => {
  assert.equal(anyProviderConfigured({ operator: false, github: false, google: false }), false);
  assert.equal(anyProviderConfigured({ operator: false, github: true, google: false }), true);
});

test("signInErrorMessage turns Auth.js codes into prose", () => {
  assert.equal(signInErrorMessage(null), null);
  assert.equal(signInErrorMessage(""), null);
  assert.match(signInErrorMessage("CredentialsSignin"), /operator secret/i);
  // Refused sign-in must tell a real user what to do next, not name an env var.
  assert.match(signInErrorMessage("AccessDenied"), /full|suspended/i);
  assert.match(signInErrorMessage("Configuration"), /AUTH_SECRET/);
  // an unknown code must still produce something a user can read
  assert.match(signInErrorMessage("SomethingNew"), /try again/i);
});
