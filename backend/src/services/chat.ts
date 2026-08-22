import { and, arrayContains, arrayOverlaps, desc, eq, gt, inArray, lt, not, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { blocks, dmClears, dmMessages, teamMessages, users } from "../db/schema.js";
import { subjectsWithOpenCases } from "./reports.js";

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
 *  sweeps.
 *
 *  WITH ONE EXEMPTION: anybody who is the subject of an OPEN case keeps their
 *  messages. Fifteen days is a sensible life for chatter and a disastrous one
 *  for evidence — a report filed on day fourteen about something said on day
 *  one would otherwise be investigated against a conversation the platform had
 *  already deleted. The exemption lasts exactly as long as the case: resolve
 *  it and the next sweep takes the messages with it. */
export function startChatRetention(): void {
  const sweep = async () => {
    try {
      const cutoff = retentionCutoff();
      const spared = await subjectsWithOpenCases();
      // uid → internal id, because the messages are keyed by the latter and a
      // case is opened against the former.
      const keep = spared.length
        ? (await db.select({ id: users.id }).from(users).where(inArray(users.uid, spared))).map((r) => r.id)
        : [];
      const safeDm = keep.length
        ? and(
            lt(dmMessages.createdAt, cutoff),
            notInArray(dmMessages.senderId, keep),
            notInArray(dmMessages.recipientId, keep)
          )
        : lt(dmMessages.createdAt, cutoff);
      // Squad chat carries who could see it, so a message is spared when the
      // person under a case sent it OR was in the room to hear it.
      const safeTeam = keep.length
        ? and(
            lt(teamMessages.createdAt, cutoff),
            notInArray(teamMessages.senderId, keep),
            not(arrayOverlaps(teamMessages.visibleTo, keep))
          )
        : lt(teamMessages.createdAt, cutoff);
      await db.delete(dmMessages).where(safeDm);
      await db.delete(teamMessages).where(safeTeam);
    } catch (err) {
      console.error("Chat retention sweep failed:", err);
    }
  };
  void sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}
