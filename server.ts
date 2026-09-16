import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import next from "next";
import { Server, type Socket } from "socket.io";

import { recentMessages, saveMessage } from "./src/lib/db";
import {
  cleanText,
  normalizeRoom,
  MAX_MESSAGE_LENGTH,
  MAX_USERNAME_LENGTH,
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
  /** Timestamps of recent sends, used for a simple sliding-window rate limit. */
  sends: number[];
};

const SEND_WINDOW_MS = 10_000;
const SEND_LIMIT = 15;
const TYPING_TTL_MS = 4000;

const state = new Map<string, SocketState>();

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

function usersIn(io: Server<ClientToServerEvents, ServerToClientEvents>, room: string): string[] {
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

function withinRateLimit(entry: SocketState): boolean {
  const now = Date.now();
  entry.sends = entry.sends.filter((t) => now - t < SEND_WINDOW_MS);
  if (entry.sends.length >= SEND_LIMIT) return false;
  entry.sends.push(now);
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

  io.on("connection", (socket: ChatSocket) => {
    socket.on("join", ({ room, username } = { room: "", username: "" }) => {
      const normalizedRoom = normalizeRoom(room);
      const cleanName = cleanText(username, MAX_USERNAME_LENGTH);

      if (!normalizedRoom) {
        socket.emit("rejected", "That room name is not valid.");
        return;
      }
      if (!cleanName) {
        socket.emit("rejected", "Please choose a display name.");
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
        username: cleanName,
        typingUntil: 0,
        sends: [],
      });
      socket.join(normalizedRoom);

      socket.emit("joined", { room: normalizedRoom, username: cleanName });

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

      if (!withinRateLimit(entry)) {
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
  }, TYPING_TTL_MS);
  sweeper.unref();

  httpServer.listen(port, () => {
    console.log(`> Chat server ready on http://${hostname}:${port}`);
  });
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
