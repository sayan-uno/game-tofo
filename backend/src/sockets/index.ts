import type { Server, Socket } from "socket.io";
import { verifyToken, type AuthPayload } from "../middleware/auth.js";
import {
  setOnline,
  setOffline,
  getSocketId,
  getUserLobby,
  getLobbyMembers,
  joinLobby,
  leaveLobby,
  MAX_LOBBY_SIZE,
} from "../redis.js";
import { areFriends, getFriendIds, getUserByUid, getUsersByIds } from "../services/users.js";

interface AuthedSocket extends Socket {
  data: { auth: AuthPayload };
}

/** Push the current member list of a lobby to everyone in it. */
async function broadcastLobby(io: Server, lobbyId: string) {
  const memberIds = await getLobbyMembers(lobbyId);
  const users = await getUsersByIds(memberIds);
  const members = users.map((u) => ({
    id: u.id,
    uid: u.uid,
    name: u.name,
    avatarUrl: u.avatarUrl,
    isLeader: lobbyId === `L${u.uid}`,
  }));
  io.to(`room:${lobbyId}`).emit("lobby:members", { lobbyId, members });
}

async function moveToLobby(io: Server, socket: AuthedSocket, lobbyId: string): Promise<boolean> {
  const { userId } = socket.data.auth;
  const previous = await leaveLobby(userId);
  if (previous && previous !== lobbyId) {
    socket.leave(`room:${previous}`);
    await broadcastLobby(io, previous);
  }
  const ok = await joinLobby(userId, lobbyId);
  if (!ok) {
    // Lobby full — fall back to own solo lobby.
    const solo = `L${socket.data.auth.uid}`;
    await joinLobby(userId, solo);
    socket.join(`room:${solo}`);
    await broadcastLobby(io, solo);
    socket.emit("lobby:error", { error: `Lobby is full (max ${MAX_LOBBY_SIZE})` });
    return false;
  }
  socket.join(`room:${lobbyId}`);
  await broadcastLobby(io, lobbyId);
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

    try {
      // If this user is already connected elsewhere, drop the old socket.
      const oldSocketId = await getSocketId(userId);
      if (oldSocketId && oldSocketId !== socket.id) {
        io.sockets.sockets.get(oldSocketId)?.disconnect(true);
      }

      await setOnline(userId, socket.id);
      socket.join(`user:${userId}`);

      // Everyone sits in their own solo lobby by default (like Free Fire).
      await moveToLobby(io, socket, soloLobby);

      // Tell online friends I'm here.
      const friendIds = await getFriendIds(userId);
      for (const fid of friendIds) {
        io.to(`user:${fid}`).emit("friend:online", { uid, name });
      }
    } catch (err) {
      console.error("Socket connect error:", err);
      socket.disconnect(true);
      return;
    }

    // Invite a friend to my CURRENT lobby.
    socket.on("lobby:invite", async ({ friendUid }: { friendUid: string }, ack?: (r: object) => void) => {
      try {
        const target = await getUserByUid(String(friendUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (!(await areFriends(userId, target.id))) return ack?.({ error: "You can only invite friends" });

        const targetSocketId = await getSocketId(target.id);
        if (!targetSocketId) return ack?.({ error: `${target.name} is offline` });

        const lobbyId = (await getUserLobby(userId)) ?? soloLobby;
        const members = await getLobbyMembers(lobbyId);
        if (members.length >= MAX_LOBBY_SIZE) return ack?.({ error: "Your lobby is full" });

        io.to(`user:${target.id}`).emit("lobby:invite", { from: { uid, name }, lobbyId });
        ack?.({ ok: true });
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

    // Leave back to my own solo lobby.
    socket.on("lobby:leave", async (ack?: (r: object) => void) => {
      try {
        await moveToLobby(io, socket, soloLobby);
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
        if (lobbyId) await broadcastLobby(io, lobbyId);

        const friendIds = await getFriendIds(userId);
        for (const fid of friendIds) {
          io.to(`user:${fid}`).emit("friend:offline", { uid, name });
        }
      } catch (err) {
        console.error("Socket disconnect cleanup error:", err);
      }
    });
  });
}
