// Events — something the platform wants a player to SEE, rather than read.
//
// A picture, a clip, or a piece of markup. The one behaviour that makes this
// more than a list is PINNING: a pinned event is put in front of a player when
// they next arrive, and "arrive" means a fresh session, not coming back from
// another tab. Something that reappears every time somebody glances away is
// not an announcement — it is the fastest way to teach people to close it
// without reading it.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema.js";

export type EventKind = "image" | "video" | "html";

export interface EventRow {
  id: string;
  title: string;
  kind: EventKind;
  body: string;
  pinned: boolean;
  itemId: string | null;
  createdAt: string;
}

export async function createEvent(input: {
  title: string;
  kind: EventKind;
  body: string;
  pinned: boolean;
  itemId: string | null;
  createdBy: string;
}): Promise<EventRow> {
  const [row] = await db.insert(events).values(input).returning();
  return shape(row);
}

export async function setPinned(id: string, pinned: boolean): Promise<boolean> {
  const [row] = await db
    .update(events)
    .set({ pinned })
    .where(and(eq(events.id, id), isNull(events.deletedAt)))
    .returning({ id: events.id });
  return !!row;
}

/** Soft, like a notice: an admin taking an event down is itself a thing that
 *  happened, and the audit trail points at this row. */
export async function deleteEvent(id: string): Promise<boolean> {
  const [row] = await db
    .update(events)
    .set({ deletedAt: sql`now()`, pinned: false })
    .where(and(eq(events.id, id), isNull(events.deletedAt)))
    .returning({ id: events.id });
  return !!row;
}

/** Everything the console lists, deleted ones included. */
export async function listEvents(limit = 60): Promise<(EventRow & { deletedAt: string | null })[]> {
  const rows = await db.select().from(events).orderBy(desc(events.createdAt)).limit(limit);
  return rows.map((r) => ({ ...shape(r), deletedAt: r.deletedAt ? new Date(r.deletedAt).toISOString() : null }));
}

/** What a player sees: live events, newest first, pinned ones marked. */
export async function liveEventsForPlayers(limit = 30): Promise<EventRow[]> {
  const rows = await db
    .select()
    .from(events)
    .where(isNull(events.deletedAt))
    .orderBy(desc(events.pinned), desc(events.createdAt))
    .limit(limit);
  return rows.map(shape);
}

const shape = (r: typeof events.$inferSelect): EventRow => ({
  id: r.id,
  title: r.title,
  kind: r.kind as EventKind,
  body: r.body,
  pinned: r.pinned,
  itemId: r.itemId,
  createdAt: new Date(r.createdAt).toISOString(),
});
