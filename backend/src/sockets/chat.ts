import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import type { AuthPayload } from "../middleware/auth.js";
import {
  clearTeamSession,
  ensureTeamSession,
  getLobbyMembers,
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

/** Keep the squad-chat session in step with lobby membership:
 *  ≥2 members → make sure a session exists (a squad is alive);
 *  ≤1 member → the squad disbanded: drop the session AND its messages, so the
 *  chat disappears for everyone and the next squad starts blank. */
export async function syncTeamChatSession(lobbyId: string): Promise<void> {
  const members = await getLobbyMembers(lobbyId);
  if (members.length >= 2) {
    await ensureTeamSession(lobbyId, randomUUID());
  } else {
    const sessionId = await clearTeamSession(lobbyId);
    if (sessionId) await deleteTeamSessionMessages(sessionId);
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
      const members = lobbyId ? await getLobbyMembers(lobbyId) : [];
      if (!lobbyId || members.length < 2) return ack?.({ error: "You're not in a squad" });

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
}
