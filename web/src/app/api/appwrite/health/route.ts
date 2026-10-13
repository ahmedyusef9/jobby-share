import { withTenant } from "@/lib/tenant/http";
import { pingAppwrite } from "@/lib/appwrite/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Setup check for the Appwrite backend — the server-side stand-in for the
 * console quickstart's `client.ping()`.
 *
 * Behind withTenant so an unauthenticated visitor cannot use it to discover
 * whether a private Appwrite instance exists or where it lives.
 */
async function handleGET() {
  const result = await pingAppwrite();
  return Response.json(result, { status: result.ok ? 200 : 503 });
}

export const GET = withTenant(handleGET);
