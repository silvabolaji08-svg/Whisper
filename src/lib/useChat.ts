"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import type {
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from "./types";

export type ConnectionStatus = "connecting" | "online" | "offline";

type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const TYPING_THROTTLE_MS = 2000;

export function useChat(room: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<ChatSocket | null>(null);
  const lastTypingSentAt = useRef(0);

  useEffect(() => {
    if (!room) return;

    const socket: ChatSocket = io({ path: "/api/socket" });
    socketRef.current = socket;

    const join = () => {
      setStatus("online");
      setError(null);
      socket.emit("join", { room });
    };

    socket.on("connect", join);
    socket.on("disconnect", () => setStatus("offline"));
    socket.on("connect_error", () => setStatus("offline"));

    socket.on("history", (history) => setMessages(history));
    socket.on("message", (message) =>
      setMessages((current) => [...current, message]),
    );
    socket.on("presence", (present) => setUsers(present));
    socket.on("typing", (names) => setTypingUsers(names));
    socket.on("rejected", (reason) => setError(reason));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [room]);

  const send = useCallback((text: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    const body = text.trim();
    if (!body) return;
    lastTypingSentAt.current = 0;
    socket.emit("message", { text: body });
    socket.emit("typing", { isTyping: false });
  }, []);

  /** Throttled so a fast typist does not emit on every keystroke. */
  const notifyTyping = useCallback((isTyping: boolean) => {
    const socket = socketRef.current;
    if (!socket) return;
    const now = Date.now();
    if (isTyping && now - lastTypingSentAt.current < TYPING_THROTTLE_MS) return;
    lastTypingSentAt.current = isTyping ? now : 0;
    socket.emit("typing", { isTyping });
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    messages,
    users,
    typingUsers,
    status,
    error,
    send,
    notifyTyping,
    dismissError,
  };
}
