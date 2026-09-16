/**
 * End-to-end tests for auth and the realtime layer.
 *
 * These drive the actual server over real HTTP and real Socket.IO connections
 * rather than stubbing it, so they cover the parts that only break in
 * integration: the OTP flow, session cookies gating the socket handshake,
 * broadcast fan-out, presence bookkeeping, SQLite history replay and the
 * rate limiter.
 *
 * With no RESEND_API_KEY set the server prints login codes to stdout, which is
 * how these tests obtain them — the same path a developer uses locally.
 *
 * Run with `npm test`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { io } from "socket.io-client";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOCKET_PATH = "/api/socket";
const SESSION_COOKIE = "chat_session";
/** Kept separate from .next so the suite never clobbers a dev server's build. */
const TEST_DIST_DIR = ".next-test";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Settle time for a broadcast round-trip through the server. */
const SETTLE_MS = 300;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let server;
let dataDir;
let baseUrl;
let serverOutput = "";

/* -------------------------------------------------------------------------- */
/* Auth helpers                                                                */
/* -------------------------------------------------------------------------- */

const post = (route, body, cookie) =>
  fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

/** Waits for the dev-mode console line carrying this address's login code. */
async function codeFromConsole(email, fromIndex) {
  const pattern = new RegExp(
    `login code for ${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is: (\\d{6})`,
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = serverOutput.slice(fromIndex).match(pattern);
    if (match) return match[1];
    await wait(100);
  }
  throw new Error(`no login code appeared for ${email}`);
}

function sessionCookieFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const header = raw.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (!header) return null;
  return header.split(";")[0];
}

/** Completes the whole OTP flow and returns a usable session cookie. */
async function signIn(email) {
  const mark = serverOutput.length;

  const requested = await post("/api/auth/request-code", { email });
  assert.equal(requested.status, 200, `request-code failed for ${email}`);

  const code = await codeFromConsole(email, mark);
  const verified = await post("/api/auth/verify", { email, code });
  assert.equal(verified.status, 200, `verify failed for ${email}`);

  const cookie = sessionCookieFrom(verified);
  assert.ok(cookie, "verify did not set a session cookie");
  return { cookie, code };
}

/* -------------------------------------------------------------------------- */
/* Socket helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A connected client that records every server event for later assertions. */
async function connect(cookie) {
  const socket = io(baseUrl, {
    path: SOCKET_PATH,
    transports: ["websocket"],
    extraHeaders: cookie ? { Cookie: cookie } : {},
    reconnection: false,
  });
  socket.events = [];
  for (const name of ["history", "message", "presence", "typing", "joined", "rejected"]) {
    socket.on(name, (payload) => socket.events.push({ name, payload }));
  }
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

const last = (socket, name) =>
  [...socket.events].reverse().find((entry) => entry.name === name)?.payload;
const countOf = (socket, name) =>
  socket.events.filter((entry) => entry.name === name).length;

async function join(socket, room) {
  socket.emit("join", { room });
  await wait(SETTLE_MS);
}

/** Signs in and opens an authenticated socket in one step. */
async function member(email, room) {
  const { cookie } = await signIn(email);
  const socket = await connect(cookie);
  if (room) await join(socket, room);
  return socket;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "realtime-chat-test-"));
  const port = await freePort();
  baseUrl = `http://localhost:${port}`;

  server = spawn(
    process.execPath,
    [path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), "server.ts"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: String(port),
        CHAT_DATA_DIR: dataDir,
        // Production mode against the prebuilt .next-test: `next dev` allows
        // only one instance per directory, so dev mode would fail whenever the
        // developer already has `npm run dev` running.
        NODE_ENV: "production",
        NEXT_DIST_DIR: TEST_DIST_DIR,
        AUTH_SECRET: "test-secret-not-used-anywhere-real",
        // Lets the server print codes instead of emailing them; the suite reads
        // them from stdout.
        AUTH_DEV_CONSOLE_CODES: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Login codes arrive on stdout in dev mode, so both streams are captured.
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => {
      serverOutput += chunk.toString();
    });
  }
  server.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`server exited early (${code}):\n${serverOutput}`);
    }
  });

  // The build is prebuilt by the pretest step, so boot is quick.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`server did not start within 60s:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    await wait(500);
  }
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));

    // tsx spawns a child of its own, so kill the whole tree on Windows.
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }

    // Windows keeps the SQLite file locked until the process is really gone,
    // so wait for the exit before trying to delete the directory.
    await Promise.race([exited, wait(10_000)]);
  }

  if (dataDir) {
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("sign-in with an email code", () => {
  it("creates an account and a session on first correct code", async () => {
    const { cookie } = await signIn("newcomer@example.com");
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=.+`));
  });

  it("marks the session cookie HttpOnly and SameSite", async () => {
    const email = "cookieflags@example.com";
    const mark = serverOutput.length;
    await post("/api/auth/request-code", { email });
    const code = await codeFromConsole(email, mark);
    const verified = await post("/api/auth/verify", { email, code });

    const header = (verified.headers.getSetCookie?.() ?? []).find((value) =>
      value.startsWith(`${SESSION_COOKIE}=`),
    );
    assert.match(header, /HttpOnly/i, "cookie must be HttpOnly");
    assert.match(header, /SameSite=Lax/i, "cookie must be SameSite=Lax");
  });

  it("rejects an incorrect code", async () => {
    const email = "wrongcode@example.com";
    const mark = serverOutput.length;
    await post("/api/auth/request-code", { email });
    const code = await codeFromConsole(email, mark);

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const response = await post("/api/auth/verify", { email, code: wrong });

    assert.equal(response.status, 401);
    assert.equal(sessionCookieFrom(response), null, "no session on a bad code");
  });

  it("refuses to reuse a code that already worked", async () => {
    const email = "replay@example.com";
    const { code } = await signIn(email);

    const again = await post("/api/auth/verify", { email, code });
    assert.equal(again.status, 410, "a consumed code must not work twice");
  });

  it("invalidates an earlier code once a new one is requested", async () => {
    const email = "rotate@example.com";

    const firstMark = serverOutput.length;
    await post("/api/auth/request-code", { email });
    const first = await codeFromConsole(email, firstMark);

    const secondMark = serverOutput.length;
    await post("/api/auth/request-code", { email });
    const second = await codeFromConsole(email, secondMark);
    assert.notEqual(first, second, "a fresh code should be generated");

    // The status is deliberately indistinguishable from any other wrong code:
    // the server does not reveal *why* a code failed. What matters is that the
    // superseded one grants nothing.
    const stale = await post("/api/auth/verify", { email, code: first });
    assert.ok(!stale.ok, "the superseded code must stop working");
    assert.equal(sessionCookieFrom(stale), null, "no session from a stale code");
  });

  it("rejects a malformed address without issuing a code", async () => {
    const response = await post("/api/auth/request-code", { email: "not-an-email" });
    assert.equal(response.status, 400);
  });

  it("signs out and invalidates the session", async () => {
    const { cookie } = await signIn("signout@example.com");

    const loggedOut = await post("/api/auth/logout", {}, cookie);
    assert.equal(loggedOut.status, 200);

    // The cookie value is now meaningless, so the socket must refuse it.
    await assert.rejects(
      connect(cookie),
      "a destroyed session must not open a socket",
    );
  });
});

describe("the socket requires a session", () => {
  it("refuses a connection with no cookie", async () => {
    await assert.rejects(connect(undefined), "anonymous sockets must be refused");
  });

  it("refuses a connection with a bogus token", async () => {
    await assert.rejects(
      connect(`${SESSION_COOKIE}=not-a-real-token`),
      "forged tokens must be refused",
    );
  });
});

describe("joining a room", () => {
  it("acknowledges the join and replays empty history", async () => {
    const socket = await member("lobby1@example.com", "lobby");

    assert.equal(last(socket, "joined").room, "lobby");
    assert.deepEqual(last(socket, "history"), []);
    assert.equal(last(socket, "presence").length, 1);

    socket.disconnect();
  });

  it("takes the display name from the account, not the client", async () => {
    const socket = await connect((await signIn("ada.lovelace@example.com")).cookie);

    // A username in the payload must be ignored entirely.
    socket.emit("join", { room: "identity", username: "Impersonator" });
    await wait(SETTLE_MS);

    assert.equal(last(socket, "joined").username, "ada lovelace");
    assert.deepEqual(last(socket, "presence"), ["ada lovelace"]);

    socket.disconnect();
  });

  it("normalizes the room name", async () => {
    const socket = await member("normalize@example.com");
    await join(socket, "  Mixed Case Room!  ");

    assert.equal(last(socket, "joined").room, "mixed-case-room");
    socket.disconnect();
  });

  it("rejects an unusable room", async () => {
    const socket = await member("badroom@example.com");
    await join(socket, "!!!");

    assert.match(last(socket, "rejected"), /room name is not valid/i);
    socket.disconnect();
  });

  it("reports presence to everyone in the room", async () => {
    const alice = await member("alice.p@example.com", "presence-room");
    const bob = await member("bob.p@example.com", "presence-room");

    assert.deepEqual(last(alice, "presence"), ["alice p", "bob p"]);
    assert.deepEqual(last(bob, "presence"), ["alice p", "bob p"]);

    bob.disconnect();
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "presence"), ["alice p"]);

    alice.disconnect();
  });
});

describe("messaging", () => {
  it("broadcasts a message to the room, sender included", async () => {
    const alice = await member("alice.m@example.com", "talk");
    const bob = await member("bob.m@example.com", "talk");

    alice.emit("message", { text: "hello bob" });
    await wait(SETTLE_MS);

    for (const [who, socket] of [
      ["sender", alice],
      ["peer", bob],
    ]) {
      const message = last(socket, "message");
      assert.equal(message.text, "hello bob", `${who} received the text`);
      assert.equal(message.username, "alice m");
      assert.equal(message.room, "talk");
      assert.ok(message.id, "message has an id");
      assert.equal(typeof message.createdAt, "number");
    }

    alice.disconnect();
    bob.disconnect();
  });

  it("refuses messages before a join", async () => {
    const socket = await member("early@example.com");
    socket.emit("message", { text: "too early" });
    await wait(SETTLE_MS);

    assert.match(last(socket, "rejected"), /join a room/i);
    assert.equal(countOf(socket, "message"), 0);

    socket.disconnect();
  });

  it("drops blank messages without rejecting the sender", async () => {
    const socket = await member("blank@example.com", "blank");

    socket.emit("message", { text: "   " });
    await wait(SETTLE_MS);

    assert.equal(countOf(socket, "message"), 0);
    socket.disconnect();
  });

  it("does not leak messages into another room", async () => {
    const here = await member("here@example.com", "room-a");
    const elsewhere = await member("elsewhere@example.com", "room-b");

    here.emit("message", { text: "only for room-a" });
    await wait(SETTLE_MS);

    assert.equal(countOf(here, "message"), 1);
    assert.equal(countOf(elsewhere, "message"), 0);

    here.disconnect();
    elsewhere.disconnect();
  });

  it("rate limits a sender past the burst allowance", async () => {
    const socket = await member("spammer@example.com", "spam");

    for (let i = 0; i < 20; i += 1) socket.emit("message", { text: `spam ${i}` });
    await wait(1000);

    assert.ok(countOf(socket, "rejected") > 0, "expected a rate-limit rejection");
    assert.ok(
      countOf(socket, "message") <= 15,
      `expected at most 15 delivered, got ${countOf(socket, "message")}`,
    );

    socket.disconnect();
  });

  it("keeps the rate limit across a reconnect", async () => {
    const email = "persistent.spammer@example.com";
    const { cookie } = await signIn(email);

    const first = await connect(cookie);
    await join(first, "spam2");
    for (let i = 0; i < 20; i += 1) first.emit("message", { text: `burst ${i}` });
    await wait(1000);
    const deliveredFirst = countOf(first, "message");
    first.disconnect();
    await wait(SETTLE_MS);

    // Reconnecting must not hand out a fresh allowance: the limit follows the
    // account, not the socket.
    const second = await connect(cookie);
    await join(second, "spam2");
    for (let i = 0; i < 10; i += 1) second.emit("message", { text: `after ${i}` });
    await wait(1000);

    const total = deliveredFirst + countOf(second, "message");
    assert.ok(
      total <= 15,
      `reconnect reset the limiter: ${total} messages delivered in one window`,
    );

    second.disconnect();
  });
});

describe("typing indicators", () => {
  it("shows the typist to others but not to themselves", async () => {
    const alice = await member("alice.t@example.com", "typing-room");
    const bob = await member("bob.t@example.com", "typing-room");

    bob.emit("typing", { isTyping: true });
    await wait(SETTLE_MS);

    assert.deepEqual(last(alice, "typing"), ["bob t"]);
    assert.deepEqual(last(bob, "typing"), []);

    bob.emit("typing", { isTyping: false });
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "typing"), []);

    alice.disconnect();
    bob.disconnect();
  });

  it("clears the indicator when the typist sends", async () => {
    const alice = await member("alice.s@example.com", "typing-send");
    const bob = await member("bob.s@example.com", "typing-send");

    bob.emit("typing", { isTyping: true });
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "typing"), ["bob s"]);

    bob.emit("message", { text: "done typing" });
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "typing"), []);

    alice.disconnect();
    bob.disconnect();
  });
});

describe("persisted history", () => {
  it("replays earlier messages to someone who joins later", async () => {
    const early = await member("early.h@example.com", "history-room");
    early.emit("message", { text: "first" });
    await wait(200);
    early.emit("message", { text: "second" });
    await wait(SETTLE_MS);
    early.disconnect();
    await wait(SETTLE_MS);

    const late = await member("late.h@example.com", "history-room");

    assert.deepEqual(
      last(late, "history").map((message) => message.text),
      ["first", "second"],
      "history arrives oldest-first",
    );

    late.disconnect();
  });
});

describe("the profile endpoint", () => {
  it("renames the account and uses the new name in a room", async () => {
    const { cookie } = await signIn("renamer@example.com");

    const response = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ displayName: "Grace H" }),
    });
    assert.equal(response.status, 200);

    const socket = await connect(cookie);
    await join(socket, "renamed");
    assert.equal(last(socket, "joined").username, "Grace H");

    socket.disconnect();
  });

  it("refuses an empty name", async () => {
    const { cookie } = await signIn("emptyname@example.com");

    const response = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ displayName: "   " }),
    });
    assert.equal(response.status, 400);
  });

  it("refuses an unauthenticated rename", async () => {
    const response = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Nobody" }),
    });
    assert.equal(response.status, 401);
  });
});
