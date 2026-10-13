import { MIN_PASSWORD_LENGTH, emailAuthAvailable, registerEmailUser } from "@/lib/appwrite/auth";
import { getConfig } from "@/lib/app-config";
import { attachSlot, checkSignup, claimSlot, releaseSlot } from "@/lib/batches";
import { isMultiTenant } from "@/lib/key-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create an account with an email and a password.
 *
 * Deliberately NOT wrapped in withTenant: the caller has no session yet — that is
 * the point. Registration only; the client signs in afterwards through Auth.js, so
 * this route never issues a session itself.
 *
 * Lives at /api/signup rather than /api/auth/signup to stay clear of the Auth.js
 * catch-all route.
 */

export async function POST(req: Request) {
  if (!emailAuthAvailable()) {
    return Response.json({ error: "Email sign-up is not enabled here." }, { status: 404 });
  }
  if (!isMultiTenant()) {
    // Registering on a single-tenant instance would drop the new account into the
    // shared `default` directory alongside someone else's CV.
    return Response.json({ error: "Sign-up is not open on this instance." }, { status: 403 });
  }

  /*
   * Live config gate. Reading it here is what makes the version in Appwrite mean
   * something: flipping `signupOpen` to false closes registration on every running
   * instance within one TTL, with no deploy and no restart.
   */
  const config = (await getConfig()) as { signupOpen?: boolean };
  if (config.signupOpen === false) {
    return Response.json({ error: "Sign-ups are paused right now." }, { status: 403 });
  }

  let body: { email?: unknown; password?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!email || !email.includes("@")) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 },
    );
  }

  /*
   * Capacity check. Registration is OPEN — this asks whether the round is
   * accepting people and whether there is room, never who the applicant is. There
   * is no invite, no code and no allow-list to be on.
   */
  const decision = (await checkSignup({ email })) as {
    allowed: boolean;
    reason?: string;
    plan?: string;
    batchId?: string;
    capacity?: number;
  };
  if (!decision.allowed) {
    // 403 for "full / closed / not open yet"; the message already says which.
    return Response.json({ error: decision.reason ?? "Sign-ups are not open." }, { status: 403 });
  }

  /*
   * Take the capacity slot BEFORE creating the identity.
   *
   * The other order leaves an orphan: if the claim loses a race after the Appwrite
   * user exists, that user can still sign in and provision a tenant beyond
   * capacity. Claiming first means a lost race costs nothing, and a failed
   * registration is undone by releasing a slot no account is attached to.
   */
  const batchId = decision.batchId ?? "";
  const capacity = Number(decision.capacity ?? 0);
  const claim = (await claimSlot(batchId, capacity, `pending:${email}`)) as {
    ok: boolean;
    slotId?: string;
    error?: string;
  };
  if (!claim.ok || !claim.slotId) {
    // 403, the same as the pre-check: losing the race means the round filled up,
    // which is not a different situation from finding it full a second earlier.
    // It also keeps 409 meaning exactly one thing — "you already have an account".
    return Response.json({ error: claim.error ?? "Jobby is currently full." }, { status: 403 });
  }
  const slotId = claim.slotId;

  const result = await registerEmailUser(email, password, name || undefined);
  if (!result.ok) {
    await releaseSlot(slotId);
    // 409 for "already exists" so the client can offer to sign in instead.
    const status = /already exists/i.test(result.error) ? 409 : 400;
    return Response.json({ error: result.error }, { status });
  }

  // Re-point the claim at the real account id now that it exists.
  await attachSlot(slotId, result.identity.id);

  // No session is issued here. The tenant is provisioned on first sign-in, by the
  // same path OAuth uses, so there is one place where accounts come into being.
  return Response.json({
    ok: true,
    email: result.identity.email,
    batchId: decision.batchId ?? null,
    plan: decision.plan ?? null,
  });
}
