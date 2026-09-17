import { randomUUID } from "node:crypto";

import { recentMessages, saveMessage } from "../db";
import { cleanText, normalizeRoom, MAX_MESSAGE_LENGTH } from "../types";
import type { ChatMessage } from "../types";
import type { User } from "../auth/store";
import { getHub, PRESENCE_TTL_MS, TYPING_TTL_MS, type Hub } from "./hub";
import {
  decodeClientFrame,
  encode,
  type ServerFrame,
} from "./protocol";

/**
 * The realtime logic, written against a minimal socket shape so it can be
 * driven by either transport: the `ws` server used by `server.ts` locally, or
 * the WebSocket handed over by Vercel's route handler in production.
 */
export type SocketLike = {
  send(data: string): void;
  close(): void;
  readyState: number;
};

const OPEN = 1;

/** Local connections owned by this process, keyed by connection id. */
type Connection = {
  id: string;
  socket: SocketLike;
  user: User;
  room: string | null;
};

const CACHE = Symbol.for("realtime-chat.connections");
type Cache = { connections: Map<string, Connection>; wired: boolean };
const globalCache = globalThis as unknown as Record<symbol, Cache | undefined>;
globalCache[CACHE] ??= { connections: new Map(), wired: false };
const cache = globalCache[CACHE]!;

function deliver(room: string, frame: ServerFrame) {
  const payload = encode(frame);
  for (const connection of cache.connections.values()) {
    if (connection.room !== room) continue;
    if (connection.socket.readyState !== OPEN) continue;
    try {
      connection.socket.send(payload);
    } catch {
      // A socket that fails mid-send is cleaned up by its own close handler.
    }
  }
}

/** Wires this process's delivery callback exactly once. */
async function ensureWired(hub: Hub) {
  if (cache.wired) return;
  cache.wired = true;
  hub.onPublish(deliver);
}

function send(socket: SocketLike, frame: ServerFrame) {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(encode(frame));
  } catch {
    // Nothing useful to do; the close handler will tidy up.
  }
}

/** Pushes the current typing set to each member, filtered per recipient. */
async function broadcastTyping(hub: Hub, room: string) {
  for (const connection of cache.connections.values()) {
    if (connection.room !== room) continue;
    const users = await hub.typists(room, connection.id);
    send(connection.socket, { t: "typing", users });
  }
}

async function broadcastPresence(hub: Hub, room: string) {
  await hub.publish(room, { t: "presence", users: await hub.members(room) });
}

/**
 * Attaches a freshly authenticated socket. Returns a disposer the transport
 * calls when the underlying connection closes.
 */
export async function handleConnection(
  socket: SocketLike,
  user: User,
): Promise<{
  onMessage: (raw: string) => void;
  onClose: () => void;
}> {
  const hub = await getHub();
  await ensureWired(hub);

  const connection: Connection = {
    id: randomUUID(),
    socket,
    user,
    room: null,
  };
  cache.connections.set(connection.id, connection);

  // Presence entries expire, so refresh while the socket is open. This also
  // keeps intermediaries from culling an idle connection.
  const heartbeat = setInterval(() => {
    void (async () => {
      if (!connection.room) return;
      await hub.join(connection.room, connection.id, user.displayName);
    })();
  }, PRESENCE_TTL_MS / 3);
  heartbeat.unref?.();

  // Typing flags lapse on a timer, so refresh the room periodically to clear
  // stale indicators for everyone still watching.
  const sweeper = setInterval(() => {
    void (async () => {
      if (connection.room) await broadcastTyping(hub, connection.room);
    })();
  }, TYPING_TTL_MS);
  sweeper.unref?.();

  async function join(rawRoom: string) {
    const room = normalizeRoom(rawRoom);
    if (!room) {
      send(socket, { t: "rejected", reason: "That room name is not valid." });
      return;
    }

    if (connection.room && connection.room !== room) {
      const previous = connection.room;
      await hub.leave(previous, connection.id);
      await broadcastPresence(hub, previous);
    }

    connection.room = room;
    await hub.join(room, connection.id, user.displayName);

    send(socket, { t: "joined", room, username: user.displayName });

    // History is a convenience: failing to load it must not stop the join.
    try {
      send(socket, { t: "history", messages: await recentMessages(room) });
    } catch (error) {
      console.error("Failed to load history:", error);
      send(socket, {
        t: "rejected",
        reason: "Earlier messages could not be loaded.",
      });
    }

    await broadcastPresence(hub, room);
    await broadcastTyping(hub, room);
  }

  async function message(text: string) {
    const room = connection.room;
    if (!room) {
      send(socket, {
        t: "rejected",
        reason: "Join a room before sending messages.",
      });
      return;
    }

    const body = cleanText(text, MAX_MESSAGE_LENGTH);
    if (!body) return;

    // Keyed to the account, so reconnecting does not reset the allowance.
    if (!(await hub.allowSend(user.id))) {
      send(socket, {
        t: "rejected",
        reason: "You are sending messages too quickly.",
      });
      return;
    }

    const chatMessage: ChatMessage = {
      id: randomUUID(),
      room,
      username: user.displayName,
      text: body,
      createdAt: Date.now(),
    };

    try {
      await saveMessage(chatMessage);
    } catch (error) {
      console.error("Failed to persist message:", error);
      send(socket, { t: "rejected", reason: "Message could not be saved." });
      return;
    }

    // Sending stops the typing indicator immediately.
    await hub.setTyping(room, connection.id, user.displayName, false);
    await hub.publish(room, { t: "message", message: chatMessage });
    await broadcastTyping(hub, room);
  }

  async function typing(isTyping: boolean) {
    const room = connection.room;
    if (!room) return;
    await hub.setTyping(room, connection.id, user.displayName, isTyping);
    await broadcastTyping(hub, room);
  }

  return {
    onMessage(raw: string) {
      const frame = decodeClientFrame(raw);
      if (!frame) return;

      void (async () => {
        try {
          switch (frame.t) {
            case "join":
              await join(frame.room);
              break;
            case "message":
              await message(frame.text);
              break;
            case "typing":
              await typing(frame.isTyping);
              break;
            case "ping":
              send(socket, { t: "pong" });
              break;
          }
        } catch (error) {
          console.error("Frame handling failed:", error);
        }
      })();
    },

    onClose() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      cache.connections.delete(connection.id);

      const room = connection.room;
      if (!room) return;
      void (async () => {
        try {
          await hub.leave(room, connection.id);
          await broadcastPresence(hub, room);
          await broadcastTyping(hub, room);
        } catch (error) {
          console.error("Cleanup after disconnect failed:", error);
        }
      })();
    },
  };
}

/** Shared by both transports: resolve the session cookie to an account. */
export async function userFromCookieHeader(
  header: string | undefined,
): Promise<User | null> {
  const { SESSION_COOKIE } = await import("../auth/config");
  const { userForToken } = await import("../auth/store");

  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    return userForToken(decodeURIComponent(part.slice(index + 1).trim()));
  }
  return null;
}
