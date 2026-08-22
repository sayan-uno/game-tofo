import type { Server, Socket } from "socket.io";
import { verifyToken, type AuthPayload } from "../middleware/auth.js";
import {
  HERE_TTL,
  setOnline,
  setOffline,
  setAway,
  touchHere,
  touchSocket,
  getSocketId,
  getUserLobby,
  getLobbyMembers,
  getLobbyLeader,
  setLobbyLeader,
  clearLobbyLeader,
  isLobbyLeader,
  isPartyLobby,
  newPartyId,
  getLobbyMode,
  setLobbyMode,
  ensureLobbyModeOnConnect,
  lobbyCapacity,
  joinLobby,
  leaveLobby,
  setDnd,
  isDnd,
  armSendCooldown,
  SEND_COOLDOWN_SECONDS,
  getOrCreateTeamCode,
  getTeamCode,
  getTeamCodeLobby,
  releaseTeamCode,
  moveTeamCode,
  throttleCodeJoin,
  createJoinRequest,
  consumeJoinRequest,
  getLobbyJoinTimes,
  migrateLobbyMembers,
  moveTeamSession,
} from "../redis.js";
import { areFriends, displayName, getFriendIds, getUserById, getUserByUid, getUsersByIds } from "../services/users.js";
import { registerChatHandlers, syncTeamChatSession } from "./chat.js";
import { deviceHashFrom, socketOrigin, type ClientOrigin } from "../services/clientIp.js";
import { logEvent } from "../services/eventLog.js";
import { noteDevice } from "../services/devices.js";
import { getSanctions } from "../services/sanctions.js";
import { gateShut, getFlags, inMaintenance, markNoticeSeen, noticeSeen } from "../platform/flags.js";
import { noticesFor } from "../services/notices.js";
import { canPerform, resolveCharacter, resolveWeapon } from "../services/catalog.js";
import { platformOnConnect, platformOnDisconnect, registerPlatformHandlers } from "../platform/sockets.js";
import {
  clearLobbyGameState,
  getLoading,
  getSayReady,
  setSayReady,
  getLobbyGame,
  getLobbyMatch,
  getUserMatch,
  getSearching,
  moveLobbyGameState,
} from "../platform/store.js";
import { dequeue, updateSize } from "../platform/matchmaking.js";
import { syncLobbyRecording } from "../platform/voiceRecording.js";
import { bannedAmong } from "../platform/gameLocks.js";
import {
  noteInvite,
  noteLobbyChat,
  noteLobbyEmote,
  noteLobbyJoin,
  noteLobbyState,
  partyEnabled,
  takeInvite,
  noteLobbyLeader,
  noteLobbyLeave,
  noteLobbyMic,
} from "../platform/partyLog.js";

interface AuthedSocket extends Socket {
  data: {
    auth: AuthPayload;
    /** Where this connection came from, resolved once at the handshake — the
     *  session trail needs it and re-deriving it per event would be waste. */
    origin: ClientOrigin;
    /** Client-reported, unverified, correlation only. */
    deviceHash: string | null;
    connectedAt: number;
    /** When the page last said it was open AND in front of somebody. */
    lastBeatAt?: number;
    /** Connected, but nobody is looking. Held here rather than read back out
     *  of Redis so the sweep below is pure memory. */
    away?: boolean;
    /** When the sweep last refreshed this connection's registry key. */
    socketTouchedAt?: number;
    /** …and, for a page too old to send heartbeats, its presence. */
    hereTouchedAt?: number;
    /** When they went quiet, so coming back can say for how long. */
    awayAt?: number;
    /** Why this player is about to leave a party, when it is not their own
     *  doing. Set by whoever forces the move and consumed by moveToLobby, so
     *  the record says what actually happened.
     *
     *  Without it a kick wrote TWO lines — "left the party", from the move
     *  itself, and "was removed", from the handler — and the first one was a
     *  lie. Evidence that says somebody walked out when they were thrown out
     *  is worse than no evidence: it is the wrong answer, in writing, to the
     *  exact question the record exists to settle. */
    leaveReason?: "kicked";
  };
}

/** Floor between two emotes from one connection. Long enough to stop a held
 *  finger (or a script) making every squadmate re-pose on every frame, short
 *  enough that a player who genuinely wants to emote twice can. */
const EMOTE_COOLDOWN_MS = 1200;

/** Push the current member list (and party mode) of a lobby to everyone in it.
 *  Exported because equipping a character changes what squadmates see, so the
 *  collection route re-broadcasts through this same path. */
/** Where an action came from, in the shape logEvent wants.
 *
 *  An action without an address is half a record: "he sent that invite" is
 *  worth much less than "he sent that invite from this address on this
 *  device". The socket already carries both from the handshake, so this costs
 *  a property read.
 */
export const trace = (socket: AuthedSocket) => ({
  ip: socket.data.origin?.ip,
  ipCountry: socket.data.origin?.country,
  ua: socket.data.origin?.ua,
  deviceHash: socket.data.deviceHash,
});

export async function broadcastLobby(io: Server, lobbyId: string) {
  const memberIds = await getLobbyMembers(lobbyId);
  const [users, mode, game, loadingAll, sayReady, leaderId] = await Promise.all([
    getUsersByIds(memberIds),
    getLobbyMode(lobbyId),
    getLobbyGame(lobbyId),
    getLoading(lobbyId),
    getSayReady(lobbyId),
    isPartyLobby(lobbyId) ? getLobbyLeader(lobbyId) : Promise.resolve(null),
  ]);
  // The party is gone — its game pick and download progress go with it.
  if (memberIds.length === 0 && game) await clearLobbyGameState(lobbyId);
  // Codes are created on demand (lobby:teamCode below), never here — this
  // broadcast only carries the current one so joiners and re-renders stay in
  // sync, and releases it when the party dissolves (solo / emptied out).
  // Leader transfers rehome the group under a new lobby id: the code resets
  // to unrevealed there while the old mapping dies to the liveness check in
  // lobby:joinByCode.
  let teamCode: string | null = null;
  if (mode !== "solo" && memberIds.length > 0) teamCode = await getTeamCode(lobbyId);
  else await releaseTeamCode(lobbyId);
  const members = users.map((u) => ({
    id: u.id,
    uid: u.uid,
    name: displayName(u),
    avatarUrl: u.avatarUrl,
    // A party says who leads it; a personal lobby has an owner by definition.
    isLeader: isPartyLobby(lobbyId) ? u.id === leaderId : lobbyId === `L${u.uid}`,
    // Which character model to draw on this player's pedestal. Resolved here
    // (not on the client) so a retired or never-chosen id can never reach the
    // scene as a broken model URL.
    character: resolveCharacter(u.equippedCharacter),
    // What they're holding, or null for empty-handed. Resolved here too, so a
    // retired weapon leaves an empty hand rather than a broken model URL.
    weapon: resolveWeapon(u.equippedWeapon),
  }));
  // Download progress only for people still in the party (a member who left
  // may have a stale row until the pick changes).
  const loading: Record<string, number> = {};
  for (const m of members) if (loadingAll[m.uid] !== undefined) loading[m.uid] = loadingAll[m.uid];
  // Who in this party may not play what is picked, and why. Asked only when a
  // game IS picked, and answered for the whole party in one command — the
  // alternative is a round trip per member on every broadcast.
  const barred =
    game && memberIds.length > 0
      ? await bannedAmong(game, memberIds)
      : new Map<string, string>();

  io.to(`room:${lobbyId}`).emit("lobby:members", {
    lobbyId,
    mode,
    members,
    teamCode,
    game: memberIds.length > 0 ? game : null,
    loading,
    // Who has said they want to play what is picked. Only members who are
    // still here count: a ready-up from somebody who has since left would
    // otherwise let the leader start a game nobody present agreed to.
    ready: sayReady.filter((u) => members.some((m) => m.uid === u)),
    // Named, not merely counted: a party told "somebody here cannot play this"
    // spends the next minute working out who.
    barred: users
      .filter((u) => barred.has(u.id))
      .map((u) => ({ uid: u.uid, why: barred.get(u.id) ?? "cannot play this game" })),
  });
  // Write down what the party looks like, so the console can replay it later.
  // Never awaited, and it returns immediately when nothing has changed — which
  // is what most broadcasts are.
  if (partyEnabled()) {
    void noteLobbyState(lobbyId, mode, members, memberIds.length > 0 ? game : null)
      .then(() => syncLobbyRecording(lobbyId))
      .catch((e: unknown) => console.error("[party] log:", e));
  }
  // Membership just changed; if this party is queued, the pool must be told.
  await repriceSearch(lobbyId);
}

/** Is THIS PLAYER in a match right now?
 *
 *  Not "is their party in one". The two came apart the moment a match could be
 *  assembled from several parties: a group that finished early was held by
 *  strangers still playing, and its leader could not leave, could not change
 *  the mode, and could not even remove the teammate who was still in it —
 *  every one of those asked about the lobby. What each of them actually needs
 *  to know is whether the person DOING it is mid-match. */
const playerInMatch = async (userId: string): Promise<boolean> => (await getUserMatch(userId)) !== null;

/** A party that is playing a match takes no membership changes. */
async function inMatch(lobbyId: string): Promise<boolean> {
  return (await getLobbyMatch(lobbyId)) !== null;
}

/** Searching counts as busy for joins too — a party whose size changes mid-
 *  queue would be promised a seat count it no longer has. Members may still
 *  LEAVE (that is handled below by re-pricing or dropping the entry). */
async function isBusy(lobbyId: string): Promise<string | null> {
  if (await getLobbyMatch(lobbyId)) return "in a match";
  if (await getSearching(lobbyId)) return "searching for a match";
  return null;
}

/** The party's size changed while queued: keep its place in the pool but at
 *  the new size, or drop it entirely once nobody is left. */
async function repriceSearch(lobbyId: string): Promise<void> {
  const pool = await getSearching(lobbyId);
  if (!pool) return;
  const [gameId, sizeText] = pool.split(":");
  const size = Number(sizeText);
  const members = await getLobbyMembers(lobbyId);
  if (members.length === 0) await dequeue(gameId, size, lobbyId);
  else await updateSize(gameId, size, lobbyId, members.length);
}

/** Why `userId` may not move into `targetLobbyId` right now, or null if they
 *  may. Checked by every join path before moveToLobby. */
async function joinBlockedReason(userId: string, uid: string, targetLobbyId: string): Promise<string | null> {
  // THEIRS, as a party: walking into a group that is mid-match or queued would
  // put somebody in a match they were never dealt into.
  const target = await isBusy(targetLobbyId);
  if (target) return `That party is ${target} right now`;
  // MINE, as a person. A player whose own match is over is free to go
  // somewhere else, even while a teammate is still finishing theirs — being
  // held by somebody else's match is the thing that made a party a trap.
  if (await playerInMatch(userId)) return "Leave your match first";
  if (await getSearching((await getUserLobby(userId)) ?? `L${uid}`)) return "Cancel your search first";
  return null;
}

async function moveToLobby(io: Server, socket: AuthedSocket, lobbyId: string): Promise<boolean> {
  const { userId, uid } = socket.data.auth;
  // Walking out drops what you agreed to. Ready-up is consent to play ONE
  // game with ONE group of people; carrying it into the next party would let
  // a leader start something this player never saw.
  const leaving = await getUserLobby(userId);
  if (leaving) await setSayReady(leaving, uid, false);
  // Walking out of a party I LEAD hands it on rather than beheading it. The
  // party keeps its id, its recording, its voice room and everyone in it —
  // only the leader field changes.
  const from = await getUserLobby(userId);
  if (from && from !== lobbyId) await stepDownIfLeading(io, from, userId);
  const previous = await leaveLobby(userId);
  if (previous && previous !== lobbyId) {
    // Written BEFORE the broadcast that removes them from the member list, so
    // the line lands while the recording still knows who they were.
    if (isPartyLobby(previous)) {
      const why = socket.data.leaveReason ?? (socket.data.away ? "quiet" : "left");
      socket.data.leaveReason = undefined;
      void noteLobbyLeave(previous, uid, socket.data.auth.name, why).catch((e: unknown) =>
        console.error("[party] leave:", e)
      );
    }
    socket.leave(`room:${previous}`);
    await broadcastLobby(io, previous);
    await syncTeamChatSession(previous);
    // One player left behind is not a party — send them home so it ends
    // cleanly rather than leaving somebody in a group of one.
    await dissolveIfAlone(io, previous);
  }
  const ok = await joinLobby(userId, lobbyId);
  if (!ok) {
    // Lobby full — fall back to own lobby, on your own again → solo.
    const solo = `L${socket.data.auth.uid}`;
    await setLobbyMode(solo, "solo");
    await joinLobby(userId, solo);
    socket.join(`room:${solo}`);
    await broadcastLobby(io, solo);
    socket.emit("lobby:error", { error: "That party is full" });
    return false;
  }
  socket.join(`room:${lobbyId}`);
  await broadcastLobby(io, lobbyId);
  await syncTeamChatSession(lobbyId);
  return true;
}

/** The lobby somebody is about to walk into, as a PARTY.
 *
 *  A player's own lobby is `L<uid>` and is theirs alone; the moment a second
 *  person arrives it becomes a group, and a group gets a name of its own that
 *  it will keep whatever happens to its leadership. Already a party → nothing
 *  to do, which is every join after the first. */
async function asParty(io: Server, lobbyId: string): Promise<string> {
  if (isPartyLobby(lobbyId)) return lobbyId;
  const [ownerId] = await getLobbyMembers(lobbyId);
  if (!ownerId) return lobbyId;
  return promoteToParty(io, lobbyId, ownerId);
}

/** Somebody who leads a party is leaving it. Pass it on, in place.
 *
 *  This is the whole of what a leadership change costs now. It used to be a
 *  migration: the lobby was named after its leader, so handing the party on
 *  renamed it, and membership, join times, mode, team code, game pick, chat
 *  session, search binding and every socket room had to be dragged to the new
 *  name — while the party RECORDING could not follow at all, so one group
 *  became two in the console with the first stuck marked live.
 *
 *  Returns the new leader, or null if there was nobody to pass it to. */
async function stepDownIfLeading(io: Server, lobbyId: string, userId: string): Promise<string | null> {
  if (!isPartyLobby(lobbyId)) return null;
  if ((await getLobbyLeader(lobbyId)) !== userId) return null;
  const remaining = (await getLobbyMembers(lobbyId)).filter((id) => id !== userId);
  if (remaining.length === 0) return null;

  // The longest-present member, as when a leader presses Leave: seniority is
  // the one ordering everybody in the party can already see.
  const joinTimes = await getLobbyJoinTimes(lobbyId);
  const nextId = remaining.reduce(
    (best, id) => ((joinTimes.get(id) ?? Infinity) < (joinTimes.get(best) ?? Infinity) ? id : best),
    remaining[0]
  );
  const [next] = await getUsersByIds([nextId]);
  if (!next) return null;
  await setLobbyLeader(lobbyId, nextId);
  const [wasLeader] = await getUsersByIds([userId]);
  io.to(`room:${lobbyId}`).emit("lobby:leader", { uid: next.uid, name: displayName(next) });
  void noteLobbyLeader(lobbyId, {
    uid: next.uid,
    name: displayName(next),
    fromUid: wasLeader?.uid ?? null,
    fromName: wasLeader ? displayName(wasLeader) : null,
    why: "left",
  }).catch((e: unknown) => console.error("[party] leader:", e));
  return nextId;
}

/** One player left in a party is not a party.
 *
 *  Send them home to their own lobby so the party ends cleanly — the record
 *  closes, the voice room is released, the id is finished with — rather than
 *  leaving somebody standing in a group of one wondering where everybody
 *  went. Called after every departure. */
async function dissolveIfAlone(io: Server, lobbyId: string): Promise<void> {
  if (!isPartyLobby(lobbyId)) return;
  const members = await getLobbyMembers(lobbyId);
  if (members.length !== 1) return;
  const [lastId] = members;
  const [last] = await getUsersByIds([lastId]);
  if (!last) return;
  const home = `L${last.uid}`;
  await leaveLobby(lastId);
  await setLobbyMode(home, "solo");
  await joinLobby(lastId, home);
  const socketId = await getSocketId(lastId);
  const theirSocket = socketId ? io.sockets.sockets.get(socketId) : null;
  theirSocket?.leave(`room:${lobbyId}`);
  theirSocket?.join(`room:${home}`);
  await clearLobbyLeader(lobbyId);
  await broadcastLobby(io, lobbyId);
  await syncTeamChatSession(lobbyId);
  await broadcastLobby(io, home);
  await syncTeamChatSession(home);
}

/** The first person joins somebody's personal lobby: it becomes a party, with
 *  a name of its own that it keeps for the rest of its life.
 *
 *  The one migration left, and the cheapest possible one — exactly one member
 *  to move, no party recording open yet (that needs two people), no voice room
 *  yet, nothing in a queue. Everything after this point stays put. */
async function promoteToParty(io: Server, ownerLobby: string, ownerId: string): Promise<string> {
  const partyId = newPartyId();
  const joinTimes = await getLobbyJoinTimes(ownerLobby);
  const [owner] = await getUsersByIds([ownerId]);
  await migrateLobbyMembers(ownerLobby, partyId, [ownerId], joinTimes);
  await moveTeamSession(ownerLobby, partyId);
  await moveLobbyGameState(ownerLobby, partyId);
  await moveTeamCode(ownerLobby, partyId);
  await setLobbyLeader(partyId, ownerId);
  const socketId = await getSocketId(ownerId);
  const ownerSocket = socketId ? io.sockets.sockets.get(socketId) : null;
  ownerSocket?.leave(`room:${ownerLobby}`);
  ownerSocket?.join(`room:${partyId}`);
  // On the record, by id. A party outlives its founder's leadership and every
  // one of its members, so "who started this group" is otherwise unanswerable
  // — and the id is the handle everything else about it hangs off.
  logEvent({
    type: "lobby.party",
    userId: ownerId,
    uid: owner?.uid,
    lobbyId: partyId,
    data: { party: partyId, by: owner?.uid ?? null },
  });
  console.log(`[lobby] ${owner?.uid ?? ownerId} started party ${partyId}`);
  return partyId;
}

/** How long a page may go quiet before its player stops counting as online,
 *  and is taken out of whatever group they were holding up. The page beats
 *  every four seconds, so this is two missed beats. */
const AWAY_AFTER_MS = 10_000;

/** Everything that has to happen on a clock rather than on an event.
 *
 *  ONE interval for the whole process, walking sockets already in memory. A
 *  timer per connection would be a thousand timers at a thousand players; this
 *  is one, and it does no I/O for anybody whose state has not changed. */
function startPresenceSweep(io: Server): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      const now = Date.now();
      try {
        for (const raw of io.sockets.sockets.values()) {
          const socket = raw as AuthedSocket;
          const auth = socket.data?.auth;
          if (!auth) continue;

          // ---- the connection is alive, whatever the page is doing ----
          //
          // Kept by the server, not by the client. The socket registry is what
          // invites, kicks and match joins are delivered through, and a player
          // who has pocketed their phone must still be reachable by all three.
          if (now - (socket.data.socketTouchedAt ?? 0) > 30_000) {
            socket.data.socketTouchedAt = now;
            await touchSocket(auth.userId);
          }

          // ---- a page that has never said a word ----
          //
          // An older build, still cached on somebody's device, does not know
          // to send a heartbeat. Holding it to a rule it cannot follow would
          // strike every one of those players off the friends list the moment
          // this ships. They keep the old meaning — connected is online —
          // until their next reload brings them a page that can speak up.
          if (socket.data.lastBeatAt === undefined) {
            if (now - (socket.data.hereTouchedAt ?? 0) > (HERE_TTL * 1000) / 2) {
              socket.data.hereTouchedAt = now;
              await touchHere(auth.userId);
            }
            continue;
          }

          // ---- players who stopped looking ----
          if (socket.data.away) continue;
          if (now - socket.data.lastBeatAt <= AWAY_AFTER_MS) continue;
          socket.data.away = true;
          socket.data.awayAt = now;
          logEvent({
            type: "session.away",
            userId: auth.userId,
            uid: auth.uid,
            ip: socket.data.origin?.ip,
            deviceHash: socket.data.deviceHash,
          });
          await setAway(auth.userId);
          const friendIds = await getFriendIds(auth.userId);
          for (const fid of friendIds) io.to(`user:${fid}`).emit("friend:offline", { uid: auth.uid });

          // …and out of the party. A group is people waiting on each other,
          // and somebody who is not there holds up everyone who is: nobody can
          // start while a ready-up is missing, and nobody can tell whether
          // they are coming back. So they go home, exactly as if they had
          // pressed Leave — the leader included, whose party carries on under
          // the next member without changing anything about itself.
          //
          // NOT during a match. Their seat is held for them there by the
          // match's own grace period, and pulling them out of the lobby
          // underneath a running match would land them, at the end of it, in a
          // party they are no longer part of.
          await dropAwayPlayerFromParty(io, socket).catch((err) =>
            console.error(`[lobby] could not drop ${auth.uid} from their party:`, err)
          );
        }
      } catch (err) {
        console.error("presence sweep error:", err);
      }
    })();
  }, 3000);
}

/** Somebody stopped answering. If they were in a group, they are not any more. */
async function dropAwayPlayerFromParty(io: Server, socket: AuthedSocket): Promise<void> {
  const { userId, uid } = socket.data.auth;
  const lobbyId = (await getUserLobby(userId)) ?? `L${uid}`;
  if (!isPartyLobby(lobbyId)) return;
  if ((await getLobbyMembers(lobbyId)).length < 2) return;
  if (await getLobbyMatch(lobbyId)) return;
  await setSayReady(lobbyId, uid, false);
  await leaveParty(io, socket);
  console.log(`[lobby] ${uid} went quiet — out of ${lobbyId}`);
}

/** Out of the party, whether they pressed the button or stopped answering.
 *
 *  One path for both so the two can never drift. */
async function leaveParty(io: Server, socket: AuthedSocket): Promise<void> {
  const home = `L${socket.data.auth.uid}`;
  await setLobbyMode(home, "solo");
  await moveToLobby(io, socket, home);
}

export function registerSockets(io: Server) {
  startPresenceSweep(io);
  // Handshake auth: the frontend passes its JWT in socket.io auth. The JWT's
  // name can be stale (signed before the username claim, or on an old
  // device), so the live row is loaded once per CONNECTION — one PK lookup,
  // nothing per event — and every handler/emit closes over the fresh
  // username. No username yet → no lobby: the client bounces to the claim
  // screen on this error.
  io.use((socket, next) => {
    void (async () => {
      try {
        const token = socket.handshake.auth?.token as string | undefined;
        const payload = token ? verifyToken(token) : null;
        if (!payload) return next(new Error("Unauthorized"));
        const user = await getUserById(payload.userId);
        if (!user) return next(new Error("Unauthorized"));
        if (!user.username) return next(new Error("USERNAME_REQUIRED"));
        const origin = socketOrigin(socket);
        const deviceHash = deviceHashFrom(socket.handshake.auth?.deviceHash);
        // One Redis GET against a key that exists only for sanctioned players,
        // and one field read for maintenance. A ban has to be felt at the door,
        // not discovered three screens in.
        const [sanctions, maintenance] = await Promise.all([
          getSanctions(payload.userId),
          inMaintenance(),
        ]);
        if (maintenance) {
          // Deliberately checked BEFORE the ban: during maintenance nobody is
          // getting in, and telling a banned player they are banned is not the
          // message that matters at that moment.
          return next(new Error("MAINTENANCE"));
        }
        if (sanctions.ban) {
          // The device matters MOST on a refused connection: a banned player
          // knocking again from the same machine is what ban evasion looks
          // like, and it is the one row that proves it.
          logEvent({
            type: "session.rejected",
            userId: payload.userId,
            uid: payload.uid,
            ip: origin.ip,
            ipCountry: origin.country,
            ua: origin.ua,
            deviceHash,
            data: { reason: "banned", detail: sanctions.ban.reason },
          });
          return next(new Error(`BANNED:${sanctions.ban.reason}`));
        }
        const s = socket as AuthedSocket;
        s.data.auth = { ...payload, name: user.username };
        s.data.origin = origin;
        s.data.deviceHash = deviceHash;
        s.data.connectedAt = Date.now();
        next();
      } catch (err) {
        console.error("Socket auth error:", err);
        next(new Error("Unauthorized"));
      }
    })();
  });

  io.on("connection", async (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    const { userId, uid, name } = socket.data.auth;
    const soloLobby = `L${uid}`;
    /** When this connection may emote again — see EMOTE_COOLDOWN_MS. */
    let emoteReadyAt = 0;

    // Register ALL event handlers before any awaited setup below — events a
    // fast client emits right after connecting would otherwise be dropped.
    registerChatHandlers(io, socket);
    registerPlatformHandlers(io, socket, { broadcastLobby });

    // Invite a friend to my CURRENT lobby.
    socket.on("lobby:invite", async (payload: { friendUid?: string } | null, ack?: (r: object) => void) => {
      try {
        const { friendUid } = payload ?? {};
        const target = await getUserByUid(String(friendUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        const targetName = displayName(target);
        if (!(await areFriends(userId, target.id))) return ack?.({ error: "You can only invite friends" });

        const targetSocketId = await getSocketId(target.id);
        if (!targetSocketId) return ack?.({ error: `${targetName} is offline` });

        const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
        if ((await getUserLobby(target.id)) === lobbyId) {
          return ack?.({ error: `${targetName} is already in your group` });
        }
        if (await isDnd(target.id)) {
          return ack?.({ error: `${targetName} has Do Not Disturb on` });
        }
        const [members, mode] = await Promise.all([getLobbyMembers(lobbyId), getLobbyMode(lobbyId)]);
        // Inviting from solo opens a party right away (Free Fire style): the
        // group exists as soon as the invite goes out, accepted or not.
        const effectiveMode = mode === "solo" ? "squad" : mode;
        if (members.length >= lobbyCapacity(effectiveMode)) {
          return ack?.({ error: effectiveMode === "duo" ? "Duo is full — switch to Squad for more players" : "Your squad is full" });
        }
        // Last check, so a failed invite never burns the cooldown window.
        const wait = await armSendCooldown("invite", userId, target.id);
        if (wait > 0) {
          return ack?.({ error: `Wait ${wait}s before inviting ${targetName} again`, wait });
        }
        if (mode === "solo") {
          await setLobbyMode(lobbyId, "squad");
          await broadcastLobby(io, lobbyId);
        }

        io.to(`user:${target.id}`).emit("lobby:invite", { from: { uid, name }, lobbyId });
        // Remembered briefly, so that when they accept — which may be minutes
        // later — the party's record can say who brought them in.
        void noteInvite(target.id, lobbyId, { uid, name }).catch((e: unknown) => console.error("[party] invite:", e));
        // Buffered in memory and flushed in batches — this costs the player
        // nothing, because the request they just made was going to happen
        // anyway. See services/eventLog.ts.
        logEvent({ ...trace(socket), type: "lobby.invite", userId, uid, lobbyId, data: { to: target.uid } });
        // wait tells the UI how long to hold this friend's button disabled.
        ack?.({ ok: true, wait: SEND_COOLDOWN_SECONDS });
      } catch (err) {
        console.error("lobby:invite error:", err);
        ack?.({ error: "Invite failed" });
      }
    });

    // Accept an invite (or otherwise switch lobby).
    socket.on("lobby:join", async (payload: { lobbyId?: string } | null, ack?: (r: object) => void) => {
      try {
        const { lobbyId } = payload ?? {};
        // `L…` is somebody's own lobby, `P…` is a party. Both are places a
        // player can be invited into; anything else is not an id we minted.
        if (typeof lobbyId !== "string" || !/^[LP][A-Za-z0-9-]{1,40}$/.test(lobbyId)) {
          return ack?.({ error: "Bad lobby id" });
        }
        const members = await getLobbyMembers(lobbyId);
        if (lobbyId !== soloLobby && members.length === 0) return ack?.({ error: "That lobby no longer exists" });
        const blocked = await joinBlockedReason(userId, uid, lobbyId);
        if (blocked) return ack?.({ error: blocked });
        const target = await asParty(io, lobbyId);
        const ok = await moveToLobby(io, socket, target);
        if (ok) {
          // Accepting an invite and walking into a friend's party are the same
          // socket call; the pending invite is what tells them apart.
          //
          // The invite is looked up under the id it was ADDRESSED to — which
          // may be the inviter's own lobby, from before there was a party —
          // while the arrival is recorded against the party they actually
          // walked into. Writing it to the old id instead is how the arrival
          // that CREATES a group went missing: that lobby has no recording,
          // because the recording belongs to the group it just became.
          const by = await takeInvite(userId, lobbyId).catch(() => null);
          void noteLobbyJoin(target, uid, name, by ? "invite" : "friend", by).catch((e: unknown) =>
            console.error("[party] join:", e)
          );
          logEvent({
            ...trace(socket),
            type: "lobby.join",
            userId,
            uid,
            lobbyId: target,
            data: { via: by ? "invite" : "friend", by: by?.uid ?? null },
          });
        }
        ack?.(ok ? { ok: true, lobbyId } : { error: "Lobby is full" });
      } catch (err) {
        console.error("lobby:join error:", err);
        ack?.({ error: "Join failed" });
      }
    });

    // Reveal the party's team code (creating it on the first ask), or with
    // reset=true mint a replacement — leader only, since a reset invalidates
    // whatever the group already shared. The room event keeps every member's
    // open TEAM CODE card in sync, clicker included.
    socket.on("lobby:teamCode", async (payload: { reset?: boolean } | null, ack?: (r: object) => void) => {
      try {
        const { reset } = payload ?? {};
        const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
        const mode = await getLobbyMode(lobbyId);
        if (mode === "solo") return ack?.({ error: "Open a Duo or Squad party first" });
        if (reset) {
          if (!(await isLobbyLeader(lobbyId, userId, uid))) {
            return ack?.({ error: "Only the party leader can reset the team code" });
          }
          await releaseTeamCode(lobbyId);
        }
        const teamCode = await getOrCreateTeamCode(lobbyId);
        io.to(`room:${lobbyId}`).emit("lobby:teamCode", { teamCode });
        ack?.({ ok: true, teamCode });
      } catch (err) {
        console.error("lobby:teamCode error:", err);
        ack?.({ error: "Team code failed" });
      }
    });

    // Join a party by its 6-digit team code — no friendship and no approval
    // round on purpose: knowing the code IS the permission (Free Fire style).
    socket.on("lobby:joinByCode", async (payload: { code?: string } | null, ack?: (r: object) => void) => {
      try {
        const { code } = payload ?? {};
        const cleaned = String(code ?? "").trim();
        if (!/^\d{6}$/.test(cleaned)) return ack?.({ error: "Invalid team code" });
        if (!(await throttleCodeJoin(userId))) return ack?.({ error: "Hold on — try again in a moment" });
        const lobbyId = await getTeamCodeLobby(cleaned);
        if (!lobbyId) return ack?.({ error: "Invalid team code" });
        if ((await getUserLobby(userId)) === lobbyId) return ack?.({ error: "You're already in this group" });
        const [members, mode] = await Promise.all([getLobbyMembers(lobbyId), getLobbyMode(lobbyId)]);
        // A code can outlive its party (last member gone, mode back to solo
        // while nobody was in the room to broadcast) — stale means invalid.
        if (members.length === 0 || mode === "solo") {
          await releaseTeamCode(lobbyId);
          return ack?.({ error: "Invalid team code" });
        }
        if (members.length >= lobbyCapacity(mode)) return ack?.({ error: "That group is full" });
        const blocked = await joinBlockedReason(userId, uid, lobbyId);
        if (blocked) return ack?.({ error: blocked });
        // A code shared while still alone points at a personal lobby; walking
        // in with it is what turns that into a party.
        const target = await asParty(io, lobbyId);
        const joined = await moveToLobby(io, socket, target);
        if (!joined) return ack?.({ error: "That group is full" });
        void noteLobbyJoin(target, uid, name, "code", null).catch((e: unknown) =>
          console.error("[party] join:", e)
        );
        logEvent({ ...trace(socket), type: "lobby.join", userId, uid, lobbyId: target, data: { via: "code" } });
        ack?.({ ok: true, lobbyId: target });
      } catch (err) {
        console.error("lobby:joinByCode error:", err);
        ack?.({ error: "Join failed" });
      }
    });

    // Ask a friend to let me into their group. The friend approves/declines;
    // approval moves ME into THEIR current lobby.
    socket.on("lobby:joinRequest", async (payload: { friendUid?: string } | null, ack?: (r: object) => void) => {
      try {
        const { friendUid } = payload ?? {};
        const target = await getUserByUid(String(friendUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        const targetName = displayName(target);
        if (!(await areFriends(userId, target.id))) return ack?.({ error: "You can only join a friend's group" });
        const targetSocketId = await getSocketId(target.id);
        if (!targetSocketId) return ack?.({ error: `${targetName} is offline` });
        if (await isDnd(target.id)) return ack?.({ error: `${targetName} has Do Not Disturb on` });

        const targetLobby = (await getUserLobby(target.id)) ?? `L${target.uid}`;
        const myLobby = (await getUserLobby(userId)) ?? soloLobby;
        if (targetLobby === myLobby) return ack?.({ error: "You're already in this group" });
        // A solo player can always take one joiner — approving forms a squad.
        const [members, mode] = await Promise.all([getLobbyMembers(targetLobby), getLobbyMode(targetLobby)]);
        if (members.length >= lobbyCapacity(mode === "solo" ? "squad" : mode)) {
          return ack?.({ error: "That group is full" });
        }

        // Last check, so a failed request never burns the cooldown window.
        const wait = await armSendCooldown("joinreq", userId, target.id);
        if (wait > 0) {
          return ack?.({ error: `Wait ${wait}s before asking ${targetName} again`, wait });
        }
        await createJoinRequest(userId, target.id);
        io.to(`user:${target.id}`).emit("lobby:joinRequest", { from: { uid, name } });
        ack?.({ ok: true, wait: SEND_COOLDOWN_SECONDS });
      } catch (err) {
        console.error("lobby:joinRequest error:", err);
        ack?.({ error: "Request failed" });
      }
    });

    socket.on(
      "lobby:joinRespond",
      async (payload: { requesterUid?: string; accept?: boolean } | null, ack?: (r: object) => void) => {
        try {
          const { requesterUid, accept } = payload ?? {};
          const requester = await getUserByUid(String(requesterUid || ""));
          if (!requester) return ack?.({ error: "Player not found" });
          // Consent marker: only a real, recent request can be approved.
          if (!(await consumeJoinRequest(requester.id, userId))) {
            return ack?.({ error: "That request has expired" });
          }
          if (!accept) {
            io.to(`user:${requester.id}`).emit("lobby:joinDeclined", { name });
            return ack?.({ ok: true });
          }
          const requesterSocketId = await getSocketId(requester.id);
          const requesterSocket = requesterSocketId ? io.sockets.sockets.get(requesterSocketId) : null;
          if (!requesterSocket) return ack?.({ error: `${displayName(requester)} went offline` });

          const myLobby = (await getUserLobby(userId)) ?? soloLobby;
          if ((await getUserLobby(requester.id)) === myLobby) return ack?.({ ok: true });
          const blocked = await joinBlockedReason(requester.id, requester.uid, myLobby);
          if (blocked) return ack?.({ error: blocked === "Leave your match first" ? `${displayName(requester)} is in a match` : "Finish the match first" });
          // Approving while solo forms the group — which means this lobby stops
          // being one person's own and becomes a party with a name of its own,
          // exactly as an invite or a team code would.
          if ((await getLobbyMode(myLobby)) === "solo") await setLobbyMode(myLobby, "squad");
          const party = await asParty(io, myLobby);
          const joined = await moveToLobby(io, requesterSocket as AuthedSocket, party);
          if (!joined) return ack?.({ error: "Your group is full" });
          // Asked to come in, and was let in. A third way to arrive, and it
          // reads differently from the other two: this one they initiated.
          void noteLobbyJoin(party, requester.uid, displayName(requester), "request", { uid, name }).catch(
            (e: unknown) => console.error("[party] join:", e)
          );
          logEvent({
            ...trace(socket),
            type: "lobby.join",
            userId: requester.id,
            uid: requester.uid,
            lobbyId: party,
            data: { via: "request", by: uid },
          });
          io.to(`user:${requester.id}`).emit("lobby:joinApproved", { name });
          ack?.({ ok: true });
        } catch (err) {
          console.error("lobby:joinRespond error:", err);
          ack?.({ error: "Respond failed" });
        }
      }
    );

    // Do Not Disturb: block invites + join requests, never messages.
    socket.on("user:dnd", async (payload: { on?: boolean } | null, ack?: (r: object) => void) => {
      try {
        const { on } = payload ?? {};
        await setDnd(userId, !!on);
        ack?.({ ok: true, on: !!on });
      } catch (err) {
        console.error("user:dnd error:", err);
        ack?.({ error: "Could not update Do Not Disturb" });
      }
    });

    // Perform an emote on my own character, for the whole squad to see.
    //
    // The performer does NOT wait for this: they play the clip the moment they
    // tap it and this call only tells everyone else, so the one player whose
    // latency they can feel never pays a round trip for their own emote.
    socket.on("lobby:emote", async (payload: { emoteId?: string } | null, ack?: (r: object) => void) => {
      try {
        const { emoteId } = payload ?? {};
        const id = String(emoteId || "");
        // The client's sheet is a menu, not a guarantee — a modified client
        // can ask for "fall", or for an emote it hasn't bought.
        if (!canPerform(id)) return ack?.({ error: "You can't perform that" });
        // Held per connection, in memory: emote spam costs every squadmate a
        // clip download and a re-pose, so the SERVER owns the floor on it
        // rather than trusting the sheet to stay closed.
        const now = Date.now();
        if (now < emoteReadyAt) return ack?.({ error: "Slow down" });
        emoteReadyAt = now + EMOTE_COOLDOWN_MS;
        const lobbyId = await getUserLobby(userId);
        // Alone is not an error: the emote still played on their own screen,
        // there is simply nobody to forward it to.
        if (lobbyId) {
          socket.to(`room:${lobbyId}`).emit("lobby:emote", { uid, emoteId: id });
          void noteLobbyEmote(lobbyId, uid, name, id).catch((e: unknown) => console.error("[party] emote:", e));
        }
        ack?.({ ok: true });
      } catch (err) {
        console.error("lobby:emote error:", err);
        ack?.({ error: "Emote failed" });
      }
    });

    // Change my party mode (Free Fire style Solo/Duo/Squad). Leader only, and
    // you can't shrink below the number of players already in the party.
    socket.on("lobby:mode", async (payload: { mode?: string } | null, ack?: (r: object) => void) => {
      try {
        const { mode } = payload ?? {};
        if (mode !== "solo" && mode !== "duo" && mode !== "squad") return ack?.({ error: "Unknown mode" });
        const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
        if (!(await isLobbyLeader(lobbyId, userId, uid))) {
          return ack?.({ error: "Only the party leader can change the mode" });
        }
        if (await playerInMatch(userId)) return ack?.({ error: "Finish the match first" });
        const members = await getLobbyMembers(lobbyId);
        if (members.length > lobbyCapacity(mode)) {
          return ack?.({
            error:
              mode === "solo"
                ? "Solo means playing alone — your party still has teammates"
                : `Duo supports 2 players — your party has ${members.length}`,
          });
        }
        await setLobbyMode(lobbyId, mode);
        logEvent({ ...trace(socket), type: "lobby.mode", userId, uid, lobbyId, data: { mode } });
        await broadcastLobby(io, lobbyId);
        // Picking SOLO dissolves the group like leaving does — drop its chat.
        await syncTeamChatSession(lobbyId);
        ack?.({ ok: true, mode });
      } catch (err) {
        console.error("lobby:mode error:", err);
        ack?.({ error: "Could not change mode" });
      }
    });

    // Hand the crown to a teammate (leader only). Nobody moves and nothing is
    // renamed — the party is not called after whoever runs it any more.
    socket.on("lobby:transferLead", async (payload: { targetUid?: string } | null, ack?: (r: object) => void) => {
      try {
        const { targetUid } = payload ?? {};
        const target = await getUserByUid(String(targetUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (target.id === userId) return ack?.({ error: "You're already the leader" });
        const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
        if (!(await isLobbyLeader(lobbyId, userId, uid))) {
          return ack?.({ error: "Only the group leader can transfer leadership" });
        }
        if (await playerInMatch(userId)) return ack?.({ error: "Finish the match first" });
        const members = await getLobbyMembers(lobbyId);
        if (!members.includes(target.id)) return ack?.({ error: "That player isn't in your group" });

        // The whole of a leadership change: one field. The party keeps its id,
        // its members, its recording, its voice room and its place in any
        // queue — nothing about it moves except who runs it.
        await setLobbyLeader(lobbyId, target.id);
        io.to(`room:${lobbyId}`).emit("lobby:leader", { uid: target.uid, name: displayName(target) });
        await broadcastLobby(io, lobbyId);
        void noteLobbyLeader(lobbyId, {
          uid: target.uid,
          name: displayName(target),
          fromUid: uid,
          fromName: name,
          why: "handed",
        }).catch((e: unknown) => console.error("[party] leader:", e));
        logEvent({ ...trace(socket), type: "lobby.leader", userId, uid, lobbyId, data: { to: target.uid } });
        ack?.({ ok: true });
      } catch (err) {
        console.error("lobby:transferLead error:", err);
        ack?.({ error: "Transfer failed" });
      }
    });

    // Kick a member out of my group (leader only). They land back in their
    // own lobby in solo mode; the group lives on for everyone else.
    socket.on("lobby:kick", async (payload: { targetUid?: string } | null, ack?: (r: object) => void) => {
      try {
        const { targetUid } = payload ?? {};
        const target = await getUserByUid(String(targetUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (target.id === userId) return ack?.({ error: "You can't kick yourself — use Leave" });
        const myLobby = (await getUserLobby(userId)) ?? soloLobby;
        if (!(await isLobbyLeader(myLobby, userId, uid))) {
          return ack?.({ error: "Only the group leader can kick players" });
        }
        // The LEADER's own state, not the party's. Removing somebody who is
        // still playing is allowed and is the point: they finish their match
        // and land in their own lobby, while the party gets on with its day.
        if (await playerInMatch(userId)) return ack?.({ error: "Finish the match first" });
        if ((await getUserLobby(target.id)) !== myLobby) {
          return ack?.({ error: "That player isn't in your group" });
        }

        await setLobbyMode(`L${target.uid}`, "solo");
        const targetSocketId = await getSocketId(target.id);
        const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
        if (targetSocket) {
          // Said BEFORE the move, so the one line the move writes is the true
          // one. Writing a second line afterwards left the false one standing.
          (targetSocket as AuthedSocket).data.leaveReason = "kicked";
          await moveToLobby(io, targetSocket as AuthedSocket, `L${target.uid}`);
        } else {
          // They dropped offline mid-kick — just detach their membership, and
          // say so here since no move will.
          void noteLobbyLeave(myLobby, target.uid, displayName(target), "kicked").catch((e: unknown) =>
            console.error("[party] leave:", e)
          );
          await leaveLobby(target.id);
          await broadcastLobby(io, myLobby);
          await syncTeamChatSession(myLobby);
        }
        await dissolveIfAlone(io, myLobby);
        io.to(`user:${target.id}`).emit("lobby:kicked", { by: name });
        logEvent({ ...trace(socket), type: "lobby.kick", userId, uid, lobbyId: myLobby, data: { target: target.uid } });
        ack?.({ ok: true });
      } catch (err) {
        console.error("lobby:kick error:", err);
        ack?.({ error: "Kick failed" });
      }
    });

    // Leave the group. Members go back to their own lobby in solo mode; a
    // LEADER leaving hands the group to the longest-present member instead.
    // Works even when alone in a duo/squad party — it drops you back to solo.
    socket.on("lobby:leave", async (ack?: (r: object) => void) => {
      try {
        const from = (await getUserLobby(userId)) ?? soloLobby;
        if (await playerInMatch(userId)) return ack?.({ error: "Leave the match first" });
        // Walking out is a deliberate act and was the one departure with no
        // line of its own: the party's own recording had it, the platform's
        // did not, so "when did this account leave that group" could only be
        // answered by opening the party.
        if (isPartyLobby(from)) {
          logEvent({ ...trace(socket), type: "lobby.leave", userId, uid, lobbyId: from });
        }
        await leaveParty(io, socket);
        ack?.({ ok: true, lobbyId: soloLobby });
      } catch (err) {
        console.error("lobby:leave error:", err);
        ack?.({ error: "Leave failed" });
      }
    });

    /** Everything that has to happen when this connection goes away.
     *
     *  Pulled out of the handler because it has TWO callers. The obvious one is
     *  the disconnect event. The other is the end of the connect setup below:
     *  that setup is asynchronous, and a socket that drops while it is still
     *  running fires its disconnect BEFORE presence was ever written — so the
     *  ownership guard here sends it home having cleaned nothing, and the
     *  player is left marked online for ever. Rare with a good connection,
     *  routine on a phone in a lift, and it quietly inflates every "players
     *  online" number the platform reports. */
    async function endSession(): Promise<void> {
      try {
        // Another socket may have replaced us already — only clean up if we still own presence.
        const current = await getSocketId(userId);
        if (current !== socket.id) return;

        // Mid-match: keep their seat for the grace period (platform/match.ts).
        platformOnDisconnect(io, socket);
        logEvent({
          type: "session.end",
          userId,
          uid,
          ip: socket.data.origin?.ip,
          deviceHash: socket.data.deviceHash,
          data: { seconds: Math.round((Date.now() - (socket.data.connectedAt ?? Date.now())) / 1000) },
        });
        await setOffline(userId);
        // A leader dropping hands the party on before they go, so the group
        // is never left standing under somebody who is not there. It costs one
        // Redis write and the party does not notice: same id, same recording,
        // same voice room.
        const wasIn = await getUserLobby(userId);
        if (wasIn && isPartyLobby(wasIn)) {
          void noteLobbyLeave(wasIn, uid, name, "dropped").catch((e: unknown) =>
            console.error("[party] leave:", e)
          );
        }
        if (wasIn) await stepDownIfLeading(io, wasIn, userId);
        const lobbyId = await leaveLobby(userId);
        if (lobbyId) {
          await broadcastLobby(io, lobbyId);
          await syncTeamChatSession(lobbyId);
          await dissolveIfAlone(io, lobbyId);
        }

        const friendIds = await getFriendIds(userId);
        for (const fid of friendIds) {
          io.to(`user:${fid}`).emit("friend:offline", { uid, name });
        }
      } catch (err) {
        console.error("Socket disconnect cleanup error:", err);
      }
    }

    // NOTHING GETS THROUGH while the platform is shut.
    //
    // Sockets are disconnected when a window opens, but "disconnect everyone"
    // and "refuse everything" are not the same guarantee: a connection can
    // arrive in the gap, survive a race, or be re-established against an
    // instance that has not caught up. This is a middleware on the socket
    // itself, so it covers every event — including ones added later, which is
    // the failure mode of a check that has to be remembered per handler.
    socket.use(([event], next) => {
      if (!gateShut() || event === "presence:beat") return next();
      next(new Error("MAINTENANCE"));
    });

    // ---- "I am still here" --------------------------------------------
    //
    // Sent by the page every few seconds, and ONLY while it is visible. A tab
    // in the background, a phone in a pocket or a game minimised behind
    // something else stops sending, and this player drops out of the friends
    // list within about ten seconds — which is the point: an "online" that
    // only means "a socket is open" tells a friend nothing about whether
    // anybody will answer them.
    //
    // Cheap on purpose. No payload, no acknowledgement, one pipelined Redis
    // round trip, and the friends of somebody whose state has not changed are
    // told nothing at all.
    socket.on("presence:beat", () => {
      void (async () => {
        try {
          socket.data.lastBeatAt = Date.now();
          if (socket.data.away) {
            socket.data.away = false;
            await touchHere(userId);
            // Their friends are told; so is the record. A player coming back
            // from a minimised game is a presence change like any other, and
            // an activity log that shows the going-quiet but not the coming-
            // back reads as though they never returned.
            logEvent({
              ...trace(socket),
              type: "session.back",
              userId,
              uid,
              data: { awaySeconds: Math.round((Date.now() - (socket.data.awayAt ?? Date.now())) / 1000) },
            });
            const friendIds = await getFriendIds(userId);
            for (const fid of friendIds) io.to(`user:${fid}`).emit("friend:online", { uid, name });
          } else {
            await touchHere(userId);
          }
        } catch (err) {
          console.error("presence:beat error:", err);
        }
      })();
    });

    // A microphone opened or closed. Reported by the page rather than inferred
    // from the audio, because the two answer different questions: the audio
    // says what was HEARD, and this says what was possible. A player who opens
    // a mic and says nothing has still done something, and a player whose mic
    // was shut cannot be responsible for what came through.
    socket.on("voice:mic", (payload: { on?: unknown } | null) => {
      void (async () => {
        try {
          const on = (payload ?? {}).on === true;
          const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
          if (isPartyLobby(lobbyId)) {
            await noteLobbyMic(lobbyId, uid, name, on);
          }
          // Matches have no party log of their own, so this is where a mic in
          // a match is written down — stamped with the match, so it can be
          // read back beside that match's recording.
          logEvent({
            ...trace(socket),
            type: "voice.mic",
            userId,
            uid,
            lobbyId,
            matchKey: (await getUserMatch(userId)) ?? undefined,
            data: { on },
          });
        } catch (err) {
          console.error("voice:mic error:", err);
        }
      })();
    });

    socket.on("disconnect", () => void endSession());

    // ---- connection setup (runs after handlers are attached) ----
    try {
      // If this user is already connected elsewhere, drop the old socket.
      const oldSocketId = await getSocketId(userId);
      if (oldSocketId && oldSocketId !== socket.id) {
        io.sockets.sockets.get(oldSocketId)?.disconnect(true);
      }

      await setOnline(userId, socket.id);
      // NOT lastBeatAt: that stays undefined until the page actually sends
      // one, which is how a build too old to know about heartbeats is told
      // apart from a page that has gone quiet.
      socket.data.socketTouchedAt = Date.now();
      socket.data.away = false;
      socket.join(`user:${userId}`);
      logEvent({
        type: "session.start",
        userId,
        uid,
        ip: socket.data.origin.ip,
        ipCountry: socket.data.origin.country,
        ua: socket.data.origin.ua,
        deviceHash: socket.data.deviceHash,
      });
      // Fire-and-forget: one upsert per session, never awaited, so the
      // handshake does not wait on Postgres for a correlation hint.
      noteDevice(userId, socket.data.deviceHash, socket.data.origin.ua);

      // Everyone starts a session in their own lobby, in solo mode (like Free
      // Fire) — unless their squad is still alive and waiting for them.
      await ensureLobbyModeOnConnect(soloLobby);
      await moveToLobby(io, socket, soloLobby);
      // Back into a match that is still running for them (page reload, drop).
      platformOnConnect(socket);

      // WHAT THEY MISSED, and what is coming.
      //
      // A notice sent while somebody was offline is not much of a notice if
      // they never see it, so it waits for them — once, marked against their
      // account so a reconnect does not show it again. A scheduled maintenance
      // is pushed for the opposite reason: they need to know before they start
      // something they will not be allowed to finish.
      void (async () => {
        try {
          const flags = await getFlags();
          if (flags.maintenanceAt > 0 || flags.maintenance) {
            socket.emit("platform:maintenance", {
              active: flags.maintenance,
              at: flags.maintenanceAt,
              message: flags.maintenanceMessage,
            });
          }
          // Anything sent while they were away. Marked by TIME rather than by
          // a per-notice acknowledgement: one small key per player instead of
          // a row per player per notice, and the only thing it has to get
          // right is "not again".
          const since = await noticeSeen(userId);
          const mine = await noticesFor(uid, 5);
          const fresh = mine.filter((n) => new Date(n.sentAt).getTime() > since);
          for (const n of fresh.reverse()) {
            socket.emit("platform:notice", { message: n.body, level: "info", id: n.id });
          }
          if (mine.length > 0) await markNoticeSeen(userId, new Date(mine[0].sentAt).getTime());
        } catch (err) {
          console.error("connect notices:", err);
        }
      })();

      // Tell online friends I'm here.
      const friendIds = await getFriendIds(userId);
      for (const fid of friendIds) {
        io.to(`user:${fid}`).emit("friend:online", { uid, name });
      }

      // The socket may have gone while all of the above was running. Its own
      // disconnect handler already came and went with nothing to clean, so the
      // cleanup has to happen here instead — see endSession.
      if (socket.disconnected) await endSession();
    } catch (err) {
      console.error("Socket connect error:", err);
      socket.disconnect(true);
    }
  });
}
