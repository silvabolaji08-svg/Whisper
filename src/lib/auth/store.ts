import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { query } from "../database";
import { cleanText, MAX_USERNAME_LENGTH } from "../types";
import {
  authSecret,
  CODE_LENGTH,
  CODE_MAX_ATTEMPTS,
  CODE_REQUESTS_PER_WINDOW,
  CODE_REQUEST_WINDOW_MS,
  CODE_TTL_MS,
  nameFromEmail,
  SESSION_TTL_MS,
} from "./config";

export type User = {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  createdAt: Number(row.created_at),
});

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Login codes are peppered with AUTH_SECRET. A plain hash would be pointless:
 * six digits is only a million candidates, so an attacker with the database
 * could rainbow-table every code in seconds.
 */
function hashCode(email: string, code: string): string {
  return createHmac("sha256", authSecret())
    .update(`${email}:${code}`)
    .digest("hex");
}

/** Session tokens are already high-entropy, so a plain SHA-256 is enough. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare so a wrong code cannot be narrowed down by timing. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export function findUserByEmail(email: string): User | null {
  const row = query((handle) =>
    handle
      .prepare("SELECT id, email, display_name, created_at FROM users WHERE email = ?")
      .get(email),
  ) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserById(id: string): User | null {
  const row = query((handle) =>
    handle
      .prepare("SELECT id, email, display_name, created_at FROM users WHERE id = ?")
      .get(id),
  ) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/** Signup and login are the same flow, so the account is created on first proof. */
export function findOrCreateUser(email: string): User {
  const existing = findUserByEmail(email);
  if (existing) return existing;

  const user: User = {
    id: randomUUID(),
    email,
    displayName: nameFromEmail(email),
    createdAt: Date.now(),
  };
  query((handle) =>
    handle
      .prepare(
        "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(user.id, user.email, user.displayName, user.createdAt),
  );
  return user;
}

export function updateDisplayName(userId: string, name: string): User | null {
  const cleaned = cleanText(name, MAX_USERNAME_LENGTH);
  if (!cleaned) return null;
  query((handle) =>
    handle
      .prepare("UPDATE users SET display_name = ? WHERE id = ?")
      .run(cleaned, userId),
  );
  return findUserById(userId);
}

/* -------------------------------------------------------------------------- */
/* Login codes                                                                 */
/* -------------------------------------------------------------------------- */

export type IssuedCode = { code: string; expiresAt: number };

/** True when this address has asked for too many codes recently. */
export function isRequestingTooOften(email: string): boolean {
  const since = Date.now() - CODE_REQUEST_WINDOW_MS;
  const row = query((handle) =>
    handle
      .prepare(
        "SELECT COUNT(*) AS count FROM login_codes WHERE email = ? AND created_at > ?",
      )
      .get(email, since),
  ) as { count: number } | undefined;
  return Number(row?.count ?? 0) >= CODE_REQUESTS_PER_WINDOW;
}

/**
 * Issues a fresh code, invalidating any outstanding one for the address so a
 * previously emailed code stops working the moment a new one is requested.
 */
export function issueCode(email: string): IssuedCode {
  const now = Date.now();
  const expiresAt = now + CODE_TTL_MS;

  // randomInt is drawn from a CSPRNG, unlike Math.random.
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

  query((handle) => {
    handle
      .prepare(
        "UPDATE login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL",
      )
      .run(now, email);
    handle
      .prepare(
        `INSERT INTO login_codes (id, email, code_hash, attempts, created_at, expires_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(randomUUID(), email, hashCode(email, code), now, expiresAt);
  });

  return { code, expiresAt };
}

export type VerifyResult =
  | { ok: true; user: User }
  | { ok: false; reason: "no-code" | "expired" | "too-many-attempts" | "mismatch" };

/** Checks a submitted code and, on success, burns it and returns the account. */
export function verifyCode(email: string, code: string): VerifyResult {
  const now = Date.now();

  const row = query((handle) =>
    handle
      .prepare(
        `SELECT id, code_hash, attempts, expires_at FROM login_codes
         WHERE email = ? AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(email),
  ) as
    | { id: string; code_hash: string; attempts: number; expires_at: number }
    | undefined;

  if (!row) return { ok: false, reason: "no-code" };

  if (Number(row.expires_at) < now) {
    query((handle) =>
      handle
        .prepare("UPDATE login_codes SET consumed_at = ? WHERE id = ?")
        .run(now, row.id),
    );
    return { ok: false, reason: "expired" };
  }

  if (Number(row.attempts) >= CODE_MAX_ATTEMPTS) {
    query((handle) =>
      handle
        .prepare("UPDATE login_codes SET consumed_at = ? WHERE id = ?")
        .run(now, row.id),
    );
    return { ok: false, reason: "too-many-attempts" };
  }

  if (!equals(row.code_hash, hashCode(email, code))) {
    query((handle) =>
      handle
        .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?")
        .run(row.id),
    );
    return { ok: false, reason: "mismatch" };
  }

  // Correct: burn the code so it cannot be replayed.
  query((handle) =>
    handle
      .prepare("UPDATE login_codes SET consumed_at = ? WHERE id = ?")
      .run(now, row.id),
  );

  return { ok: true, user: findOrCreateUser(email) };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export type NewSession = { token: string; expiresAt: number };

/** Returns the raw token; only its hash is persisted. */
export function createSession(userId: string): NewSession {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  query((handle) =>
    handle
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(hashToken(token), userId, now, expiresAt),
  );

  return { token, expiresAt };
}

/** Resolves a cookie token to its account, or null when missing or expired. */
export function userForToken(token: string): User | null {
  if (!token) return null;

  const row = query((handle) =>
    handle
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.created_at, s.expires_at
         FROM sessions AS s
         JOIN users AS u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)),
  ) as (UserRow & { expires_at: number }) | undefined;

  if (!row) return null;

  if (Number(row.expires_at) < Date.now()) {
    destroySession(token);
    return null;
  }

  return toUser(row);
}

export function destroySession(token: string): void {
  if (!token) return;
  query((handle) =>
    handle.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token)),
  );
}

/** Housekeeping for expired sessions and spent codes. */
export function purgeExpired(): void {
  const now = Date.now();
  query((handle) => {
    handle.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    handle
      .prepare("DELETE FROM login_codes WHERE expires_at < ?")
      .run(now - CODE_TTL_MS);
  });
}
