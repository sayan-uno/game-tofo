// The world-chat archive.
//
// World chat is the loudest surface on the platform — a thousand people who
// can all hear each other — which makes it both the one most likely to need
// answering for and the one that must never cost a player anything. Those two
// pull in opposite directions, and this file is where they are reconciled:
//
//   * WHAT PLAYERS SEE comes from Redis (platform/world.ts). A message is in
//     the ring and on its way to a thousand sockets before Postgres has heard
//     of it.
//   * WHAT MODERATION SEES comes from here. Rows are buffered in memory and
//     written in one multi-row INSERT every couple of seconds, exactly like
//     the activity log, so saying something in a busy world never waits on the
//     database — and a database wobble costs a few seconds of archive rather
//     than the conversation.
//
// Retention is the platform's fifteen days, swept by the same hourly job as
// direct and squad messages and spared by the same open-case exemption: a
// report filed on day fourteen about something said on day one must not arrive
// at a conversation the platform has already deleted.
//
// Bot lines are archived too. That looks odd until you need it: an admin
// reading a world back has to see the room as it was, and a transcript with
// every other line missing is not a transcript.
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { worldMessages } from "../db/schema.js";

/** Shorter than a DM on purpose. A public room rewards brevity, and a
 *  three-hundred-character wall from one person is what spam looks like here. */
export const MAX_WORLD_MESSAGE_LENGTH = 200;

type Row = typeof worldMessages.$inferInsert;

const FLUSH_MS = 2000;
const MAX_BATCH = 500;
/** Minutes of a very busy platform. Past this the OLDEST go — the newest
 *  lines are the ones a live incident is about. */
const MAX_BUFFER = Math.max(10, Number(process.env.WORLD_CHAT_MAX_BUFFER || 20_000));

let buffer: Row[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing = false;
let dropped = 0;
let written = 0;

/** Archive one line. Returns immediately; never awaits, never throws. */
export function archiveWorldMessage(row: {
  worldId: string;
  senderId: string | null;
  botId: string | null;
  uid: string;
  name: string;
  body: string;
  at: Date;
}): void {
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    dropped++;
  }
  buffer.push({
    worldId: row.worldId,
    senderId: row.senderId,
    botId: row.botId,
    uid: row.uid,
    name: row.name,
    // Truncated here rather than trusted from the caller: one over-long row
    // must never be able to take 499 good ones down with it.
    body: row.body.slice(0, MAX_WORLD_MESSAGE_LENGTH),
    createdAt: row.at,
  });
}

/** Same reasoning as the activity log: a row Postgres will NEVER accept must
 *  not jam the queue for ever, so a data fault (SQLSTATE 22/23) bisects until
 *  the offender is alone and dropped, while anything else is the database
 *  being away and the whole batch is kept for the next tick. */
function isRowFault(err: unknown): boolean {
  const code = ((err as { cause?: unknown })?.cause ?? err) as { code?: unknown };
  return typeof code?.code === "string" && (code.code.startsWith("22") || code.code.startsWith("23"));
}

export async function flushWorldChat(): Promise<number> {
  if (flushing || buffer.length === 0) return 0;
  flushing = true;
  let total = 0;
  let size = MAX_BATCH;
  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, size);
      try {
        await db.insert(worldMessages).values(batch);
        written += batch.length;
        total += batch.length;
        size = MAX_BATCH;
      } catch (err) {
        if (isRowFault(err)) {
          if (batch.length === 1) {
            dropped++;
            size = MAX_BATCH;
            const why = ((err as { cause?: unknown }).cause ?? err) as { code?: string; message?: string };
            console.error(`[worldChat] dropped an unwritable message (${why.code}): ${why.message}`);
          } else {
            size = Math.ceil(batch.length / 2);
            buffer.unshift(...batch);
          }
          continue;
        }
        size = MAX_BATCH;
        buffer.unshift(...batch);
        while (buffer.length > MAX_BUFFER) {
          buffer.shift();
          dropped++;
        }
        console.error(`[worldChat] flush failed (${buffer.length} buffered, ${dropped} dropped):`, err);
        break;
      }
    }
  } finally {
    flushing = false;
  }
  return total;
}

export function startWorldChatArchive(): void {
  if (timer) return;
  timer = setInterval(() => void flushWorldChat(), FLUSH_MS);
  timer.unref();
}

export function stopWorldChatArchive(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export const worldChatStats = () => ({ buffered: buffer.length, written, dropped });

// ---------------------------------------------------------------------------
// Reading it back (console only)
// ---------------------------------------------------------------------------

export type WorldMessageRow = typeof worldMessages.$inferSelect;

/** One world's archive, newest first. `before` pages backwards through it. */
export async function listWorldArchive(
  worldId: string,
  limit = 200,
  before?: Date
): Promise<WorldMessageRow[]> {
  const rows = await db
    .select()
    .from(worldMessages)
    .where(
      before
        ? and(eq(worldMessages.worldId, worldId), lt(worldMessages.createdAt, before))
        : eq(worldMessages.worldId, worldId)
    )
    .orderBy(desc(worldMessages.createdAt))
    .limit(Math.min(500, limit));
  return rows;
}

/** Everything ONE player has said in any world. The question a report about
 *  world chat actually asks — "what has this account been saying in public" —
 *  which a per-world listing cannot answer. */
export async function listWorldMessagesBy(userId: string, limit = 200): Promise<WorldMessageRow[]> {
  return db
    .select()
    .from(worldMessages)
    .where(eq(worldMessages.senderId, userId))
    .orderBy(desc(worldMessages.createdAt))
    .limit(Math.min(500, limit));
}

/** How many lines each world has carried in the last day — the number that
 *  says which worlds are alive without reading any of them. */
export async function worldChatVolume(sinceHours = 24): Promise<Map<string, number>> {
  const rows = await db
    .select({ worldId: worldMessages.worldId, n: sql<number>`count(*)::int` })
    .from(worldMessages)
    .where(gt(worldMessages.createdAt, new Date(Date.now() - sinceHours * 60 * 60 * 1000)))
    .groupBy(worldMessages.worldId);
  return new Map(rows.map((r) => [r.worldId, r.n]));
}
