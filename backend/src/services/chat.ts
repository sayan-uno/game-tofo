import { and, arrayContains, desc, eq, gt, lt, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { blocks, dmClears, dmMessages, teamMessages } from "../db/schema.js";

export const RETENTION_DAYS = 15;
export const MAX_MESSAGE_LENGTH = 500;

const retentionCutoff = () => new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

export type DmRow = typeof dmMessages.$inferSelect;
export type TeamMessageRow = typeof teamMessages.$inferSelect;

// ---------- direct messages ----------

export async function insertDm(senderId: string, recipientId: string, body: string): Promise<DmRow> {
  const [row] = await db.insert(dmMessages).values({ senderId, recipientId, body }).returning();
  return row;
}

/** The viewer's conversation with a partner: retention window, minus anything
 *  before the viewer's own "clear chat" marker, oldest first. */
export async function listDmBetween(viewerId: string, partnerId: string, limit = 200): Promise<DmRow[]> {
  const clearedAt = await getDmClearedAt(viewerId, partnerId);
  const since = clearedAt && clearedAt > retentionCutoff() ? clearedAt : retentionCutoff();
  const rows = await db
    .select()
    .from(dmMessages)
    .where(
      and(
        gt(dmMessages.createdAt, since),
        or(
          and(eq(dmMessages.senderId, viewerId), eq(dmMessages.recipientId, partnerId)),
          and(eq(dmMessages.senderId, partnerId), eq(dmMessages.recipientId, viewerId))
        )
      )
    )
    .orderBy(desc(dmMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Latest visible message per conversation partner (viewer's clears applied). */
export async function listDmThreads(userId: string): Promise<Map<string, DmRow>> {
  const [rows, clears] = await Promise.all([
    db
      .select()
      .from(dmMessages)
      .where(
        and(
          gt(dmMessages.createdAt, retentionCutoff()),
          or(eq(dmMessages.senderId, userId), eq(dmMessages.recipientId, userId))
        )
      )
      .orderBy(desc(dmMessages.createdAt))
      .limit(500),
    getClearMap(userId),
  ]);

  const latestByPartner = new Map<string, DmRow>();
  for (const row of rows) {
    const partnerId = row.senderId === userId ? row.recipientId : row.senderId;
    const clearedAt = clears.get(partnerId);
    if (clearedAt && row.createdAt <= clearedAt) continue;
    if (!latestByPartner.has(partnerId)) latestByPartner.set(partnerId, row);
  }
  return latestByPartner;
}

// ---------- "clear chat" markers (hide-for-me, never a DB delete) ----------

export async function setDmCleared(userId: string, partnerId: string): Promise<void> {
  await db
    .insert(dmClears)
    .values({ userId, partnerId, clearedAt: new Date() })
    .onConflictDoUpdate({
      target: [dmClears.userId, dmClears.partnerId],
      set: { clearedAt: new Date() },
    });
}

async function getDmClearedAt(userId: string, partnerId: string): Promise<Date | null> {
  const [row] = await db
    .select({ clearedAt: dmClears.clearedAt })
    .from(dmClears)
    .where(and(eq(dmClears.userId, userId), eq(dmClears.partnerId, partnerId)));
  return row?.clearedAt ?? null;
}

async function getClearMap(userId: string): Promise<Map<string, Date>> {
  const rows = await db.select().from(dmClears).where(eq(dmClears.userId, userId));
  return new Map(rows.map((r) => [r.partnerId, r.clearedAt]));
}

// ---------- team (squad) messages ----------

export async function insertTeamMessage(
  sessionId: string,
  lobbyId: string,
  senderId: string,
  body: string,
  visibleTo: string[]
): Promise<TeamMessageRow> {
  const [row] = await db
    .insert(teamMessages)
    .values({ sessionId, lobbyId, senderId, body, visibleTo })
    .returning();
  return row;
}

/** Session history the viewer is allowed to see: only messages sent while
 *  they were in the squad (visible_to snapshot), oldest first. */
export async function listTeamMessages(
  sessionId: string,
  viewerId: string,
  limit = 200
): Promise<TeamMessageRow[]> {
  const rows = await db
    .select()
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.sessionId, sessionId),
        gt(teamMessages.createdAt, retentionCutoff()),
        arrayContains(teamMessages.visibleTo, [viewerId])
      )
    )
    .orderBy(desc(teamMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** The squad disbanded — its chat disappears for everyone. */
export async function deleteTeamSessionMessages(sessionId: string): Promise<void> {
  await db.delete(teamMessages).where(eq(teamMessages.sessionId, sessionId));
}

// ---------- blocks ----------

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  await db.insert(blocks).values({ blockerId, blockedId }).onConflictDoNothing();
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await db.delete(blocks).where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)));
}

/** Who blocked whom between two users (either direction). */
export async function getBlockState(a: string, b: string): Promise<{ byA: boolean; byB: boolean }> {
  const rows = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
        and(eq(blocks.blockerId, b), eq(blocks.blockedId, a))
      )
    );
  return {
    byA: rows.some((r) => r.blockerId === a),
    byB: rows.some((r) => r.blockerId === b),
  };
}

export async function listBlockedIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ blockedId: blocks.blockedId })
    .from(blocks)
    .where(eq(blocks.blockerId, userId));
  return rows.map((r) => r.blockedId);
}

// ---------- retention ----------

/** Hourly sweep deleting anything older than the retention window. Read
 *  queries also filter by the window, so expired rows never surface between
 *  sweeps. */
export function startChatRetention(): void {
  const sweep = async () => {
    try {
      const cutoff = retentionCutoff();
      await db.delete(dmMessages).where(lt(dmMessages.createdAt, cutoff));
      await db.delete(teamMessages).where(lt(teamMessages.createdAt, cutoff));
    } catch (err) {
      console.error("Chat retention sweep failed:", err);
    }
  };
  void sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}
