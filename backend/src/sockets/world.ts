// World chat, from the player's side.
//
// Six handlers, and between them the whole of what a world is to somebody
// holding a phone: open it, read it, say something, ask for a group, take your
// card down, and join somebody else's.
//
// Two things this file is careful about, both of which are the reason the
// feature is worth having rather than a chat box:
//
//   * A CARD IS A PROMISE. Pressing "team up" means you have a group within
//     ten seconds — filled with real people if any are there, and filled
//     anyway if not (platform/worldLife.ts does the filling). Nothing here may
//     leave a card standing with nobody coming.
//   * A REAL PLAYER OUTRANKS A BOT, ALWAYS. Somebody joining a group that
//     filled with bots does not get "that group is full": the newest bot
//     stands down and the person takes the seat.
//
// Everything a handler touches is either Redis or memory. The only Postgres on
// any of these paths is the archive write, which is buffered and never awaited.
import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import type { AuthPayload } from "../middleware/auth.js";
import {
  redis,
  getLobbyMembers,
  getLobbyMode,
  getUserLobby,
  isLobbyLeader,
  isPartyLobby,
  lobbyCapacity,
  setLobbyMode,
} from "../redis.js";
import { getSanctions } from "../services/sanctions.js";
import { listBlockedIds } from "../services/chat.js";
import { archiveWorldMessage, MAX_WORLD_MESSAGE_LENGTH } from "../services/worldChat.js";
import { logEvent } from "../services/eventLog.js";
import { getLobbyGame } from "../platform/store.js";
import { getBots } from "../platform/botAccounts.js";
import { dropOneBotSeat, countBotSeats, seatBots } from "../platform/botSeats.js";
import { noteLobbyJoin } from "../platform/partyLog.js";
import { sayInParty, type WorldDeps } from "../platform/worldLife.js";
import { arrivalLine } from "../platform/worldLines.js";
import {
  deleteRequest,
  getRequest,
  joinWorld,
  listRequests,
  putRequest,
  pushMessage,
  recentMessages,
  requestsBy,
  toPublicMessage,
  toPublicRequest,
  worldCounts,
  REQUEST_TTL_MS,
  REQUEST_FILL_MS,
  type WorldRequest,
} from "../platform/world.js";
import { WORLD_EV, type WorldHello } from "../shared/core/protocol.js";
import { ackOf, payloadOf } from "./ack.js";

interface AuthedSocket extends Socket {
  data: { auth: AuthPayload };
}

/** Everything the lobby module owns that a world join needs. Injected, so this
 *  module never imports the one that imports it — the same arrangement
 *  platform/sockets.ts already uses. */
export interface WorldSocketDeps extends WorldDeps {
  asParty: (io: Server, lobbyId: string) => Promise<string>;
  /** Plain `Socket` rather than the lobby module's richer authed shape: this
   *  module must not depend on the connection fields that module attaches, and
   *  a structural mismatch there would be a compile error for no gain. */
  moveToLobby: (io: Server, socket: Socket, lobbyId: string) => Promise<boolean>;
  joinBlockedReason: (userId: string, uid: string, targetLobbyId: string) => Promise<string | null>;
}

/** Public chat needs a real limit, and the limit has two halves because
 *  spam has two shapes: a burst, and a drip that never stops. */
const SAY_BURST = 5; // messages…
const SAY_WINDOW = 12; // …per this many seconds
const SAY_GAP_MS = 900; // and never two in the same breath
/** One card at a time, and not a new one every few seconds. */
const CARD_COOLDOWN_SEC = 20;

async function sayAllowed(userId: string): Promise<string | null> {
  const key = `world:say:${userId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, SAY_WINDOW);
  if (n > SAY_BURST) return "You're sending messages too quickly";
  return null;
}

export function registerWorldHandlers(io: Server, socket: AuthedSocket, deps: WorldSocketDeps): void {
  const { userId, uid, name } = socket.data.auth;
  const soloLobby = `L${uid}`;
  let lastSayAt = 0;
  /** The world room this socket is currently listening to, so leaving is
   *  exact rather than a guess at which room it might be in. */
  let listening: string | null = null;

  /** Same gate the private chats use: a mute is told to the sender, a shadow
   *  mute reports success and goes nowhere. In a public room the shadow case
   *  matters more than anywhere else — a spam account told it is muted simply
   *  makes another one. */
  async function chatGate(): Promise<"ok" | "muted" | "shadow"> {
    const active = await getSanctions(userId);
    if (active["shadow-chat"]) return "shadow";
    return active.chat ? "muted" : "ok";
  }

  const cleanBody = (raw: unknown): string | null => {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text || text.length > MAX_WORLD_MESSAGE_LENGTH) return null;
    return text;
  };

  // ---- open the tab -------------------------------------------------------
  socket.on(WORLD_EV.hello, async (...args: unknown[]) => {
    const ack = ackOf(args);
    try {
      const worldId = await joinWorld(userId);
      if (listening && listening !== worldId) socket.leave(`world:${listening}`);
      socket.join(`world:${worldId}`);
      listening = worldId;
      const [counts, messages, requests, blocked] = await Promise.all([
        worldCounts(worldId),
        recentMessages(worldId),
        listRequests(worldId),
        listBlockedIds(userId).catch(() => [] as string[]),
      ]);
      // uids, not internal ids — the client only ever sees uids.
      const blockedUids = blocked.length > 0 ? await uidsFor(blocked) : [];
      const hello: WorldHello = {
        worldId,
        online: counts.total,
        capacity: counts.capacity,
        messages: messages.map(toPublicMessage),
        requests: requests.map(toPublicRequest),
        blocked: blockedUids,
        fillMs: REQUEST_FILL_MS,
      };
      ack(hello);
    } catch (err) {
      console.error("world:hello error:", err);
      ack({ error: "World chat is unavailable right now" });
    }
  });

  socket.on(WORLD_EV.leave, () => {
    // The tab closed. Membership of the WORLD is unaffected — that belongs to
    // being online, not to having the panel open — so the player still counts
    // towards the population and still shows in the console's roster.
    if (listening) socket.leave(`world:${listening}`);
    listening = null;
  });

  // ---- say something ------------------------------------------------------
  socket.on(WORLD_EV.say, async (...args: unknown[]) => {
    const ack = ackOf(args);
    try {
      const text = cleanBody(payloadOf<{ body: string }>(args).body);
      if (!text) return ack({ error: `Message must be 1–${MAX_WORLD_MESSAGE_LENGTH} characters` });
      const now = Date.now();
      if (now - lastSayAt < SAY_GAP_MS) return ack({ error: "Slow down a moment" });
      const gate = await chatGate();
      if (gate === "muted") return ack({ error: "You cannot send messages right now" });
      const limited = await sayAllowed(userId);
      if (limited) return ack({ error: limited });
      lastSayAt = now;
      if (gate === "shadow") return ack({ ok: true });

      const worldId = (await joinWorld(userId)) ?? "";
      const record = await pushMessage(worldId, { uid, name, body: text, userId, botId: null });
      io.to(`world:${worldId}`).emit(WORLD_EV.msg, toPublicMessage(record));
      // Buffered; never awaited. A busy world must not put a player's send
      // behind a database round trip.
      archiveWorldMessage({
        worldId,
        senderId: userId,
        botId: null,
        uid,
        name,
        body: text,
        at: new Date(record.at),
      });
      ack({ ok: true, id: record.id, at: record.at });
    } catch (err) {
      console.error("world:say error:", err);
      ack({ error: "Send failed" });
    }
  });

  // ---- ask the world for teammates ---------------------------------------
  socket.on(WORLD_EV.seek, async (...args: unknown[]) => {
    const ack = ackOf(args);
    try {
      const wanted = payloadOf<{ mode: string }>(args).mode === "duo" ? "duo" : "squad";
      const worldId = await joinWorld(userId);
      const myLobby = (await getUserLobbyOr(userId, soloLobby));
      const blocked = await deps.joinBlockedReason(userId, uid, myLobby);
      // Re-uses the join gate for its OWN half: "you are in a match / already
      // searching" is exactly the state in which a card must not go up.
      if (blocked === "Leave your match first" || blocked === "Cancel your search first") {
        return ack({ error: blocked });
      }

      const mode = await getLobbyMode(myLobby);
      if (isPartyLobby(myLobby) && !(await isLobbyLeader(myLobby, userId, uid))) {
        return ack({ error: "Only the party leader can look for players" });
      }
      // Everything that can REFUSE this comes first, and nothing above changes
      // any state. Advertising from solo opens a group — and a refusal that
      // has already opened one leaves somebody standing in a party of one they
      // never got a card for. Same rule the invite path follows: the cooldown
      // is the last check, so a request that was going to fail never burns it.
      const effective = mode === "solo" ? wanted : mode;
      const [members, seats] = await Promise.all([getLobbyMembers(myLobby), countBotSeats(myLobby)]);
      const need = lobbyCapacity(effective) - members.length - seats;
      if (need <= 0) return ack({ error: "Your group is already full" });

      const cooldown = await redis.set(`world:card:${userId}`, "1", "EX", CARD_COOLDOWN_SEC, "NX");
      if (cooldown !== "OK") return ack({ error: "You just asked — give it a moment" });

      // Past the point of no return: from here the group exists.
      if (mode === "solo") await setLobbyMode(myLobby, wanted);
      const lobbyId = await deps.asParty(io, myLobby);
      if (lobbyId !== myLobby) await deps.broadcastLobby(io, myLobby);

      // One card per player. A second press replaces the first rather than
      // stacking, so the board can never be one person three times.
      for (const old of await requestsBy(worldId, uid)) {
        await deleteRequest(worldId, old.id);
        io.to(`world:${worldId}`).emit(WORLD_EV.requestGone, { id: old.id });
      }

      const at = Date.now();
      const req: WorldRequest = {
        id: randomUUID(),
        worldId,
        uid,
        name,
        lobbyId,
        mode: effective === "duo" ? "duo" : "squad",
        need,
        gameId: await getLobbyGame(lobbyId),
        at,
        expiresAt: at + REQUEST_TTL_MS,
        fillAt: at + REQUEST_FILL_MS,
        userId,
        botId: null,
        withBotIds: [],
      };
      await putRequest(req);
      io.to(`world:${worldId}`).emit(WORLD_EV.request, toPublicRequest(req));
      logEvent({ type: "lobby.invite", userId, uid, lobbyId, data: { via: "world", world: worldId, need } });
      await deps.broadcastLobby(io, lobbyId);
      ack({ ok: true, id: req.id, fillMs: REQUEST_FILL_MS, need });
    } catch (err) {
      console.error("world:seek error:", err);
      ack({ error: "Could not post that" });
    }
  });

  socket.on(WORLD_EV.unseek, async (...args: unknown[]) => {
    const ack = ackOf(args);
    try {
      const worldId = await joinWorld(userId);
      for (const req of await requestsBy(worldId, uid)) {
        await deleteRequest(worldId, req.id);
        io.to(`world:${worldId}`).emit(WORLD_EV.requestGone, { id: req.id });
      }
      ack({ ok: true });
    } catch (err) {
      console.error("world:unseek error:", err);
      ack({ error: "Could not take that down" });
    }
  });

  // ---- join somebody's group ---------------------------------------------
  socket.on(WORLD_EV.accept, async (...args: unknown[]) => {
    const ack = ackOf(args);
    try {
      const id = String(payloadOf<{ id: string }>(args).id ?? "");
      if (!id) return ack({ error: "That group is gone" });
      const worldId = await joinWorld(userId);
      const req = await getRequest(worldId, id);
      if (!req || req.expiresAt <= Date.now()) {
        io.to(`world:${worldId}`).emit(WORLD_EV.requestGone, { id });
        return ack({ error: "That group is gone" });
      }
      if (req.uid === uid) return ack({ error: "That's your own group" });

      const result = req.botId
        ? await acceptBotGroup(req)
        : await acceptPlayerGroup(req);
      if (result.error) return ack(result);

      // Whether the card comes down or merely shrinks is the difference
      // between "they found their last player" and "one seat left".
      if (result.filled) {
        await deleteRequest(worldId, req.id);
        io.to(`world:${worldId}`).emit(WORLD_EV.requestGone, { id: req.id });
      } else {
        req.need = Math.max(0, req.need - 1);
        await putRequest(req);
        io.to(`world:${worldId}`).emit(WORLD_EV.request, toPublicRequest(req));
      }
      ack({ ok: true, lobbyId: result.lobbyId });
    } catch (err) {
      console.error("world:accept error:", err);
      ack({ error: "Join failed" });
    }
  });

  /** Joining a person: I move into THEIR party, exactly as a team code does. */
  async function acceptPlayerGroup(
    req: WorldRequest
  ): Promise<{ error?: string; lobbyId?: string; filled: boolean }> {
    const members = await getLobbyMembers(req.lobbyId);
    if (members.length === 0) return { error: "That group is gone", filled: true };
    if (members.includes(userId)) return { error: "You're already in this group", filled: false };
    const blocked = await deps.joinBlockedReason(userId, uid, req.lobbyId);
    if (blocked) return { error: blocked, filled: false };

    const mode = await getLobbyMode(req.lobbyId);
    const effective = mode === "solo" ? req.mode : mode;
    const seats = await countBotSeats(req.lobbyId);
    if (members.length + seats >= lobbyCapacity(effective)) {
      // THE RULE: a real player outranks a bot. The newest bot stands down
      // rather than the person being turned away.
      const stood = seats > 0 ? await dropOneBotSeat(req.lobbyId) : null;
      if (!stood) return { error: "That group is full", filled: true };
    }

    const target = await deps.asParty(io, req.lobbyId);
    const joined = await deps.moveToLobby(io, socket, target);
    if (!joined) return { error: "That group is full", filled: true };
    void noteLobbyJoin(target, uid, name, "request", { uid: req.uid, name: req.name }).catch((e: unknown) =>
      console.error("[world] join note:", e)
    );
    logEvent({ type: "lobby.join", userId, uid, lobbyId: target, data: { via: "world", by: req.uid } });
    const after = await getLobbyMembers(target);
    const seatsAfter = await countBotSeats(target);
    return {
      lobbyId: target,
      filled: after.length + seatsAfter >= lobbyCapacity(await getLobbyMode(target)),
    };
  }

  /** Joining a group somebody in the server population put up: THEY come to
   *  ME. There is no lobby behind their card — a bot has no party of its own —
   *  so the group is formed here, around the player who answered it. Which is
   *  also the honest arrangement: the person who is actually there leads. */
  async function acceptBotGroup(
    req: WorldRequest
  ): Promise<{ error?: string; lobbyId?: string; filled: boolean }> {
    const myLobby = await getUserLobbyOr(userId, soloLobby);
    const blocked = await deps.joinBlockedReason(userId, uid, myLobby);
    if (blocked === "Leave your match first" || blocked === "Cancel your search first") {
      return { error: blocked, filled: false };
    }
    if (isPartyLobby(myLobby) && !(await isLobbyLeader(myLobby, userId, uid))) {
      return { error: "Only the party leader can bring players in", filled: false };
    }
    // Everything that can refuse comes first — see world:seek. Walking into
    // somebody's group OPENS one around you, and a refusal that has already
    // done that leaves a player in a party they did not ask for.
    const mode = await getLobbyMode(myLobby);
    const [members, seats] = await Promise.all([getLobbyMembers(myLobby), countBotSeats(myLobby)]);
    const room = lobbyCapacity(mode === "solo" ? req.mode : mode) - members.length - seats;
    if (room <= 0) return { error: "Your group is already full", filled: false };
    // The names on the card are the names that arrive. A group advertised by
    // Nova that turns up as somebody else is worse than no group at all — so
    // if those accounts are gone, so is the group.
    const wanted = getBots(req.withBotIds).slice(0, room);
    if (wanted.length === 0) return { error: "That group is gone", filled: true };

    // Past the point of no return.
    if (mode === "solo") await setLobbyMode(myLobby, req.mode);
    const lobbyId = await deps.asParty(io, myLobby);
    if (lobbyId !== myLobby) await deps.broadcastLobby(io, myLobby);
    const arrived = await seatBots(lobbyId, wanted);
    if (arrived.length === 0) return { error: "That group is gone", filled: true };
    await deps.broadcastLobby(io, lobbyId);
    for (const bot of arrived) {
      void noteLobbyJoin(lobbyId, bot.uid, bot.name, "request", { uid, name }).catch((e: unknown) =>
        console.error("[world] join note:", e)
      );
    }
    arrived.forEach((bot, i) => {
      setTimeout(
        () => void sayInParty(io, lobbyId, bot, arrivalLine(bot.persona)),
        800 + i * (600 + Math.random() * 1200)
      ).unref();
    });
    logEvent({ type: "lobby.join", userId, uid, lobbyId, data: { via: "world-open", with: arrived.length } });
    // A card taken is a card gone: that group has its player.
    return { lobbyId, filled: true };
  }
}

/** The lobby a player is in, or their own. */
async function getUserLobbyOr(userId: string, fallback: string): Promise<string> {
  return (await getUserLobby(userId)) ?? fallback;
}

/** Internal ids → uids, for the block list the client filters with. */
async function uidsFor(ids: string[]): Promise<string[]> {
  const { getUsersByIds } = await import("../services/users.js");
  return (await getUsersByIds(ids)).map((u) => u.uid);
}
