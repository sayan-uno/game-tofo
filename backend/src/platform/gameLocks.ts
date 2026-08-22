// Stopping a game — for everybody, or for one person.
//
// Two different powers with one shape:
//
//   THE WHOLE GAME IS OFF. A game is broken, or exploited, or its pack is bad,
//   and nobody should be starting a new match of it. Matches already running
//   are left alone — cutting them short is the thing this is trying to avoid,
//   and by the time an admin reaches for it the damage is in the new matches,
//   not the ones in flight.
//
//   ONE PLAYER IS OFF IT. Somebody ruins one game in particular and there is
//   no reason to take the whole platform away from them. Narrower than a match
//   ban, which stops them playing anything.
//
// In Redis, like maintenance mode and for the same reason: this has to change
// while the server is running, and putting a game away by editing a variable
// and redeploying would make the deploy the outage. It is temporary state by
// design — a flushed Redis lets everyone back in, which for a hold is the safe
// direction to fail.
import { redis } from "../redis.js";

/** gameId → why. One hash, so "what is off right now" is one read. */
const BLOCKED = "game:blocked";
/** userId → why, one hash per game. HMGET answers a whole party at once,
 *  which is what the lobby broadcast needs and why it is shaped this way. */
const banKey = (gameId: string) => `game:ban:${gameId}`;

// ---------------------------------------------------------------------------
// WITHDRAWN THINGS
//
// A catalog item or a game that players may no longer see or use — a character
// that turned out to be broken, a weapon that was published early, an emote
// somebody found a use for that was not intended.
//
// Withdrawing is not deleting. The thing stays in the code and in the bucket,
// because pulling it out of either means a deploy, and the moment you need
// this you do not have time for one. It simply stops being offered, and stops
// being accepted if a client asks for it anyway — because a client can ask for
// anything, and "not in the list we sent you" is not a rule, it is a hope.
const WITHDRAWN = "catalog:withdrawn";

// Held in memory as well as in Redis, because the resolvers that need it run
// on the hot path — every lobby broadcast resolves a character and a weapon
// per member — and a round trip per member per broadcast is not a price worth
// paying for a switch that changes twice a year. Refreshed when an admin acts
// and on a slow timer as a backstop, exactly like the maintenance gate.
let withdrawnNow = new Set<string>();

/** Synchronous, for the resolvers. */
export const isWithdrawn = (id: string | null | undefined): boolean => !!id && withdrawnNow.has(id);

/** Re-read the set into memory. Called at boot, when an admin changes it, and
 *  on a timer that catches an instance which missed the message. */
export async function refreshWithdrawn(): Promise<number> {
  try {
    withdrawnNow = new Set(await redis.smembers(WITHDRAWN));
  } catch {
    /* keep what we had: an empty set would silently un-withdraw everything */
  }
  return withdrawnNow.size;
}

export function startWithdrawnWatch(): NodeJS.Timeout {
  const t = setInterval(() => void refreshWithdrawn(), 30_000);
  t.unref();
  return t;
}

/** Item ids nobody may see or wear. */
export async function withdrawnItems(): Promise<string[]> {
  try {
    return await redis.smembers(WITHDRAWN);
  } catch {
    // Fail OPEN, like every other switch here: the worst case is a withdrawn
    // item being visible a moment longer, and the alternative is an empty
    // collection for everybody.
    return [];
  }
}

export async function withdrawItem(id: string): Promise<void> {
  await redis.sadd(WITHDRAWN, id);
  await refreshWithdrawn();
}
export async function restoreItem(id: string): Promise<void> {
  await redis.srem(WITHDRAWN, id);
  await refreshWithdrawn();
}

/** Games nobody may see in the picker at all. Different from a hold, which
 *  leaves the game visible with a reason on it — hiding is for something that
 *  should not be advertised while it is dealt with. */
const HIDDEN_GAMES = "game:hidden";
export async function hiddenGames(): Promise<string[]> {
  try {
    return await redis.smembers(HIDDEN_GAMES);
  } catch {
    return [];
  }
}
export const hideGame = (gameId: string): Promise<number> => redis.sadd(HIDDEN_GAMES, gameId);
export const showGame = (gameId: string): Promise<number> => redis.srem(HIDDEN_GAMES, gameId);

export interface GameHold {
  gameId: string;
  reason: string;
}

// ---- the whole game -------------------------------------------------------

export async function holdGame(gameId: string, reason: string): Promise<void> {
  await redis.hset(BLOCKED, gameId, reason || "temporarily unavailable");
}

export async function releaseGame(gameId: string): Promise<void> {
  await redis.hdel(BLOCKED, gameId);
}

export async function heldGames(): Promise<GameHold[]> {
  try {
    const h = await redis.hgetall(BLOCKED);
    return Object.entries(h).map(([gameId, reason]) => ({ gameId, reason }));
  } catch {
    // A Redis wobble must not take every game away. Failing OPEN is right: the
    // worst case is a held game being playable for a moment longer, and the
    // alternative is an outage nobody asked for.
    return [];
  }
}

/** Why this game is off, or null if it is not. */
export async function gameHeld(gameId: string): Promise<string | null> {
  try {
    return await redis.hget(BLOCKED, gameId);
  } catch {
    return null;
  }
}

// ---- one player ------------------------------------------------------------

export async function banFromGame(gameId: string, userId: string, reason: string): Promise<void> {
  await redis.hset(banKey(gameId), userId, reason || "barred from this game");
}

export async function unbanFromGame(gameId: string, userId: string): Promise<void> {
  await redis.hdel(banKey(gameId), userId);
}

/** Why this player may not play this game, or null. */
export async function gameBanReason(gameId: string, userId: string): Promise<string | null> {
  try {
    return await redis.hget(banKey(gameId), userId);
  } catch {
    return null;
  }
}

/** Which of these players may not play this game — the whole party in ONE
 *  command, because this is asked on a lobby broadcast and a round trip per
 *  member would be four of them every time somebody moves. */
export async function bannedAmong(gameId: string, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  try {
    const reasons = await redis.hmget(banKey(gameId), ...userIds);
    userIds.forEach((id, i) => {
      const why = reasons[i];
      if (why) out.set(id, why);
    });
  } catch {
    /* fail open, as above */
  }
  return out;
}

/** Everyone barred from a game, for the console's list. */
export async function bannedFrom(gameId: string): Promise<{ userId: string; reason: string }[]> {
  try {
    const h = await redis.hgetall(banKey(gameId));
    return Object.entries(h).map(([userId, reason]) => ({ userId, reason }));
  } catch {
    return [];
  }
}
