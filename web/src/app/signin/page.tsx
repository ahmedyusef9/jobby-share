import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { BrandMark } from "@/components/brand-mark";
import { accountForTenantStrict, sessionStillValid } from "@/lib/accounts";
import { anyProviderConfigured, anySignupProvider, configuredProviders, safeCallbackUrl } from "@/lib/auth";
import { isMultiTenant } from "@/lib/key-store";
import { SignInForm } from "./signin-form";

export const metadata: Metadata = {
  title: "Sign in — jobby",
  description: "Sign in to your jobby workspace.",
  robots: { index: false, follow: false },
};

// The provider list depends on run-time environment (compose / Railway vars),
// so this page must never be statically rendered.
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

const POINTS = [
  "Your CV, tracker and reports stay in your own workspace — no one else can see them, including us.",
  "Scoring runs on your own AI key, so nothing is billed to anyone but you.",
  "Nothing is ever submitted to an employer on your behalf. You review every application.",
];

export default async function SignInPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(one(params, "callbackUrl"));

  // Already signed in — skip the form. A cookie can still be present after
  // suspend/reactivate (sessionVersion bump); bouncing that JWT back to the
  // app loops / ↔ /signin (ERR_TOO_MANY_REDIRECTS). Only skip when the JWT
  // is still accepted.
  const session = await auth();
  let staleSession = false;
  if (session?.user) {
    if (session.tenantId) {
      const account = await accountForTenantStrict(session.tenantId);
      if (await sessionStillValid(session.tenantId, session.sv, account)) {
        redirect(callbackUrl);
      }
      staleSession = true;
    } else {
      redirect(callbackUrl);
    }
  }

  const providers = configuredProviders();
  // On a shared instance, OAuth is how real users get an account, so it leads and
  // the operator secret becomes a collapsed admin affordance. On a single-user
  // install the operator secret IS the way in, so it stays front and centre.
  const publicSignup = isMultiTenant() && anySignupProvider(providers);

  return (
    <main className="min-h-dvh bg-bg text-foreground">
      <div className="grid min-h-dvh w-full grid-cols-1 lg:grid-cols-2">
        {/* Brand panel — hidden on small screens, where the form is the whole page. */}
        <section className="relative hidden flex-col overflow-hidden border-r border-border bg-surface px-12 py-12 lg:flex">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-brand-soft blur-3xl"
          />
          <div className="relative flex flex-1 flex-col justify-center">
            <BrandMark size={88} />
            <h2 className="mt-10 max-w-sm font-display text-[2.5rem] leading-[1.15] text-landing">
              Your job search, run like a pipeline.
            </h2>
            <ul className="mt-8 max-w-sm space-y-3.5">
              {POINTS.map((point) => (
                <li key={point} className="flex gap-3 text-sm leading-relaxed text-muted">
                  <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="relative text-xs text-faint">© 2026 Jobby · local-first</p>
        </section>

        {/* Form panel */}
        <section className="flex flex-col justify-center px-6 py-12 sm:px-10">
          <div className="mx-auto w-full max-w-[22rem]">
            <div className="lg:hidden">
              <BrandMark size={56} />
            </div>

            <h1 className="mt-6 font-display text-3xl text-landing lg:mt-0">
              {publicSignup ? "Sign in or create your account" : "Sign in"}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {publicSignup
                ? "New here? Open Create account — alpha is open until this round is full."
                : "This workspace is private."}
            </p>

            <SignInForm
              publicSignup={publicSignup}
              callbackUrl={callbackUrl}
              providers={providers}
              initialError={one(params, "error") ?? null}
              staleSession={staleSession}
            />

            {!anyProviderConfigured(providers) && (
              <p className="mt-8 rounded-xl border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
                No sign-in method is configured on this deployment. Set{" "}
                <code className="font-mono text-brand-text">JOBBY_OPERATOR_SECRET</code> (and{" "}
                <code className="font-mono text-brand-text">AUTH_SECRET</code>) in{" "}
                <code className="font-mono text-brand-text">deploy/.env</code>, then restart.
              </p>
            )}

            <p className="mt-10 text-xs text-faint lg:hidden">© 2026 Jobby · local-first</p>
          </div>
        </section>
      </div>
    </main>
  );
}
