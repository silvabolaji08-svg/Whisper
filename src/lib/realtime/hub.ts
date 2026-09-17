import { EventEmitter } from "node:events";

import type { ServerFrame } from "./protocol";

/**
 * Cross-instance state for the realtime layer: who is in a room, who is
 * typing, how many messages an account has sent, and the fan-out of frames.
 *
 * Vercel pins a WebSocket to one function instance and makes no promise that
 * the next connection lands on the same one, so none of this can live in a
 * plain module-level Map in production. With `REDIS_URL` set every instance
 * shares one view; without it the in-process backend is used, which is exactly
 * equivalent while there is only one instance (local development and tests).
 */

export const PRESENCE_TTL_MS = 30_000;
export const TYPING_TTL_MS = 4_000;
const SEND_WINDOW_MS = 10_000;
const SEND_LIMIT = 15;

/** A member of a room, as tracked for presence. */
type Member = { connectionId: string; username: string; expiresAt: number };
type Typist = { connectionId: string; username: string; expiresAt: number };

export interface Hub {
  /** Records or refreshes a connection's membership of a room. */
  join(room: string, connectionId: string, username: string): Promise<void>;
  leave(room: string, connectionId: string): Promise<void>;
  members(room: string): Promise<string[]>;

  setTyping(
    room: string,
    connectionId: string,
    username: string,
    isTyping: boolean,
  ): Promise<void>;
  /** Typists in a room, excluding the asking connection's own entry. */
  typists(room: string, excludeConnectionId: string): Promise<string[]>;

  /** False when the account has exceeded its burst allowance. */
  allowSend(userId: string): Promise<boolean>;

  /** Delivers a frame to every connection in a room, on every instance. */
  publish(room: string, frame: ServerFrame): Promise<void>;
  /** Registers the local delivery callback. Called once per process. */
  onPublish(handler: (room: string, frame: ServerFrame) => void): void;

  close(): Promise<void>;
}

const alphabetical = (a: string, b: string) => a.localeCompare(b);
const fresh = <T extends { expiresAt: number }>(entries: T[], now: number) =>
  entries.filter((entry) => entry.expiresAt > now);

/* -------------------------------------------------------------------------- */
/* In-process backend                                                          */
/* -------------------------------------------------------------------------- */

class MemoryHub implements Hub {
  private rooms = new Map<string, Member[]>();
  private typing = new Map<string, Typist[]>();
  private sends = new Map<string, number[]>();
  private bus = new EventEmitter();

  async join(room: string, connectionId: string, username: string) {
    const now = Date.now();
    const current = fresh(this.rooms.get(room) ?? [], now).filter(
      (member) => member.connectionId !== connectionId,
    );
    current.push({ connectionId, username, expiresAt: now + PRESENCE_TTL_MS });
    this.rooms.set(room, current);
  }

  async leave(room: string, connectionId: string) {
    const current = (this.rooms.get(room) ?? []).filter(
      (member) => member.connectionId !== connectionId,
    );
    if (current.length) this.rooms.set(room, current);
    else this.rooms.delete(room);

    const typists = (this.typing.get(room) ?? []).filter(
      (entry) => entry.connectionId !== connectionId,
    );
    if (typists.length) this.typing.set(room, typists);
    else this.typing.delete(room);
  }

  async members(room: string) {
    const now = Date.now();
    const current = fresh(this.rooms.get(room) ?? [], now);
    this.rooms.set(room, current);
    return [...new Set(current.map((member) => member.username))].sort(alphabetical);
  }

  async setTyping(
    room: string,
    connectionId: string,
    username: string,
    isTyping: boolean,
  ) {
    const now = Date.now();
    const current = fresh(this.typing.get(room) ?? [], now).filter(
      (entry) => entry.connectionId !== connectionId,
    );
    if (isTyping) {
      current.push({ connectionId, username, expiresAt: now + TYPING_TTL_MS });
    }
    this.typing.set(room, current);
  }

  async typists(room: string, excludeConnectionId: string) {
    const now = Date.now();
    const current = fresh(this.typing.get(room) ?? [], now);
    this.typing.set(room, current);
    return [
      ...new Set(
        current
          .filter((entry) => entry.connectionId !== excludeConnectionId)
          .map((entry) => entry.username),
      ),
    ].sort(alphabetical);
  }

  async allowSend(userId: string) {
    const now = Date.now();
    const recent = (this.sends.get(userId) ?? []).filter(
      (at) => now - at < SEND_WINDOW_MS,
    );
    if (recent.length >= SEND_LIMIT) {
      this.sends.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.sends.set(userId, recent);
    return true;
  }

  async publish(room: string, frame: ServerFrame) {
    this.bus.emit("frame", room, frame);
  }

  onPublish(handler: (room: string, frame: ServerFrame) => void) {
    this.bus.removeAllListeners("frame");
    this.bus.on("frame", handler);
  }

  async close() {
    this.bus.removeAllListeners();
  }
}

/* -------------------------------------------------------------------------- */
/* Redis backend                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Only the commands this file uses, typed structurally.
 *
 * node-redis's own client type is heavily generic and awkward to name across
 * versions; pinning the surface here keeps the dependency explicit and the
 * build stable across minor upgrades.
 */
type RedisLike = {
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRemRangeByScore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<unknown>;
  zRangeByScore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]>;
  zRem(key: string, members: string | string[]): Promise<unknown>;
  pExpire(key: string, ms: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<unknown>;
  quit(): Promise<unknown>;
};

const CHANNEL = "chat:frames";
const presenceKey = (room: string) => `chat:presence:${room}`;
const typingKey = (room: string) => `chat:typing:${room}`;
const sendsKey = (userId: string) => `chat:sends:${userId}`;

class RedisHub implements Hub {
  private handler: ((room: string, frame: ServerFrame) => void) | null = null;

  constructor(
    private readonly publisher: RedisLike,
    private readonly subscriber: RedisLike,
  ) {}

  static async create(url: string): Promise<RedisHub> {
    const { createClient } = await import("redis");
    const publisher = createClient({ url });
    const subscriber = publisher.duplicate();
    // The structural type above covers what RedisHub calls.
    const pub = publisher as unknown as RedisLike;
    const sub = subscriber as unknown as RedisLike;
    // Without a listener a connection error becomes an unhandled rejection.
    publisher.on("error", (error) => console.error("Redis (publisher):", error));
    subscriber.on("error", (error) => console.error("Redis (subscriber):", error));
    await Promise.all([publisher.connect(), subscriber.connect()]);

    const hub = new RedisHub(pub, sub);
    await sub.subscribe(CHANNEL, (payload: string) => {
      try {
        const { room, frame } = JSON.parse(payload) as {
          room: string;
          frame: ServerFrame;
        };
        hub.handler?.(room, frame);
      } catch (error) {
        console.error("Dropped a malformed frame from Redis:", error);
      }
    });
    return hub;
  }

  /**
   * Presence and typing are sorted sets scored by expiry, so a instance that
   * dies without cleaning up simply ages out instead of haunting the room.
   */
  private async touch(key: string, member: string, ttlMs: number) {
    const now = Date.now();
    await this.publisher.zAdd(key, { score: now + ttlMs, value: member });
    await this.publisher.zRemRangeByScore(key, 0, now);
    await this.publisher.pExpire(key, ttlMs * 2);
  }

  private async live(key: string): Promise<string[]> {
    const now = Date.now();
    await this.publisher.zRemRangeByScore(key, 0, now);
    return this.publisher.zRangeByScore(key, now, "+inf");
  }

  // Entries are "<connectionId> <username>" so one person with two tabs
  // is two entries but one name.
  private static pack = (connectionId: string, username: string) =>
    `${connectionId} ${username}`;
  private static nameOf = (entry: string) => entry.split(" ")[1] ?? "";
  private static idOf = (entry: string) => entry.split(" ")[0] ?? "";

  async join(room: string, connectionId: string, username: string) {
    await this.touch(
      presenceKey(room),
      RedisHub.pack(connectionId, username),
      PRESENCE_TTL_MS,
    );
  }

  async leave(room: string, connectionId: string) {
    for (const key of [presenceKey(room), typingKey(room)]) {
      const entries = await this.live(key);
      const mine = entries.filter((e) => RedisHub.idOf(e) === connectionId);
      if (mine.length) await this.publisher.zRem(key, mine);
    }
  }

  async members(room: string) {
    const entries = await this.live(presenceKey(room));
    return [...new Set(entries.map(RedisHub.nameOf))].sort(alphabetical);
  }

  async setTyping(
    room: string,
    connectionId: string,
    username: string,
    isTyping: boolean,
  ) {
    const key = typingKey(room);
    const entry = RedisHub.pack(connectionId, username);
    if (isTyping) await this.touch(key, entry, TYPING_TTL_MS);
    else await this.publisher.zRem(key, entry);
  }

  async typists(room: string, excludeConnectionId: string) {
    const entries = await this.live(typingKey(room));
    return [
      ...new Set(
        entries
          .filter((e) => RedisHub.idOf(e) !== excludeConnectionId)
          .map(RedisHub.nameOf),
      ),
    ].sort(alphabetical);
  }

  /** A fixed window per account: one INCR, with the TTL set on first use. */
  async allowSend(userId: string) {
    const key = sendsKey(userId);
    const count = await this.publisher.incr(key);
    if (count === 1) await this.publisher.pExpire(key, SEND_WINDOW_MS);
    return count <= SEND_LIMIT;
  }

  async publish(room: string, frame: ServerFrame) {
    await this.publisher.publish(CHANNEL, JSON.stringify({ room, frame }));
  }

  onPublish(handler: (room: string, frame: ServerFrame) => void) {
    this.handler = handler;
  }

  async close() {
    this.handler = null;
    await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

// Cached on globalThis for the same reason as the database connection: this
// module is instantiated once by server.ts and again by Next's bundle.
const CACHE = Symbol.for("realtime-chat.hub");
type Cache = { hub: Promise<Hub> | null };
const globalCache = globalThis as unknown as Record<symbol, Cache | undefined>;
globalCache[CACHE] ??= { hub: null };
const cache = globalCache[CACHE]!;

/**
 * Says plainly that this instance cannot see the others.
 *
 * Without shared state the failure is invisible from the inside: each instance
 * works perfectly, and only a person whose message never arrives would notice.
 * Anywhere that runs more than one instance, that has to be said out loud.
 */
function warnAboutIsolatedState(reason: string): void {
  // VERCEL is set in every deployment there; a long-lived host runs one process
  // and is genuinely fine without Redis.
  if (!process.env.VERCEL) return;

  console.warn(
    [
      "",
      "  ⚠ REDIS_URL is not configured, so presence and message delivery are",
      `    limited to a single instance (${reason}).`,
      "",
      "    Vercel pins a WebSocket to one instance and makes no promise the",
      "    next connection lands on the same one. Two people on different",
      "    instances will not see each other's messages, and nothing will",
      "    report an error when that happens.",
      "",
      "    Fix: create a free database at https://upstash.com, then set",
      "    REDIS_URL to its rediss:// URL (not the https:// REST one).",
      "",
    ].join("\n"),
  );
}

export function getHub(): Promise<Hub> {
  cache.hub ??= (async () => {
    const url = process.env.REDIS_URL;
    if (!url) {
      warnAboutIsolatedState("no REDIS_URL set");
      return new MemoryHub();
    }
    try {
      return await RedisHub.create(url);
    } catch (error) {
      // A chat that works on one instance beats one that will not start.
      console.error("Redis unavailable, falling back to in-process state:", error);
      warnAboutIsolatedState("Redis could not be reached");
      return new MemoryHub();
    }
  })().catch((error) => {
    cache.hub = null;
    throw error;
  });

  return cache.hub;
}

export async function closeHub(): Promise<void> {
  if (!cache.hub) return;
  const hub = await cache.hub.catch(() => null);
  cache.hub = null;
  await hub?.close();
}
