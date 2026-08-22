// Notices, as records rather than broadcasts.
//
// ONE SEND IS ONE ROW. A notice to the whole platform must not become a row
// per player: an admin who sent one by mistake would have to find and delete
// forty thousand of them, which is not an undo, it is a punishment. So the row
// describes the AUDIENCE and the reading side works out whether it is for you.
//
// DELETING IS THE POINT. A notice sent in error is retractable in exactly one
// window — before the people who were offline come back — and that window is
// the only reason to store this at all rather than fire it down a socket and
// forget it. Deleting takes it off every list and stops it reaching anybody
// who has not seen it yet.
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notices } from "../db/schema.js";

/** Kept as long as a party recording, and gone the same way — by expiry, never
 *  by hand. A three-month-old "servers back up" helps nobody. */
const RETENTION_DAYS = 30;

export type Audience = "everyone" | "online" | "players";

export interface NoticeRow {
  id: string;
  body: string;
  audience: Audience;
  uids: string[];
  sentBy: string | null;
  sentAt: string;
  deletedAt: string | null;
}

export async function sendNotice(input: {
  body: string;
  audience: Audience;
  uids: string[];
  sentBy: string;
}): Promise<NoticeRow> {
  const [row] = await db
    .insert(notices)
    .values({
      body: input.body,
      audience: input.audience,
      // `everyone` is defined by the ABSENCE of a list: a notice for the whole
      // platform should reach the player who signs up tomorrow, and a snapshot
      // of today's accounts would not.
      uids: input.audience === "everyone" ? [] : input.uids,
      sentBy: input.sentBy,
      expiresAt: new Date(Date.now() + RETENTION_DAYS * 86_400_000),
    })
    .returning();
  return shape(row);
}

/** Take it back. Soft, because an admin retracting a notice is itself a thing
 *  that happened and the audit trail points at this row. */
export async function deleteNotice(id: string, by: string): Promise<boolean> {
  const [row] = await db
    .update(notices)
    .set({ deletedAt: sql`now()`, deletedBy: by })
    .where(and(eq(notices.id, id), isNull(notices.deletedAt)))
    .returning({ id: notices.id });
  return !!row;
}

/** What the console lists: every send, newest first, deleted ones included so
 *  an admin can see what they took back. */
export async function listNotices(limit = 50): Promise<NoticeRow[]> {
  const rows = await db.select().from(notices).orderBy(desc(notices.sentAt)).limit(limit);
  return rows.map(shape);
}

/** What ONE player should see, newest first.
 *
 *  Deleted notices are absent rather than struck through: to the player it
 *  should be as though it was never sent, which is what an admin deleting one
 *  is asking for. */
export async function noticesFor(uid: string, limit = 20): Promise<NoticeRow[]> {
  const rows = await db
    .select()
    .from(notices)
    .where(
      and(
        isNull(notices.deletedAt),
        or(sql`${notices.expiresAt} is null`, gt(notices.expiresAt, sql`now()`)),
        or(eq(notices.audience, "everyone"), sql`${notices.uids} @> ${JSON.stringify([uid])}::jsonb`)
      )
    )
    .orderBy(desc(notices.sentAt))
    .limit(limit);
  return rows.map(shape);
}

/** Retention: notices go by expiry, like everything else that is kept for a
 *  while and then is not. */
export async function sweepNotices(limit = 500): Promise<number> {
  const due = await db
    .select({ id: notices.id })
    .from(notices)
    .where(and(sql`${notices.expiresAt} is not null`, lte(notices.expiresAt, sql`now()`)))
    .limit(limit);
  if (due.length === 0) return 0;
  for (const d of due) await db.delete(notices).where(eq(notices.id, d.id));
  console.log(`✔ Swept ${due.length} expired notice(s)`);
  return due.length;
}

const shape = (r: typeof notices.$inferSelect): NoticeRow => ({
  id: r.id,
  body: r.body,
  audience: r.audience as Audience,
  uids: (r.uids as string[]) ?? [],
  sentBy: r.sentBy,
  sentAt: new Date(r.sentAt).toISOString(),
  deletedAt: r.deletedAt ? new Date(r.deletedAt).toISOString() : null,
});
