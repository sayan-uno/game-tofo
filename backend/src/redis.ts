import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});

// ---- Presence (who is online, and on which socket) ----
const presenceKey = (userId: string) => `presence:${userId}`;

export async function setOnline(userId: string, socketId: string) {
  await redis.set(presenceKey(userId), socketId);
}

export async function setOffline(userId: string) {
  await redis.del(presenceKey(userId));
}

export async function getSocketId(userId: string): Promise<string | null> {
  return redis.get(presenceKey(userId));
}

export async function getOnlineSet(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const values = await redis.mget(userIds.map(presenceKey));
  const online = new Set<string>();
  values.forEach((v, i) => {
    if (v) online.add(userIds[i]);
  });
  return online;
}

// ---- Lobbies (a lobby is a set of member userIds, keyed by the leader's uid) ----
export const MAX_LOBBY_SIZE = 4;
const lobbyKey = (lobbyId: string) => `lobby:${lobbyId}:members`;
const userLobbyKey = (userId: string) => `user:lobby:${userId}`;
const lobbyModeKey = (lobbyId: string) => `lobby:${lobbyId}:mode`;
// join timestamps (ms) per member — used to pick the longest-present player
// as the new leader when the current leader walks out.
const lobbyJoinedKey = (lobbyId: string) => `lobby:${lobbyId}:joinedAt`;

// Free Fire-style party modes. The mode belongs to the lobby (i.e. its
// leader) and caps how many players can join.
export type LobbyMode = "duo" | "squad";

export function lobbyCapacity(mode: LobbyMode): number {
  return mode === "duo" ? 2 : MAX_LOBBY_SIZE;
}

export async function getLobbyMode(lobbyId: string): Promise<LobbyMode> {
  const mode = await redis.get(lobbyModeKey(lobbyId));
  return mode === "duo" ? "duo" : "squad";
}

export async function setLobbyMode(lobbyId: string, mode: LobbyMode): Promise<void> {
  await redis.set(lobbyModeKey(lobbyId), mode);
}

export async function getUserLobby(userId: string): Promise<string | null> {
  return redis.get(userLobbyKey(userId));
}

export async function getLobbyMembers(lobbyId: string): Promise<string[]> {
  return redis.smembers(lobbyKey(lobbyId));
}

export async function joinLobby(userId: string, lobbyId: string): Promise<boolean> {
  const [size, mode] = await Promise.all([redis.scard(lobbyKey(lobbyId)), getLobbyMode(lobbyId)]);
  if (size >= lobbyCapacity(mode)) return false;
  await redis
    .multi()
    .sadd(lobbyKey(lobbyId), userId)
    .set(userLobbyKey(userId), lobbyId)
    .hset(lobbyJoinedKey(lobbyId), userId, String(Date.now()))
    .exec();
  return true;
}

export async function leaveLobby(userId: string): Promise<string | null> {
  const lobbyId = await getUserLobby(userId);
  if (!lobbyId) return null;
  await redis
    .multi()
    .srem(lobbyKey(lobbyId), userId)
    .del(userLobbyKey(userId))
    .hdel(lobbyJoinedKey(lobbyId), userId)
    .exec();
  return lobbyId;
}

export async function getLobbyJoinTimes(lobbyId: string): Promise<Map<string, number>> {
  const hash = await redis.hgetall(lobbyJoinedKey(lobbyId));
  return new Map(Object.entries(hash).map(([userId, ts]) => [userId, Number(ts)]));
}

/** Rehome members into a new lobby id (leader walked out): membership, their
 *  original join times (seniority survives), and the party mode all move. */
export async function migrateLobbyMembers(
  oldLobbyId: string,
  newLobbyId: string,
  memberIds: string[],
  joinTimes: Map<string, number>
): Promise<void> {
  const mode = await redis.get(lobbyModeKey(oldLobbyId));
  const m = redis.multi();
  for (const id of memberIds) {
    m.srem(lobbyKey(oldLobbyId), id);
    m.sadd(lobbyKey(newLobbyId), id);
    m.set(userLobbyKey(id), newLobbyId);
    m.hdel(lobbyJoinedKey(oldLobbyId), id);
    m.hset(lobbyJoinedKey(newLobbyId), id, String(joinTimes.get(id) ?? Date.now()));
  }
  m.set(lobbyModeKey(newLobbyId), mode ?? "squad");
  await m.exec();
}

// ---- Do Not Disturb (friends can still message, but not invite/join-request) ----
const dndKey = (userId: string) => `dnd:${userId}`;

export async function setDnd(userId: string, on: boolean): Promise<void> {
  if (on) await redis.set(dndKey(userId), "1");
  else await redis.del(dndKey(userId));
}

export async function isDnd(userId: string): Promise<boolean> {
  return (await redis.get(dndKey(userId))) === "1";
}

// ---- Pending join requests (consent marker so an "approval" can never pull
// ---- in a friend who didn't actually ask; expires after a minute) ----
const joinReqKey = (requesterId: string, targetId: string) => `joinreq:${requesterId}:${targetId}`;

export async function createJoinRequest(requesterId: string, targetId: string): Promise<void> {
  await redis.set(joinReqKey(requesterId, targetId), "1", "EX", 60);
}

export async function consumeJoinRequest(requesterId: string, targetId: string): Promise<boolean> {
  return (await redis.del(joinReqKey(requesterId, targetId))) > 0;
}

// ---- Team chat sessions ----
// A session id marks one "squad lifetime": born when a lobby grows past one
// member, wiped when it shrinks back. A new squad gets a fresh id → blank chat.
const teamSessionKey = (lobbyId: string) => `lobby:${lobbyId}:chatSession`;

export async function getTeamSession(lobbyId: string): Promise<string | null> {
  return redis.get(teamSessionKey(lobbyId));
}

/** Create the session if the squad doesn't have one yet; returns the live id. */
export async function ensureTeamSession(lobbyId: string, candidateId: string): Promise<string> {
  const created = await redis.set(teamSessionKey(lobbyId), candidateId, "NX");
  if (created === "OK") return candidateId;
  return (await redis.get(teamSessionKey(lobbyId))) ?? candidateId;
}

export async function clearTeamSession(lobbyId: string): Promise<string | null> {
  const key = teamSessionKey(lobbyId);
  const sessionId = await redis.get(key);
  if (sessionId) await redis.del(key);
  return sessionId;
}

/** The squad keeps living under a new lobby id (leader left) — its chat
 *  session moves with it so the remaining members keep their history. */
export async function moveTeamSession(oldLobbyId: string, newLobbyId: string): Promise<void> {
  const sessionId = await redis.get(teamSessionKey(oldLobbyId));
  if (!sessionId) return;
  await redis
    .multi()
    .set(teamSessionKey(newLobbyId), sessionId)
    .del(teamSessionKey(oldLobbyId))
    .exec();
}
