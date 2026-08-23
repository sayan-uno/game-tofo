// Bot teammates: seats in a PARTY held by a bot account.
//
// Until now a bot only ever existed inside a match. This is the other half —
// a bot standing in the lobby with you, on a pedestal, in the roster, in the
// team chat, and then in the match beside you. It is what makes two promises
// in the world-chat feature true:
//
//   * ask the world to team up, and if nobody real answers within ten seconds
//     somebody turns up anyway;
//   * a group advertised by a bot is a group you can actually walk into.
//
// THE ONE RULE: a real player always outranks a bot for a seat. Every bot in a
// party is a placeholder for a person who has not arrived yet, so a full group
// of bots is still joinable — the newest bot stands down and the person takes
// its place. Anything else makes the bots that were meant to help into the
// reason a real player could not get in.
//
// State lives in Redis with the rest of the lobby (hot state, never Postgres),
// keyed the same way and swept the same way. A restart cannot leave a bot
// standing in an empty room: nobody is in a party at boot, so the keys are
// cleared then.
import { redis } from "../redis.js";
import { getBots, holdBots, releaseBots, takeBots, type BotAccount } from "./botAccounts.js";
import { asIdentity, type BotIdentity } from "./bots.js";

const seatsKey = (lobbyId: string) => `lobby:${lobbyId}:seats`;
/** Same backstop as the lobby itself — a party that is somehow abandoned
 *  without a departure event does not keep bots for ever. */
const SEAT_TTL = 12 * 60 * 60;

/** Bot ids holding a seat in this party, oldest first. */
export async function getBotSeatIds(lobbyId: string): Promise<string[]> {
  return redis.zrange(seatsKey(lobbyId), 0, -1);
}

export const countBotSeats = (lobbyId: string): Promise<number> => redis.zcard(seatsKey(lobbyId));

/** The accounts behind the seats, resolved from the in-memory pool. Ids whose
 *  account has been retired simply drop out — the seat is then empty, which is
 *  the correct reading of "that teammate is gone". */
export async function getBotSeats(lobbyId: string): Promise<BotAccount[]> {
  return getBots(await getBotSeatIds(lobbyId));
}

/** Match seats for the bots in this party, in the shape createMatch wants. */
export async function botSeatIdentities(lobbyId: string): Promise<BotIdentity[]> {
  return (await getBotSeats(lobbyId)).map(asIdentity);
}

/** Put `count` bots into this party. Returns the ones that actually arrived.
 *
 *  `exclude` keeps a party from seating the same account twice — the caller
 *  passes whoever is already sitting there. */
export async function addBotSeats(lobbyId: string, count: number): Promise<BotAccount[]> {
  if (count <= 0) return [];
  const already = new Set(await getBotSeatIds(lobbyId));
  const bots = await takeBots(count, already);
  if (bots.length === 0) return [];
  const now = Date.now();
  const m = redis.multi();
  // Scored by arrival, so "who stands down for a real player" has an obvious
  // and fair answer: the one who has been there least long.
  bots.forEach((bot, i) => m.zadd(seatsKey(lobbyId), now + i, bot.id));
  m.expire(seatsKey(lobbyId), SEAT_TTL);
  await m.exec();
  return bots;
}

/** Seat these SPECIFIC bots — the ones who advertised a group somebody has
 *  just walked into. Their holds are already taken by the world that is
 *  standing them up, so this adds one of its own and the world's release
 *  cannot pull a teammate out of a live party. */
export async function seatBots(lobbyId: string, bots: BotAccount[]): Promise<BotAccount[]> {
  if (bots.length === 0) return [];
  const already = new Set(await getBotSeatIds(lobbyId));
  const fresh = bots.filter((b) => !already.has(b.id));
  if (fresh.length === 0) return [];
  holdBots(fresh.map((b) => b.id));
  const now = Date.now();
  const m = redis.multi();
  fresh.forEach((bot, i) => m.zadd(seatsKey(lobbyId), now + i, bot.id));
  m.expire(seatsKey(lobbyId), SEAT_TTL);
  await m.exec();
  return fresh;
}

/** Make room for one real player: the newest bot stands down. Returns the bot
 *  that left, or null if there were none to move. */
export async function dropOneBotSeat(lobbyId: string): Promise<BotAccount | null> {
  const [id] = await redis.zrange(seatsKey(lobbyId), -1, -1);
  if (!id) return null;
  await redis.zrem(seatsKey(lobbyId), id);
  releaseBots([id]);
  const [bot] = getBots([id]);
  return bot ?? null;
}

/** Remove one named bot — a teammate leaving of its own accord, which is what
 *  keeps a party of bots from being a party that never changes. */
export async function dropBotSeat(lobbyId: string, botId: string): Promise<boolean> {
  const removed = await redis.zrem(seatsKey(lobbyId), botId);
  if (removed > 0) releaseBots([botId]);
  return removed > 0;
}

/** The party is over. Every bot goes back to the pool. */
export async function clearBotSeats(lobbyId: string): Promise<number> {
  const ids = await getBotSeatIds(lobbyId);
  if (ids.length === 0) return 0;
  await redis.del(seatsKey(lobbyId));
  releaseBots(ids);
  return ids.length;
}

/** A personal lobby became a party (or a party was renamed): the bots move
 *  with it, exactly as the game pick and the team code do. */
export async function moveBotSeats(oldLobbyId: string, newLobbyId: string): Promise<void> {
  if (oldLobbyId === newLobbyId) return;
  if (await redis.exists(seatsKey(oldLobbyId))) {
    await redis.rename(seatsKey(oldLobbyId), seatsKey(newLobbyId));
    await redis.expire(seatsKey(newLobbyId), SEAT_TTL);
  }
}

/** Called ONCE at boot. Nobody can be in a party at the moment the server
 *  starts, so any seat key is a leftover — and a leftover seat is a bot the
 *  in-memory hold table has never heard of, which would be handed out twice. */
export async function clearStaleBotSeats(): Promise<number> {
  let cursor = "0";
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "lobby:*:seats", "COUNT", 200);
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
      removed += keys.length;
    }
  } while (cursor !== "0");
  return removed;
}
