// The activity trail: signed in, connected, entered a match, dropped, banned.
//
// The ONE rule this file exists to enforce: writing a log line must never make
// a player wait. `logEvent` is synchronous, does no I/O, and cannot throw — it
// pushes onto an array. A timer drains that array into a single multi-row
// INSERT a couple of times a second, off every request and socket path.
//
// Two failure modes are handled on purpose, because the naive version of this
// takes the game server down with the database:
//   * A failed flush puts its rows BACK, so a five-second Postgres wobble
//     costs nothing.
//   * The buffer is bounded. If the database is gone for long enough, the
//     oldest events are dropped and counted rather than growing until the
//     process runs out of memory. A degraded log beats a dead game.
//
// And one that is easy to miss: a single row Postgres will NEVER accept must
// not jam the queue for ever. Re-queueing blindly puts the same poison row at
// the head on every tick and the log stops moving. So the two kinds of failure
// are told apart by SQLSTATE — a data error bisects the batch until the bad row
// is alone and can be dropped; anything else is treated as the database being
// away and the whole batch is retried intact.
import { db } from "../db/client.js";
import { eventLog } from "../db/schema.js";
import { normaliseIp } from "./clientIp.js";

/** Types are a closed set so the console can filter on them without guessing,
 *  and so a typo becomes a compile error rather than a row nobody ever finds. */
export type EventType =
  | "auth.login"
  | "auth.username"
  | "session.start"
  | "session.end"
  // Connected the whole time, but not THERE: the page went quiet (minimised,
  // backgrounded, screen off) and then came back. Kept apart from start/end,
  // which are the connection itself — one player can go away and back several
  // times inside a single session.
  /** A microphone opened or closed — in a party, or inside a match. Says what
   *  was POSSIBLE to hear, which the audio itself cannot: a mic opened in
   *  silence leaves no recording, and a mic that was shut is an alibi. */
  | "voice.mic"
  | "session.away"
  | "session.back"
  | "session.rejected"
  | "match.created"
  | "match.joined"
  | "match.left"
  | "match.ended"
  /** A game taken away, and given back. Two sizes of the same act: the whole
   *  game held for everybody, or one player barred from one game.
   *
   *  These go in the ACTIVITY log as well as the admin audit trail, and the
   *  two are not interchangeable. The audit answers "what have the admins been
   *  doing"; the activity log answers "what happened to this player, and
   *  why" — and a player who suddenly cannot start a game is a question asked
   *  from that side, usually by a different person, often days later. */
  /** The platform going down, and coming back. In the activity log as well as
   *  the audit trail: "why did my match end at nine o'clock" is a question
   *  asked from the players' side. */
  | "platform.maintenance"
  | "event.create"
  | "event.delete"
  | "notice.send"
  | "notice.delete"
  | "game.hide"
  | "game.show"
  | "collection.withdraw"
  | "collection.restore"
  | "game.hold"
  | "game.release"
  | "game.ban"
  | "game.unban"
  | "sanction.applied"
  | "sanction.lifted"
  | "admin.login"
  | "ops.command"
  // Things a player DID, as opposed to things that happened to them. Only
  // actions that already reach the server are here: a tap that never leaves
  // the phone cannot be logged without sending a message that would not
  // otherwise exist, and that message is what costs a battery.
  | "profile.view"
  | "collection.equip"
  | "lobby.invite"
  /** A group came into being, with the id it will keep for its whole life.
   *  The one line that ties a party recording back to the person who started
   *  it — search the id and everything about that group is in front of you. */
  | "lobby.party"
  | "lobby.join"
  | "lobby.leave"
  | "lobby.kick"
  | "lobby.leader"
  | "lobby.pick"
  | "lobby.search"
  | "lobby.cancel"
  | "lobby.leave"
  | "lobby.mode"
  | "friend.request"
  | "friend.respond"
  /** A player said somebody spoiled their game, or that a sanction against
   *  them is wrong. In the activity log as well as the reports queue: a wave
   *  of complaints against one player at one moment is itself a signal, and
   *  it is unreadable afterwards if only the ones an admin acted on were
   *  written down. */
  | "report.filed"
  | "appeal.filed"
  /** What an admin did with them. */
  | "report.dismissed"
  | "case.opened"
  | "case.resolved"
  | "case.export"
  /** Money (P1). In the ACTIVITY log as well as the payment tables, because
   *  "I paid and got nothing" is a question asked from the player's side, at
   *  the player's timeline, often by somebody who has never opened the
   *  payments screen. `store.open` is a QR being put in front of somebody;
   *  `store.paid` is a bank SMS having settled it. */
  | "store.open"
  | "store.paid"
  /** …and the two things an admin can do to a balance without a payment. */
  | "payments.settings"
  | "payments.approve"
  | "payments.grant"
  /** A player spending what they earned or bought on something to wear. */
  | "collection.claim"
  | "pricing.set";

export interface EventInput {
  type: EventType;
  userId?: string | null;
  uid?: string | null;
  ip?: string | null;
  ipCountry?: string | null;
  ua?: string | null;
  deviceHash?: string | null;
  matchKey?: string | null;
  gameId?: string | null;
  lobbyId?: string | null;
  data?: Record<string, unknown>;
}

type Row = typeof eventLog.$inferInsert;

const FLUSH_MS = 2000;
/** Rows per INSERT. Large enough that a busy second is one statement, small
 *  enough that a retry after a failure is cheap. */
const MAX_BATCH = 500;
/** Roughly ten minutes of a very busy server. Past this the oldest go.
 *  Tunable because the right number depends on how much memory the process has
 *  to spare, and because the self-check needs a small one. */
const MAX_BUFFER = Math.max(10, Number(process.env.EVENT_LOG_MAX_BUFFER || 20_000));

let buffer: Row[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing = false;
let dropped = 0;
let written = 0;
let failures = 0;

/** Record something. Returns immediately; never awaits, never throws. */
export function logEvent(e: EventInput): void {
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    dropped++;
  }
  buffer.push({
    type: e.type,
    userId: e.userId ?? null,
    uid: e.uid ?? null,
    // Normalised here rather than at the call site so no caller can put a
    // value in that Postgres will reject and take 499 good rows down with.
    ip: normaliseIp(e.ip),
    ipCountry: e.ipCountry ?? null,
    ua: e.ua ?? null,
    deviceHash: e.deviceHash ?? null,
    matchKey: e.matchKey ?? null,
    gameId: e.gameId ?? null,
    lobbyId: e.lobbyId ?? null,
    data: e.data ?? {},
  });
}

/** Is this the data's fault rather than the connection's? SQLSTATE class 22 is
 *  a data exception (value too long, bad inet…) and 23 an integrity violation;
 *  both will fail identically for ever. Anything else — no code at all, a
 *  connection class — is the database being unavailable, which retrying fixes.
 *  Drizzle may wrap the driver error, so `cause` is checked too. */
function isRowFault(err: unknown): boolean {
  const code = ((err as { cause?: unknown })?.cause ?? err) as { code?: unknown };
  return typeof code?.code === "string" && (code.code.startsWith("22") || code.code.startsWith("23"));
}

/** Drain the buffer. Safe to call at any time; used by the timer, by tests,
 *  and once on shutdown so a restart does not lose the last two seconds. */
export async function flushEvents(): Promise<number> {
  if (flushing || buffer.length === 0) return 0;
  flushing = true;
  let total = 0;
  // Halved on a data fault so the retry is genuinely smaller — putting the same
  // rows back and taking the same number again is an infinite loop, which is
  // exactly what check:ops caught the first time this was written.
  let size = MAX_BATCH;
  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, size);
      try {
        await db.insert(eventLog).values(batch);
        written += batch.length;
        total += batch.length;
        size = MAX_BATCH; // healthy again
      } catch (err) {
        failures++;
        if (isRowFault(err)) {
          // Postgres will never accept something in this batch. Narrow the
          // window by half and try again; when it is down to one row, that row
          // is the offender and is dropped. Nine rounds isolates a bad row out
          // of five hundred, and the log keeps moving.
          if (batch.length === 1) {
            dropped++;
            size = MAX_BATCH;
            const why = (((err as { cause?: unknown }).cause ?? err) as { code?: string; message?: string });
            console.error(`[eventLog] dropped an unwritable "${batch[0].type}" event (${why.code}): ${why.message}`);
          } else {
            size = Math.ceil(batch.length / 2);
            buffer.unshift(...batch);
          }
          continue;
        }
        size = MAX_BATCH;
        // The database is away rather than offended. Keep every row, stop for
        // this round, retry on the next tick. Trimming from the front keeps
        // the bound while preferring the NEWEST events — those are the ones a
        // live incident is about.
        buffer.unshift(...batch);
        while (buffer.length > MAX_BUFFER) {
          buffer.shift();
          dropped++;
        }
        console.error(`[eventLog] flush failed (${buffer.length} buffered, ${dropped} dropped):`, err);
        break;
      }
    }
  } finally {
    flushing = false;
  }
  return total;
}

export function startEventLog(): void {
  if (timer) return;
  timer = setInterval(() => void flushEvents(), FLUSH_MS);
  // Never hold the process open for a log flush.
  timer.unref();
}

export function stopEventLog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For the ops snapshot and the self-check: is the writer keeping up? */
export function eventLogStats() {
  return { buffered: buffer.length, written, dropped, failures };
}

/** Thirty days, then it goes.
 *
 *  One rule for every kind of row, which is the choice that was made: it keeps
 *  the table small and the promise simple. Worth knowing what it costs — a
 *  sign-in record from four months ago is not there to produce if somebody
 *  asks for it later. Raising it is one number here.
 */
export const EVENT_RETENTION_DAYS = 30;

export async function sweepEventLog(limit = 5000): Promise<number> {
  const { db } = await import("../db/client.js");
  const { eventLog } = await import("../db/schema.js");
  const { sql, inArray } = await import("drizzle-orm");
  // Deleted in bounded batches: an unbounded DELETE on a table this size takes
  // a long lock, and this runs on the same timer as everything else.
  const due = await db
    .select({ id: eventLog.id })
    .from(eventLog)
    .where(sql`${eventLog.at} < now() - (${EVENT_RETENTION_DAYS} || ' days')::interval`)
    .limit(limit);
  if (due.length === 0) return 0;
  await db.delete(eventLog).where(inArray(eventLog.id, due.map((d) => d.id)));
  console.log(`✔ Swept ${due.length} activity row(s) past ${EVENT_RETENTION_DAYS} days`);
  return due.length;
}
