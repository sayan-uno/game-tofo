import { Router } from "express";
import type { Server } from "socket.io";
import { requireAuth } from "../middleware/auth.js";
import { getLobbyMembers, getOnlineSet, getUserLobby, isDnd } from "../redis.js";
import { getUserByUid, toPublicUser } from "../services/users.js";
import {
  acceptFriendRequest,
  createFriendRequest,
  deleteFriendship,
  findFriendshipBetween,
  getPendingRequest,
  listFriends,
  listIncomingRequests,
} from "../services/friends.js";
import { getBlockState } from "../services/chat.js";

export function friendsRouter(io: Server) {
  const router = Router();
  router.use(requireAuth);

  // Accepted friends with live status: online, which lobby they're in (so the
  // client can tag "Same group"), whether that lobby is a real group, plus the
  // caller's own Do Not Disturb state.
  router.get("/", async (req, res) => {
    const userId = req.auth!.userId;
    const friends = await listFriends(userId);
    const [online, dnd] = await Promise.all([getOnlineSet(friends.map((f) => f.id)), isDnd(userId)]);
    const enriched = await Promise.all(
      friends.map(async (f) => {
        const base = { ...toPublicUser(f), online: online.has(f.id) };
        if (!base.online) return { ...base, lobbyId: null, inGroup: false };
        const lobbyId = await getUserLobby(f.id);
        const members = lobbyId ? await getLobbyMembers(lobbyId) : [];
        return { ...base, lobbyId, inGroup: members.length > 1 };
      })
    );
    res.json({ friends: enriched, dnd });
  });

  // Incoming pending requests.
  router.get("/requests", async (req, res) => {
    res.json({ requests: await listIncomingRequests(req.auth!.userId) });
  });

  // Search a player by UID (for the add-friend flow).
  router.get("/search/:uid", async (req, res) => {
    const target = await getUserByUid(req.params.uid.trim());
    if (!target || target.id === req.auth!.userId) {
      res.status(404).json({ error: "No player found with that UID" });
      return;
    }
    res.json({ user: toPublicUser(target) });
  });

  // Send a friend request by UID.
  router.post("/request", async (req, res) => {
    const userId = req.auth!.userId;
    const { uid } = req.body as { uid?: string };
    if (!uid) {
      res.status(400).json({ error: "Missing uid" });
      return;
    }
    const target = await getUserByUid(uid.trim());
    if (!target) {
      res.status(404).json({ error: "No player found with that UID" });
      return;
    }
    if (target.id === userId) {
      res.status(400).json({ error: "That's your own UID" });
      return;
    }
    const blockState = await getBlockState(userId, target.id);
    if (blockState.byA || blockState.byB) {
      res.status(403).json({ error: "You can't add this player" });
      return;
    }
    const existing = await findFriendshipBetween(userId, target.id);
    if (existing) {
      if (existing.status === "accepted") {
        res.status(409).json({ error: "You are already friends" });
      } else if (existing.requesterId === userId) {
        res.status(409).json({ error: "Request already sent" });
      } else {
        res.status(409).json({ error: "This player already sent you a request — check your requests tab" });
      }
      return;
    }
    const requestId = await createFriendRequest(userId, target.id);
    // Realtime ping to the target if they're online.
    io.to(`user:${target.id}`).emit("friend:request", {
      requestId,
      uid: req.auth!.uid,
      name: req.auth!.name,
    });
    res.json({ ok: true });
  });

  // Remove an existing friend. Their DM history simply shows up under the
  // "Recent" chat section from now on — messages are never deleted by this.
  router.post("/unfriend", async (req, res) => {
    const userId = req.auth!.userId;
    const { uid } = req.body as { uid?: string };
    const target = uid ? await getUserByUid(uid.trim()) : null;
    if (!target) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    const existing = await findFriendshipBetween(userId, target.id);
    if (!existing || existing.status !== "accepted") {
      res.status(404).json({ error: "You are not friends with this player" });
      return;
    }
    await deleteFriendship(existing.id);
    io.to(`user:${target.id}`).emit("friend:removed", {
      uid: req.auth!.uid,
      name: req.auth!.name,
    });
    res.json({ ok: true });
  });

  // Accept or decline a request.
  router.post("/respond", async (req, res) => {
    const userId = req.auth!.userId;
    const { requestId, accept } = req.body as { requestId?: string; accept?: boolean };
    if (!requestId || typeof accept !== "boolean") {
      res.status(400).json({ error: "Missing requestId or accept" });
      return;
    }
    const pending = await getPendingRequest(requestId, userId);
    if (!pending) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (accept) {
      await acceptFriendRequest(requestId);
      io.to(`user:${pending.requesterId}`).emit("friend:accepted", {
        uid: req.auth!.uid,
        name: req.auth!.name,
      });
    } else {
      await deleteFriendship(requestId);
    }
    res.json({ ok: true });
  });

  return router;
}
