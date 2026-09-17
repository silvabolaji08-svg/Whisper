import { cookies } from "next/headers";

import { SESSION_COOKIE, SESSION_TTL_MS } from "./config";
import { createSession, destroySession, userForToken, type User } from "./store";

/**
 * Session helpers for Server Components and Route Handlers.
 *
 * `cookies()` is async in this version of Next, and it can only be *written*
 * from a Route Handler or Server Function — reading works anywhere on the
 * server.
 */

export async function currentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? userForToken(token) : null;
}

/** Issues a session and attaches the cookie. Route Handlers only. */
export async function startSession(userId: string): Promise<void> {
  const { token } = await createSession(userId);
  const store = await cookies();

  store.set(SESSION_COOKIE, token, {
    httpOnly: true, // Keeps the token out of reach of any script on the page.
    sameSite: "lax", // Survives top-level navigation, blocks cross-site POSTs.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Clears the cookie and deletes the row behind it. Route Handlers only. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(token);
  store.delete(SESSION_COOKIE);
}
