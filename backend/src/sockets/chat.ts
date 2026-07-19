import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import type { AuthPayload } from "../middleware/auth.js";
import {
  addUnreadDm,
  clearTeamSession,
  clearUnreadDm,
  ensureTeamSession,
  getLobbyMembers,
  getLobbyMode,
  getUserLobby,
} from "../redis.js";
import { areFriends, getUserByUid } from "../services/users.js";
import {
  MAX_MESSAGE_LENGTH,
  deleteTeamSessionMessages,
  getBlockState,
  insertDm,
  insertTeamMessage,
} from "../services/chat.js";

interface AuthedSocket extends Socket {
  data: { auth: AuthPayload };
}

/** Keep the squad-chat session in step with the party's lifetime:
 *  ≥2 members → make sure a session exists (a squad is alive);
 *  1 member in an open duo/squad → the group still lives (teammates left, but
 *  the last player keeps the group and its chat until THEY leave too);
 *  0 members, or the lobby dropped back to solo → the group is destroyed:
 *  drop the session AND its messages so the next squad starts blank. */
export async function syncTeamChatSession(lobbyId: string): Promise<void> {
  const [members, mode] = await Promise.all([getLobbyMembers(lobbyId), getLobbyMode(lobbyId)]);
  if (members.length === 0 || mode === "solo") {
    const sessionId = await clearTeamSession(lobbyId);
    if (sessionId) await deleteTeamSessionMessages(sessionId);
  } else if (members.length >= 2) {
    await ensureTeamSession(lobbyId, randomUUID());
  }
}

function cleanBody(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_MESSAGE_LENGTH) return null;
  return text;
}

export function registerChatHandlers(io: Server, socket: AuthedSocket): void {
  const { userId, uid, name } = socket.data.auth;

  // Direct message — lands in the recipient's Friends or Recent section
  // depending on the relationship (isFriend travels with the event).
  socket.on(
    "chat:dm",
    async ({ toUid, body }: { toUid?: string; body?: string }, ack?: (r: object) => void) => {
      try {
        const text = cleanBody(body);
        if (!text) return ack?.({ error: "Message must be 1–500 characters" });
        const target = await getUserByUid(String(toUid || ""));
        if (!target) return ack?.({ error: "Player not found" });
        if (target.id === userId) return ack?.({ error: "That's your own UID" });

        const blockState = await getBlockState(userId, target.id);
        if (blockState.byA) return ack?.({ error: "You blocked this player — unblock them to chat" });
        if (blockState.byB) return ack?.({ error: "This player has blocked you" });

        const row = await insertDm(userId, target.id, text);
        // Mark unread for the recipient — persists across their sessions; the
        // recipient's client reports back (chat:read / opening the thread)
        // when the conversation is actually looked at.
        await addUnreadDm(target.id, uid);
        const isFriend = await areFriends(userId, target.id);
        io.to(`user:${target.id}`).emit("chat:dm", {
          id: row.id,
          from: { uid, name },
          body: text,
          at: row.createdAt.toISOString(),
          isFriend,
        });
        ack?.({ ok: true, id: row.id, at: row.createdAt.toISOString() });
      } catch (err) {
        console.error("chat:dm error:", err);
        ack?.({ error: "Send failed" });
      }
    }
  );

  // Squad message — snapshots the current member list as the visibility set,
  // so players who join later never see it.
  socket.on("chat:team", async ({ body }: { body?: string }, ack?: (r: object) => void) => {
    try {
      const text = cleanBody(body);
      if (!text) return ack?.({ error: "Message must be 1–500 characters" });
      const lobbyId = await getUserLobby(userId);
      if (!lobbyId) return ack?.({ error: "You're not in a squad" });
      // Being alone in an open duo/squad still counts as in the group — only
      // solo mode means there's no team to talk to.
      const [members, mode] = await Promise.all([getLobbyMembers(lobbyId), getLobbyMode(lobbyId)]);
      if (mode === "solo") return ack?.({ error: "You're not in a squad" });

      const sessionId = await ensureTeamSession(lobbyId, randomUUID());
      const row = await insertTeamMessage(sessionId, lobbyId, userId, text, members);
      io.to(`room:${lobbyId}`).emit("chat:team", {
        id: row.id,
        from: { uid, name },
        body: text,
        at: row.createdAt.toISOString(),
      });
      ack?.({ ok: true });
    } catch (err) {
      console.error("chat:team error:", err);
      ack?.({ error: "Send failed" });
    }
  });

  // The client had this sender's thread open when a message arrived — the
  // persistent unread marker can go (opening a thread clears via the DM GET).
  socket.on("chat:read", async ({ uid: senderUid }: { uid?: string }) => {
    try {
      if (typeof senderUid === "string" && senderUid) await clearUnreadDm(userId, senderUid);
    } catch (err) {
      console.error("chat:read error:", err);
    }
  });
}
