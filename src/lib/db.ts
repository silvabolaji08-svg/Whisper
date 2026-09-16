import { query } from "./database";
import { HISTORY_LIMIT, type ChatMessage } from "./types";

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

/**
 * Drops messages a room will never serve again.
 *
 * Only the newest `keep` messages per room are ever replayed, so everything
 * older is dead weight. Without this the table grows without bound.
 */
export function pruneMessages(keep = HISTORY_LIMIT): number {
  const result = query((handle) =>
    handle
      .prepare(
        `DELETE FROM messages
         WHERE id NOT IN (
           SELECT id FROM messages AS recent
           WHERE recent.room = messages.room
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )`,
      )
      .run(keep),
  );
  return Number(result.changes ?? 0);
}
