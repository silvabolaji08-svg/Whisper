import type { ChatMessage } from "../types";

/**
 * The wire protocol, shared by the browser client and both server transports.
 *
 * Plain JSON frames with a `t` discriminator. This replaced Socket.IO because
 * Vercel does not run custom servers: the socket layer has to live in a Route
 * Handler, and Socket.IO's server needs to own the HTTP upgrade itself.
 */

export type ClientFrame =
  | { t: "join"; room: string }
  | { t: "message"; text: string }
  | { t: "typing"; isTyping: boolean }
  // Answered with "pong". Keeps intermediaries from culling an idle socket.
  | { t: "ping" };

export type ServerFrame =
  // Sent once the session has been resolved, so a client knows the socket
  // is authenticated rather than merely open.
  | { t: "ready" }
  | { t: "joined"; room: string; username: string }
  | { t: "history"; messages: ChatMessage[] }
  | { t: "message"; message: ChatMessage }
  | { t: "presence"; users: string[] }
  | { t: "typing"; users: string[] }
  | { t: "rejected"; reason: string }
  | { t: "pong" };

export function encode(frame: ServerFrame | ClientFrame): string {
  return JSON.stringify(frame);
}

/** Returns null rather than throwing: a peer may send anything at all. */
export function decodeClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as { t?: unknown };

  switch (frame.t) {
    case "join": {
      const { room } = frame as { room?: unknown };
      return typeof room === "string" ? { t: "join", room } : null;
    }
    case "message": {
      const { text } = frame as { text?: unknown };
      return typeof text === "string" ? { t: "message", text } : null;
    }
    case "typing": {
      const { isTyping } = frame as { isTyping?: unknown };
      return { t: "typing", isTyping: isTyping === true };
    }
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}

export function decodeServerFrame(raw: string): ServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as ServerFrame;
}

/**
 * The two transports must be served from different paths.
 *
 * On Vercel the endpoint is a Route Handler, so it lives at a route path. On
 * the custom server it must NOT be one: Next's own upgrade handler ends any
 * upgrade whose path matches a route ("if (matchedOutput) return socket.end()")
 * and only leaves unmatched paths for a custom WebSocket server. Serving the
 * local socket at /api/socket therefore has Next close it immediately.
 *
 * Which one is in use is decided on the server and passed to the client, since
 * only the server knows where it is running.
 */
export const SOCKET_PATH_ROUTE = "/api/socket";
export const SOCKET_PATH_NODE = "/_ws";

/** Vercel sets VERCEL=1 in every deployment. */
export function serverSocketPath(): string {
  return process.env.VERCEL ? SOCKET_PATH_ROUTE : SOCKET_PATH_NODE;
}
