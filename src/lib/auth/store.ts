import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { query, queryOne, toNumber, type Row } from "../database";
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

type UserRow = Row & {
  id: string;
  email: string;
  display_name: string;
  created_at: string | number;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  createdAt: toNumber(row.created_at),
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

export async function findUserByEmail(email: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    "SELECT id, email, display_name, created_at FROM users WHERE email = $1",
    [email],
  );
  return row ? toUser(row) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    "SELECT id, email, display_name, created_at FROM users WHERE id = $1",
    [id],
  );
  return row ? toUser(row) : null;
}

/**
 * Signup and login are the same flow, so the account is created on first proof.
 *
 * ON CONFLICT covers two codes for a new address being verified at once: the
 * insert does nothing and the existing row is returned.
 */
export async function findOrCreateUser(email: string): Promise<User> {
  const existing = await findUserByEmail(email);
  if (existing) return existing;

  await query(
    `INSERT INTO users (id, email, display_name, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    [randomUUID(), email, nameFromEmail(email), Date.now()],
  );

  const created = await findUserByEmail(email);
  if (!created) throw new Error(`failed to create an account for ${email}`);
  return created;
}

export async function updateDisplayName(
  userId: string,
  name: string,
): Promise<User | null> {
  const cleaned = cleanText(name, MAX_USERNAME_LENGTH);
  if (!cleaned) return null;
  await query("UPDATE users SET display_name = $1 WHERE id = $2", [
    cleaned,
    userId,
  ]);
  return findUserById(userId);
}

/* -------------------------------------------------------------------------- */
/* Login codes                                                                 */
/* -------------------------------------------------------------------------- */

export type IssuedCode = { code: string; expiresAt: number };

/**
 * Whether this address has asked for too many codes recently, and when the
 * next slot frees up.
 *
 * The window rolls, so a slot opens once the oldest request in it ages out —
 * which is what the caller tells the user, rather than "try again later".
 */
export async function requestAllowance(
  email: string,
): Promise<{ limited: boolean; retryAfterMs: number }> {
  const since = Date.now() - CODE_REQUEST_WINDOW_MS;
  const row = await queryOne<
    Row & { count: string | number; oldest: string | number | null }
  >(
    `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
     FROM login_codes WHERE email = $1 AND created_at > $2`,
    [email, since],
  );

  const used = toNumber(row?.count ?? 0);
  if (used < CODE_REQUESTS_PER_WINDOW) return { limited: false, retryAfterMs: 0 };

  const oldest = row?.oldest == null ? Date.now() : toNumber(row.oldest);
  return {
    limited: true,
    retryAfterMs: Math.max(0, oldest + CODE_REQUEST_WINDOW_MS - Date.now()),
  };
}

/**
 * Issues a fresh code, invalidating any outstanding one for the address so a
 * previously emailed code stops working the moment a new one is requested.
 */
export async function issueCode(email: string): Promise<IssuedCode> {
  const now = Date.now();
  const expiresAt = now + CODE_TTL_MS;

  // randomInt is drawn from a CSPRNG, unlike Math.random.
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

  await query(
    "UPDATE login_codes SET consumed_at = $1 WHERE email = $2 AND consumed_at IS NULL",
    [now, email],
  );
  await query(
    `INSERT INTO login_codes (id, email, code_hash, attempts, created_at, expires_at)
     VALUES ($1, $2, $3, 0, $4, $5)`,
    [randomUUID(), email, hashCode(email, code), now, expiresAt],
  );

  return { code, expiresAt };
}

export type VerifyResult =
  | { ok: true; user: User }
  | { ok: false; reason: "no-code" | "expired" | "too-many-attempts" | "mismatch" };

/** Checks a submitted code and, on success, burns it and returns the account. */
export async function verifyCode(
  email: string,
  code: string,
): Promise<VerifyResult> {
  const now = Date.now();

  const row = await queryOne<
    Row & {
      id: string;
      code_hash: string;
      attempts: string | number;
      expires_at: string | number;
    }
  >(
    `SELECT id, code_hash, attempts, expires_at FROM login_codes
     WHERE email = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [email],
  );

  if (!row) return { ok: false, reason: "no-code" };

  const burn = () =>
    query("UPDATE login_codes SET consumed_at = $1 WHERE id = $2", [now, row.id]);

  if (toNumber(row.expires_at) < now) {
    await burn();
    return { ok: false, reason: "expired" };
  }

  if (toNumber(row.attempts) >= CODE_MAX_ATTEMPTS) {
    await burn();
    return { ok: false, reason: "too-many-attempts" };
  }

  if (!equals(row.code_hash, hashCode(email, code))) {
    await query(
      "UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1",
      [row.id],
    );
    return { ok: false, reason: "mismatch" };
  }

  // Correct: burn the code so it cannot be replayed.
  await burn();
  return { ok: true, user: await findOrCreateUser(email) };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export type NewSession = { token: string; expiresAt: number };

/** Returns the raw token; only its hash is persisted. */
export async function createSession(userId: string): Promise<NewSession> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await query(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(token), userId, now, expiresAt],
  );

  return { token, expiresAt };
}

/** Resolves a cookie token to its account, or null when missing or expired. */
export async function userForToken(token: string): Promise<User | null> {
  if (!token) return null;

  const row = await queryOne<UserRow & { expires_at: string | number }>(
    `SELECT u.id, u.email, u.display_name, u.created_at, s.expires_at
     FROM sessions AS s
     JOIN users AS u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );

  if (!row) return null;

  if (toNumber(row.expires_at) < Date.now()) {
    await destroySession(token);
    return null;
  }

  return toUser(row);
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** Housekeeping for expired sessions and spent codes. */
export async function purgeExpired(): Promise<void> {
  const now = Date.now();
  await query("DELETE FROM sessions WHERE expires_at < $1", [now]);
  await query("DELETE FROM login_codes WHERE expires_at < $1", [
    now - CODE_TTL_MS,
  ]);
}
