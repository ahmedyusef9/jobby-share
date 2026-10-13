import "server-only";
import { Client, Databases, Users } from "node-appwrite";

/**
 * Appwrite client — server side only (JOBBY-BL-041).
 *
 * Why not the browser SDK the console suggests
 * --------------------------------------------
 * Appwrite's quickstart installs `appwrite` and builds a client the browser talks
 * to directly. That is wrong here for two independent reasons:
 *
 *  1. This deployment's Appwrite lives on a Tailscale hostname. A tester's browser
 *     on the public internet cannot resolve or reach it, so client-side calls would
 *     fail for every real user while working perfectly on the developer's machine.
 *  2. The collections carry no client permissions on purpose. Every read and write
 *     goes through this server after the tenant has been resolved from a verified
 *     session, so a browser holding a session can never enumerate other accounts.
 *
 * The consequence worth keeping: Appwrite stays entirely private, and jobby remains
 * the single trust boundary.
 */

export const DB_ID = "jobby";
export const COL_TENANTS = "tenants";
export const COL_IDENTITIES = "identities";
export const COL_KEYS = "provider_keys";
export const COL_USAGE = "usage_events";

function endpoint(): string {
  const v = process.env.APPWRITE_ENDPOINT?.trim();
  if (!v) throw new Error("APPWRITE_ENDPOINT is not set");
  return v.replace(/\/$/, "");
}

function projectId(): string {
  const v = process.env.APPWRITE_PROJECT_ID?.trim();
  if (!v) throw new Error("APPWRITE_PROJECT_ID is not set");
  return v;
}

function apiKey(): string {
  const v = process.env.APPWRITE_API_KEY?.trim();
  if (!v) throw new Error("APPWRITE_API_KEY is not set");
  return v;
}

/** True when Appwrite is configured. Lets callers degrade instead of throwing at import time. */
export function appwriteEnabled(): boolean {
  return Boolean(
    process.env.APPWRITE_ENDPOINT?.trim() &&
      process.env.APPWRITE_PROJECT_ID?.trim() &&
      process.env.APPWRITE_API_KEY?.trim(),
  );
}

let cached: Client | null = null;

/** Admin client, authenticated with the API key. Never hand this to a browser. */
export function adminClient(): Client {
  if (cached) return cached;
  cached = new Client().setEndpoint(endpoint()).setProject(projectId()).setKey(apiKey());
  return cached;
}

export function db(): Databases {
  return new Databases(adminClient());
}

export function users(): Users {
  return new Users(adminClient());
}

/**
 * Health check — the server-side equivalent of the console's `client.ping()`.
 *
 * Returns rather than throws: a dead Appwrite should surface as a clear status on
 * the doctor endpoint, not as a crashed page render.
 */
export async function pingAppwrite(): Promise<{ ok: boolean; detail: string }> {
  if (!appwriteEnabled()) {
    return { ok: false, detail: "Appwrite is not configured (APPWRITE_* env vars missing)" };
  }
  try {
    // Reading our own database, not /health — an API key has no `public` scope, so
    // the health endpoint 401s on a perfectly working instance. This probe proves
    // endpoint, project, key AND that the schema is provisioned, in one call.
    const res = await fetch(`${endpoint()}/databases/${DB_ID}`, {
      headers: {
        "X-Appwrite-Project": projectId(),
        "X-Appwrite-Key": apiKey(),
      },
      cache: "no-store",
    });
    if (res.status === 404) {
      return { ok: false, detail: "Connected, but the `jobby` database is missing — run scripts/appwrite-schema.mjs" };
    }
    if (!res.ok) {
      return { ok: false, detail: `Appwrite returned ${res.status}` };
    }
    return { ok: true, detail: "Appwrite reachable, jobby database present" };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? `Appwrite unreachable: ${err.message}` : "Appwrite unreachable",
    };
  }
}
