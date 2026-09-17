/** Shared auth tunables and the server-side secret used to hash codes. */

export const SESSION_COOKIE = "chat_session";

/** How long a signed-in session lasts before a fresh code is required. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** A login code is short-lived on purpose. */
export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const CODE_LENGTH = 6;
/** Wrong guesses allowed before the code is burned. */
export const CODE_MAX_ATTEMPTS = 5;
/**
 * Codes a single address may request per window, to stop mailbox flooding.
 *
 * Generous enough to survive a mistyped address, a code lost to spam and a few
 * retries in a row, which five was not: a normal person testing the flow hit
 * the wall before signing in once.
 */
export const CODE_REQUESTS_PER_WINDOW = 10;
export const CODE_REQUEST_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical maximum

const DEV_SECRET = "dev-only-insecure-secret";

/**
 * Pepper for hashing login codes. A real value is mandatory in production —
 * falling back silently there would make leaked code hashes trivially
 * reversible, since the input space is only a million six-digit codes.
 */
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length >= 16) return secret;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET must be set to at least 16 characters in production.",
    );
  }
  return DEV_SECRET;
}

/** Basic shape check; real validity is proven by receiving the code. */
export function isEmailShaped(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_EMAIL_LENGTH &&
    /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value)
  );
}

/** Addresses are matched case-insensitively so Ada@x.com === ada@x.com. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Default display name for a new account, derived from the address. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 24) : "user";
}
