"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatMessage } from "./types";
import {
  decodeServerFrame,
  encode,
  SOCKET_PATH,
  type ClientFrame,
} from "./realtime/protocol";

export type ConnectionStatus = "connecting" | "online" | "offline";

const TYPING_THROTTLE_MS = 2000;
/** Keeps the socket from being culled while idle. */
const PING_INTERVAL_MS = 25_000;

/**
 * Vercel closes a WebSocket when the function reaches its maximum duration —
 * 300s on the Hobby plan — so a reconnect roughly every five minutes is normal
 * operation, not a fault. The status only drops to "offline" after this grace
 * period, so a routine reconnect never flashes an error at the reader.
 */
const OFFLINE_GRACE_MS = 3000;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${SOCKET_PATH}`;
}

export function useChat(room: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const lastTypingSentAt = useRef(0);
  const closedByUs = useRef(false);
  /** Messages typed while the socket was down, flushed on reconnect. */
  const outbox = useRef<string[]>([]);

  useEffect(() => {
    if (!room) return;

    closedByUs.current = false;
    let attempt = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let offlineTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const clearTimers = () => {
      clearTimeout(offlineTimer);
      clearInterval(pingTimer);
    };

    const connect = () => {
      socket = new WebSocket(socketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        attempt = 0;
        clearTimeout(offlineTimer);
        setStatus("online");
        setError(null);
        socket?.send(encode({ t: "join", room }));

        // Anything typed while the socket was down goes out now, so a
        // reconnect never silently swallows a message.
        for (const text of outbox.current.splice(0)) {
          socket?.send(encode({ t: "message", text }));
        }

        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(encode({ t: "ping" }));
          }
        }, PING_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        const frame = decodeServerFrame(String(event.data));
        if (!frame) return;

        switch (frame.t) {
          case "history":
            setMessages(frame.messages);
            break;
          case "message":
            // The server may replay a message we already hold after a
            // reconnect; ids make that idempotent.
            setMessages((current) =>
              current.some((m) => m.id === frame.message.id)
                ? current
                : [...current, frame.message],
            );
            break;
          case "presence":
            setUsers(frame.users);
            break;
          case "typing":
            setTypingUsers(frame.users);
            break;
          case "rejected":
            setError(frame.reason);
            break;
          case "joined":
          case "pong":
            break;
        }
      };

      const scheduleReconnect = () => {
        clearTimers();
        if (closedByUs.current) return;

        // Hold "online" briefly: a routine five-minute cycle reconnects well
        // inside this window, so the indicator never flickers.
        offlineTimer = setTimeout(() => setStatus("offline"), OFFLINE_GRACE_MS);
        setTypingUsers([]);

        const backoff = Math.min(
          RECONNECT_BASE_MS * 2 ** attempt,
          RECONNECT_MAX_MS,
        );
        attempt += 1;
        // Jitter, so many clients dropped by one instance do not return in lockstep.
        reconnectTimer = setTimeout(connect, backoff * (0.5 + Math.random()));
      };

      socket.onclose = scheduleReconnect;
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closedByUs.current = true;
      clearTimeout(reconnectTimer);
      clearTimers();
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      socketRef.current = null;
    };
  }, [room]);

  const send = useCallback((text: string) => {
    const body = text.trim();
    if (!body) return;
    lastTypingSentAt.current = 0;

    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(encode({ t: "message", text: body }));
      socket.send(encode({ t: "typing", isTyping: false }));
    } else {
      // Queued rather than dropped; flushed by onopen.
      outbox.current.push(body);
    }
  }, []);

  /** Throttled so a fast typist does not emit on every keystroke. */
  const notifyTyping = useCallback((isTyping: boolean) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    if (isTyping && now - lastTypingSentAt.current < TYPING_THROTTLE_MS) return;
    lastTypingSentAt.current = isTyping ? now : 0;

    const frame: ClientFrame = { t: "typing", isTyping };
    socket.send(encode(frame));
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
