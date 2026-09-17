import { headers } from "next/headers";

import {
  handleConnection,
  userFromCookieHeader,
} from "@/lib/realtime/connection";

/**
 * The production (Vercel) WebSocket transport.
 *
 * Vercel does not run custom servers, so the socket layer has to be a Route
 * Handler. Locally `server.ts` serves the same path with the `ws` package and
 * calls the same `handleConnection`, so only the upgrade differs.
 *
 * Note the connection is closed when the function reaches its maximum
 * duration — 300s on Hobby — which is why the client reconnects.
 */
export const maxDuration = 300;

// Holding a socket open is inherently dynamic.
export const dynamic = "force-dynamic";

export async function GET() {
  const requestHeaders = await headers();
  const user = await userFromCookieHeader(
    requestHeaders.get("cookie") ?? undefined,
  );

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Imported lazily so local development, where this module is never used,
  // does not need the package resolved at startup.
  const { experimental_upgradeWebSocket } = await import("@vercel/functions");

  return experimental_upgradeWebSocket(async (ws) => {
    const { onMessage, onClose } = await handleConnection(
      ws as unknown as { send(data: string): void; close(): void; readyState: number },
      user,
    );

    ws.on("message", (data) => onMessage(data.toString()));
    ws.on("close", onClose);
    ws.on("error", onClose);
  });
}
