import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { HISTORY_LIMIT, type ChatMessage } from "./types";

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
`;

function open(): DatabaseSync {
  const handle = new DatabaseSync(dbPath);
  // WAL lets readers proceed while a write is in flight.
  handle.exec("PRAGMA journal_mode = WAL");
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
function query<T>(run: (handle: DatabaseSync) => T): T {
  try {
    return run(db);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_INVALID_STATE") throw error;
    db = open();
    return run(db);
  }
}

type MessageRow = {
  id: string;
  room: string;
  username: string;
  text: string;
  created_at: number;
};

// node:sqlite hands back null-prototype rows, so copy them into plain objects.
function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    room: row.room,
    username: row.username,
    text: row.text,
    createdAt: Number(row.created_at),
  };
}

export function saveMessage(message: ChatMessage): void {
  query((handle) =>
    handle
      .prepare(
        "INSERT INTO messages (id, room, username, text, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        message.id,
        message.room,
        message.username,
        message.text,
        message.createdAt,
      ),
  );
}

/** Most recent messages for a room, returned oldest-first for direct rendering. */
export function recentMessages(
  room: string,
  limit = HISTORY_LIMIT,
): ChatMessage[] {
  const rows = query(
    (handle) =>
      handle
        .prepare(
          `SELECT id, room, username, text, created_at FROM messages
           WHERE room = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(room, limit) as unknown as MessageRow[],
  );
  return rows.map(toMessage).reverse();
}
