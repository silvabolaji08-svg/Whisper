"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { AlertIcon, ArrowLeftIcon } from "@/components/icons";
import Wordmark from "@/components/Wordmark";
import Logo from "@/components/Logo";

const CODE_LENGTH = 6;
/** Wait before "Resend code" becomes available, matching the server's patience. */
const RESEND_COOLDOWN_S = 30;

type Step = "email" | "code";

export default function LoginForm({ next }: { next: string }) {
  const router = useRouter();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function requestCode(address: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Could not send the code.");
        return false;
      }

      setStep("code");
      setCooldown(RESEND_COOLDOWN_S);
      setNotice(
        data.devCodeInConsole
          ? "The code was printed to the server console, not emailed."
          : `We sent a ${CODE_LENGTH}-digit code to ${address}.`,
      );
      return true;
    } catch {
      setError("Network problem. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleEmailSubmit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) {
      setError("Enter your email address.");
      return;
    }
    await requestCode(address);
  }

  async function handleCodeSubmit(event: FormEvent) {
    event.preventDefault();
    if (code.length !== CODE_LENGTH) {
      setError(`Enter all ${CODE_LENGTH} digits.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "That code did not work.");
        setCode("");
        codeRef.current?.focus();
        return;
      }

      // Full navigation so server components re-read the new session cookie.
      router.replace(next);
      router.refresh();
    } catch {
      setError("Network problem. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={64} className="mb-5 shadow-(--shadow-md) rounded-[18px]" />
          <p className="mb-2 text-5xl">
            <Wordmark />
          </p>
          <h1 className="font-display text-xl font-semibold">
            {step === "email" ? "Sign in" : "Check your email"}
          </h1>
          <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-fg-muted">
            {step === "email"
              ? "Enter your email and we'll send you a one-time code. No password needed."
              : notice}
          </p>
        </div>

        <div className="rounded-2xl border border-border-default bg-surface p-6 shadow-(--shadow-lg) sm:p-7">
          {step === "email" ? (
            <form onSubmit={handleEmailSubmit} className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="email" className="block text-sm font-medium">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoFocus
                  required
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-border-default bg-bg-elevated px-3.5 py-3 text-sm outline-none transition-colors duration-150 placeholder:text-fg-subtle hover:border-border-strong focus:border-primary focus:ring-4 focus:ring-primary/15"
                />
              </div>

              {error ? <ErrorNote>{error}</ErrorNote> : null}

              <SubmitButton busy={busy}>
                {busy ? "Sending code…" : "Send me a code"}
              </SubmitButton>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="code" className="block text-sm font-medium">
                  {CODE_LENGTH}-digit code
                </label>
                <input
                  id="code"
                  ref={codeRef}
                  // one-time-code lets iOS/Android offer the code from the
                  // notification, and keeps paste working (separate boxes break both).
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={CODE_LENGTH}
                  value={code}
                  onChange={(event) => {
                    const digits = event.target.value
                      .replace(/\D/g, "")
                      .slice(0, CODE_LENGTH);
                    setCode(digits);
                    setError(null);
                  }}
                  placeholder="······"
                  className="w-full rounded-xl border border-border-default bg-bg-elevated px-3.5 py-3 text-center font-mono text-2xl tracking-[0.5em] outline-none transition-colors duration-150 placeholder:text-fg-subtle focus:border-primary focus:ring-4 focus:ring-primary/15"
                />
              </div>

              {error ? <ErrorNote>{error}</ErrorNote> : null}

              <SubmitButton busy={busy}>
                {busy ? "Verifying…" : "Verify and sign in"}
              </SubmitButton>

              <div className="flex items-center justify-between gap-3 pt-1 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                  }}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-fg-muted transition-colors duration-150 hover:text-fg"
                >
                  <ArrowLeftIcon size={14} />
                  Use a different email
                </button>

                <button
                  type="button"
                  disabled={cooldown > 0 || busy}
                  onClick={() => requestCode(email.trim())}
                  className="cursor-pointer font-medium text-primary transition-opacity duration-150 hover:opacity-80 disabled:cursor-not-allowed disabled:text-fg-subtle"
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-fg-subtle">
          Signing in creates your account automatically if you don&apos;t have one.
        </p>
      </div>
    </main>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
    >
      <AlertIcon size={18} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function SubmitButton({
  busy,
  children,
}: {
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold surface-brand shadow-(--shadow-md) transition-[filter,transform,opacity] duration-150 hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}
