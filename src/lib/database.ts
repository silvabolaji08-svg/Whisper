import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// node:sqlite ships with Node itself (>= 22.5), so there is no native module to compile.
// CHAT_DATA_DIR lets the test suite (and a deployment with a mounted volume)
// point the database somewhere other than ./data.
const dataDir = process.env.CHAT_DATA_DIR ?? path.join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "chat.db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT    PRIMARY KEY,
    room       TEXT    NOT NULL,
    username   TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages (room, created_at);

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT    PRIMARY KEY,
    email        TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  );

  -- One row per emailed code. Only the HMAC of the code is stored, so a
  -- database leak does not hand out working login codes.
  CREATE TABLE IF NOT EXISTS login_codes (
    id          TEXT    PRIMARY KEY,
    email       TEXT    NOT NULL,
    code_hash   TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email, created_at);

  -- Sessions store only the SHA-256 of the cookie token, for the same reason.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`;

function open(): DatabaseSync {
  const handle = new DatabaseSync(dbPath);
  // WAL lets readers proceed while a write is in flight.
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec(SCHEMA);
  return handle;
}

let db = open();

/**
 * Runs a query, reopening the database once if the handle went stale.
 *
 * Next's `app.prepare()` finalizes `node:sqlite` statements that were prepared
 * before it ran, so statements are prepared per call rather than cached at module
 * scope, and a stale handle is recovered here instead of failing the request.
 */
export function query<T>(run: (handle: DatabaseSync) => T): T {
  try {
    return run(db);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_INVALID_STATE") throw error;
    db = open();
    return run(db);
  }
}

/** Closes the handle so the process can exit cleanly on a shutdown signal. */
export function closeDatabase(): void {
  try {
    db.close();
  } catch {
    // Already closed, or never opened: nothing useful to do while shutting down.
  }
}
