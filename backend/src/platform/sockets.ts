// Socket handlers for the game platform: picking a game, download progress,
// starting, and the match lifecycle. Registered per connection from
// sockets/index.ts (the lobby's own handlers stay there). Every handler reads
// `payload ?? {}` — a null emit must never be able to crash the server.
import type { Server, Socket } from "socket.io";
import type { AuthPayload } from "../middleware/auth.js";
import { getLobbyMembers, getLobbyMode, getUserLobby, isLobbyLeader, isPartyLobby } from "../redis.js";
import { displayName, getUsersByIds } from "../services/users.js";
import { getGame } from "./games.js";
import { findFriendshipBetween } from "../services/friends.js";
import {
  createMatch,
  getMatchForUser,
  humansIn,
  isActive,
  leave,
  markReady,
  onDisconnect,
  onInput,
  onQuick,
  onReconnect,
} from "./match.js";
import {
  getLoading,
  getLobbyGame,
  getLobbyMatch,
  getSayReady,
  getSearching,
  setLoading,
  setLobbyGame,
  setSayReady,
  throttle,
} from "./store.js";
import { FILL_DEADLINE_MS, dequeue, enqueue, packNow } from "./matchmaking.js";
import { botSeatIdentities, countBotSeats } from "./botSeats.js";
import {
  getIslandForUser,
  humansOnIsland,
  isLive,
  joinIsland,
  leaveIsland,
  onEmote,
  onIslandDisconnect,
  onIslandPin,
  onIslandQuick,
  onIslandReconnect,
  onReport,
} from "./island.js";
import { canPerform } from "../services/catalog.js";
import { EV, LIVE_EV, PROGRESS_MAX_HZ, type MatchAddable, type MatchSync, type TimePong } from "../shared/core/protocol.js";
import { noteLobbyPick, noteLobbyReady, noteLobbySearch } from "./partyLog.js";
import { bannedAmong, gameHeld, hiddenGames } from "./gameLocks.js";
import { getSanctions } from "../services/sanctions.js";
import { logEvent } from "../services/eventLog.js";

interface AuthedSocket extends Socket {
  data: { auth: AuthPayload; lastProgressAt?: number };
}

/** Injected so this module never imports the lobby module (which imports
 *  this one) — the lobby's broadcast is the one thing we need from it. */
export interface PlatformDeps {
  broadcastLobby: (io: Server, lobbyId: string) => Promise<void>;
}

/** Ignored-input counters, so abuse is visible in logs without costing a
 *  round trip per dropped swipe. */
const dropped = new Map<string, number>();
setInterval(() => {
  if (dropped.size === 0) return;
  console.warn("[match] dropped inputs:", Object.fromEntries(dropped));
  dropped.clear();
}, 60_000).unref();

/** Where an action came from. An action without an address is half a record,
 *  and the handshake already resolved it — the same shape the lobby module
 *  attaches, so a row from either side reads the same. */
const trace = (socket: AuthedSocket) => {
  const d = socket.data as {
    origin?: { ip?: string; country?: string | null; ua?: string | null };
    deviceHash?: string;
  };
  return { ip: d.origin?.ip, ipCountry: d.origin?.country ?? null, ua: d.origin?.ua ?? null, deviceHash: d.deviceHash };
};

export function registerPlatformHandlers(io: Server, socket: AuthedSocket, deps: PlatformDeps): void {
  const { userId, uid } = socket.data.auth;
  const soloLobby = `L${uid}`;
  /** The name to put in front of teammates. Read from the row rather than
   *  from the token, which carries whatever the name was when it was signed —
   *  the lobby module makes the same choice, for the same reason. Only two
   *  handlers below need it, and both are things a person does by hand. */
  const myName = async (): Promise<string> => {
    const [me] = await getUsersByIds([userId]);
    return me ? displayName(me) : uid;
  };
  registerSync(socket);

  // ---- lobby: game selection ----
  socket.on(EV.pickGame, async (payload: { gameId?: unknown } | null, ack?: (r: object) => void) => {
    try {
      const { gameId } = payload ?? {};
      const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
      if (!(await isLobbyLeader(lobbyId, userId, uid))) {
        return ack?.({ error: "Only the party leader can choose the game" });
      }
      if (await getLobbyMatch(lobbyId)) return ack?.({ error: "Finish the current match first" });
      let picked: string | null = null;
      if (gameId !== null && gameId !== undefined) {
        if (typeof gameId !== "string" || !getGame(gameId)) return ack?.({ error: "That game isn't available" });
        const held = await gameHeld(gameId);
        if (held) return ack?.({ error: held });
        // Not offered is not the same as not allowed. A client can name any
        // id it likes, and one naming a hidden game is the client this exists
        // to stop.
        if ((await hiddenGames()).includes(gameId)) return ack?.({ error: "That game isn't available" });
        picked = gameId;
      }
      if (!(await throttle("pickgame", userId, 1))) return ack?.({ error: "Hold on a moment" });
      await setLobbyGame(lobbyId, picked);
      void noteLobbyPick(lobbyId, uid, await myName(), picked).catch((e: unknown) =>
        console.error("[party] pick:", e)
      );
      await deps.broadcastLobby(io, lobbyId);
      logEvent({
        type: "lobby.pick",
        userId,
        uid,
        lobbyId,
        gameId: picked ?? undefined,
        ...trace(socket),
      });
      ack?.({ ok: true, gameId: picked });
    } catch (err) {
      console.error("lobby:pickGame error:", err);
      ack?.({ error: "Could not choose the game" });
    }
  });

  // ---- lobby: download progress (fire-and-forget from the client) ----
  socket.on(EV.progress, async (payload: { pct?: unknown } | null) => {
    try {
      const raw = (payload ?? {}).pct;
      if (typeof raw !== "number" || !Number.isFinite(raw)) return;
      const pct = Math.max(0, Math.min(100, Math.round(raw)));
      const now = Date.now();
      // Server-side floor on the rate: intermediate values faster than the
      // ceiling are dropped unread. The endpoints always land — 100 is what
      // lets the leader start, and a tiny pack reaches it within a frame.
      const terminal = pct === 0 || pct === 100;
      if (!terminal && now - (socket.data.lastProgressAt ?? 0) < 1000 / PROGRESS_MAX_HZ - 20) return;
      socket.data.lastProgressAt = now;
      const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
      if (!(await getLobbyGame(lobbyId))) return; // nothing selected — stale report
      await setLoading(lobbyId, uid, pct);
      socket.to(`room:${lobbyId}`).emit(EV.loading, { uid, pct });
    } catch (err) {
      console.error("game:progress error:", err);
    }
  });

  // ---- lobby: start (leader) ----
  socket.on(EV.start, async (_payload: unknown, ack?: (r: object) => void) => {
    // Socket.IO passes (payload, ack) or just (ack) — accept both shapes.
    const reply = typeof _payload === "function" ? (_payload as (r: object) => void) : ack;
    try {
      const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
      if (!(await isLobbyLeader(lobbyId, userId, uid))) {
        return reply?.({ error: "Only the party leader can start" });
      }
      // A match ban leaves the lobby and friends working — only playing stops.
      const active = await getSanctions(userId);
      if (active.match) return reply?.({ error: active.match.reason || "You cannot join matches right now" });
      const gameId = await getLobbyGame(lobbyId);
      if (!gameId) return reply?.({ error: "Choose a game first" });
      const game = getGame(gameId);
      if (!game) return reply?.({ error: "That game isn't available right now" });
      // Held between the pick and the press — which is the ordinary case, since
      // a hold goes on while parties are already sitting in front of it.
      const held = await gameHeld(gameId);
      if (held) return reply?.({ error: held });
      if ((await hiddenGames()).includes(gameId)) return reply?.({ error: "That game isn't available right now" });
      if (await getLobbyMatch(lobbyId)) return reply?.({ error: "Your party is already in a match" });
      const [memberIds, mode, loading] = await Promise.all([
        getLobbyMembers(lobbyId),
        getLobbyMode(lobbyId),
        getLoading(lobbyId),
      ]);
      const users = await getUsersByIds(memberIds);
      if (users.length === 0) return reply?.({ error: "Nobody to start with" });
      // One barred player stops the party, and is NAMED. A start that fails
      // without saying who is a party arguing with itself.
      //
      // BEFORE the download gate. Making a party fetch a twenty-megabyte pack
      // and only then telling them somebody at the table cannot use it is a
      // waste of their data and their time — and the answer was known before
      // the first byte.
      const barred = await bannedAmong(gameId, memberIds);
      if (barred.size > 0) {
        const who = users.filter((u) => barred.has(u.id)).map((u) => u.username ?? u.uid);
        return reply?.({
          error:
            who.length === 1
              ? users.length === 1
                ? barred.get(memberIds.find((id) => barred.has(id))!) || "You cannot play this game"
                : `${who[0]} cannot play this game`
              : `${who.join(", ")} cannot play this game`,
        });
      }
      const notReady = users.filter((u) => (loading[u.uid] ?? 0) < 100);
      if (notReady.length > 0) {
        return reply?.({ error: `Waiting for ${notReady.length === 1 ? notReady[0].username ?? "a teammate" : `${notReady.length} teammates`} to finish downloading` });
      }
      // Downloaded is not the same as willing. Everybody EXCEPT the leader has
      // to say they want to play this — pressing START is the leader saying
      // it. One player who does not fancy this game can hold the party, which
      // is the point: the alternative is being dragged into it.
      if (users.length > 1) {
        const saidYes = new Set(await getSayReady(lobbyId));
        const waiting = users.filter((u) => u.uid !== uid && !saidYes.has(u.uid));
        if (waiting.length > 0) {
          return reply?.({
            error:
              waiting.length === 1
                ? `${waiting[0].username ?? "A teammate"} has not said they are ready`
                : `${waiting.length} teammates have not said they are ready`,
          });
        }
      }
      // Bot teammates occupy seats in the match too, so they count towards
      // what this party is worth to the pool — and against how big it may be.
      // Left out, matchmaking would promise the same seats twice (W3).
      const partyBots = await countBotSeats(lobbyId);
      const partySize = users.length + partyBots;
      if (partySize > game.matchSizeFor(mode)) return reply?.({ error: "Your party is too big for this mode" });
      if (await getSearching(lobbyId)) return reply?.({ error: "Already searching" });
      if (!(await throttle("start", userId, 3))) return reply?.({ error: "Hold on a moment" });

      const size = game.matchSizeFor(mode);
      // A DROP-IN WORLD IS NOT QUEUED FOR.
      //
      // Matchmaking's whole shape is "hold this party until enough others turn
      // up, then build a match out of them". A social island already exists and
      // already has twenty people on it; what a party needs is a door, not a
      // queue. So START skips the pool entirely and the seats are taken from
      // the population — which is also why nobody here ever sees a "finding
      // players" screen.
      if (game.dropIn) {
        logEvent({
          ...trace(socket),
          type: "lobby.search",
          userId,
          uid,
          lobbyId,
          gameId,
          data: { mode, party: users.length, size, solo: users.length === 1, dropIn: true },
        });
        const joined = await joinIsland(io, game, { lobbyId, users, bots: await botSeatIdentities(lobbyId) });
        if ("error" in joined) return reply?.({ error: joined.error });
        return reply?.({ ok: true, matchId: joined.id });
      }
      // PRESSING START IS AN ACT, and until now only its consequence was on
      // record: a match appeared, with nothing saying who asked for it or when
      // — and nothing at all when the ask never turned into a match. Logged
      // here, before either outcome, so a search that fills with bots, a
      // search that is cancelled and a search that finds nobody all leave the
      // same first line.
      logEvent({
        ...trace(socket),
        type: "lobby.search",
        userId,
        uid,
        lobbyId,
        gameId,
        data: { mode, party: users.length, size, solo: users.length === 1 },
      });
      // The same fact in the group's own recording, when there is a group to
      // record it in. The global log answers "what did this account do"; a
      // party's recording answers "what happened in this group" — and the
      // run-up to a match is exactly what somebody watching one back is
      // looking for.
      if (isPartyLobby(lobbyId)) {
        void noteLobbySearch(lobbyId, uid, await myName(), true, gameId).catch((e: unknown) =>
          console.error("[party] search:", e)
        );
      }
      if (users.length >= size) {
        // A full party needs nobody: start at once rather than queue for a
        // pool that has nothing to add.
        const match = await createMatch(io, game, [{ lobbyId, users }]);
        return reply?.({ ok: true, matchId: match.id });
      }
      // Otherwise wait to be topped up — by other parties, and then by bots
      // once the deadline passes. The client shows the search from this ack.
      await enqueue(gameId, size, lobbyId, partySize);
      io.to(`room:${lobbyId}`).emit(EV.searching, { found: users.length, size, elapsedMs: 0, deadlineMs: FILL_DEADLINE_MS });
      reply?.({ ok: true, searching: true, size });
      // Try immediately: someone may already be waiting.
      await packNow(io, gameId, size);
    } catch (err) {
      console.error("lobby:start error:", err);
      reply?.({ error: "Could not start" });
    }
  });

  // ---- lobby: cancel the search (ANY member) ----
  //
  // Starting is the leader's call; stopping is not. A search runs for up to
  // ten seconds and then fills the empty seats with bots, and a player who has
  // changed their mind — or who never wanted this game — should not have to
  // sit through a match to get out of it. Anybody in the party can pull the
  // handle, and everybody is told who did, so it is not a mystery.
  socket.on(EV.cancel, async (_payload: unknown, ack?: (r: object) => void) => {
    const reply = typeof _payload === "function" ? (_payload as (r: object) => void) : ack;
    try {
      const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
      const pool = await getSearching(lobbyId);
      if (!pool) return reply?.({ ok: true }); // already out of the queue
      const [gameId, sizeText] = pool.split(":");
      await dequeue(gameId, Number(sizeText), lobbyId);
      logEvent({
        ...trace(socket),
        type: "lobby.cancel",
        userId,
        uid,
        lobbyId,
        gameId,
        // Any member can stop a search, so WHO did is the whole point of the
        // line — "the party stopped looking" answers nothing.
        data: { leader: await isLobbyLeader(lobbyId, userId, uid) },
      });
      if (isPartyLobby(lobbyId)) {
        void noteLobbySearch(lobbyId, uid, await myName(), false, gameId).catch((e: unknown) =>
          console.error("[party] search:", e)
        );
      }
      io.to(`room:${lobbyId}`).emit(EV.searchEnded, {
        reason: "cancelled",
        by: { uid, name: await myName() },
        mine: await isLobbyLeader(lobbyId, userId, uid),
      });
      reply?.({ ok: true });
    } catch (err) {
      console.error("lobby:cancelSearch error:", err);
      reply?.({ error: "Could not cancel" });
    }
  });

  // ---- lobby: I am ready / I am not ----
  socket.on(EV.sayReady, async (payload: { ready?: unknown } | null, ack?: (r: object) => void) => {
    const reply = typeof payload === "function" ? (payload as (r: object) => void) : ack;
    try {
      const ready = (payload ?? {}).ready !== false;
      const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
      if (await getLobbyMatch(lobbyId)) return reply?.({ error: "You are already in a match" });
      await setSayReady(lobbyId, uid, ready);
      void noteLobbyReady(lobbyId, uid, await myName(), ready).catch((e: unknown) =>
        console.error("[party] ready:", e)
      );
      // Everyone sees it, through the same broadcast that carries the rest of
      // the lobby — one shape of truth, not a second channel that can drift.
      await deps.broadcastLobby(io, lobbyId);
      reply?.({ ok: true, ready });
    } catch (err) {
      console.error("lobby:sayReady error:", err);
      reply?.({ error: "Could not change that" });
    }
  });

  // ---- lobby: I would rather play something else ----
  //
  // The polite half of the cancel above. A member cannot change the game —
  // that stays the leader's — but they can say so without leaving the party
  // or typing it into chat and hoping somebody reads it.
  socket.on(EV.objectGame, async (_payload: unknown, ack?: (r: object) => void) => {
    const reply = typeof _payload === "function" ? (_payload as (r: object) => void) : ack;
    try {
      const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
      if (await isLobbyLeader(lobbyId, userId, uid)) {
        return reply?.({ error: "You choose the game — nobody to ask" });
      }
      if (!(await throttle("object", userId, 20))) return reply?.({ error: "You have just said so" });
      const gameId = await getLobbyGame(lobbyId);
      io.to(`room:${lobbyId}`).emit(EV.objection, { uid, name: await myName(), gameId });
      reply?.({ ok: true });
    } catch (err) {
      console.error("lobby:objectGame error:", err);
      reply?.({ error: "Could not send that" });
    }
  });

  // ---- match: ready / input / leave ----
  socket.on(EV.ready, (_payload: unknown, ack?: (r: object) => void) => {
    const reply = typeof _payload === "function" ? (_payload as (r: object) => void) : ack;
    const m = getMatchForUser(userId);
    if (!m || !isActive(m)) {
      // A world is already running, so there is nothing to be ready FOR — but
      // a client that says so is not wrong and must not be told it is.
      if (getIslandForUser(userId)) return reply?.({ ok: true });
      return reply?.({ error: "No match to be ready for" });
    }
    markReady(io, m, uid);
    reply?.({ ok: true });
  });

  socket.on(EV.input, (payload: unknown) => {
    const m = getMatchForUser(userId);
    if (!m) return;
    const why = onInput(socket, m, uid, payload);
    if (why) dropped.set(why, (dropped.get(why) ?? 0) + 1);
  });

  socket.on(EV.quick, (payload: unknown) => {
    const island = getIslandForUser(userId);
    if (island) {
      const why = onIslandQuick(io, island, uid, payload);
      if (why) dropped.set(`quick:${why}`, (dropped.get(`quick:${why}`) ?? 0) + 1);
      return;
    }
    const m = getMatchForUser(userId);
    if (!m) return;
    const why = onQuick(io, m, uid, payload);
    if (why) dropped.set(`quick:${why}`, (dropped.get(`quick:${why}`) ?? 0) + 1);
  });

  // ---- drop-in worlds: where I am, and what I am performing ----
  //
  // Deliberately NOT on the input channel. An input is logged, simulated,
  // relayed and replayed; a position is none of those things — twenty people
  // walking for forty minutes is half a million messages that decide nothing,
  // and the day one of them is treated as evidence is the day a replay claims
  // somebody stood somewhere they did not.
  socket.on(LIVE_EV.state, (payload: unknown) => {
    const island = getIslandForUser(userId);
    if (!island) return;
    const why = onReport(island, uid, payload);
    if (why) dropped.set(`live:${why}`, (dropped.get(`live:${why}`) ?? 0) + 1);
  });

  socket.on(LIVE_EV.pin, (payload: unknown) => {
    const island = getIslandForUser(userId);
    if (!island) return;
    const why = onIslandPin(io, island, uid, payload);
    if (why) dropped.set(`pin:${why}`, (dropped.get(`pin:${why}`) ?? 0) + 1);
  });

  socket.on(LIVE_EV.emote, async (payload: { id?: unknown } | null, ack?: (r: object) => void) => {
    const reply = typeof payload === "function" ? (payload as (r: object) => void) : ack;
    try {
      const island = getIslandForUser(userId);
      if (!island || !isLive(island)) return reply?.({ error: "You are not in a world" });
      const id = String((payload ?? {}).id || "");
      // The sheet is a menu, not a guarantee: a modified client can ask for
      // "fall", or for a dance it has not bought.
      if (!(await canPerform(userId, id))) return reply?.({ error: "You can't perform that" });
      const why = onEmote(io, island, uid, id);
      if (why === "rate") return reply?.({ error: "Slow down" });
      reply?.(why ? { error: "Emote failed" } : { ok: true });
    } catch (err) {
      console.error("live:emote error:", err);
      reply?.({ error: "Emote failed" });
    }
  });

  // Who from the match just finished can I still send a friend request to?
  //
  // Answered per asker and only on request, never folded into the broadcast
  // result: a uid is absent from this list whether it belonged to a bot, to
  // someone already on your friend list, or to someone you already have a
  // request with — so the list can never be read backwards to work out which
  // opponents were real.
  socket.on(EV.addable, async (payload: unknown, ack?: (r: MatchAddable) => void) => {
    const reply = typeof payload === "function" ? (payload as (r: MatchAddable) => void) : ack;
    try {
      const { matchId } = (payload ?? {}) as { matchId?: unknown };
      if (typeof matchId !== "string") return reply?.({ uids: [] });
      // An island answers the same question, and it is the more useful half of
      // it: the whole point of standing in a park with strangers is leaving
      // with one of them on your friend list.
      const people = humansIn(matchId).size > 0 ? humansIn(matchId) : humansOnIsland(matchId);
      // Only someone who was actually in the match may ask about it.
      if (![...people.values()].includes(userId)) return reply?.({ uids: [] });
      const others = [...people.entries()].filter(([, id]) => id !== userId);
      const known = await Promise.all(others.map(([, id]) => findFriendshipBetween(userId, id)));
      reply?.({ uids: others.filter((_, i) => !known[i]).map(([theirUid]) => theirUid) });
    } catch (err) {
      console.error("match:addable error:", err);
      reply?.({ uids: [] });
    }
  });

  socket.on(EV.leave, async (_payload: unknown, ack?: (r: object) => void) => {
    const reply = typeof _payload === "function" ? (_payload as (r: object) => void) : ack;
    try {
      const island = getIslandForUser(userId);
      if (island) {
        await leaveIsland(io, island, uid);
        return reply?.({ ok: true });
      }
      const m = getMatchForUser(userId);
      if (!m) return reply?.({ ok: true }); // nothing to leave — already out
      await leave(io, m, uid);
      reply?.({ ok: true });
    } catch (err) {
      console.error("match:leave error:", err);
      reply?.({ error: "Could not leave" });
    }
  });

  // ---- clock probe ----
  socket.on(EV.ping, (_payload: unknown, ack?: (r: TimePong) => void) => {
    const reply = typeof _payload === "function" ? (_payload as (r: TimePong) => void) : ack;
    reply?.({ serverNow: Date.now() });
  });
}

/** Called once the connection is set up (presence + lobby). If this user is
 *  mid-match, put the socket back into it and send the catch-up payload. */
export function platformOnConnect(socket: AuthedSocket): void {
  const resume = onReconnect(socket, socket.data.auth.userId) ?? onIslandReconnect(socket, socket.data.auth.userId);
  if (resume) socket.emit(EV.resume, resume);
}

/** The other half of reconnecting: a client that believes it is in a match
 *  asks, and gets a straight answer either way.
 *
 *  The push above only fires when there IS a match, so on its own it leaves
 *  the bad case silent — the seat was forfeited while the player had no
 *  signal, and their screen carries on showing a run that is no longer theirs.
 *  This is asked by the client, so it does not depend on the server having
 *  guessed what the client still has on screen. */
function registerSync(socket: AuthedSocket): void {
  socket.on(EV.sync, (_p: unknown, ack?: (r: MatchSync) => void) => {
    const reply = typeof _p === "function" ? (_p as (r: MatchSync) => void) : ack;
    const resume =
      onReconnect(socket, socket.data.auth.userId) ?? onIslandReconnect(socket, socket.data.auth.userId);
    reply?.(resume ? { in: true, resume } : { in: false, reason: "gone" });
  });
}

/** Called from the lobby's disconnect handler, only when this socket still
 *  owned the user's presence (a replacement socket means they're still here). */
export function platformOnDisconnect(io: Server, socket: AuthedSocket): void {
  onDisconnect(io, socket.data.auth.userId);
  onIslandDisconnect(io, socket.data.auth.userId);
}
