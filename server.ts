import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import next from "next";
import { Server, type Socket } from "socket.io";

import { closeDatabase } from "./src/lib/database";
import { pruneMessages, recentMessages, saveMessage } from "./src/lib/db";
import { SESSION_COOKIE } from "./src/lib/auth/config";
import { purgeExpired, userForToken, type User } from "./src/lib/auth/store";
import {
  cleanText,
  normalizeRoom,
  MAX_MESSAGE_LENGTH,
  type ChatMessage,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "./src/lib/types";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 3000);

/** Per-connection state, attached once a socket successfully joins a room. */
type SocketState = {
  room: string;
  username: string;
  typingUntil: number;
};

const SEND_WINDOW_MS = 10_000;
const SEND_LIMIT = 15;
const TYPING_TTL_MS = 4000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

const state = new Map<string, SocketState>();

/**
 * Send timestamps keyed by account, not by socket.
 *
 * Keying on socket.id would let anyone reset their own limit just by
 * reconnecting, which is trivial to automate.
 */
const sendHistory = new Map<string, number[]>();

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents> & {
  data: { user: User };
};

/** Minimal cookie header parser; avoids a dependency for one lookup. */
function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function usersIn(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  room: string,
): string[] {
  const ids = io.sockets.adapter.rooms.get(room);
  if (!ids) return [];
  const names = new Set<string>();
  for (const id of ids) {
    const entry = state.get(id);
    if (entry) names.add(entry.username);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function typingIn(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  room: string,
  exclude?: string,
): string[] {
  const ids = io.sockets.adapter.rooms.get(room);
  if (!ids) return [];
  const now = Date.now();
  const names = new Set<string>();
  for (const id of ids) {
    if (id === exclude) continue;
    const entry = state.get(id);
    if (entry && entry.typingUntil > now) names.add(entry.username);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Push the current typing set to each member, with that member filtered out of their own view. */
function broadcastTyping(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  room: string,
): void {
  const ids = io.sockets.adapter.rooms.get(room);
  if (!ids) return;
  for (const id of ids) {
    io.to(id).emit("typing", typingIn(io, room, id));
  }
}

function withinRateLimit(userId: string): boolean {
  const now = Date.now();
  const recent = (sendHistory.get(userId) ?? []).filter(
    (at) => now - at < SEND_WINDOW_MS,
  );
  if (recent.length >= SEND_LIMIT) {
    sendHistory.set(userId, recent);
    return false;
  }
  recent.push(now);
  sendHistory.set(userId, recent);
  return true;
}

async function main(): Promise<void> {
  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("Request failed:", error);
      res.statusCode = 500;
      res.end("Internal server error");
    });
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    path: "/api/socket",
  });

  /**
   * Authenticate at the handshake, before any event is handled. The browser
   * sends the session cookie with the upgrade request, so no token needs to be
   * passed through client code where a script could read it.
   */
  io.use((socket, nextFn) => {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    const user = token ? userForToken(token) : null;

    if (!user) {
      nextFn(new Error("unauthorized"));
      return;
    }

    (socket as ChatSocket).data.user = user;
    nextFn();
  });

  io.on("connection", (socket: ChatSocket) => {
    const user = socket.data.user;

    socket.on("join", ({ room } = { room: "" }) => {
      const normalizedRoom = normalizeRoom(room);

      if (!normalizedRoom) {
        socket.emit("rejected", "That room name is not valid.");
        return;
      }

      // A socket only ever belongs to one room; leave the previous one first.
      const previous = state.get(socket.id);
      if (previous) {
        socket.leave(previous.room);
        io.to(previous.room).emit("presence", usersIn(io, previous.room));
      }

      state.set(socket.id, {
        room: normalizedRoom,
        // Identity is the account's, never anything the client sent.
        username: user.displayName,
        typingUntil: 0,
      });
      socket.join(normalizedRoom);

      socket.emit("joined", { room: normalizedRoom, username: user.displayName });

      // History is a convenience: failing to load it must not stop the join.
      try {
        socket.emit("history", recentMessages(normalizedRoom));
      } catch (error) {
        console.error("Failed to load history:", error);
        socket.emit("rejected", "Earlier messages could not be loaded.");
      }

      io.to(normalizedRoom).emit("presence", usersIn(io, normalizedRoom));
      broadcastTyping(io, normalizedRoom);
    });

    socket.on("message", ({ text } = { text: "" }) => {
      const entry = state.get(socket.id);
      if (!entry) {
        socket.emit("rejected", "Join a room before sending messages.");
        return;
      }

      const body = cleanText(text, MAX_MESSAGE_LENGTH);
      if (!body) return;

      if (!withinRateLimit(user.id)) {
        socket.emit("rejected", "You are sending messages too quickly.");
        return;
      }

      const message: ChatMessage = {
        id: randomUUID(),
        room: entry.room,
        username: entry.username,
        text: body,
        createdAt: Date.now(),
      };

      try {
        saveMessage(message);
      } catch (error) {
        console.error("Failed to persist message:", error);
        socket.emit("rejected", "Message could not be saved.");
        return;
      }

      // Sending stops the typing indicator immediately.
      entry.typingUntil = 0;
      io.to(entry.room).emit("message", message);
      broadcastTyping(io, entry.room);
    });

    socket.on("typing", ({ isTyping } = { isTyping: false }) => {
      const entry = state.get(socket.id);
      if (!entry) return;
      entry.typingUntil = isTyping ? Date.now() + TYPING_TTL_MS : 0;
      broadcastTyping(io, entry.room);
    });

    socket.on("disconnect", () => {
      const entry = state.get(socket.id);
      state.delete(socket.id);
      if (!entry) return;
      io.to(entry.room).emit("presence", usersIn(io, entry.room));
      broadcastTyping(io, entry.room);
    });
  });

  // Typing flags expire on a timer, so refresh rooms periodically to clear stale indicators.
  const sweeper = setInterval(() => {
    for (const room of new Set([...state.values()].map((entry) => entry.room))) {
      broadcastTyping(io, room);
    }

    // Drop rate-limit history for accounts that have gone quiet, so the map
    // does not grow for the lifetime of the process.
    const cutoff = Date.now() - SEND_WINDOW_MS;
    for (const [userId, times] of sendHistory) {
      if (times.every((at) => at < cutoff)) sendHistory.delete(userId);
    }
  }, TYPING_TTL_MS);
  sweeper.unref();

  // Only the newest messages per room are ever served; the rest are dead weight.
  const pruner = setInterval(() => {
    try {
      const removed = pruneMessages();
      if (removed > 0) console.log(`Pruned ${removed} old message(s).`);
      purgeExpired();
    } catch (error) {
      console.error("Housekeeping failed:", error);
    }
  }, PRUNE_INTERVAL_MS);
  pruner.unref();

  httpServer.listen(port, () => {
    console.log(`> Chat server ready on http://${hostname}:${port}`);
  });

  /**
   * Close in order on a shutdown signal: stop timers, tell clients to go away
   * so they reconnect to the replacement instance, then close the HTTP server
   * and the database. Without this, a deploy severs sockets mid-write.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down…`);

    clearInterval(sweeper);
    clearInterval(pruner);

    const done = () => {
      closeDatabase();
      process.exit(0);
    };

    io.close(() => {
      httpServer.close(done);
    });

    // Do not hang forever on a stuck connection.
    setTimeout(done, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
