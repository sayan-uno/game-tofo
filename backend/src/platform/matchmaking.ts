// Matchmaking: filling a match from waiting parties, then from bots.
//
// THE RULE, from which every case falls out: a party is topped up to its
// game's match size from a pool of other waiting parties, and whatever is
// still missing when the oldest entry has waited FILL_DEADLINE_MS becomes a
// server bot. So:
//
//   solo player          → 4-runner match: 3 others, or bots
//   duo party of 1       → 2-runner match: 1 other, or a bot
//   squad party of 3     → 4-runner match: 1 other, or a bot
//   full party           → starts immediately, nobody else involved
//
// POOLS ARE KEYED BY MATCH SIZE, not by party mode — so a lone solo starter
// and a squad party of three can meet in the same 4-runner match. There are no
// teams in a runner, so nothing is unbalanced by it, and it roughly halves the
// wait. `poolKeyFor` is the one line to change if you ever want strict
// per-mode pools instead.
//
// The pool lives in Redis (hot state, same as lobbies). Claiming entries is a
// Lua script so two packers can never hand the same party to two matches, even
// though only one process runs the ticker today.
import type { Server } from "socket.io";
import { redis, getLobbyMembers, getSocketId } from "../redis.js";
import { getUsersByIds, type UserRow } from "../services/users.js";
import { getGame, listGames, type GameServerDefinition } from "./games.js";
import { createMatch, type PartyInput } from "./match.js";
import { buildBots } from "./bots.js";
import { botSeatIdentities } from "./botSeats.js";
import { setSearching } from "./store.js";
import { EV } from "../shared/core/protocol.js";

/** How long the OLDEST waiting party waits for humans before the empty seats
 *  are filled with bots. Long enough to find real people at a healthy hour,
 *  short enough that nobody stares at a spinner. */
export const FILL_DEADLINE_MS = 10_000;

/** How often the packer runs. Enqueueing also packs immediately, so this only
 *  has to catch the deadline. */
const TICK_MS = 500;

const poolKey = (gameId: string, size: number) => `mm:${gameId}:${size}`;
const sizeKey = (gameId: string, size: number) => `mm:${gameId}:${size}:sizes`;

/** The pool a party belongs in. Match size, not mode — see the header. */
export function poolKeyFor(game: GameServerDefinition, mode: "solo" | "duo" | "squad"): number {
  return game.matchSizeFor(mode);
}

/** Claim a set of waiting parties atomically. Returns false when any of them
 *  was taken in the meantime, in which case the caller re-reads and retries —
 *  which is what stops one party being started into two matches at once. */
const CLAIM_LUA = `
for i = 1, #ARGV do
  if redis.call('ZSCORE', KEYS[1], ARGV[i]) == false then return 0 end
end
for i = 1, #ARGV do
  redis.call('ZREM', KEYS[1], ARGV[i])
  redis.call('HDEL', KEYS[2], ARGV[i])
end
return 1
`;

export interface WaitingEntry {
  lobbyId: string;
  size: number;
  enqueuedAt: number;
}

export async function enqueue(gameId: string, size: number, lobbyId: string, partySize: number): Promise<void> {
  const now = Date.now();
  await redis
    .multi()
    .zadd(poolKey(gameId, size), now, lobbyId)
    .hset(sizeKey(gameId, size), lobbyId, String(partySize))
    .exec();
  await setSearching(lobbyId, `${gameId}:${size}`);
}

export async function dequeue(gameId: string, size: number, lobbyId: string): Promise<void> {
  await redis.multi().zrem(poolKey(gameId, size), lobbyId).hdel(sizeKey(gameId, size), lobbyId).exec();
  await setSearching(lobbyId, null);
}

/** A party's size changed while it was waiting (someone joined or left). The
 *  entry keeps its ORIGINAL enqueue time, so waiting longer is never punished
 *  by a teammate arriving. */
export async function updateSize(gameId: string, size: number, lobbyId: string, partySize: number): Promise<void> {
  if ((await redis.zscore(poolKey(gameId, size), lobbyId)) === null) return;
  await redis.hset(sizeKey(gameId, size), lobbyId, String(partySize));
}

/** How many parties are waiting in one pool. For the ops snapshot — exported
 *  from here rather than rebuilt elsewhere so the key format stays in one
 *  place. */
export const poolDepth = (gameId: string, size: number): Promise<number> => redis.zcard(poolKey(gameId, size));

export async function isSearching(gameId: string, size: number, lobbyId: string): Promise<boolean> {
  return (await redis.zscore(poolKey(gameId, size), lobbyId)) !== null;
}

async function readPool(gameId: string, size: number): Promise<WaitingEntry[]> {
  const [flat, sizes] = await Promise.all([
    redis.zrange(poolKey(gameId, size), 0, -1, "WITHSCORES"),
    redis.hgetall(sizeKey(gameId, size)),
  ]);
  const out: WaitingEntry[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const lobbyId = flat[i];
    const partySize = Number(sizes[lobbyId] ?? 0);
    if (partySize > 0) out.push({ lobbyId, size: partySize, enqueuedAt: Number(flat[i + 1]) });
  }
  return out;
}

/** Greedy pack, oldest first: the party that has waited longest is always in
 *  the match that forms, and bigger parties are preferred as filler because
 *  they leave fewer awkward gaps. */
function pack(entries: WaitingEntry[], target: number): WaitingEntry[] {
  if (entries.length === 0) return [];
  const [oldest, ...rest] = entries;
  const chosen = [oldest];
  let total = oldest.size;
  const candidates = [...rest].sort((a, b) => b.size - a.size || a.enqueuedAt - b.enqueuedAt);
  for (const c of candidates) {
    if (total >= target) break;
    if (total + c.size <= target) {
      chosen.push(c);
      total += c.size;
    }
  }
  return chosen;
}

/** Drop entries whose party no longer exists or whose leader went offline —
 *  otherwise a dead party keeps winning the "oldest" slot forever. */
async function alive(entry: WaitingEntry): Promise<{ ok: boolean; users: UserRow[] }> {
  const memberIds = await getLobbyMembers(entry.lobbyId);
  if (memberIds.length === 0) return { ok: false, users: [] };
  const users = await getUsersByIds(memberIds);
  const online = await Promise.all(users.map((u) => getSocketId(u.id)));
  if (!online.some((s) => s !== null)) return { ok: false, users };
  return { ok: true, users };
}

async function claim(gameId: string, size: number, ids: string[]): Promise<boolean> {
  const res = await redis.eval(CLAIM_LUA, 2, poolKey(gameId, size), sizeKey(gameId, size), ...ids);
  return Number(res) === 1;
}

/** One packing attempt for one pool. Returns true when a match was made. */
async function tryPack(io: Server, game: GameServerDefinition, size: number): Promise<boolean> {
  const entries = await readPool(game.id, size);
  if (entries.length === 0) {
    // The pool can hold members whose SIZE record is missing — the two live in
    // different Redis keys — and readPool skips those. Left silent, a party
    // then waits forever with nothing in any log to say why, which is the
    // worst failure this system can have. Clean them out loudly instead.
    const orphans = await redis.zrange(poolKey(game.id, size), 0, -1);
    if (orphans.length > 0) {
      console.warn(`[mm] ${game.id}/${size}: ${orphans.length} pool entr(ies) with no size record — clearing`);
      for (const lobbyId of orphans) await dequeue(game.id, size, lobbyId);
    }
    return false;
  }

  // Prune the dead before deciding anything.
  const live: WaitingEntry[] = [];
  for (const e of entries) {
    const state = await alive(e);
    if (state.ok) live.push(e);
    else {
      // Never silent: a party leaving the queue without a match is something
      // a player experiences as "the search hung", so it has to be traceable.
      console.warn(`[mm] dropped ${e.lobbyId} from ${game.id}/${size} — party empty or nobody online`);
      await dequeue(game.id, size, e.lobbyId);
    }
  }
  if (live.length === 0) return false;

  const chosen = pack(live, size);
  const humans = chosen.reduce((n, c) => n + c.size, 0);
  const waited = Date.now() - live[0].enqueuedAt;
  const full = humans === size;
  const deadlineHit = waited >= FILL_DEADLINE_MS;
  if (!full && !deadlineHit) return false;

  if (!(await claim(game.id, size, chosen.map((c) => c.lobbyId)))) return false; // someone else got them
  for (const c of chosen) await setSearching(c.lobbyId, null);

  const parties: PartyInput[] = [];
  for (const c of chosen) {
    const state = await alive(c);
    // The bots a party ALREADY has walk in with it, keeping their names and
    // their careers — they are teammates, not filler, and the group has been
    // standing in the lobby with them (W3).
    if (state.users.length > 0) {
      parties.push({ lobbyId: c.lobbyId, users: state.users, bots: await botSeatIdentities(c.lobbyId) });
    }
  }
  if (parties.length === 0) {
    // Everyone chosen vanished between the claim and here. Rare, but it must
    // be visible: their entries are already out of the pool, so silence would
    // mean a party dropped out of matchmaking with no trace.
    console.warn(`[mm] ${game.id}/${size}: all ${chosen.length} claimed part(ies) disappeared before the match was built`);
    return false;
  }

  const humansSeated = parties.reduce((n, p) => n + p.users.length, 0);
  const partyBots = parties.flatMap((p) => p.bots ?? []);
  const seatsUsed = humansSeated + partyBots.length;
  // Never the same account twice at one table: a party's own bots are already
  // seated, so the filler has to be drawn from everybody else.
  const bots =
    seatsUsed < size
      ? await buildBots(game, size - seatsUsed, new Set(partyBots.map((b) => b.botId)))
      : [];
  console.info(
    `[mm] ${game.id}/${size}: ${parties.length} part${parties.length === 1 ? "y" : "ies"} ` +
      `(${humansSeated} human${humansSeated === 1 ? "" : "s"}${partyBots.length ? ` + ${partyBots.length} teammate bot(s)` : ""}) ` +
      `+ ${bots.length} filler bot(s) after ${(waited / 1000).toFixed(1)}s`
  );
  await createMatch(io, game, parties, bots);
  return true;
}

/** Progress for everyone still waiting, so the screen can count up honestly. */
async function reportWaiting(io: Server, game: GameServerDefinition, size: number): Promise<void> {
  const entries = await readPool(game.id, size);
  if (entries.length === 0) return;
  const now = Date.now();
  // Everyone in a pool is a candidate for the same match, so "found" is the
  // whole pool capped at the target — which is what a player would count.
  const found = Math.min(
    size,
    entries.reduce((n, e) => n + e.size, 0)
  );
  for (const e of entries) {
    io.to(`room:${e.lobbyId}`).emit(EV.searching, {
      found,
      size,
      elapsedMs: now - e.enqueuedAt,
      deadlineMs: FILL_DEADLINE_MS,
    });
  }
}

let ticker: NodeJS.Timeout | null = null;

/** Start the packer. Idempotent — called once from the server bootstrap. */
export function startMatchmaker(io: Server): void {
  if (ticker) return;
  console.info(`[mm] matchmaker started (${listGames().length} game(s), fill deadline ${FILL_DEADLINE_MS}ms)`);
  ticker = setInterval(() => {
    void (async () => {
      try {
        for (const game of listGames()) {
          const sizes = new Set([game.matchSizeFor("solo"), game.matchSizeFor("duo"), game.matchSizeFor("squad")]);
          for (const size of sizes) {
            if ((await redis.zcard(poolKey(game.id, size))) === 0) continue;
            // Keep packing while the pool can still produce a match.
            for (let i = 0; i < 4; i++) if (!(await tryPack(io, game, size))) break;
            await reportWaiting(io, game, size);
          }
        }
      } catch (err) {
        console.error("[mm] tick failed:", err);
      }
    })();
  }, TICK_MS);
  ticker.unref();
}

/** Try immediately, so a party that completes a match does not wait for the
 *  next tick to find out. */
export async function packNow(io: Server, gameId: string, size: number): Promise<void> {
  const game = getGame(gameId);
  if (!game) return;
  try {
    await tryPack(io, game, size);
  } catch (err) {
    console.error("[mm] immediate pack failed:", err);
  }
}
