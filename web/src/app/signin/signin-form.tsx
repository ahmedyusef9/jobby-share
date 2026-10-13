"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { signInErrorMessage, type ConfiguredProviders } from "@/lib/auth";

type Pending = "operator" | "github" | "google" | "email" | null;
type Mode = "signin" | "signup";

const labelClass = "block text-xs font-semibold uppercase tracking-[0.18em] text-muted";
const inputClass =
  "mt-1.5 min-h-[44px] w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/30 disabled:opacity-60";

const tabClass = (active: boolean) =>
  `flex-1 rounded-full px-3 py-1.5 font-medium transition ${
    active ? "bg-brand text-brand-foreground" : "text-muted hover:text-foreground"
  }`;

export function SignInForm({
  callbackUrl,
  providers,
  initialError,
  publicSignup = false,
  staleSession = false,
}: {
  callbackUrl: string;
  providers: ConfiguredProviders;
  initialError: string | null;
  /** Shared instance: OAuth is how users get an account, so it leads. */
  publicSignup?: boolean;
  /** JWT present but sessionVersion/status no longer match — drop the cookie. */
  staleSession?: boolean;
}) {
  const router = useRouter();
  const secretId = useId();
  const errorId = useId();
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(signInErrorMessage(initialError));
  // On a public instance the operator secret is an admin door, not the front door.
  const [showOperator, setShowOperator] = useState(!publicSignup);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();

  useEffect(() => {
    if (!staleSession) return;
    void signOut({ callbackUrl: "/signin" });
  }, [staleSession]);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  /**
   * Create-account and sign-in share one submit.
   *
   * Registration does not issue a session, so signing up is register-then-sign-in.
   * Doing both here means the user types their password once and lands signed in,
   * rather than succeeding at signup and then facing a login form.
   */
  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email || !password) return;
    setPending("email");
    setError(null);

    try {
      if (mode === "signup") {
        const res = await fetch("/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          // An existing account is a wrong-tab mistake, not a failure — offer the fix.
          if (res.status === 409) {
            setMode("signin");
            setError("You already have an account. Signing in instead — check your password.");
          } else {
            setError(body.error || "Could not create that account.");
          }
          setPending(null);
          return;
        }
      }

      const res = await signIn("email", { email, password, redirect: false });
      if (res?.error) {
        setError(
          mode === "signup"
            ? "Account created, but sign-in failed. Try signing in."
            : signInErrorMessage(res.error) ?? "That email and password do not match.",
        );
        setPassword("");
        setPending(null);
        return;
      }
      router.replace(callbackUrl);
      router.refresh();
    } catch {
      setError("Could not reach the sign-in service. Check that the app is running.");
      setPending(null);
    }
  }

  const busy = pending !== null;

  async function submitOperator(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !secret) return;
    setPending("operator");
    setError(null);
    try {
      // redirect:false keeps the failure on this page — a full reload back to
      // /signin?error=… loses the typed secret and reads like a crash.
      const res = await signIn("operator", { secret, redirect: false });
      if (res?.error) {
        setError(signInErrorMessage(res.error) ?? "Sign-in failed. Please try again.");
        setSecret("");
        setPending(null);
        return;
      }
      // Session cookie is set; refresh so the server layout re-renders signed in.
      router.replace(callbackUrl);
      router.refresh();
    } catch {
      setError("Could not reach the sign-in service. Check that the app is running.");
      setPending(null);
    }
  }

  function oauth(provider: "github" | "google") {
    setPending(provider);
    setError(null);
    // OAuth must leave the page, so redirect stays on.
    void signIn(provider, { callbackUrl });
  }

  const oauthAvailable = providers.github || providers.google;

  return (
    <div className="mt-8">
      {error && (
        <p
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      {/* Email + password: the method that needs no GitHub account. */}
      {providers.email && publicSignup && (
        <form onSubmit={submitEmail} noValidate className="space-y-3">
          <div className="mb-5 flex rounded-full border border-border p-1 text-xs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signin"}
              onClick={() => switchMode("signin")}
              className={tabClass(mode === "signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signup"}
              onClick={() => switchMode("signup")}
              className={tabClass(mode === "signup")}
            >
              Create account
            </button>
          </div>

          {mode === "signup" && (
            <div>
              <label htmlFor={nameId} className={labelClass}>
                Name <span className="normal-case tracking-normal text-faint">(optional)</span>
              </label>
              <input
                id={nameId}
                type="text"
                autoComplete="name"
                disabled={busy}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
              />
            </div>
          )}

          <div>
            <label htmlFor={emailId} className={labelClass}>
              Email
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              autoFocus
              disabled={busy}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor={passwordId} className={labelClass}>
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
            {mode === "signup" && (
              <p className="mt-1.5 text-xs text-faint">At least 8 characters.</p>
            )}
          </div>

          <button
            type="submit"
            disabled={busy || !email || !password}
            aria-busy={pending === "email"}
            className="mt-2 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "email" && <Loader2 size={16} className="animate-spin" aria-hidden />}
            {pending === "email"
              ? mode === "signup"
                ? "Creating account…"
                : "Signing in…"
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </button>

          {mode === "signup" && (
            <p className="pt-1 text-xs leading-relaxed text-faint">
              Jobby is in alpha and open to a limited number of people at a time. No
              invite needed — if there is room, your account is created right away.
            </p>
          )}
        </form>
      )}

      {providers.email && publicSignup && oauthAvailable && (
        <div className="my-7 flex items-center gap-4" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          <span className="text-[11px] uppercase tracking-[0.18em] text-faint">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {/* Public instance: the account-creating buttons come first. */}
      {publicSignup && oauthAvailable && (
        <div className="space-y-3">
          {providers.github && (
            <ProviderButton
              label="Continue with GitHub"
              pending={pending === "github"}
              disabled={busy}
              onClick={() => oauth("github")}
              primary
            />
          )}
          {providers.google && (
            <ProviderButton
              label="Continue with Google"
              pending={pending === "google"}
              disabled={busy}
              onClick={() => oauth("google")}
              primary
            />
          )}
          <p className="pt-1 text-xs leading-relaxed text-faint">
            First time here? This creates your account.
          </p>
        </div>
      )}

      {publicSignup && providers.operator && !showOperator && (
        <button
          type="button"
          onClick={() => setShowOperator(true)}
          className="mt-8 w-full text-center text-xs text-faint underline-offset-4 transition hover:text-muted hover:underline"
        >
          Operator sign-in
        </button>
      )}

      {providers.operator && showOperator && (
        <form onSubmit={submitOperator} noValidate className={publicSignup ? "mt-8 border-t border-border pt-6" : undefined}>
          <label
            htmlFor={secretId}
            className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted"
          >
            Operator secret
          </label>
          <div className="relative mt-2">
            <input
              id={secretId}
              name="secret"
              type={reveal ? "text" : "password"}
              autoComplete="current-password"
              autoFocus
              required
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="min-h-[44px] w-full rounded-xl border border-border bg-surface px-3 py-2 pr-11 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              disabled={busy}
              aria-label={reveal ? "Hide secret" : "Show secret"}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted transition hover:text-foreground disabled:opacity-60"
            >
              {reveal ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
            </button>
          </div>

          <button
            type="submit"
            disabled={busy || !secret}
            aria-busy={pending === "operator"}
            className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "operator" && <Loader2 size={16} className="animate-spin" aria-hidden />}
            {pending === "operator" ? "Signing in…" : "Continue as operator"}
          </button>
        </form>
      )}

      {!publicSignup && providers.operator && oauthAvailable && (
        <div className="my-7 flex items-center gap-4" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          <span className="text-[11px] uppercase tracking-[0.18em] text-faint">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {!publicSignup && oauthAvailable && (
        <div className="space-y-3">
          {providers.github && (
            <ProviderButton
              label="Continue with GitHub"
              pending={pending === "github"}
              disabled={busy}
              onClick={() => oauth("github")}
            />
          )}
          {providers.google && (
            <ProviderButton
              label="Continue with Google"
              pending={pending === "google"}
              disabled={busy}
              onClick={() => oauth("google")}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ProviderButton({
  label,
  pending,
  disabled,
  onClick,
  primary = false,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  /** Leading call-to-action on a public instance, where this button creates the account. */
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={pending}
      className={
        primary
          ? "inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50"
          : "inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border border-border bg-surface px-5 py-2 text-sm font-medium transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
      }
    >
      {pending && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {pending ? "Redirecting…" : label}
    </button>
  );
}
