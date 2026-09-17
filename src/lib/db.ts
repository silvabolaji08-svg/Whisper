import { query, toNumber, type Row } from "./database";
import { HISTORY_LIMIT, type ChatMessage } from "./types";

type MessageRow = Row & {
  id: string;
  room: string;
  username: string;
  text: string;
  created_at: string | number;
};

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    room: row.room,
    username: row.username,
    text: row.text,
    createdAt: toNumber(row.created_at),
  };
}

export async function saveMessage(message: ChatMessage): Promise<void> {
  await query(
    `INSERT INTO messages (id, room, username, text, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      message.id,
      message.room,
      message.username,
      message.text,
      message.createdAt,
    ],
  );
}

/** Most recent messages for a room, returned oldest-first for direct rendering. */
export async function recentMessages(
  room: string,
  limit = HISTORY_LIMIT,
): Promise<ChatMessage[]> {
  const { rows } = await query<MessageRow>(
    `SELECT id, room, username, text, created_at FROM messages
     WHERE room = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [room, limit],
  );
  return rows.map(toMessage).reverse();
}

/**
 * Drops messages a room will never serve again.
 *
 * Only the newest `keep` messages per room are ever replayed, so everything
 * older is dead weight. Without this the table grows without bound.
 */
export async function pruneMessages(keep = HISTORY_LIMIT): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM messages
     WHERE id IN (
       SELECT id FROM (
         SELECT id, row_number() OVER (
           PARTITION BY room ORDER BY created_at DESC, id DESC
         ) AS position
         FROM messages
       ) ranked
       WHERE position > $1
     )`,
    [keep],
  );
  return rowCount;
}
