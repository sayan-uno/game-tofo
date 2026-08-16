// Redis keys for the game platform: which game a party picked, how far each
// member's download is, and which match a party / a user is in. All hot state
// (see the Redis-not-Postgres rule); everything carries a TTL as a backstop.
import { redis } from "../redis.js";

const lobbyGameKey = (lobbyId: string) => `lobby:${lobbyId}:game`;
const lobbyReadyKey = (lobbyId: string) => `lobby:${lobbyId}:ready`;
const lobbyMatchKey = (lobbyId: string) => `lobby:${lobbyId}:match`;
const userMatchKey = (userId: string) => `user:match:${userId}`;

/** A party's game selection lives as long as the party is used; the backstop
 *  is generous because a leader picking a game and coming back tomorrow to a
 *  cleared choice is merely odd, not broken. */
const SELECTION_TTL = 7 * 24 * 60 * 60;
/** A match is minutes long; three hours covers any stall. */
const MATCH_TTL = 3 * 60 * 60;

// ---- game selection + download progress ----

export async function setLobbyGame(lobbyId: string, gameId: string | null): Promise<void> {
  const m = redis.multi();
  if (gameId) m.set(lobbyGameKey(lobbyId), gameId, "EX", SELECTION_TTL);
  else m.del(lobbyGameKey(lobbyId));
  // A new pick means a new pack: nobody is ready for it yet.
  m.del(lobbyReadyKey(lobbyId));
  await m.exec();
}

export const getLobbyGame = (lobbyId: string): Promise<string | null> => redis.get(lobbyGameKey(lobbyId));

export async function setLoading(lobbyId: string, uid: string, pct: number): Promise<void> {
  await redis
    .multi()
    .hset(lobbyReadyKey(lobbyId), uid, String(pct))
    .expire(lobbyReadyKey(lobbyId), SELECTION_TTL)
    .exec();
}

export async function getLoading(lobbyId: string): Promise<Record<string, number>> {
  const raw = await redis.hgetall(lobbyReadyKey(lobbyId));
  const out: Record<string, number> = {};
  for (const [uid, pct] of Object.entries(raw)) out[uid] = Number(pct) || 0;
  return out;
}

/** The party moved under a new leader's lobby id — its pick and progress
 *  move with it, so a leader hand-off never un-picks the game. */
export async function moveLobbyGameState(oldLobbyId: string, newLobbyId: string): Promise<void> {
  for (const [from, to] of [
    [lobbyGameKey(oldLobbyId), lobbyGameKey(newLobbyId)],
    [lobbyReadyKey(oldLobbyId), lobbyReadyKey(newLobbyId)],
    [lobbyMatchKey(oldLobbyId), lobbyMatchKey(newLobbyId)],
  ]) {
    if (await redis.exists(from)) await redis.rename(from, to);
  }
}

export async function clearLobbyGameState(lobbyId: string): Promise<void> {
  await redis.del(lobbyGameKey(lobbyId), lobbyReadyKey(lobbyId));
}

// ---- match membership ----

export async function bindMatch(matchId: string, lobbyIds: string[], userIds: string[]): Promise<void> {
  const m = redis.multi();
  for (const lobbyId of lobbyIds) m.set(lobbyMatchKey(lobbyId), matchId, "EX", MATCH_TTL);
  for (const userId of userIds) m.set(userMatchKey(userId), matchId, "EX", MATCH_TTL);
  await m.exec();
}

export async function unbindMatch(matchId: string, lobbyIds: string[], userIds: string[]): Promise<void> {
  // Only clear bindings that still point at THIS match — a party may already
  // be in its next one by the time a slow cleanup runs.
  for (const lobbyId of lobbyIds) {
    if ((await redis.get(lobbyMatchKey(lobbyId))) === matchId) await redis.del(lobbyMatchKey(lobbyId));
  }
  for (const userId of userIds) {
    if ((await redis.get(userMatchKey(userId))) === matchId) await redis.del(userMatchKey(userId));
  }
}

export const getLobbyMatch = (lobbyId: string): Promise<string | null> => redis.get(lobbyMatchKey(lobbyId));
export const getUserMatch = (userId: string): Promise<string | null> => redis.get(userMatchKey(userId));
export const clearUserMatch = (userId: string): Promise<number> => redis.del(userMatchKey(userId));

/** One start / pick per few seconds per player. */
export async function throttle(kind: string, userId: string, seconds: number): Promise<boolean> {
  return (await redis.set(`cooldown:${kind}:${userId}`, "1", "EX", seconds, "NX")) === "OK";
}
