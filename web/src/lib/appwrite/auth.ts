import "server-only";
import { Account, Client, ID, Users } from "node-appwrite";
import { adminClient, appwriteEnabled } from "@/lib/appwrite/server";

/**
 * Email/password identity backed by Appwrite (JOBBY-BL-042).
 *
 * Why Appwrite rather than building this
 * --------------------------------------
 * Email sign-up done properly is verification tokens with expiry, password reset,
 * rate limiting and enumeration resistance. Appwrite already has all of it, and it
 * removes the requirement that every alpha tester own a GitHub account.
 *
 * Why it plugs into Auth.js instead of replacing it
 * -------------------------------------------------
 * Auth.js already binds tenantId to the session, and withTenant()/the proxy/the
 * account index all read that. Swapping the whole session layer to verify a
 * password would rewrite working, tested plumbing. Appwrite verifies credentials;
 * Auth.js keeps owning the session. Small change, same outcome.
 *
 * Nothing here runs in a browser: Appwrite lives on a private Tailscale host that
 * a tester's browser cannot reach.
 */

/** Appwrite's own floor. Rejecting shorter here gives a clear message instead of a 400. */
export const MIN_PASSWORD_LENGTH = 8;

export type AppwriteIdentity = {
  /** Appwrite user $id — stable, and what the tenant mapping keys on. */
  id: string;
  email: string;
  name: string | null;
};

/**
 * A client with no API key. Sessions must be created as the *user*, not as an
 * admin, or Appwrite issues a key-scoped call rather than a real session.
 */
function sessionClient(): Client {
  const endpoint = process.env.APPWRITE_ENDPOINT?.trim().replace(/\/$/, "");
  const project = process.env.APPWRITE_PROJECT_ID?.trim();
  if (!endpoint || !project) throw new Error("Appwrite is not configured");
  return new Client().setEndpoint(endpoint).setProject(project);
}

export function emailAuthAvailable(): boolean {
  return appwriteEnabled();
}

/** Narrow an Appwrite SDK error to a message safe to show a user. */
function readableError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : "";
  if (/already exists/i.test(message)) return "An account with that email already exists.";
  if (/Invalid credentials/i.test(message)) return "That email and password do not match.";
  if (/password/i.test(message) && /length|short/i.test(message)) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (/Rate limit/i.test(message)) return "Too many attempts. Wait a minute and try again.";
  return fallback;
}

/**
 * Create the Appwrite user. Registration only — it does not sign anyone in, so the
 * caller decides whether an invite gate passed before a session is issued.
 */
export async function registerEmailUser(
  email: string,
  password: string,
  name?: string,
): Promise<{ ok: true; identity: AppwriteIdentity } | { ok: false; error: string }> {
  if (!emailAuthAvailable()) return { ok: false, error: "Email sign-up is not configured." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  try {
    const users = new Users(adminClient());
    const user = await users.create(ID.unique(), email, undefined, password, name || undefined);
    return {
      ok: true,
      identity: { id: user.$id, email: user.email, name: user.name || null },
    };
  } catch (err) {
    return { ok: false, error: readableError(err, "Could not create that account.") };
  }
}

/**
 * Verify an email and password against Appwrite.
 *
 * The Appwrite session is deleted immediately: Auth.js owns the browser session,
 * and leaving a second live session behind would mean a sign-out that only ends
 * one of them.
 */
export async function verifyEmailPassword(
  email: string,
  password: string,
): Promise<AppwriteIdentity | null> {
  if (!emailAuthAvailable()) return null;
  try {
    const account = new Account(sessionClient());
    const session = await account.createEmailPasswordSession(email, password);

    const users = new Users(adminClient());
    const user = await users.get(session.userId);

    try {
      await users.deleteSession(session.userId, session.$id);
    } catch {
      // A stranded Appwrite session is untidy, not unsafe — never fail a valid
      // sign-in because cleanup did not land.
    }

    return { id: user.$id, email: user.email, name: user.name || null };
  } catch {
    return null;
  }
}

/** Appwrite's own password-reset email. Never reveals whether the address exists. */
export async function requestPasswordReset(email: string, resetUrl: string): Promise<void> {
  if (!emailAuthAvailable()) return;
  try {
    const account = new Account(sessionClient());
    await account.createRecovery(email, resetUrl);
  } catch {
    /* silence is the point — a different response for unknown emails leaks the user list */
  }
}
