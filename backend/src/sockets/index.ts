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
  createJoinRequest,
  consumeJoinRequest,
  getLobbyJoinTimes,
  migrateLobbyMembers,
  moveTeamSession,
} from "../redis.js";
import { areFriends, getFriendIds, getUserByUid, getUsersByIds } from "../services/users.js";
import { registerChatHandlers, syncTeamChatSession } from "./chat.js";

interface AuthedSocket extends Socket {
  data: { auth: AuthPayload };
}

/** Push the current member list (and party mode) of a lobby to everyone in it. */
async function broadcastLobby(io: Server, lobbyId: string) {
  const memberIds = await getLobbyMembers(lobbyId);
  const [users, mode] = await Promise.all([getUsersByIds(memberIds), getLobbyMode(lobbyId)]);
  const members = users.map((u) => ({
    id: u.id,
    uid: u.uid,
    name: u.name,
    avatarUrl: u.avatarUrl,
    isLeader: lobbyId === `L${u.uid}`,
  }));
  io.to(`room:${lobbyId}`).emit("lobby:members", { lobbyId, mode, members });
}

async function moveToLobby(io: Server, socket: AuthedSocket, lobbyId: string): Promise<boolean> {
  const { userId } = socket.data.auth;
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
  for (const memberId of memberIds) {
    const socketId = await getSocketId(memberId);
    const memberSocket = socketId ? io.sockets.sockets.get(socketId) : null;
    memberSocket?.leave(`room:${oldLobbyId}`);
    memberSocket?.join(`room:${newLobbyId}`);
  }
  await broadcastLobby(io, newLobbyId);
  await syncTeamChatSession(newLobbyId);
}

/** A leader's lobby id IS their identity (L<uid>), so a leader "leaving" means
 *  everyone ELSE moves out: remaining members are rehomed under the new
 *  leader's lobby id — chosen as the longest-present member — carrying the
 *  party mode and the team chat session with them. Returns false when the
 *  departing user isn't a leader with members left behind (normal leave). */
async function migrateGroupOnLeaderLeave(io: Server, socket: AuthedSocket): Promise<boolean> {
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
  // The departing leader stays in their own (now empty of others) lobby, on
  // their own again — no membership change needed.
  await setLobbyMode(ownLobby, "solo");
  await broadcastLobby(io, ownLobby);
  await syncTeamChatSession(ownLobby);
  return true;
}

export function registerSockets(io: Server) {
  // Handshake auth: the frontend passes its JWT in socket.io auth.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return next(new Error("Unauthorized"));
    (socket as AuthedSocket).data.auth = payload;
    next();
  });

  io.on("connection", async (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    const { userId, uid, name } = socket.data.auth;
    const soloLobby = `L${uid}`;

    // Register ALL event handlers before any awaited setup below — events a
    // fast client emits right after connecting would otherwise be dropped.
    registerChatHandlers(io, socket);

    // Invite a friend to my CURRENT lobby.
    socket.on("lobby:invite", async ({ friendUid }: { friendUid: string }, ack?: (r: object) => void) => {
      try {
        const target = await getUserByUid(String(friendUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (!(await areFriends(userId, target.id))) return ack?.({ error: "You can only invite friends" });

        const targetSocketId = await getSocketId(target.id);
        if (!targetSocketId) return ack?.({ error: `${target.name} is offline` });

        const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
        if ((await getUserLobby(target.id)) === lobbyId) {
          return ack?.({ error: `${target.name} is already in your group` });
        }
        if (await isDnd(target.id)) {
          return ack?.({ error: `${target.name} has Do Not Disturb on` });
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
          return ack?.({ error: `Wait ${wait}s before inviting ${target.name} again`, wait });
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
    socket.on("lobby:join", async ({ lobbyId }: { lobbyId: string }, ack?: (r: object) => void) => {
      try {
        if (typeof lobbyId !== "string" || !lobbyId.startsWith("L")) return ack?.({ error: "Bad lobby id" });
        const members = await getLobbyMembers(lobbyId);
        if (lobbyId !== soloLobby && members.length === 0) return ack?.({ error: "That lobby no longer exists" });
        const ok = await moveToLobby(io, socket, lobbyId);
        ack?.(ok ? { ok: true, lobbyId } : { error: "Lobby is full" });
      } catch (err) {
        console.error("lobby:join error:", err);
        ack?.({ error: "Join failed" });
      }
    });

    // Ask a friend to let me into their group. The friend approves/declines;
    // approval moves ME into THEIR current lobby.
    socket.on("lobby:joinRequest", async ({ friendUid }: { friendUid?: string }, ack?: (r: object) => void) => {
      try {
        const target = await getUserByUid(String(friendUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (!(await areFriends(userId, target.id))) return ack?.({ error: "You can only join a friend's group" });
        const targetSocketId = await getSocketId(target.id);
        if (!targetSocketId) return ack?.({ error: `${target.name} is offline` });
        if (await isDnd(target.id)) return ack?.({ error: `${target.name} has Do Not Disturb on` });

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
          return ack?.({ error: `Wait ${wait}s before asking ${target.name} again`, wait });
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
      async ({ requesterUid, accept }: { requesterUid?: string; accept?: boolean }, ack?: (r: object) => void) => {
        try {
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
          if (!requesterSocket) return ack?.({ error: `${requester.name} went offline` });

          const myLobby = (await getUserLobby(userId)) ?? soloLobby;
          if ((await getUserLobby(requester.id)) === myLobby) return ack?.({ ok: true });
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
    socket.on("user:dnd", async ({ on }: { on?: boolean }, ack?: (r: object) => void) => {
      try {
        await setDnd(userId, !!on);
        ack?.({ ok: true, on: !!on });
      } catch (err) {
        console.error("user:dnd error:", err);
        ack?.({ error: "Could not update Do Not Disturb" });
      }
    });

    // Change my party mode (Free Fire style Solo/Duo/Squad). Leader only, and
    // you can't shrink below the number of players already in the party.
    socket.on("lobby:mode", async ({ mode }: { mode?: string }, ack?: (r: object) => void) => {
      try {
        if (mode !== "solo" && mode !== "duo" && mode !== "squad") return ack?.({ error: "Unknown mode" });
        const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
        if (lobbyId !== soloLobby) return ack?.({ error: "Only the party leader can change the mode" });
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
    socket.on("lobby:transferLead", async ({ targetUid }: { targetUid?: string }, ack?: (r: object) => void) => {
      try {
        const target = await getUserByUid(String(targetUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (target.id === userId) return ack?.({ error: "You're already the leader" });
        if ((await getUserLobby(userId)) !== soloLobby) {
          return ack?.({ error: "Only the group leader can transfer leadership" });
        }
        const members = await getLobbyMembers(soloLobby);
        if (!members.includes(target.id)) return ack?.({ error: "That player isn't in your group" });

        const newLobbyId = `L${target.uid}`;
        const joinTimes = await getLobbyJoinTimes(soloLobby);
        await rehomeMembers(io, soloLobby, newLobbyId, members, joinTimes);
        // My old lobby id is empty now — reset it for my next fresh session.
        await setLobbyMode(soloLobby, "solo");
        io.to(`room:${newLobbyId}`).emit("lobby:leader", { uid: target.uid, name: target.name });
        ack?.({ ok: true });
      } catch (err) {
        console.error("lobby:transferLead error:", err);
        ack?.({ error: "Transfer failed" });
      }
    });

    // Kick a member out of my group (leader only). They land back in their
    // own lobby in solo mode; the group lives on for everyone else.
    socket.on("lobby:kick", async ({ targetUid }: { targetUid?: string }, ack?: (r: object) => void) => {
      try {
        const target = await getUserByUid(String(targetUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (target.id === userId) return ack?.({ error: "You can't kick yourself — use Leave" });
        if ((await getUserLobby(userId)) !== soloLobby) {
          return ack?.({ error: "Only the group leader can kick players" });
        }
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
