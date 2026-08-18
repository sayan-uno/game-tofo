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
  | "session.rejected"
  | "match.created"
  | "match.joined"
  | "match.left"
  | "match.ended"
  | "sanction.applied"
  | "sanction.lifted"
  | "admin.login"
  | "ops.command";

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
