import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});

// ---- Presence (who is online, and on which socket) ----
const presenceKey = (userId: string) => `presence:${userId}`;
// A parallel SET of everyone online. The per-user keys answer "where is this
// player's socket"; this answers "how many are there", which the admin
// console asks on every dashboard load. Counting the per-user keys would mean
// SCANning the keyspace — this is one SCARD. The cost is one extra Redis
// command per connect and per disconnect, and nothing per event.
const ONLINE_KEY = "presence:online";

export async function setOnline(userId: string, socketId: string) {
  await redis.multi().set(presenceKey(userId), socketId).sadd(ONLINE_KEY, userId).exec();
}

export async function setOffline(userId: string) {
  await redis.multi().del(presenceKey(userId)).srem(ONLINE_KEY, userId).exec();
}

/** How many players are connected right now. O(1). */
export const countOnline = (): Promise<number> => redis.scard(ONLINE_KEY);

/** Drop the online set. Called ONCE at boot for the same reason the stale
 *  match bindings are cleared: nobody can legitimately be connected to a
 *  process that has not started yet, so whatever is in there is a leftover
 *  from the previous run and would inflate the count for ever. */
export const clearOnlineSet = (): Promise<number> => redis.del(ONLINE_KEY);

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
// leader) and caps how many players can join. "solo" means not in a group at
// all — it's every player's state until they invite someone or join a party.
export type LobbyMode = "solo" | "duo" | "squad";

export function lobbyCapacity(mode: LobbyMode): number {
  return mode === "solo" ? 1 : mode === "duo" ? 2 : MAX_LOBBY_SIZE;
}

export async function getLobbyMode(lobbyId: string): Promise<LobbyMode> {
  const mode = await redis.get(lobbyModeKey(lobbyId));
  return mode === "duo" || mode === "squad" ? mode : "solo";
}

export async function setLobbyMode(lobbyId: string, mode: LobbyMode): Promise<void> {
  await redis.set(lobbyModeKey(lobbyId), mode);
}

/** Connect-time mode reset: a fresh session always starts solo. If the user's
 *  own lobby still holds members (a leader reconnecting to their live squad),
 *  the group mode is kept — writing squad only when no mode was stored, so a
 *  legacy lobby from before solo existed can't be read as capacity 1. */
export async function ensureLobbyModeOnConnect(lobbyId: string): Promise<void> {
  const size = await redis.scard(lobbyKey(lobbyId));
  if (size === 0) await redis.set(lobbyModeKey(lobbyId), "solo");
  else await redis.set(lobbyModeKey(lobbyId), "squad", "NX");
}

export async function getUserLobby(userId: string): Promise<string | null> {
  return redis.get(userLobbyKey(userId));
}

export async function getLobbyMembers(lobbyId: string): Promise<string[]> {
  return redis.smembers(lobbyKey(lobbyId));
}

// Check-capacity-then-add as ONE atomic step. A plain SCARD-then-MULTI let two
// players racing into the last slot both pass the check and overfill the party
// (very reachable now a team code can be pasted to several people at once). An
// existing member re-joins idempotently (never the reachable path — leaveLobby
// always runs first — but it keeps seniority instead of resetting it). Returns
// "1" on success, "0" when the party was already full.
const JOIN_LOBBY_LUA = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then
  if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[3]) then
    return 0
  end
  redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

export async function joinLobby(userId: string, lobbyId: string): Promise<boolean> {
  // Mode is read outside the script; it only changes via the leader-only
  // lobby:mode (which itself can't shrink below current members), so the
  // atomic guard below is the count race that actually needed closing.
  const capacity = lobbyCapacity(await getLobbyMode(lobbyId));
  const res = await redis.eval(
    JOIN_LOBBY_LUA,
    3,
    lobbyKey(lobbyId),
    userLobbyKey(userId),
    lobbyJoinedKey(lobbyId),
    userId,
    lobbyId,
    String(capacity),
    String(Date.now())
  );
  return Number(res) === 1;
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

// ---- Send cooldowns: one invite / join-request per target per window, so a
// ---- player can't be popup-spammed. SET NX EX = atomic check-and-arm in one
// ---- round trip; the key simply expires when the window ends.
export const SEND_COOLDOWN_SECONDS = 10;
const sendCooldownKey = (kind: "invite" | "joinreq", fromId: string, toId: string) =>
  `cooldown:${kind}:${fromId}:${toId}`;

/** Arms the cooldown if clear. Returns 0 when the send is allowed, otherwise
 *  the seconds left until this sender may target this player again. */
export async function armSendCooldown(
  kind: "invite" | "joinreq",
  fromId: string,
  toId: string
): Promise<number> {
  const key = sendCooldownKey(kind, fromId, toId);
  const set = await redis.set(key, "1", "EX", SEND_COOLDOWN_SECONDS, "NX");
  if (set === "OK") return 0;
  const ttl = await redis.ttl(key); // only on the blocked path
  return ttl > 0 ? ttl : SEND_COOLDOWN_SECONDS;
}

// ---- Team codes: a 6-digit number that lets ANYONE hop into an open party —
// ---- no friendship, no approval round; knowing the code IS the permission.
// ---- Two-way mapping so the party can show its code and release it later.
const codeToLobbyKey = (code: string) => `teamcode:code:${code}`;
const lobbyToCodeKey = (lobbyId: string) => `teamcode:lobby:${lobbyId}`;
// Backstop TTL only. Real cleanup is releaseTeamCode on dissolve plus the
// liveness check at join time; this just stops crash leftovers piling up.
const TEAM_CODE_TTL_SECONDS = 24 * 60 * 60;

/** The lobby's current code, minting one on first ask. */
export async function getOrCreateTeamCode(lobbyId: string): Promise<string> {
  const existing = await redis.get(lobbyToCodeKey(lobbyId));
  if (existing) return existing;
  for (;;) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    // NX rejects a code already owned by another lobby (rare in a 900k space).
    const claimed = await redis.set(codeToLobbyKey(code), lobbyId, "EX", TEAM_CODE_TTL_SECONDS, "NX");
    if (claimed !== "OK") continue;
    const linked = await redis.set(lobbyToCodeKey(lobbyId), code, "EX", TEAM_CODE_TTL_SECONDS, "NX");
    if (linked === "OK") return code;
    // Lost a race against a concurrent broadcast — keep theirs, drop ours.
    await redis.del(codeToLobbyKey(code));
    const winner = await redis.get(lobbyToCodeKey(lobbyId));
    if (winner) return winner;
  }
}

/** The lobby's code if someone revealed one — never mints. */
export async function getTeamCode(lobbyId: string): Promise<string | null> {
  return redis.get(lobbyToCodeKey(lobbyId));
}

export async function getTeamCodeLobby(code: string): Promise<string | null> {
  return redis.get(codeToLobbyKey(code));
}

/** Drop a lobby's code (party dissolved, or the mapping turned out stale). */
export async function releaseTeamCode(lobbyId: string): Promise<void> {
  const code = await redis.get(lobbyToCodeKey(lobbyId));
  if (!code) return;
  await redis.del(codeToLobbyKey(code), lobbyToCodeKey(lobbyId));
}

/** One join-by-code attempt per 2s per user: quick enough to retry a typo,
 *  hopeless for brute-forcing the 900k code space. */
export async function throttleCodeJoin(userId: string): Promise<boolean> {
  return (await redis.set(`cooldown:codejoin:${userId}`, "1", "EX", 2, "NX")) === "OK";
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

// ---- Unread DMs: set of sender uids whose messages the user hasn't opened.
// ---- Lives in Redis (not Postgres) so red dots survive logouts without any
// ---- read-state queries on the message tables; TTL mirrors chat retention.
const unreadDmKey = (userId: string) => `unread:dm:${userId}`;
const UNREAD_TTL_SECONDS = 15 * 24 * 60 * 60;

export async function addUnreadDm(userId: string, senderUid: string): Promise<void> {
  await redis
    .multi()
    .sadd(unreadDmKey(userId), senderUid)
    .expire(unreadDmKey(userId), UNREAD_TTL_SECONDS)
    .exec();
}

export async function clearUnreadDm(userId: string, senderUids: string | string[]): Promise<void> {
  const uids = Array.isArray(senderUids) ? senderUids : [senderUids];
  if (uids.length === 0) return;
  await redis.srem(unreadDmKey(userId), ...uids);
}

export async function getUnreadDmUids(userId: string): Promise<string[]> {
  return redis.smembers(unreadDmKey(userId));
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
