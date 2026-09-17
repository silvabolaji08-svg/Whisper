import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";

import { closeDatabase } from "./src/lib/database";
import { pruneMessages } from "./src/lib/db";
import { purgeExpired } from "./src/lib/auth/store";
import { closeHub } from "./src/lib/realtime/hub";
import {
  handleConnection,
  userFromCookieHeader,
} from "./src/lib/realtime/connection";
import { SOCKET_PATH } from "./src/lib/realtime/protocol";

/**
 * The development and self-hosted server.
 *
 * Vercel does not run custom servers, so in production the WebSocket endpoint
 * is the Route Handler at `src/app/api/socket/route.ts` instead. Both call the
 * same `handleConnection`; only the upgrade mechanism differs. Keeping this
 * file means `npm run dev` and a long-lived host still work, and the realtime
 * layer stays testable without deploying.
 */

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 3000);

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function main(): Promise<void> {
  /**
   * Next attaches its own "upgrade" listener for the dev HMR socket, on the
   * first request, to whichever server it is given. Left to itself it claims
   * every upgrade — including ours — and destroys the ones it does not
   * recognise, with no error logged.
   *
   * Handing it a server that never listens keeps that listener off the real
   * one, so this file owns upgrades and forwards the non-chat ones to Next's
   * handler explicitly. HMR keeps working; the chat socket stops being killed.
   */
  const decoyServer = createServer();

  const app = next({ dev, hostname, port, httpServer: decoyServer });
  await app.prepare();
  const handle = app.getRequestHandler();
  const nextUpgrade = app.getUpgradeHandler();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("Request failed:", error);
      res.statusCode = 500;
      res.end("Internal server error");
    });
  });

  // noServer: the upgrade is routed by path below, so Next's own HMR socket in
  // development is left alone.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(
      request.url ?? "/",
      `http://${request.headers.host}`,
    );
    if (pathname !== SOCKET_PATH) {
      // Anything else is Next's (the HMR socket in development).
      void nextUpgrade(request, socket, head);
      return;
    }

    // Upgrade synchronously. Next attaches its own "upgrade" listener for HMR
    // on the first request, and awaiting the session lookup before calling
    // handleUpgrade loses that race — Next sees an unclaimed upgrade and
    // destroys the socket. So claim it first, then authenticate.
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Frames can arrive before the session lookup resolves; hold them rather
      // than dropping them, since the client sends "join" straight after open.
      const pending: string[] = [];
      const buffer = (data: unknown) => pending.push(String(data));
      ws.on("message", buffer);

      void (async () => {
        try {
          const user = await userFromCookieHeader(request.headers.cookie);
          if (!user) {
            ws.close(4401, "unauthorized");
            return;
          }

          const { onMessage, onClose } = await handleConnection(ws, user);
          ws.off("message", buffer);
          ws.on("message", (data) => onMessage(data.toString()));
          ws.on("close", onClose);
          ws.on("error", onClose);

          ws.send(JSON.stringify({ t: "ready" }));
          for (const data of pending) onMessage(data);
        } catch (error) {
          console.error("Failed to attach a connection:", error);
          ws.close(1011, "server error");
        }
      })();
    });
  });

  // Only the newest messages per room are ever served; the rest are dead weight.
  const pruner = setInterval(() => {
    void (async () => {
      try {
        const removed = await pruneMessages();
        if (removed > 0) console.log(`Pruned ${removed} old message(s).`);
        await purgeExpired();
      } catch (error) {
        console.error("Housekeeping failed:", error);
      }
    })();
  }, PRUNE_INTERVAL_MS);
  pruner.unref();

  httpServer.listen(port, () => {
    console.log(`> Chat server ready on http://${hostname}:${port}`);
  });

  /**
   * Close in order on a shutdown signal: stop timers, close sockets so clients
   * reconnect to the replacement instance, then the HTTP server and the
   * database. Without this, a deploy severs connections mid-write.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down…`);

    clearInterval(pruner);
    for (const client of wss.clients) client.close(1001, "server shutting down");

    const done = () => {
      void Promise.allSettled([closeHub(), closeDatabase()]).finally(() =>
        process.exit(0),
      );
    };

    wss.close(() => httpServer.close(done));

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
