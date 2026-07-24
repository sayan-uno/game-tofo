import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { clearUnreadDm, getLobbyMode, getTeamSession, getUnreadDmUids, getUserLobby } from "../redis.js";
import { areFriends, displayName, getFriendIds, getUserByUid, getUsersByIds, toPublicUser } from "../services/users.js";
import {
  getBlockState,
  listBlockedIds,
  listDmBetween,
  listDmThreads,
  listTeamMessages,
  blockUser,
  unblockUser,
  setDmCleared,
} from "../services/chat.js";

export const chatRouter = Router();
chatRouter.use(requireAuth);

/** Every DM conversation in the retention window, tagged with the CURRENT
 *  relationship — the client shows isFriend ones under "Friends" and the rest
 *  under "Recent", so history follows friend/unfriend changes automatically. */
chatRouter.get("/threads", async (req, res) => {
  const me = req.auth!.userId;
  const [latestByPartner, friendIds, blockedIds] = await Promise.all([
    listDmThreads(me),
    getFriendIds(me),
    listBlockedIds(me),
  ]);
  const friends = new Set(friendIds);
  const blocked = new Set(blockedIds);
  const partners = await getUsersByIds([...latestByPartner.keys()]);

  const threads = partners
    .map((partner) => {
      const last = latestByPartner.get(partner.id)!;
      return {
        user: toPublicUser(partner),
        isFriend: friends.has(partner.id),
        blockedByMe: blocked.has(partner.id),
        lastBody: last.body,
        lastFromMe: last.senderId === me,
        lastAt: last.createdAt.toISOString(),
      };
    })
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  res.json({ threads });
});

/** Full conversation with one player. */
chatRouter.get("/dm/:uid", async (req, res) => {
  const me = req.auth!.userId;
  const target = await getUserByUid(req.params.uid.trim());
  if (!target || target.id === me) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const [rows, isFriend, blockState] = await Promise.all([
    listDmBetween(me, target.id),
    areFriends(me, target.id),
    getBlockState(me, target.id),
    clearUnreadDm(me, target.uid), // opening the conversation reads it
  ]);
  res.json({
    user: toPublicUser(target),
    isFriend,
    blockedByMe: blockState.byA,
    messages: rows.map((m) => ({
      id: m.id,
      fromMe: m.senderId === me,
      body: m.body,
      at: m.createdAt.toISOString(),
    })),
  });
});

/** Current squad chat — only what this viewer was present for. A player left
 *  alone in an open duo/squad is still in the team (the group only dies when
 *  its last member leaves), so the tab and history survive teammates leaving. */
chatRouter.get("/team", async (req, res) => {
  const me = req.auth!.userId;
  const lobbyId = await getUserLobby(me);
  if (!lobbyId || (await getLobbyMode(lobbyId)) === "solo") {
    res.json({ inTeam: false, messages: [] });
    return;
  }
  const sessionId = await getTeamSession(lobbyId);
  if (!sessionId) {
    res.json({ inTeam: true, messages: [] });
    return;
  }
  const rows = await listTeamMessages(sessionId, me);
  const senders = await getUsersByIds([...new Set(rows.map((r) => r.senderId))]);
  const senderById = new Map(senders.map((u) => [u.id, u]));
  res.json({
    inTeam: true,
    messages: rows.map((m) => {
      const sender = senderById.get(m.senderId);
      return {
        id: m.id,
        fromMe: m.senderId === me,
        fromUid: sender?.uid ?? "",
        fromName: sender ? displayName(sender) : "Player",
        body: m.body,
        at: m.createdAt.toISOString(),
      };
    }),
  });
});

/** Senders with messages I haven't opened yet — restores the red dots (HUD,
 *  section tabs, chat rows) when the player comes back online. */
chatRouter.get("/unread", async (req, res) => {
  const me = req.auth!.userId;
  const uids = await getUnreadDmUids(me);
  if (uids.length === 0) {
    res.json({ unread: [] });
    return;
  }
  const friendUids = new Set((await getUsersByIds(await getFriendIds(me))).map((u) => u.uid));
  res.json({ unread: uids.map((uid) => ({ uid, isFriend: friendUids.has(uid) })) });
});

/** Hide one conversation from MY view (a marker, not a delete — the other
 *  player keeps their copy; real deletion is the 15-day retention sweep). */
chatRouter.post("/clear", async (req, res) => {
  const me = req.auth!.userId;
  const { uid } = req.body as { uid?: string };
  const target = uid ? await getUserByUid(uid.trim()) : null;
  if (!target || target.id === me) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  await Promise.all([setDmCleared(me, target.id), clearUnreadDm(me, target.uid)]);
  res.json({ ok: true });
});

/** Clear every non-friend (Recent section) conversation at once. */
chatRouter.post("/clear-recent", async (req, res) => {
  const me = req.auth!.userId;
  const [latestByPartner, friendIds] = await Promise.all([listDmThreads(me), getFriendIds(me)]);
  const friends = new Set(friendIds);
  const recentPartners = [...latestByPartner.keys()].filter((id) => !friends.has(id));
  const partnerUids = (await getUsersByIds(recentPartners)).map((u) => u.uid);
  await Promise.all([...recentPartners.map((partnerId) => setDmCleared(me, partnerId)), clearUnreadDm(me, partnerUids)]);
  res.json({ ok: true, cleared: recentPartners.length });
});

chatRouter.post("/block", async (req, res) => {
  const me = req.auth!.userId;
  const { uid } = req.body as { uid?: string };
  const target = uid ? await getUserByUid(uid.trim()) : null;
  if (!target || target.id === me) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  await Promise.all([blockUser(me, target.id), clearUnreadDm(me, target.uid)]);
  res.json({ ok: true });
});

chatRouter.post("/unblock", async (req, res) => {
  const me = req.auth!.userId;
  const { uid } = req.body as { uid?: string };
  const target = uid ? await getUserByUid(uid.trim()) : null;
  if (!target) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  await unblockUser(me, target.id);
  res.json({ ok: true });
});
