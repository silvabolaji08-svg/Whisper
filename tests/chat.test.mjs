/**
 * End-to-end tests for the realtime layer.
 *
 * These drive the actual server over real Socket.IO connections rather than
 * stubbing it, so they cover the parts that only break in integration:
 * broadcast fan-out, presence bookkeeping, SQLite history replay and the
 * rate limiter.
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

/** A connected client that records every server event for later assertions. */
async function connect() {
  const socket = io(baseUrl, { path: SOCKET_PATH, transports: ["websocket"] });
  socket.events = [];
  for (const name of [
    "history",
    "message",
    "presence",
    "typing",
    "joined",
    "rejected",
  ]) {
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

async function join(socket, room, username) {
  socket.emit("join", { room, username });
  await wait(SETTLE_MS);
}

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "realtime-chat-test-"));
  const port = await freePort();
  baseUrl = `http://localhost:${port}`;

  server = spawn(
    process.execPath,
    [path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), "server.ts"],
    {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(port), CHAT_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  server.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`server exited early (${code}):\n${stderr}`);
    }
  });

  // `next dev` compiles on boot, so allow a generous window before giving up.
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`server did not start within 120s:\n${stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/`);
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
      spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    } else {
      server.kill("SIGTERM");
    }

    // Windows keeps the SQLite file locked until the process is really gone,
    // so wait for the exit before trying to delete the directory.
    await Promise.race([exited, wait(10_000)]);
  }

  if (dataDir) {
    // retryDelay/maxRetries covers the brief window where the handle lingers.
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});

describe("joining a room", () => {
  it("acknowledges the join and replays empty history", async () => {
    const socket = await connect();
    await join(socket, "lobby", "Alice");

    assert.deepEqual(last(socket, "joined"), { room: "lobby", username: "Alice" });
    assert.deepEqual(last(socket, "history"), []);
    assert.deepEqual(last(socket, "presence"), ["Alice"]);

    socket.disconnect();
  });

  it("normalizes the room name", async () => {
    const socket = await connect();
    await join(socket, "  Mixed Case Room!  ", "Alice");

    assert.equal(last(socket, "joined").room, "mixed-case-room");
    socket.disconnect();
  });

  it("rejects an unusable room or name", async () => {
    const socket = await connect();

    await join(socket, "!!!", "Alice");
    assert.match(last(socket, "rejected"), /room name is not valid/i);

    await join(socket, "lobby", "   ");
    assert.match(last(socket, "rejected"), /display name/i);

    socket.disconnect();
  });

  it("reports presence to everyone in the room", async () => {
    const alice = await connect();
    const bob = await connect();
    await join(alice, "presence-room", "Alice");
    await join(bob, "presence-room", "Bob");

    assert.deepEqual(last(alice, "presence"), ["Alice", "Bob"]);
    assert.deepEqual(last(bob, "presence"), ["Alice", "Bob"]);

    bob.disconnect();
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "presence"), ["Alice"]);

    alice.disconnect();
  });
});

describe("messaging", () => {
  it("broadcasts a message to the room, sender included", async () => {
    const alice = await connect();
    const bob = await connect();
    await join(alice, "talk", "Alice");
    await join(bob, "talk", "Bob");

    alice.emit("message", { text: "hello bob" });
    await wait(SETTLE_MS);

    for (const [who, socket] of [
      ["sender", alice],
      ["peer", bob],
    ]) {
      const message = last(socket, "message");
      assert.equal(message.text, "hello bob", `${who} received the text`);
      assert.equal(message.username, "Alice");
      assert.equal(message.room, "talk");
      assert.ok(message.id, "message has an id");
      assert.equal(typeof message.createdAt, "number");
    }

    alice.disconnect();
    bob.disconnect();
  });

  it("refuses messages before a join", async () => {
    const socket = await connect();
    socket.emit("message", { text: "too early" });
    await wait(SETTLE_MS);

    assert.match(last(socket, "rejected"), /join a room/i);
    assert.equal(countOf(socket, "message"), 0);

    socket.disconnect();
  });

  it("drops blank messages without rejecting the sender", async () => {
    const socket = await connect();
    await join(socket, "blank", "Alice");

    socket.emit("message", { text: "   " });
    await wait(SETTLE_MS);

    assert.equal(countOf(socket, "message"), 0);
    socket.disconnect();
  });

  it("does not leak messages into another room", async () => {
    const here = await connect();
    const elsewhere = await connect();
    await join(here, "room-a", "Alice");
    await join(elsewhere, "room-b", "Bob");

    here.emit("message", { text: "only for room-a" });
    await wait(SETTLE_MS);

    assert.equal(countOf(here, "message"), 1);
    assert.equal(countOf(elsewhere, "message"), 0);

    here.disconnect();
    elsewhere.disconnect();
  });

  it("rate limits a sender past the burst allowance", async () => {
    const socket = await connect();
    await join(socket, "spam", "Alice");

    for (let i = 0; i < 20; i += 1) socket.emit("message", { text: `spam ${i}` });
    await wait(1000);

    assert.ok(
      countOf(socket, "rejected") > 0,
      "expected at least one rate-limit rejection",
    );
    assert.ok(
      countOf(socket, "message") <= 15,
      `expected at most 15 delivered, got ${countOf(socket, "message")}`,
    );

    socket.disconnect();
  });
});

describe("typing indicators", () => {
  it("shows the typist to others but not to themselves", async () => {
    const alice = await connect();
    const bob = await connect();
    await join(alice, "typing-room", "Alice");
    await join(bob, "typing-room", "Bob");

    bob.emit("typing", { isTyping: true });
    await wait(SETTLE_MS);

    assert.deepEqual(last(alice, "typing"), ["Bob"]);
    assert.deepEqual(last(bob, "typing"), []);

    bob.emit("typing", { isTyping: false });
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "typing"), []);

    alice.disconnect();
    bob.disconnect();
  });

  it("clears the indicator when the typist sends", async () => {
    const alice = await connect();
    const bob = await connect();
    await join(alice, "typing-send", "Alice");
    await join(bob, "typing-send", "Bob");

    bob.emit("typing", { isTyping: true });
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "typing"), ["Bob"]);

    bob.emit("message", { text: "done typing" });
    await wait(SETTLE_MS);
    assert.deepEqual(last(alice, "typing"), []);

    alice.disconnect();
    bob.disconnect();
  });
});

describe("persisted history", () => {
  it("replays earlier messages to someone who joins later", async () => {
    const early = await connect();
    await join(early, "history-room", "Alice");
    early.emit("message", { text: "first" });
    await wait(200);
    early.emit("message", { text: "second" });
    await wait(SETTLE_MS);
    early.disconnect();
    await wait(SETTLE_MS);

    const late = await connect();
    await join(late, "history-room", "Dave");

    const history = last(late, "history");
    assert.deepEqual(
      history.map((message) => message.text),
      ["first", "second"],
      "history arrives oldest-first",
    );

    late.disconnect();
  });
});
