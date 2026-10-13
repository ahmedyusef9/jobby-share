import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { createHash, timingSafeEqual } from "node:crypto";
import { defaultTenantId } from "@/lib/tenant";
import { isMultiTenant } from "@/lib/key-store";
import { ACCOUNT_STATUS, canSignIn, resolveAccount } from "@/lib/accounts";
import { emailAuthAvailable, verifyEmailPassword } from "@/lib/appwrite/auth";
import { hasSlot } from "@/lib/batches";

declare module "next-auth" {
  interface Session {
    tenantId: string;
    sv?: number;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    tenantId?: string;
    sv?: number;
  }
}

function secretsEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Single-tenant means every sign-in lands in the `default` tenant — correct for a
 * one-person local install, catastrophic on a shared host, where it merges five
 * people's CVs, trackers and reports into one directory.
 *
 * Reads through the key store's helper so tenancy cannot be on for identity and
 * off for API keys.
 */
function singleTenant(): boolean {
  return !isMultiTenant();
}

/**
 * Legacy allow-list, kept only as a fallback for OAuth.
 *
 * Email sign-up is OPEN and bounded by capacity, not by a list of addresses. OAuth
 * cannot take a capacity slot yet — Auth.js creates the account inside its own
 * callback, so there is no place to reserve one first — so GitHub/Google still
 * honour this variable when it is set.
 *
 * Once OAuth takes slots too, this goes away entirely (JOBBY-BL-045).
 */
function allowedEmails(): Set<string> | null {
  const raw = process.env.AUTH_ALLOWED_EMAILS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Tenant for a sign-in.
 *
 * The operator on a single-user install is always `default` — that is the local
 * career-ops case and it has no account record to keep.
 *
 * Everyone else goes through the account index, which is where signup actually
 * happens: the first sign-in creates the account, allocates a random tenant id and
 * provisions the directory. The id is deliberately NOT derived from the login, so
 * one person with two providers keeps one tenant and can change how they sign in
 * without their data moving. See deploy/design/account-lifecycle.md.
 */
async function tenantFor(
  provider: string,
  sub: string,
  email?: string | null,
): Promise<{ tenantId: string; sessionVersion?: number }> {
  if (singleTenant() || provider === "credentials" || provider === "operator") {
    return { tenantId: defaultTenantId() };
  }
  const account = await resolveAccount({
    provider,
    subject: sub,
    email: email ?? undefined,
    cohort: process.env.JOBBY_COHORT?.trim() || undefined,
  });
  return { tenantId: account.tenantId, sessionVersion: account.sessionVersion };
}

const providers = [];

const hasGitHub = Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
const hasGoogle = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
const hasEmail = emailAuthAvailable();

if (hasGitHub) providers.push(GitHub({}));
if (hasGoogle) providers.push(Google({}));

/**
 * Email + password, verified by Appwrite (JOBBY-BL-042).
 *
 * Appwrite owns the credential — hashing, rate limiting, reset — and Auth.js keeps
 * owning the browser session. This is the method that lets a tester join without
 * owning a GitHub account, which was the whole reason for adopting Appwrite.
 */
if (hasEmail) {
  providers.push(
    Credentials({
      id: "email",
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password) return null;
        const identity = await verifyEmailPassword(email, password);
        if (!identity) return null;
        return { id: identity.id, email: identity.email, name: identity.name ?? identity.email };
      },
    }),
  );
}

/**
 * Fail closed on the combination that silently merges accounts.
 *
 * Any public sign-up method means strangers can create accounts; single-tenant
 * means they all land in the same directory and see each other's CV and
 * applications. That is never intended, so refuse to boot rather than discover it
 * from a user.
 */
if ((hasGitHub || hasGoogle || hasEmail) && singleTenant()) {
  throw new Error(
    "AUTH_SINGLE_TENANT is on while a public sign-up method (GitHub/Google/email) is " +
      "configured: every account would share one tenant directory. Set AUTH_SINGLE_TENANT=0 " +
      "for a hosted instance, or remove those credentials for a single-user install.",
  );
}

providers.push(
  Credentials({
    id: "operator",
    name: "Local operator",
    credentials: {
      secret: { label: "Operator secret", type: "password" },
    },
    authorize(credentials) {
      const expected = process.env.JOBBY_OPERATOR_SECRET?.trim();
      const got = typeof credentials?.secret === "string" ? credentials.secret : "";
      if (!expected || !got || !secretsEqual(got, expected)) return null;
      return { id: "operator", name: "Operator", email: "operator@local" };
    },
  }),
);

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  pages: { signIn: "/signin" },
  providers,
  callbacks: {
    authorized({ auth: session, request }) {
      const path = request.nextUrl.pathname;
      if (path.startsWith("/signin") || path.startsWith("/api/auth")) return true;
      return !!session?.user;
    },
    async jwt({ token, account, user }) {
      if (account) {
        const sub = account.providerAccountId || token.sub || user?.id || "unknown";
        const resolved = await tenantFor(account.provider, String(sub), user?.email ?? token.email);
        token.tenantId = resolved.tenantId;
        if (resolved.sessionVersion != null) token.sv = resolved.sessionVersion;
      } else if (user && !token.tenantId) {
        const resolved = await tenantFor("credentials", String(user.id || "operator"));
        token.tenantId = resolved.tenantId;
        if (resolved.sessionVersion != null) token.sv = resolved.sessionVersion;
      }
      return token;
    },
    session({ session, token }) {
      session.tenantId = (token.tenantId as string | undefined) || defaultTenantId();
      if (token.sv != null) session.sv = token.sv;
      return session;
    },
    /**
     * The gate. Runs before a session exists, so a refusal here actually blocks
     * sign-in rather than merely hiding a page.
     *
     * Order matters: check the invite list first, so a stranger is turned away
     * before any account row or tenant directory is created for them.
     */
    async signIn({ user, account }) {
      const provider = account?.provider ?? "";
      if (provider === "operator" || provider === "credentials") return true;

      const email = user.email?.toLowerCase() || "";

      if (provider === "email") {
        /*
         * An Appwrite identity existing is not proof it completed signup. A crashed
         * request or a released slot can leave a user with valid credentials and no
         * capacity slot; without this check they would sign in and get a tenant
         * provisioned, putting the round over its limit. The slot is the account's
         * licence to exist, so it is verified here too.
         */
        const seated = await hasSlot(String(user.id ?? ""));
        if (!seated) return false;
      } else {
        // OAuth takes no capacity slot yet — Auth.js creates the account inside this
        // callback with nowhere to reserve one first — so it still uses the legacy
        // env list. Two doors until BL-045 removes this branch.
        const emails = allowedEmails();
        if (emails && !emails.has(email)) return false;
      }

      if (singleTenant()) return true;

      // A suspended or deleting account must not be able to sign back in and
      // silently re-provision itself.
      const sub = account?.providerAccountId || user.id || "unknown";
      const existing = await resolveAccount({
        provider,
        subject: String(sub),
        email: email || undefined,
      });
      if (existing.status !== ACCOUNT_STATUS.ACTIVE) return false;
      return await canSignIn(existing.accountId);
    },
  },
});
