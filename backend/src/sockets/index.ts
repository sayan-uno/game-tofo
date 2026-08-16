import type { Server, Socket } from "socket.io";
import { verifyToken, type AuthPayload } from "../middleware/auth.js";
import {
  setOnline,
  setOffline,
  getSocketId,
  getUserLobby,
  getLobbyMembers,
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
  throttleCodeJoin,
  createJoinRequest,
  consumeJoinRequest,
  getLobbyJoinTimes,
  migrateLobbyMembers,
  moveTeamSession,
} from "../redis.js";
import { areFriends, displayName, getFriendIds, getUserById, getUserByUid, getUsersByIds } from "../services/users.js";
import { registerChatHandlers, syncTeamChatSession } from "./chat.js";
import { canPerform, resolveCharacter, resolveWeapon } from "../services/catalog.js";
import { platformOnConnect, platformOnDisconnect, registerPlatformHandlers } from "../platform/sockets.js";
import {
  clearLobbyGameState,
  getLoading,
  getLobbyGame,
  getLobbyMatch,
  getSearching,
  moveLobbyGameState,
} from "../platform/store.js";
import { dequeue, updateSize } from "../platform/matchmaking.js";

interface AuthedSocket extends Socket {
  data: { auth: AuthPayload };
}

/** Floor between two emotes from one connection. Long enough to stop a held
 *  finger (or a script) making every squadmate re-pose on every frame, short
 *  enough that a player who genuinely wants to emote twice can. */
const EMOTE_COOLDOWN_MS = 1200;

/** Push the current member list (and party mode) of a lobby to everyone in it.
 *  Exported because equipping a character changes what squadmates see, so the
 *  collection route re-broadcasts through this same path. */
export async function broadcastLobby(io: Server, lobbyId: string) {
  const memberIds = await getLobbyMembers(lobbyId);
  const [users, mode, game, loadingAll] = await Promise.all([
    getUsersByIds(memberIds),
    getLobbyMode(lobbyId),
    getLobbyGame(lobbyId),
    getLoading(lobbyId),
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
    isLeader: lobbyId === `L${u.uid}`,
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
  io.to(`room:${lobbyId}`).emit("lobby:members", {
    lobbyId,
    mode,
    members,
    teamCode,
    game: memberIds.length > 0 ? game : null,
    loading,
  });
  // Membership just changed; if this party is queued, the pool must be told.
  await repriceSearch(lobbyId);
}

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
  const target = await isBusy(targetLobbyId);
  if (target) return `That party is ${target} right now`;
  const mine = await isBusy((await getUserLobby(userId)) ?? `L${uid}`);
  if (mine) return mine === "in a match" ? "Leave your match first" : "Cancel your search first";
  return null;
}

async function moveToLobby(io: Server, socket: AuthedSocket, lobbyId: string): Promise<boolean> {
  const { userId, uid } = socket.data.auth;
  // Moving into someone ELSE's lobby while leading a live group hands that
  // group off first (accepting an invite, joining by code, an approved join
  // request). Otherwise the members stay parked under this user's L<uid> —
  // and since a later leadership transfer rehomes its group under that same
  // id, they would silently merge into it, old team code included. Moving to
  // the OWN lobby must skip this: that's the reconnect path, where a leader
  // rejoins the squad that waited for them.
  if (lobbyId !== `L${uid}`) await handOffGroupIfLeading(io, socket);
  const previous = await leaveLobby(userId);
  if (previous && previous !== lobbyId) {
    socket.leave(`room:${previous}`);
    await broadcastLobby(io, previous);
    await syncTeamChatSession(previous);
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

/** Rehome a set of members under a new leader's lobby id: Redis membership
 *  (join times survive → seniority is kept), the party mode, the team chat
 *  session and everyone's socket rooms all move together. */
async function rehomeMembers(
  io: Server,
  oldLobbyId: string,
  newLobbyId: string,
  memberIds: string[],
  joinTimes: Map<string, number>
): Promise<void> {
  await migrateLobbyMembers(oldLobbyId, newLobbyId, memberIds, joinTimes);
  await moveTeamSession(oldLobbyId, newLobbyId);
  await moveLobbyGameState(oldLobbyId, newLobbyId);
  for (const memberId of memberIds) {
    const socketId = await getSocketId(memberId);
    const memberSocket = socketId ? io.sockets.sockets.get(socketId) : null;
    memberSocket?.leave(`room:${oldLobbyId}`);
    memberSocket?.join(`room:${newLobbyId}`);
  }
  await broadcastLobby(io, newLobbyId);
  await syncTeamChatSession(newLobbyId);
}

/** A leader's lobby id IS their identity (L<uid>), so a leader walking out —
 *  by leaving, or by moving into another group — means everyone ELSE moves
 *  out: remaining members are rehomed under the new leader's lobby id —
 *  chosen as the longest-present member — carrying the party mode and the
 *  team chat session with them. The departing leader's own membership is
 *  untouched; their lobby id drops back to solo so it's clean for whatever
 *  lands on it next (a fresh session, or a leadership transfer back). Returns
 *  false when the user isn't a leader with members left behind. */
async function handOffGroupIfLeading(io: Server, socket: AuthedSocket): Promise<boolean> {
  const { userId, uid } = socket.data.auth;
  const ownLobby = `L${uid}`;
  if ((await getUserLobby(userId)) !== ownLobby) return false;
  const members = await getLobbyMembers(ownLobby);
  const remaining = members.filter((id) => id !== userId);
  if (remaining.length === 0) return false;

  const joinTimes = await getLobbyJoinTimes(ownLobby);
  const newLeaderId = remaining.reduce(
    (best, id) => ((joinTimes.get(id) ?? Infinity) < (joinTimes.get(best) ?? Infinity) ? id : best),
    remaining[0]
  );
  const [newLeader] = await getUsersByIds([newLeaderId]);
  if (!newLeader) return false;

  await rehomeMembers(io, ownLobby, `L${newLeader.uid}`, remaining, joinTimes);
  await setLobbyMode(ownLobby, "solo");
  return true;
}

/** lobby:leave for a leader: hand the group off, then show the departing
 *  leader their now-solo lobby (they stay in it — no membership change) and
 *  drop its group-chat leftovers. moveToLobby covers those two steps itself
 *  through its normal leave/broadcast flow, so it calls the hand-off alone. */
async function migrateGroupOnLeaderLeave(io: Server, socket: AuthedSocket): Promise<boolean> {
  if (!(await handOffGroupIfLeading(io, socket))) return false;
  const ownLobby = `L${socket.data.auth.uid}`;
  await broadcastLobby(io, ownLobby);
  await syncTeamChatSession(ownLobby);
  return true;
}

export function registerSockets(io: Server) {
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
        (socket as AuthedSocket).data.auth = { ...payload, name: user.username };
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
        if (typeof lobbyId !== "string" || !lobbyId.startsWith("L")) return ack?.({ error: "Bad lobby id" });
        const members = await getLobbyMembers(lobbyId);
        if (lobbyId !== soloLobby && members.length === 0) return ack?.({ error: "That lobby no longer exists" });
        const blocked = await joinBlockedReason(userId, uid, lobbyId);
        if (blocked) return ack?.({ error: blocked });
        const ok = await moveToLobby(io, socket, lobbyId);
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
          if (lobbyId !== soloLobby) return ack?.({ error: "Only the party leader can reset the team code" });
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
        const joined = await moveToLobby(io, socket, lobbyId);
        if (!joined) return ack?.({ error: "That group is full" });
        ack?.({ ok: true, lobbyId });
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
          // Approving while solo forms the group.
          if ((await getLobbyMode(myLobby)) === "solo") await setLobbyMode(myLobby, "squad");
          const joined = await moveToLobby(io, requesterSocket as AuthedSocket, myLobby);
          if (!joined) return ack?.({ error: "Your group is full" });
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
        if (lobbyId) socket.to(`room:${lobbyId}`).emit("lobby:emote", { uid, emoteId: id });
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
        if (lobbyId !== soloLobby) return ack?.({ error: "Only the party leader can change the mode" });
        if (await inMatch(lobbyId)) return ack?.({ error: "Finish the match first" });
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
        await broadcastLobby(io, lobbyId);
        // Picking SOLO dissolves the group like leaving does — drop its chat.
        await syncTeamChatSession(lobbyId);
        ack?.({ ok: true, mode });
      } catch (err) {
        console.error("lobby:mode error:", err);
        ack?.({ error: "Could not change mode" });
      }
    });

    // Hand the crown to a teammate (leader only): the whole group — members,
    // join times, party mode, team chat — moves under the new leader's lobby
    // id and nobody's spot changes.
    socket.on("lobby:transferLead", async (payload: { targetUid?: string } | null, ack?: (r: object) => void) => {
      try {
        const { targetUid } = payload ?? {};
        const target = await getUserByUid(String(targetUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (target.id === userId) return ack?.({ error: "You're already the leader" });
        if ((await getUserLobby(userId)) !== soloLobby) {
          return ack?.({ error: "Only the group leader can transfer leadership" });
        }
        if (await inMatch(soloLobby)) return ack?.({ error: "Finish the match first" });
        const members = await getLobbyMembers(soloLobby);
        if (!members.includes(target.id)) return ack?.({ error: "That player isn't in your group" });

        const newLobbyId = `L${target.uid}`;
        const joinTimes = await getLobbyJoinTimes(soloLobby);
        await rehomeMembers(io, soloLobby, newLobbyId, members, joinTimes);
        // My old lobby id is empty now — reset it for my next fresh session.
        await setLobbyMode(soloLobby, "solo");
        io.to(`room:${newLobbyId}`).emit("lobby:leader", { uid: target.uid, name: displayName(target) });
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
        if ((await getUserLobby(userId)) !== soloLobby) {
          return ack?.({ error: "Only the group leader can kick players" });
        }
        if (await inMatch(soloLobby)) return ack?.({ error: "Finish the match first" });
        if ((await getUserLobby(target.id)) !== soloLobby) {
          return ack?.({ error: "That player isn't in your group" });
        }

        await setLobbyMode(`L${target.uid}`, "solo");
        const targetSocketId = await getSocketId(target.id);
        const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
        if (targetSocket) {
          await moveToLobby(io, targetSocket as AuthedSocket, `L${target.uid}`);
        } else {
          // They dropped offline mid-kick — just detach their membership.
          await leaveLobby(target.id);
          await broadcastLobby(io, soloLobby);
          await syncTeamChatSession(soloLobby);
        }
        io.to(`user:${target.id}`).emit("lobby:kicked", { by: name });
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
        if (await inMatch((await getUserLobby(userId)) ?? soloLobby)) return ack?.({ error: "Leave the match first" });
        const migrated = await migrateGroupOnLeaderLeave(io, socket);
        if (!migrated) {
          await setLobbyMode(soloLobby, "solo");
          await moveToLobby(io, socket, soloLobby);
        }
        ack?.({ ok: true, lobbyId: soloLobby });
      } catch (err) {
        console.error("lobby:leave error:", err);
        ack?.({ error: "Leave failed" });
      }
    });

    socket.on("disconnect", async () => {
      try {
        // Another socket may have replaced us already — only clean up if we still own presence.
        const current = await getSocketId(userId);
        if (current !== socket.id) return;

        // Mid-match: keep their seat for the grace period (platform/match.ts).
        platformOnDisconnect(io, socket);
        await setOffline(userId);
        const lobbyId = await leaveLobby(userId);
        if (lobbyId) {
          await broadcastLobby(io, lobbyId);
          await syncTeamChatSession(lobbyId);
        }

        const friendIds = await getFriendIds(userId);
        for (const fid of friendIds) {
          io.to(`user:${fid}`).emit("friend:offline", { uid, name });
        }
      } catch (err) {
        console.error("Socket disconnect cleanup error:", err);
      }
    });

    // ---- connection setup (runs after handlers are attached) ----
    try {
      // If this user is already connected elsewhere, drop the old socket.
      const oldSocketId = await getSocketId(userId);
      if (oldSocketId && oldSocketId !== socket.id) {
        io.sockets.sockets.get(oldSocketId)?.disconnect(true);
      }

      await setOnline(userId, socket.id);
      socket.join(`user:${userId}`);

      // Everyone starts a session in their own lobby, in solo mode (like Free
      // Fire) — unless their squad is still alive and waiting for them.
      await ensureLobbyModeOnConnect(soloLobby);
      await moveToLobby(io, socket, soloLobby);
      // Back into a match that is still running for them (page reload, drop).
      platformOnConnect(io, socket);

      // Tell online friends I'm here.
      const friendIds = await getFriendIds(userId);
      for (const fid of friendIds) {
        io.to(`user:${fid}`).emit("friend:online", { uid, name });
      }
    } catch (err) {
      console.error("Socket connect error:", err);
      socket.disconnect(true);
    }
  });
}
