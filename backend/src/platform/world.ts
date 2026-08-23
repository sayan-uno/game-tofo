// Worlds: the public rooms behind World chat.
//
// A world is a thousand people who can all hear each other. That number is the
// whole design: small enough that the room reads as a place (you see the same
// names again), large enough that it never feels empty. When a world fills
// with REAL players, the next one opens by itself — nobody provisions a world,
// and no configuration change is needed to run ten of them.
//
// THE TWO RULES, from which the rest falls out:
//
//   1. A real player always gets a seat. Capacity counts humans and bots
//      together, so a full world is only ever full of PEOPLE — if the thousand
//      includes bots, one of them stands down at the door. This is what the
//      "somebody goes offline and either a bot or a human takes the place"
//      behaviour actually is, seen from the other side.
//   2. Population is a property of the world, not of who happens to be online.
//      Bots top it up towards a target that drifts slowly, so a world does not
//      sit at exactly 1000/1000 all evening — which would be the tell.
//
// ALL OF IT IS REDIS. A world has a member list that changes many times a
// second at scale, and a chat that changes faster; none of that may touch
// Postgres (see the UX rule). What Postgres gets is the message archive, and
// even that is written by a buffered writer off the hot path — see
// services/worldChat.ts.
import { randomUUID } from "node:crypto";
import { redis } from "../redis.js";
import { getBots, releaseBots, takeBots, type BotAccount } from "./botAccounts.js";

/** Humans + bots. The number a player sees next to the world's name. */
export const WORLD_CAPACITY = 1000;

/** How long a human's membership survives without a refresh. Longer than the
 *  presence TTL on purpose: a phone that drops for twenty seconds should come
 *  back to the same world and the same conversation, not be re-shuffled. */
const MEMBER_TTL_MS = 5 * 60_000;

/** Messages kept in the live ring. What a player sees on opening the tab —
 *  deliberately short, because a public room's backlog is noise after a
 *  minute and the archive (Postgres) is where questions get answered. */
export const WORLD_BACKLOG = 60;
const RING_TTL = 6 * 60 * 60;

/** How long an unanswered "team up" post stands before it is taken down. */
export const REQUEST_TTL_MS = 90_000;

/** How long a post waits for a REAL player before bots fill the group. The
 *  same ten seconds matchmaking waits, and for the same reason: long enough to
 *  find somebody at a healthy hour, short enough that nobody stares at it. */
export const REQUEST_FILL_MS = 10_000;

const worldsKey = "world:ids";
const seqKey = "world:seq";
const humansKey = (id: string) => `world:${id}:humans`;
const botsKey = (id: string) => `world:${id}:bots`;
const ringKey = (id: string) => `world:${id}:msgs`;
const reqKey = (id: string) => `world:${id}:reqs`;
const driftKey = (id: string) => `world:${id}:drift`;
const userWorldKey = (userId: string) => `user:world:${userId}`;

export const isWorldId = (v: unknown): v is string => typeof v === "string" && /^W\d{1,6}$/.test(v);

// ---------------------------------------------------------------------------
// The list of worlds
// ---------------------------------------------------------------------------

/** Every world that exists, in the order they were opened. */
export async function listWorldIds(): Promise<string[]> {
  return redis.zrange(worldsKey, 0, -1);
}

async function openWorld(): Promise<string> {
  const n = await redis.incr(seqKey);
  const id = `W${n}`;
  await redis.zadd(worldsKey, n, id);
  console.info(`[world] opened ${id} (capacity ${WORLD_CAPACITY})`);
  return id;
}

/** There is always at least one. Called at boot and by the first joiner. */
export async function ensureFirstWorld(): Promise<string> {
  const [first] = await listWorldIds();
  return first ?? openWorld();
}

export const humanCount = (id: string): Promise<number> => redis.zcard(humansKey(id));
export const botCount = (id: string): Promise<number> => redis.zcard(botsKey(id));

export interface WorldCounts {
  id: string;
  humans: number;
  bots: number;
  total: number;
  capacity: number;
}

export async function worldCounts(id: string): Promise<WorldCounts> {
  const [humans, bots] = await Promise.all([humanCount(id), botCount(id)]);
  return { id, humans, bots, total: humans + bots, capacity: WORLD_CAPACITY };
}

export async function allWorldCounts(): Promise<WorldCounts[]> {
  const ids = await listWorldIds();
  return Promise.all(ids.map(worldCounts));
}

// ---------------------------------------------------------------------------
// People coming and going
// ---------------------------------------------------------------------------

/** Which world this player is in, without joining one. */
export const getUserWorld = (userId: string): Promise<string | null> => redis.get(userWorldKey(userId));

/** Say this player is still here. One ZADD; called on the same heartbeat the
 *  lobby already sends, so it costs no extra message. */
export async function touchWorld(userId: string): Promise<void> {
  const id = await getUserWorld(userId);
  if (!id) return;
  await redis
    .multi()
    .zadd(humansKey(id), Date.now(), userId)
    .expire(userWorldKey(userId), Math.round(MEMBER_TTL_MS / 1000))
    .exec();
}

/** Put this player in a world and return which one.
 *
 *  Sticky: somebody who is already in a world stays there, so a reconnect does
 *  not move them away from the conversation they were having. Otherwise the
 *  FIRST world with room takes them — worlds fill in order rather than
 *  spreading thin, because a hundred people in one room is a place and ten
 *  people in ten rooms is nowhere. */
export async function joinWorld(userId: string): Promise<string> {
  const existing = await getUserWorld(userId);
  if (existing && (await redis.zscore(worldsKey, existing)) !== null) {
    await redis
      .multi()
      .zadd(humansKey(existing), Date.now(), userId)
      .set(userWorldKey(userId), existing, "EX", Math.round(MEMBER_TTL_MS / 1000))
      .exec();
    return existing;
  }

  const ids = await listWorldIds();
  let target: string | null = null;
  for (const id of ids) {
    // Only PEOPLE fill a world for this purpose. If the seat is held by a bot,
    // the bot moves — see below.
    if ((await humanCount(id)) < WORLD_CAPACITY) {
      target = id;
      break;
    }
  }
  if (!target) target = await openWorld();

  // Make room. A world at capacity with bots in it has a seat for a person;
  // the bot that has been there least long is the one that goes.
  const total = (await humanCount(target)) + (await botCount(target));
  if (total >= WORLD_CAPACITY) await evictBots(target, total - WORLD_CAPACITY + 1);

  await redis
    .multi()
    .zadd(humansKey(target), Date.now(), userId)
    .set(userWorldKey(userId), target, "EX", Math.round(MEMBER_TTL_MS / 1000))
    .exec();
  return target;
}

/** Take this player out. Their seat is left empty on purpose — the world tick
 *  decides whether a bot fills it, which is what keeps the population moving
 *  rather than snapping back to the same number instantly. */
export async function leaveWorld(userId: string): Promise<string | null> {
  const id = await getUserWorld(userId);
  if (!id) return null;
  await redis.multi().zrem(humansKey(id), userId).del(userWorldKey(userId)).exec();
  return id;
}

/** Human members, most recently seen first. Ids only — the caller resolves
 *  them, because who needs a name and who needs a whole row differs. */
export async function worldHumanIds(id: string, offset = 0, limit = 100): Promise<string[]> {
  return redis.zrevrange(humansKey(id), offset, offset + limit - 1);
}

export async function worldBotIds(id: string, offset = 0, limit = 100): Promise<string[]> {
  return redis.zrevrange(botsKey(id), offset, offset + limit - 1);
}

/** Members whose last sign of life is older than the TTL. A player whose
 *  phone died mid-conversation has no disconnect to fire, and a world that
 *  never forgets them slowly fills with ghosts. */
export async function sweepStaleMembers(id: string): Promise<number> {
  const cutoff = Date.now() - MEMBER_TTL_MS;
  const stale = await redis.zrangebyscore(humansKey(id), 0, cutoff);
  if (stale.length === 0) return 0;
  const m = redis.multi();
  m.zrem(humansKey(id), ...stale);
  for (const userId of stale) m.del(userWorldKey(userId));
  await m.exec();
  return stale.length;
}

// ---------------------------------------------------------------------------
// The bots that make up the rest of the room
// ---------------------------------------------------------------------------

export async function addWorldBots(id: string, bots: BotAccount[]): Promise<void> {
  if (bots.length === 0) return;
  const now = Date.now();
  const m = redis.multi();
  bots.forEach((b, i) => m.zadd(botsKey(id), now + i, b.id));
  await m.exec();
}

/** Remove `count` bots, oldest first, and give them back to the pool. */
export async function evictBots(id: string, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const ids = await redis.zrange(botsKey(id), 0, count - 1);
  if (ids.length === 0) return [];
  await redis.zrem(botsKey(id), ...ids);
  releaseBots(ids);
  return ids;
}

/** Remove named bots — one deciding to log off for the evening. */
export async function removeWorldBots(id: string, botIds: string[]): Promise<void> {
  if (botIds.length === 0) return;
  await redis.zrem(botsKey(id), ...botIds);
  releaseBots(botIds);
}

/** The population this world is aiming at right now.
 *
 *  Not the capacity. A slow random walk a little under it, so the number on
 *  screen breathes the way a real room's does — people leave, people arrive,
 *  and it is never the same round figure twice. Stored in Redis so every tick
 *  and every process agrees on it. */
export async function targetPopulation(id: string): Promise<number> {
  const raw = await redis.get(driftKey(id));
  let drift = raw === null ? Math.floor(Math.random() * 60) : Number(raw);
  if (!Number.isFinite(drift)) drift = 0;
  // ±6 a tick, clamped: enough to move visibly over a minute, never enough to
  // look like a crash or a flood.
  drift = Math.min(120, Math.max(0, drift + Math.round((Math.random() - 0.5) * 12)));
  await redis.set(driftKey(id), String(drift), "EX", 6 * 60 * 60);
  return WORLD_CAPACITY - drift;
}

/** Bring this world's bot population to where it should be. Returns what
 *  changed, for the log. */
export async function balanceBots(id: string): Promise<{ added: number; removed: number }> {
  const [humans, bots, target] = await Promise.all([humanCount(id), botCount(id), targetPopulation(id)]);
  const want = Math.max(0, Math.min(WORLD_CAPACITY - humans, target - humans));
  if (want > bots) {
    // Never in one leap: a hundred people appearing in a room at once is not
    // something that happens. Arrivals are spread over the following ticks.
    const step = Math.min(want - bots, Math.max(3, Math.ceil((want - bots) / 6)));
    const taken = await takeBots(step, new Set(await redis.zrange(botsKey(id), 0, -1)));
    await addWorldBots(id, taken);
    return { added: taken.length, removed: 0 };
  }
  if (bots > want) {
    const step = Math.min(bots - want, Math.max(2, Math.ceil((bots - want) / 6)));
    const gone = await evictBots(id, step);
    return { added: 0, removed: gone.length };
  }
  return { added: 0, removed: 0 };
}

/** A random slice of the bots standing in this world, resolved.
 *
 *  A WINDOW rather than the whole set: the chatter engine only ever needs a
 *  few, and pulling a thousand ids out of Redis every second to pick three of
 *  them is exactly the kind of waste that is invisible until it is not.
 *  ZRANDMEMBER would say this more directly but needs Redis 6.2; a random
 *  offset works everywhere and costs the same. */
export async function worldBots(id: string, limit = 40): Promise<BotAccount[]> {
  const total = await botCount(id);
  if (total === 0) return [];
  const offset = total > limit ? Math.floor(Math.random() * (total - limit)) : 0;
  return getBots(await redis.zrange(botsKey(id), offset, offset + limit - 1));
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

/** As stored in the ring. `botId` never leaves the server for a player — see
 *  `toPublicMessage` — but the console needs it, and a message whose author
 *  cannot be identified is no use to moderation. */
export interface WorldMessageRecord {
  id: string;
  uid: string;
  name: string;
  body: string;
  at: number;
  userId: string | null;
  botId: string | null;
}

/** What a player receives. Deliberately contains nothing that could separate a
 *  bot's line from a person's. */
export interface WorldMessageView {
  id: string;
  uid: string;
  name: string;
  body: string;
  at: number;
}

export const toPublicMessage = (m: WorldMessageRecord): WorldMessageView => ({
  id: m.id,
  uid: m.uid,
  name: m.name,
  body: m.body,
  at: m.at,
});

export async function pushMessage(
  id: string,
  msg: Omit<WorldMessageRecord, "id" | "at"> & { id?: string; at?: number }
): Promise<WorldMessageRecord> {
  const record: WorldMessageRecord = {
    id: msg.id ?? randomUUID(),
    uid: msg.uid,
    name: msg.name,
    body: msg.body,
    at: msg.at ?? Date.now(),
    userId: msg.userId,
    botId: msg.botId,
  };
  await redis
    .multi()
    .lpush(ringKey(id), JSON.stringify(record))
    .ltrim(ringKey(id), 0, WORLD_BACKLOG - 1)
    .expire(ringKey(id), RING_TTL)
    .exec();
  return record;
}

/** The live backlog, oldest first (the order a chat window wants). */
export async function recentMessages(id: string, limit = WORLD_BACKLOG): Promise<WorldMessageRecord[]> {
  const raw = await redis.lrange(ringKey(id), 0, limit - 1);
  const out: WorldMessageRecord[] = [];
  for (const line of raw) {
    try {
      out.push(JSON.parse(line) as WorldMessageRecord);
    } catch {
      // A corrupt ring entry is not worth failing a chat window over.
    }
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// "Anyone want to team up?"
// ---------------------------------------------------------------------------

/** A group advertised in a world. The same shape whether a person or a bot
 *  posted it — `botId` is the server's business and is stripped on the way
 *  out, exactly like a message. */
export interface WorldRequest {
  id: string;
  worldId: string;
  /** Who is asking, as the room sees them. */
  uid: string;
  name: string;
  /** The party being advertised. Empty for a bot's post: there is no real
   *  lobby behind it until somebody walks in, and one is made then. */
  lobbyId: string;
  /** duo | squad — what the group is being built as. */
  mode: "duo" | "squad";
  /** Seats still open at the moment of the post. Recomputed on join. */
  need: number;
  /** Which game they want to play, if they have picked one. */
  gameId: string | null;
  at: number;
  expiresAt: number;
  /** When the empty seats get filled by bots. */
  fillAt: number;
  userId: string | null;
  botId: string | null;
  /** Bots already standing in a bot-posted group, so joining it puts you
   *  beside the same names the post promised. */
  withBotIds: string[];
}

export interface WorldRequestView {
  id: string;
  uid: string;
  name: string;
  mode: "duo" | "squad";
  need: number;
  gameId: string | null;
  at: number;
}

/** No per-viewer field, on purpose: a card goes to the whole room in ONE
 *  serialisation, so "is this mine" cannot live in it — it would be whoever
 *  the broadcast happened to be built for. The client compares uids. */
export const toPublicRequest = (r: WorldRequest): WorldRequestView => ({
  id: r.id,
  uid: r.uid,
  name: r.name,
  mode: r.mode,
  need: r.need,
  gameId: r.gameId,
  at: r.at,
});

export async function putRequest(req: WorldRequest): Promise<void> {
  await redis
    .multi()
    .hset(reqKey(req.worldId), req.id, JSON.stringify(req))
    .expire(reqKey(req.worldId), Math.round(REQUEST_TTL_MS / 1000) * 4)
    .exec();
}

export async function getRequest(worldId: string, id: string): Promise<WorldRequest | null> {
  const raw = await redis.hget(reqKey(worldId), id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorldRequest;
  } catch {
    return null;
  }
}

export async function deleteRequest(worldId: string, id: string): Promise<void> {
  await redis.hdel(reqKey(worldId), id);
}

/** Live posts, newest first, expired ones swept on the way past. */
export async function listRequests(worldId: string): Promise<WorldRequest[]> {
  const raw = await redis.hgetall(reqKey(worldId));
  const now = Date.now();
  const out: WorldRequest[] = [];
  const dead: string[] = [];
  for (const [id, line] of Object.entries(raw)) {
    try {
      const req = JSON.parse(line) as WorldRequest;
      if (req.expiresAt <= now || req.need <= 0) dead.push(id);
      else out.push(req);
    } catch {
      dead.push(id);
    }
  }
  if (dead.length > 0) await redis.hdel(reqKey(worldId), ...dead);
  return out.sort((a, b) => b.at - a.at);
}

/** Every player's post in this world — used to stop one person papering the
 *  room with them. */
export async function requestsBy(worldId: string, uid: string): Promise<WorldRequest[]> {
  return (await listRequests(worldId)).filter((r) => r.uid === uid);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Called ONCE at boot. Nobody is connected to a process that has not started,
 *  so every human membership is a leftover; the bots go too, because the
 *  in-memory hold table that stops one being handed out twice starts empty. */
export async function clearStaleWorldState(): Promise<number> {
  let removed = 0;
  for (const id of await listWorldIds()) {
    const members = await redis.zrange(humansKey(id), 0, -1);
    const m = redis.multi();
    for (const userId of members) m.del(userWorldKey(userId));
    m.del(humansKey(id));
    m.del(botsKey(id));
    m.del(reqKey(id));
    await m.exec();
    removed += members.length;
  }
  return removed;
}
