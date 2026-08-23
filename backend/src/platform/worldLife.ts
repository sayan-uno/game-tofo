// What makes a world move: the tick.
//
// One interval for the whole process, walking the worlds that exist. Every
// expensive thing in here is gated on somebody actually LOOKING — a world with
// no open World tab does not generate chatter, does not post cards and does
// not write archive rows, because a room nobody is in does not need to be
// convincing and the cost of pretending otherwise is paid by every player on
// the server.
//
// Four jobs, in order of how much they matter:
//
//   1. FILL WHAT WAS PROMISED. A player asked the world to team up. Ten
//      seconds later they have a group, whether or not anyone real turned up.
//      This is the one job that must never be skipped, and it is the only one
//      that runs regardless of who is watching.
//   2. KEEP THE POPULATION HONEST. Bots top the room up towards a target that
//      drifts, and stale members are swept — a phone that died mid-sentence
//      leaves no disconnect behind it.
//   3. TALK. A line every couple of seconds, from somebody chosen by persona,
//      answering the line before it more often than not.
//   4. ASK. Bots post their own "need one more" cards, so the board is not
//      only ever the one person who pressed the button.
import type { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { getLobbyMembers, getLobbyMode, lobbyCapacity, type LobbyMode } from "../redis.js";
import { getLobbyMatch, getSearching } from "./store.js";
import { archiveWorldMessage } from "../services/worldChat.js";
import { noteLobbyChat, noteLobbyJoin } from "./partyLog.js";
import { addBotSeats, countBotSeats } from "./botSeats.js";
import { touchBotsSeen, type BotAccount } from "./botAccounts.js";
import { arrivalLine, nextLine, PERSONA_VOICE } from "./worldLines.js";
import {
  balanceBots,
  deleteRequest,
  ensureFirstWorld,
  listRequests,
  listWorldIds,
  putRequest,
  pushMessage,
  recentMessages,
  sweepStaleMembers,
  toPublicMessage,
  toPublicRequest,
  worldBots,
  worldCounts,
  REQUEST_TTL_MS,
  type WorldRequest,
} from "./world.js";
import { WORLD_EV } from "../shared/core/protocol.js";

/** The heartbeat. Deliberately coarse: everything here is a room of strangers
 *  chatting, and nothing in it is worth a timer that competes with inputs. */
const TICK_MS = 1500;
/** Population re-balancing is Redis work; it does not need to happen as often
 *  as talking does. */
const BALANCE_EVERY = 8; // ticks → every 12s
const SWEEP_EVERY = 20; // ticks → every 30s
const POPULATION_EVERY = 6; // ticks → every 9s

/** Chance per tick that somebody says something, in a world with listeners.
 *  ~0.55 at 1.5s gives a line every three seconds or so, which reads as busy
 *  without being unreadable on a phone. */
const SAY_CHANCE = 0.55;
/** …and the chance of a bot putting up a card of its own. Rarer than talking
 *  by an order of magnitude: a board with a new card every few seconds looks
 *  like a bot farm, not a game. */
const CARD_CHANCE = 0.035;

/** Injected rather than imported, so this module never pulls in the lobby
 *  module that pulls in this one. The same shape platform/sockets.ts uses. */
export interface WorldDeps {
  broadcastLobby: (io: Server, lobbyId: string) => Promise<void>;
}

let timer: NodeJS.Timeout | null = null;
let ticks = 0;
/** Bot accounts seen this minute, flushed to `last_seen_at` in one statement.
 *  A write per bot per line would be a thousand writes a minute for nothing. */
const seen = new Set<string>();

/** How many sockets currently have this world's tab open. Read from the
 *  adapter — no bookkeeping of our own to get out of step. */
const listeners = (io: Server, worldId: string): number =>
  io.sockets.adapter.rooms.get(`world:${worldId}`)?.size ?? 0;

const pickWeighted = (bots: BotAccount[]): BotAccount | null => {
  if (bots.length === 0) return null;
  const total = bots.reduce((n, b) => n + PERSONA_VOICE[b.persona], 0);
  let roll = Math.random() * total;
  for (const bot of bots) {
    roll -= PERSONA_VOICE[bot.persona];
    if (roll <= 0) return bot;
  }
  return bots[bots.length - 1];
};

// ---------------------------------------------------------------------------
// 1. Filling groups
// ---------------------------------------------------------------------------

/** A player's card has waited its ten seconds. Whatever the group is still
 *  short of, it gets — and the arrivals behave like arrivals: they show up in
 *  the roster, they land in the party record, and they say hello.
 *
 *  Returns how many bots joined. */
export async function fillPartyWithBots(
  io: Server,
  deps: WorldDeps,
  lobbyId: string,
  mode: LobbyMode
): Promise<number> {
  const [members, seats, liveMode, inMatch, searching] = await Promise.all([
    getLobbyMembers(lobbyId),
    countBotSeats(lobbyId),
    getLobbyMode(lobbyId),
    getLobbyMatch(lobbyId),
    getSearching(lobbyId),
  ]);
  // The party may have changed under the card — dropped back to solo, filled
  // up with real people, or gone off to play while the ten seconds ran. All
  // three are the good outcome, and all three mean there is nothing to do.
  //
  // The last one is not a nicety. A party that pressed START before the card
  // came due is already in matchmaking, which is filling the same seats from
  // the same pool; adding teammates to the lobby underneath it would deal the
  // match one runner too many and leave a stranger standing in the group when
  // they got back.
  if (members.length === 0 || inMatch || searching) return 0;
  const effective = liveMode === "solo" ? mode : liveMode;
  const room = lobbyCapacity(effective) - members.length - seats;
  if (room <= 0) return 0;

  const arrived = await addBotSeats(lobbyId, room);
  if (arrived.length === 0) return 0;
  await deps.broadcastLobby(io, lobbyId);

  for (const bot of arrived) {
    void noteLobbyJoin(lobbyId, bot.uid, bot.name, "code", null).catch((e: unknown) =>
      console.error("[world] party join note:", e)
    );
  }
  // Say hello, spread out — three teammates greeting in the same millisecond
  // is the one thing that would give the whole thing away.
  arrived.forEach((bot, i) => {
    setTimeout(
      () => void sayInParty(io, lobbyId, bot, arrivalLine(bot.persona)),
      900 + i * (700 + Math.random() * 1400)
    ).unref();
  });
  return arrived.length;
}

/** A bot teammate speaking in squad chat.
 *
 *  Live only — deliberately. team_messages carries a foreign key to a real
 *  account, and a bot has none; rather than loosen the constraint that keeps
 *  the moderation record honest, these lines are broadcast and written to the
 *  PARTY record (which is uid-and-name based) but never to the chat archive.
 *  The visible cost is that reloading squad chat loses them, which is exactly
 *  what a scrollback of small talk losing small talk looks like. */
export async function sayInParty(io: Server, lobbyId: string, bot: BotAccount, body: string): Promise<void> {
  const members = await getLobbyMembers(lobbyId);
  if (members.length === 0) return;
  io.to(`room:${lobbyId}`).emit("chat:team", {
    id: randomUUID(),
    from: { uid: bot.uid, name: bot.name },
    body,
    at: new Date().toISOString(),
  });
  void noteLobbyChat(lobbyId, bot.uid, bot.name, body).catch((e: unknown) =>
    console.error("[world] party chat note:", e)
  );
}

async function fillDueRequests(io: Server, deps: WorldDeps, worldId: string): Promise<void> {
  const now = Date.now();
  for (const req of await listRequests(worldId)) {
    // A bot's own card is never filled by more bots: it is an advertisement,
    // and it simply comes down when nobody takes it.
    if (req.botId || !req.lobbyId) continue;
    if (now < req.fillAt) continue;
    const joined = await fillPartyWithBots(io, deps, req.lobbyId, req.mode).catch((err) => {
      console.error(`[world] could not fill ${req.lobbyId}:`, err);
      return 0;
    });
    await deleteRequest(worldId, req.id);
    io.to(`world:${worldId}`).emit(WORLD_EV.requestGone, { id: req.id });
    if (joined > 0) console.info(`[world] ${worldId}: filled ${req.lobbyId} with ${joined} bot(s)`);
  }
}

// ---------------------------------------------------------------------------
// 3 + 4. Talking, and asking
// ---------------------------------------------------------------------------

async function maybeSay(io: Server, worldId: string): Promise<void> {
  if (Math.random() > SAY_CHANCE) return;
  const bots = await worldBots(worldId, 40);
  const bot = pickWeighted(bots);
  if (!bot) return;
  const [last] = (await recentMessages(worldId, 1)).slice(-1);
  const body = nextLine(worldId, bot.persona, last?.body ?? null);
  const record = await pushMessage(worldId, {
    uid: bot.uid,
    name: bot.name,
    body,
    userId: null,
    botId: bot.id,
  });
  io.to(`world:${worldId}`).emit(WORLD_EV.msg, toPublicMessage(record));
  archiveWorldMessage({
    worldId,
    senderId: null,
    botId: bot.id,
    uid: bot.uid,
    name: bot.name,
    body,
    at: new Date(record.at),
  });
  seen.add(bot.id);
}

async function maybeCard(io: Server, worldId: string): Promise<void> {
  const live = await listRequests(worldId);
  const standing = live.filter((r) => r.botId).length;
  // A board is a place to look, not a wall. Three cards is about as many as a
  // phone shows without scrolling, and more than that reads as spam.
  if (standing >= 3) return;
  // An EMPTY board fills quickly; a board with something on it drips.
  //
  // Not a cheat: in a room of a thousand there is always somebody looking for
  // a group, so "nobody at all is asking" is the state that would be strange.
  // What must stay rare is a new card every few seconds, which reads as a
  // machine rather than a room — hence the two rates.
  if (Math.random() > (standing === 0 ? 0.3 : CARD_CHANCE)) return;

  const bots = await worldBots(worldId, 20);
  // Never the same account advertising twice at once.
  const host = pickWeighted(bots.filter((b) => !live.some((r) => r.botId === b.id)));
  if (!host) return;
  const mode: "duo" | "squad" = Math.random() < 0.35 ? "duo" : "squad";
  const capacity = mode === "duo" ? 2 : 4;
  // A group that already has somebody in it is far commoner than a lone
  // player advertising, so most cards come with a friend attached.
  const companions = mode === "squad" && Math.random() < 0.45 ? bots.filter((b) => b.id !== host.id).slice(0, 1) : [];
  const withBots = [host, ...companions];
  const need = capacity - withBots.length;
  if (need <= 0) return;

  const now = Date.now();
  const req: WorldRequest = {
    id: randomUUID(),
    worldId,
    uid: host.uid,
    name: host.name,
    lobbyId: "",
    mode,
    need,
    gameId: null,
    at: now,
    // Shorter than a player's, and jittered: a board where every card lives
    // exactly ninety seconds is a board with a clock in it.
    expiresAt: now + REQUEST_TTL_MS * (0.5 + Math.random() * 0.6),
    fillAt: Number.MAX_SAFE_INTEGER,
    userId: null,
    botId: host.id,
    withBotIds: withBots.map((b) => b.id),
  };
  await putRequest(req);
  io.to(`world:${worldId}`).emit(WORLD_EV.request, toPublicRequest(req));
  seen.add(host.id);
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

async function tick(io: Server, deps: WorldDeps): Promise<void> {
  ticks++;
  const ids = await listWorldIds();
  for (const worldId of ids) {
    // Always, watched or not: somebody is waiting on this.
    await fillDueRequests(io, deps, worldId);

    if (ticks % SWEEP_EVERY === 0) await sweepStaleMembers(worldId);
    if (ticks % BALANCE_EVERY === 0) await balanceBots(worldId);

    const watching = listeners(io, worldId);
    if (ticks % POPULATION_EVERY === 0 && watching > 0) {
      const counts = await worldCounts(worldId);
      io.to(`world:${worldId}`).emit(WORLD_EV.population, {
        worldId,
        online: counts.total,
        capacity: counts.capacity,
      });
    }
    if (watching === 0) continue;
    await maybeSay(io, worldId);
    await maybeCard(io, worldId);
  }

  if (seen.size > 0 && ticks % 40 === 0) {
    const batch = [...seen];
    seen.clear();
    void touchBotsSeen(batch).catch((err) => console.error("[world] last-seen:", err));
  }
}

export function startWorldLife(io: Server, deps: WorldDeps): void {
  if (timer) return;
  void ensureFirstWorld().catch((err) => console.error("[world] could not open the first world:", err));
  timer = setInterval(() => {
    void tick(io, deps).catch((err) => console.error("[world] tick failed:", err));
  }, TICK_MS);
  timer.unref();
  console.info(`[world] world life running (tick ${TICK_MS}ms)`);
}

export function stopWorldLife(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
