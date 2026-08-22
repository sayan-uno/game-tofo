import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});

// ---- Presence -------------------------------------------------------------
//
// TWO different questions, deliberately kept apart, because answering them
// with one key is what made the friends list lie.
//
//   WHERE IS THIS PLAYER'S SOCKET?  `presence:<id>` holds the socket id, and
//   lives as long as the connection does. Invites, kicks and match joins are
//   delivered through it, so it must NOT disappear because somebody glanced at
//   another tab — that would silently make them un-invitable.
//
//   IS THIS PLAYER ACTUALLY HERE?  `here:<id>` is refreshed by a heartbeat the
//   page sends only while it is VISIBLE, and expires on its own. Minimise the
//   game, switch app, put the phone in a pocket — it lapses, and the friends
//   list says offline. This is the one the console and the friends list read.
//
// Both carry a TTL now. Neither did before, and a process that went away
// without running its disconnect handlers — a crash, a kill, a Railway deploy
// — left people marked online for ever, with nothing to ever take it back.
const presenceKey = (userId: string) => `presence:${userId}`;
const hereKey = (userId: string) => `here:${userId}`;
// A parallel SET of everyone online. The per-user keys answer "where is this
// player's socket"; this answers "how many are there", which the admin
// console asks on every dashboard load. Counting the per-user keys would mean
// SCANning the keyspace — this is one SCARD. The cost is one extra Redis
// command per connect and per disconnect, and nothing per event.
const ONLINE_KEY = "presence:online";

/** Generous: this is a leak guard, not the liveness signal. A connection that
 *  is genuinely alive refreshes it on every heartbeat. */
const PRESENCE_TTL = 90;
/** Tight: two missed heartbeats and they are gone. The heartbeat is every
 *  four seconds, so this is the "ten seconds and you are offline" rule. */
export const HERE_TTL = 11;

export async function setOnline(userId: string, socketId: string) {
  await redis
    .multi()
    .set(presenceKey(userId), socketId, "EX", PRESENCE_TTL)
    .set(hereKey(userId), "1", "EX", HERE_TTL)
    .sadd(ONLINE_KEY, userId)
    .exec();
}

/** The page said it is open AND in front of somebody. One round trip, two
 *  cheap commands, once every four seconds per player.
 *
 *  Note what this does NOT touch: the socket registry. That is kept alive by
 *  the server for as long as the connection exists (below), because a player
 *  who has put their phone down is still someone an invite must reach. */
export async function touchHere(userId: string) {
  await redis.multi().set(hereKey(userId), "1", "EX", HERE_TTL).sadd(ONLINE_KEY, userId).exec();
}

/** The connection is still up. Refreshed by the server on a slow timer rather
 *  than by the client, so a page that never sends a heartbeat — an older build
 *  still cached on somebody's phone — cannot lose its socket registration and
 *  quietly become un-invitable. */
export const touchSocket = (userId: string): Promise<number> => redis.expire(presenceKey(userId), PRESENCE_TTL);

/** Still connected, but not looking: the tab is hidden or the app is in the
 *  background. The socket registry is left alone on purpose — they can still
 *  be invited, kicked and pulled into a match. */
export async function setAway(userId: string) {
  await redis.multi().del(hereKey(userId)).srem(ONLINE_KEY, userId).exec();
}

export async function setOffline(userId: string) {
  await redis.multi().del(presenceKey(userId), hereKey(userId)).srem(ONLINE_KEY, userId).exec();
}

/** Is this one player here right now? */
export const isHere = async (userId: string): Promise<boolean> => (await redis.exists(hereKey(userId))) === 1;

/** Everybody here right now, as UIDs.
 *
 *  The set holds internal ids, so this joins nothing and returns nothing a
 *  caller can use directly — the caller that needs names asks the database.
 *  Used when a notice is addressed to "whoever is online", so the record can
 *  say who that actually was rather than leaving it unanswerable a day later. */
export const onlineUserIds = (): Promise<string[]> => redis.smembers(ONLINE_KEY);

/** How many players are connected right now. O(1). */
export const countOnline = (): Promise<number> => redis.scard(ONLINE_KEY);

/** Drop the online set. Called ONCE at boot for the same reason the stale
 *  match bindings are cleared: nobody can legitimately be connected to a
 *  process that has not started yet, so whatever is in there is a leftover
 *  from the previous run and would inflate the count for ever. */
export const clearOnlineSet = (): Promise<number> => redis.del(ONLINE_KEY);

/** The per-player keys a previous run left behind. The set above is one key
 *  and easy to drop; these are one per player, and until they carried a TTL
 *  the only thing that ever removed them was a clean disconnect — so a crash
 *  left its whole player list marked online, permanently. They expire on
 *  their own now, and this clears the ones already out there. */
export async function clearStalePresence(): Promise<number> {
  let cursor = "0";
  let removed = 0;
  do {
    // SCAN, never KEYS: this runs against the Redis the game is using, and
    // KEYS blocks the server for the whole walk.
    const [next, keys] = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", 500);
    cursor = next;
    const stale = keys.filter((k) => k !== ONLINE_KEY);
    if (stale.length > 0) removed += await redis.del(...stale);
  } while (cursor !== "0");
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "here:*", "COUNT", 500);
    cursor = next;
    if (keys.length > 0) removed += await redis.del(...keys);
  } while (cursor !== "0");
  return removed;
}

export async function getSocketId(userId: string): Promise<string | null> {
  return redis.get(presenceKey(userId));
}

export async function getOnlineSet(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  // "here", not "has a socket": a connection that nobody is looking at is not
  // somebody a friend can expect an answer from.
  const values = await redis.mget(userIds.map(hereKey));
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
/** WHO LEADS, as a field.
 *
 *  It used to be the lobby's NAME: a lobby was `L<leaderUid>`, so the id
 *  answered "who runs this" for free. It also meant that handing the party on
 *  renamed it — and everything keyed by that name had to be dragged across:
 *  membership, join times, the mode, the team code, the game pick, the chat
 *  session, the search binding, the socket rooms. The party RECORDING could
 *  not come with it at all, so one group turned into two in the console, the
 *  first still marked live, and voice had to leave one room and join another.
 *
 *  A party is now named once and keeps that name. This is the only thing that
 *  moves when leadership does. */
const lobbyLeaderKey = (lobbyId: string) => `lobby:${lobbyId}:leader`;
/** A backstop only. Every path that dissolves a party clears this; the TTL is
 *  there so a process killed mid-flight cannot leave a party permanently led
 *  by somebody who is no longer in it. Twelve hours matches the party log. */
const LOBBY_TTL = 12 * 60 * 60;

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

/** A party is a lobby with a name of its own; `L<uid>` is one player's own
 *  space and is never shared. Told apart by the shape of the id so no lookup
 *  is needed on the hot path. */
export const isPartyLobby = (lobbyId: string): boolean => lobbyId.startsWith("P");
/** A fresh party id. Opaque, like a match id, and permanent for the life of
 *  the group whatever happens to its leadership. */
export const newPartyId = (): string => `P${randomUUID().slice(0, 12)}`;

export const setLobbyLeader = (lobbyId: string, userId: string): Promise<unknown> =>
  redis.set(lobbyLeaderKey(lobbyId), userId, "EX", LOBBY_TTL);
export const getLobbyLeader = (lobbyId: string): Promise<string | null> => redis.get(lobbyLeaderKey(lobbyId));
export const clearLobbyLeader = (lobbyId: string): Promise<number> => redis.del(lobbyLeaderKey(lobbyId));

/** May this player act as the leader here?
 *
 *  Their OWN lobby is theirs by definition — nobody else is in it — so the
 *  leader key is only consulted for a real party. That keeps a solo player's
 *  every action free of a Redis round trip. */
export async function isLobbyLeader(lobbyId: string, userId: string, uid: string): Promise<boolean> {
  if (!isPartyLobby(lobbyId)) return lobbyId === `L${uid}`;
  return (await getLobbyLeader(lobbyId)) === userId;
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

/** Carry a code across the one rename a lobby ever gets: a personal lobby
 *  becoming a party on its first join. Both directions of the mapping move,
 *  so a code somebody has already shared keeps working — which is the whole
 *  point of it, and the most likely moment for it to be in flight. */
export async function moveTeamCode(oldLobbyId: string, newLobbyId: string): Promise<void> {
  const code = await redis.get(lobbyToCodeKey(oldLobbyId));
  if (!code) return;
  await redis
    .multi()
    .set(codeToLobbyKey(code), newLobbyId, "EX", TEAM_CODE_TTL_SECONDS)
    .set(lobbyToCodeKey(newLobbyId), code, "EX", TEAM_CODE_TTL_SECONDS)
    .del(lobbyToCodeKey(oldLobbyId))
    .exec();
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
