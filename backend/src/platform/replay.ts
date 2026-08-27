// Archiving a finished match so it can be watched again.
//
// The whole feature rests on one property of this platform: a match is
// COMPLETELY described by its game, its seed, its roster and the list of
// {tick, kind} inputs. Everything else — every position, every crash, every
// die, every token that went home — is derived from those by a simulation both
// sides already run. So there is nothing to capture. There is only a
// serialization of what the match runtime is already holding.
//
// That is why this costs a player nothing. It runs after the results have gone
// out, it is never awaited by anything a player is waiting for, and the input
// arrays it reads were kept for the end-of-match ranking anyway.
//
// Two rules shape the format:
//
//   EXACTLY REVERSIBLE. The file must rebuild the same RankMember[] the server
//   ranked from — same inputs, same ORDER, per runner. Anything less and a
//   replay is a plausible reconstruction rather than the match. tools/checks/
//   replay.mts proves it by re-ranking a decoded file and comparing.
//
//   SMALL. Kinds are interned into a dictionary and the inputs travel as three
//   parallel arrays rather than a list of objects, then the whole thing is
//   gzipped. A Trackline match lands around a kilobyte; Ludo, which logs a
//   server-authored input for every die and every move across three hundred
//   turns, lands nearer five.
import { gunzipSync, gzipSync } from "node:zlib";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { matchReplays, recordingTargets } from "../db/schema.js";
import { redis } from "../redis.js";
import type { MatchEndReason, MatchInput, Standing } from "../shared/core/protocol.js";
import type { RankMember } from "./games.js";
import { deleteEvidence, describeEvidence, putEvidence } from "./evidence.js";

export const REPLAY_FORMAT = 1;

/** standard — every match. extended — a flagged player was in it.
 *  hold — attached to an open case; never swept. */
export type ReplayTier = "standard" | "extended" | "hold";
const RETENTION_DAYS: Record<ReplayTier, number | null> = { standard: 30, extended: 365, hold: null };

export interface ReplayRosterEntry {
  uid: string;
  seat: number;
  name: string;
  character: string;
  weapon: string | null;
  isBot: boolean;
  /** null for bots. Present only in the archive, never on a client. */
  userId: string | null;
  left: boolean;
  leftAtTick: number | null;
  /** When they ARRIVED, for a world whose roster changed while it ran.
   *
   *  A match has no use for it — everybody is there from tick zero — so it is
   *  optional and absent from every file the five older games write. A drop-in
   *  world cannot do without it: its seats are occupancies, one per person per
   *  visit, and a viewer scrubbing to minute two should not see somebody who
   *  turned up at minute thirty. */
  joinedAtTick?: number;
}

export interface ReplayFile {
  v: number;
  matchKey: string;
  gameId: string;
  seed: number;
  tickRate: number;
  durationTicks: number;
  createdAt: number;
  startAt: number | null;
  endedAt: number;
  reason: MatchEndReason;
  endTick: number;
  roster: ReplayRosterEntry[];
  /** The kind dictionary. Inputs reference it by index. */
  kinds: string[];
  /** Three parallel arrays, grouped by seat in the ORDER the runtime held
   *  them. Grouping is what makes decoding exact rather than merely faithful. */
  inputs: { seat: number[]; tick: number[]; kind: number[] };
  /** The chat wheel. Not an input — it changes nothing — but it is the only
   *  thing players SAY during a match, so it is the whole record of that. */
  quick: { tick: number[]; seat: number[]; kind: number[]; id: string[] };
  standings: Standing[];
  xp: Record<string, number>;
}

export interface QuickLogEntry {
  tick: number;
  seat: number;
  kind: "chat" | "emote";
  id: string;
}

export interface EncodeInput {
  matchKey: string;
  gameId: string;
  seed: number;
  tickRate: number;
  durationTicks: number;
  createdAt: number;
  startAt: number | null;
  endedAt: number;
  reason: MatchEndReason;
  endTick: number;
  roster: ReplayRosterEntry[];
  inputsBySeat: Map<number, MatchInput[]>;
  quick: QuickLogEntry[];
  standings: Standing[];
  xp: Record<string, number>;
}

export function encodeReplay(input: EncodeInput): ReplayFile {
  const kinds: string[] = [];
  const kindIndex = new Map<string, number>();
  const intern = (k: string): number => {
    let i = kindIndex.get(k);
    if (i === undefined) {
      i = kinds.length;
      kinds.push(k);
      kindIndex.set(k, i);
    }
    return i;
  };

  const seat: number[] = [];
  const tick: number[] = [];
  const kind: number[] = [];
  // Seat order, and within a seat the runtime's own order — see the header.
  for (const entry of [...input.roster].sort((a, b) => a.seat - b.seat)) {
    for (const i of input.inputsBySeat.get(entry.seat) ?? []) {
      seat.push(entry.seat);
      tick.push(i.tick);
      kind.push(intern(i.kind));
    }
  }

  return {
    v: REPLAY_FORMAT,
    matchKey: input.matchKey,
    gameId: input.gameId,
    seed: input.seed,
    tickRate: input.tickRate,
    durationTicks: input.durationTicks,
    createdAt: input.createdAt,
    startAt: input.startAt,
    endedAt: input.endedAt,
    reason: input.reason,
    endTick: input.endTick,
    roster: input.roster,
    kinds,
    inputs: { seat, tick, kind },
    quick: {
      tick: input.quick.map((q) => q.tick),
      seat: input.quick.map((q) => q.seat),
      kind: input.quick.map((q) => (q.kind === "chat" ? 0 : 1)),
      id: input.quick.map((q) => q.id),
    },
    standings: input.standings,
    xp: input.xp,
  };
}

/** Rebuild exactly what the server ranked from. The whole point of the format
 *  is that this is lossless, which tools/checks/replay.mts checks by re-ranking
 *  the result and comparing it to the standings stored alongside. */
export function toRankMembers(file: ReplayFile): RankMember[] {
  const bySeat = new Map<number, MatchInput[]>();
  for (let i = 0; i < file.inputs.seat.length; i++) {
    const s = file.inputs.seat[i];
    let list = bySeat.get(s);
    if (!list) bySeat.set(s, (list = []));
    list.push({ tick: file.inputs.tick[i], kind: file.kinds[file.inputs.kind[i]] });
  }
  return [...file.roster]
    .sort((a, b) => a.seat - b.seat)
    .map((r) => ({
      uid: r.uid,
      name: r.name,
      seat: r.seat,
      inputs: bySeat.get(r.seat) ?? [],
      left: r.left,
      leftAtTick: r.leftAtTick,
      isBot: r.isBot,
    }));
}

export const packReplay = (file: ReplayFile): Buffer => gzipSync(Buffer.from(JSON.stringify(file), "utf8"));
export const unpackReplay = (bytes: Buffer): ReplayFile => JSON.parse(gunzipSync(bytes).toString("utf8")) as ReplayFile;

export const replayKey = (matchKey: string, at: number): string => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  // Dated folders so a bucket listing is navigable and a day can be swept or
  // exported as a unit.
  return `replays/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${matchKey}.json.gz`;
};

// ---------------------------------------------------------------------------
// Which players' matches are kept longer
// ---------------------------------------------------------------------------

const EXTENDED_SET = "rec:replay";

/** Rebuilt at boot from the record, for the same reason the ban cache is: a
 *  flushed Redis must not silently downgrade everyone's retention. */
export async function warmReplayTargets(): Promise<number> {
  const rows = await db
    .selectDistinct({ userId: recordingTargets.userId })
    .from(recordingTargets)
    .where(
      and(
        eq(recordingTargets.kind, "replay-extended"),
        isNull(recordingTargets.revokedAt),
        gt(recordingTargets.expiresAt, sql`now()`)
      )
    );
  await redis.del(EXTENDED_SET);
  if (rows.length > 0) await redis.sadd(EXTENDED_SET, ...rows.map((r) => r.userId));
  return rows.length;
}

/** One Redis round trip against a set that is empty for almost every match. */
export async function tierFor(userIds: string[]): Promise<ReplayTier> {
  if (userIds.length === 0) return "standard";
  try {
    const flags = await redis.smismember(EXTENDED_SET, ...userIds);
    return flags.some((f) => f === 1) ? "extended" : "standard";
  } catch {
    return "standard";
  }
}

export const expiryFor = (tier: ReplayTier, at: number): Date | null => {
  const days = RETENTION_DAYS[tier];
  return days === null ? null : new Date(at + days * 86_400_000);
};

// ---------------------------------------------------------------------------
// The queue: match end pushes, a worker drains
// ---------------------------------------------------------------------------

const QUEUE = "replay:queue";
/** After this many failures the entry is dropped and counted rather than
 *  retried for ever — one unwritable replay must not stop every later one. */
const MAX_ATTEMPTS = 5;
const DRAIN_MS = 3000;

interface QueueEntry {
  matchKey: string;
  gameId: string;
  tier: ReplayTier;
  key: string;
  expiresAt: string | null;
  bytes: string;
  attempt: number;
}

let stats = { archived: 0, failed: 0, dropped: 0 };
export const replayStats = () => ({ ...stats });

/** Called from the match runtime, never awaited. */
export async function queueReplay(file: ReplayFile, tier: ReplayTier): Promise<void> {
  const packed = packReplay(file);
  const key = replayKey(file.matchKey, file.endedAt);
  const entry: QueueEntry = {
    matchKey: file.matchKey,
    gameId: file.gameId,
    tier,
    key,
    expiresAt: expiryFor(tier, file.endedAt)?.toISOString() ?? null,
    bytes: packed.toString("base64"),
    attempt: 0,
  };
  await redis.lpush(QUEUE, JSON.stringify(entry));
}

async function drainOnce(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const raw = await redis.rpop(QUEUE);
    if (!raw) return;
    let entry: QueueEntry;
    try {
      entry = JSON.parse(raw) as QueueEntry;
    } catch {
      stats.dropped++;
      continue;
    }
    try {
      const body = Buffer.from(entry.bytes, "base64");
      await putEvidence(entry.key, body, "application/gzip");
      await db
        .insert(matchReplays)
        .values({
          matchKey: entry.matchKey,
          gameId: entry.gameId,
          r2Key: entry.key,
          bytes: body.length,
          formatVersion: REPLAY_FORMAT,
          tier: entry.tier,
          expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : null,
        })
        // A retry after a partial success must not fail on the primary key.
        .onConflictDoNothing({ target: matchReplays.matchKey });
      stats.archived++;
    } catch (err) {
      stats.failed++;
      entry.attempt++;
      if (entry.attempt >= MAX_ATTEMPTS) {
        stats.dropped++;
        console.error(`[replay] giving up on ${entry.matchKey} after ${entry.attempt} attempts:`, err);
      } else {
        // Back onto the head, so it is retried before newer ones rather than
        // after every match played since.
        await redis.rpush(QUEUE, JSON.stringify(entry));
        console.error(`[replay] ${entry.matchKey} failed (attempt ${entry.attempt}):`, err);
      }
      return; // stop this round; the next tick tries again
    }
  }
}

let drainTimer: NodeJS.Timeout | null = null;
export function startReplayWorker(): void {
  if (drainTimer) return;
  console.log(`✔ Replay archive → ${describeEvidence()}`);
  drainTimer = setInterval(() => void drainOnce().catch((e) => console.error("[replay] drain:", e)), DRAIN_MS);
  drainTimer.unref();
}
export function stopReplayWorker(): void {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}
/** For the self-check and for a clean shutdown. */
export const drainReplays = drainOnce;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const SWEEP_MS = 6 * 3600_000;

/** Delete what has expired, by tier and expiry only — never by hand, so no one
 *  can quietly remove an inconvenient match. */
export async function sweepReplays(limit = 500): Promise<number> {
  const due = await db
    .select({ matchKey: matchReplays.matchKey, key: matchReplays.r2Key })
    .from(matchReplays)
    .where(and(sql`${matchReplays.expiresAt} is not null`, lte(matchReplays.expiresAt, sql`now()`)))
    .limit(limit);
  if (due.length === 0) return 0;
  await deleteEvidence(due.map((d) => d.key));
  for (const d of due) await db.delete(matchReplays).where(eq(matchReplays.matchKey, d.matchKey));
  console.log(`✔ Swept ${due.length} expired replay(s)`);
  return due.length;
}

let sweepTimer: NodeJS.Timeout | null = null;
export function startReplaySweeper(): void {
  if (sweepTimer) return;
  // One timer for both: replays and voice recordings expire the same way and
  // there is no reason for two schedules to drift apart.
  sweepTimer = setInterval(() => {
    void sweepReplays().catch((e) => console.error("[replay] sweep:", e));
    void import("./voiceRecording.js")
      .then(async (m) => {
        await m.sweepVoice();
        // …and anything in the bucket that no row points at, which retention
        // by expiry date can never reach.
        await m.sweepOrphanAudio();
        const party = await import("./partyLog.js");
        await party.sweepParties();
        const ops = await import("./ops.js");
        await ops.sweepHistory();
        const log = await import("../services/eventLog.js");
        await log.sweepEventLog();
      })
      .catch((e) => console.error("[voice] sweep:", e));
  }, SWEEP_MS);
  sweepTimer.unref();
}
export function stopReplaySweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
