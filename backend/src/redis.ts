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

export async function getUserLobby(userId: string): Promise<string | null> {
  return redis.get(userLobbyKey(userId));
}

export async function getLobbyMembers(lobbyId: string): Promise<string[]> {
  return redis.smembers(lobbyKey(lobbyId));
}

export async function joinLobby(userId: string, lobbyId: string): Promise<boolean> {
  const size = await redis.scard(lobbyKey(lobbyId));
  if (size >= MAX_LOBBY_SIZE) return false;
  await redis
    .multi()
    .sadd(lobbyKey(lobbyId), userId)
    .set(userLobbyKey(userId), lobbyId)
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
    .exec();
  return lobbyId;
}
