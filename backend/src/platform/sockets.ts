// Socket handlers for the game platform: picking a game, download progress,
// starting, and the match lifecycle. Registered per connection from
// sockets/index.ts (the lobby's own handlers stay there). Every handler reads
// `payload ?? {}` — a null emit must never be able to crash the server.
import type { Server, Socket } from "socket.io";
import type { AuthPayload } from "../middleware/auth.js";
import { getLobbyMembers, getLobbyMode, getUserLobby } from "../redis.js";
import { getUsersByIds } from "../services/users.js";
import { getGame } from "./games.js";
import { createMatch, getMatchForUser, isActive, leave, markReady, onDisconnect, onInput, onReconnect } from "./match.js";
import { getLoading, getLobbyGame, getLobbyMatch, setLoading, setLobbyGame, throttle } from "./store.js";
import { EV, PROGRESS_MAX_HZ, type TimePong } from "../shared/core/protocol.js";

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

export function registerPlatformHandlers(io: Server, socket: AuthedSocket, deps: PlatformDeps): void {
  const { userId, uid } = socket.data.auth;
  const soloLobby = `L${uid}`;

  // ---- lobby: game selection ----
  socket.on(EV.pickGame, async (payload: { gameId?: unknown } | null, ack?: (r: object) => void) => {
    try {
      const { gameId } = payload ?? {};
      const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
      if (lobbyId !== soloLobby) return ack?.({ error: "Only the party leader can choose the game" });
      if (await getLobbyMatch(lobbyId)) return ack?.({ error: "Finish the current match first" });
      let picked: string | null = null;
      if (gameId !== null && gameId !== undefined) {
        if (typeof gameId !== "string" || !getGame(gameId)) return ack?.({ error: "That game isn't available" });
        picked = gameId;
      }
      if (!(await throttle("pickgame", userId, 1))) return ack?.({ error: "Hold on a moment" });
      await setLobbyGame(lobbyId, picked);
      await deps.broadcastLobby(io, lobbyId);
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
      if (lobbyId !== soloLobby) return reply?.({ error: "Only the party leader can start" });
      const gameId = await getLobbyGame(lobbyId);
      if (!gameId) return reply?.({ error: "Choose a game first" });
      const game = getGame(gameId);
      if (!game) return reply?.({ error: "That game isn't available right now" });
      if (await getLobbyMatch(lobbyId)) return reply?.({ error: "Your party is already in a match" });
      const [memberIds, mode, loading] = await Promise.all([
        getLobbyMembers(lobbyId),
        getLobbyMode(lobbyId),
        getLoading(lobbyId),
      ]);
      const users = await getUsersByIds(memberIds);
      if (users.length === 0) return reply?.({ error: "Nobody to start with" });
      const notReady = users.filter((u) => (loading[u.uid] ?? 0) < 100);
      if (notReady.length > 0) {
        return reply?.({ error: `Waiting for ${notReady.length === 1 ? notReady[0].username ?? "a teammate" : `${notReady.length} teammates`} to finish downloading` });
      }
      if (users.length > game.matchSizeFor(mode)) return reply?.({ error: "Your party is too big for this mode" });
      if (!(await throttle("start", userId, 3))) return reply?.({ error: "Hold on a moment" });
      // Milestone 1: the party alone. Matchmaking (fill from the pool, then
      // bots) slots in here in M3 — createMatch already takes several parties.
      const match = await createMatch(io, game, [{ lobbyId, users }]);
      reply?.({ ok: true, matchId: match.id });
    } catch (err) {
      console.error("lobby:start error:", err);
      reply?.({ error: "Could not start" });
    }
  });

  // ---- match: ready / input / leave ----
  socket.on(EV.ready, (_payload: unknown, ack?: (r: object) => void) => {
    const reply = typeof _payload === "function" ? (_payload as (r: object) => void) : ack;
    const m = getMatchForUser(userId);
    if (!m || !isActive(m)) return reply?.({ error: "No match to be ready for" });
    markReady(io, m, uid);
    reply?.({ ok: true });
  });

  socket.on(EV.input, (payload: unknown) => {
    const m = getMatchForUser(userId);
    if (!m) return;
    const why = onInput(io, socket, m, uid, payload);
    if (why) dropped.set(why, (dropped.get(why) ?? 0) + 1);
  });

  socket.on(EV.leave, async (_payload: unknown, ack?: (r: object) => void) => {
    const reply = typeof _payload === "function" ? (_payload as (r: object) => void) : ack;
    try {
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
export function platformOnConnect(io: Server, socket: AuthedSocket): void {
  const resume = onReconnect(io, socket, socket.data.auth.userId);
  if (resume) socket.emit(EV.resume, resume);
}

/** Called from the lobby's disconnect handler, only when this socket still
 *  owned the user's presence (a replacement socket means they're still here). */
export function platformOnDisconnect(io: Server, socket: AuthedSocket): void {
  onDisconnect(io, socket.data.auth.userId);
}
