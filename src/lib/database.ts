import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Postgres access, with two transports behind one interface.
 *
 * - `DATABASE_URL` set (production, and anyone pointing at Neon): node-postgres
 *   against the real server.
 * - unset (local development and the test suite): PGlite, which is Postgres
 *   compiled to WebAssembly and runs in-process against a local directory.
 *
 * Both speak the same SQL, so there is one dialect and one set of queries —
 * only the transport differs. That keeps local work and CI free of any external
 * service while still exercising real Postgres behaviour.
 */

export type Row = Record<string, unknown>;
export type Result<T extends Row = Row> = { rows: T[]; rowCount: number };

type Driver = {
  query<T extends Row>(sql: string, params: unknown[]): Promise<Result<T>>;
  close(): Promise<void>;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT   PRIMARY KEY,
    room       TEXT   NOT NULL,
    username   TEXT   NOT NULL,
    text       TEXT   NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages (room, created_at);

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT   PRIMARY KEY,
    email        TEXT   NOT NULL UNIQUE,
    display_name TEXT   NOT NULL,
    created_at   BIGINT NOT NULL
  );

  -- One row per emailed code. Only the HMAC of the code is stored, so a
  -- database leak does not hand out working login codes.
  CREATE TABLE IF NOT EXISTS login_codes (
    id          TEXT    PRIMARY KEY,
    email       TEXT    NOT NULL,
    code_hash   TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  BIGINT  NOT NULL,
    expires_at  BIGINT  NOT NULL,
    consumed_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email, created_at);

  -- Sessions store only the SHA-256 of the cookie token, for the same reason.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT   PRIMARY KEY,
    user_id    TEXT   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`;

async function createDriver(): Promise<Driver> {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: url,
      // Neon and most hosted Postgres terminate TLS with their own CA chain.
      ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
      // Functions are short-lived and numerous; a small pool per instance keeps
      // us well inside the provider's connection limit.
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });

    return {
      async query<T extends Row>(sql: string, params: unknown[]) {
        const result = await pool.query(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      },
      close: () => pool.end(),
    };
  }

  const dataDir = process.env.CHAT_DATA_DIR ?? path.join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });

  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(path.join(dataDir, "pgdata"));

  return {
    async query<T extends Row>(sql: string, params: unknown[]) {
      const result = await db.query(sql, params);
      return {
        rows: result.rows as T[],
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
    close: () => db.close(),
  };
}

/**
 * The connection is cached on globalThis, not in a module variable.
 *
 * `server.ts` runs under tsx while Next bundles the Route Handlers separately,
 * so this module is instantiated twice in the same process. Two module-level
 * caches would mean two connections — harmless for a Postgres pool, but fatal
 * for PGlite, which is embedded and single-writer: each instance would open the
 * same directory and neither would see the other's writes. A global keeps one
 * connection per process. It also survives dev-server hot reloads.
 */
const CACHE = Symbol.for("realtime-chat.database");

type Cache = { ready: Promise<Driver> | null };

const globalCache = globalThis as unknown as Record<symbol, Cache | undefined>;
globalCache[CACHE] ??= { ready: null };
const cache = globalCache[CACHE]!;

function connect(): Promise<Driver> {
  cache.ready ??= (async () => {
    const driver = await createDriver();
    // Split because PGlite's query() takes one statement at a time.
    for (const statement of SCHEMA.split(";")) {
      const trimmed = statement.trim();
      if (trimmed) await driver.query(`${trimmed};`, []);
    }
    return driver;
  })().catch((error) => {
    cache.ready = null; // Let the next caller retry rather than caching the failure.
    throw error;
  });

  return cache.ready;
}

export async function query<T extends Row = Row>(
  sql: string,
  params: unknown[] = [],
): Promise<Result<T>> {
  const driver = await connect();
  return driver.query<T>(sql, params);
}

/** First row, or null. The common shape for a lookup. */
export async function queryOne<T extends Row = Row>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const { rows } = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Postgres returns BIGINT as a string to avoid precision loss, so every
 * millisecond timestamp goes through here rather than being trusted as a number.
 */
export function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Closes the pool so the process can exit cleanly on a shutdown signal. */
export async function closeDatabase(): Promise<void> {
  if (!cache.ready) return;
  const driver = await cache.ready.catch(() => null);
  cache.ready = null;
  try {
    await driver?.close();
  } catch {
    // Already closed, or never opened: nothing useful to do while shutting down.
  }
}
