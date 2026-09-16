import { redirect } from "next/navigation";

import LoginForm from "@/components/LoginForm";
import ThemeToggle from "@/components/ThemeToggle";
import { currentUser } from "@/lib/auth/session";

/**
 * Only same-origin paths are accepted, so `?next=` cannot be used to bounce
 * someone to another site after signing in. `//evil.com` is a protocol-relative
 * URL, hence the second check.
 */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await currentUser();
  const { next } = await searchParams;
  const destination = safeNext(next);

  if (user) redirect(destination);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60rem 30rem at 50% -10%, var(--primary-soft), transparent 70%)",
        }}
      />
      <header className="flex justify-end p-4">
        <ThemeToggle />
      </header>
      <LoginForm next={destination} />
    </div>
  );
}
