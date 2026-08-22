// The live snapshot the admin console reads.
//
// The console runs in a different process and cannot see this one's memory, so
// the game server publishes a small picture of itself to Redis on a timer.
// That is the entire coupling: the console never calls in, never holds a
// connection open, and cannot occupy the event loop that serves player inputs.
//
// Cost: one MULTI every two seconds. Nothing per player, nothing per event.
//
// Keys carry the instance id and a TTL a few ticks long, so a crashed process
// disappears from the console by itself instead of being reported as healthy
// for ever.
import type { Server } from "socket.io";
import { config } from "../config.js";
import { redis, countOnline } from "../redis.js";
import { eventLogStats } from "../services/eventLog.js";
import { listGames } from "./games.js";
import { liveMatchSnapshot } from "./match.js";
import { poolDepth, poolKeyFor } from "./matchmaking.js";
import { evidenceBackend } from "./evidence.js";
import { replayStats } from "./replay.js";

const SNAPSHOT_MS = 2000;
/** Comfortably more than two ticks, so one slow write does not make a healthy
 *  server blink out of the console. */
const SNAPSHOT_TTL_SEC = 8;

export const liveKey = (instanceId: string) => `ops:live:${instanceId}`;
export const liveMatchesKey = (instanceId: string) => `ops:live:matches:${instanceId}`;

let timer: NodeJS.Timeout | null = null;
const startedAt = Date.now();

/** Every distinct match size this build can produce, per game — that is one
 *  matchmaking pool each. */
function pools(): { gameId: string; size: number }[] {
  const out: { gameId: string; size: number }[] = [];
  for (const game of listGames()) {
    const sizes = new Set<number>();
    for (const mode of ["solo", "duo", "squad"] as const) sizes.add(poolKeyFor(game, mode));
    for (const size of sizes) out.push({ gameId: game.id, size });
  }
  return out;
}

async function writeSnapshot(io: Server): Promise<void> {
  const live = liveMatchSnapshot();
  const byGame: Record<string, number> = {};
  let humans = 0;
  let bots = 0;
  for (const m of live) {
    byGame[m.gameId] = (byGame[m.gameId] ?? 0) + 1;
    humans += m.players;
    bots += m.bots;
  }

  const queue: Record<string, number> = {};
  for (const p of pools()) {
    const depth = await poolDepth(p.gameId, p.size);
    if (depth > 0) queue[`${p.gameId}:${p.size}`] = depth;
  }

  const snapshot: Record<string, string> = {
    ts: String(Date.now()),
    instanceId: config.instanceId,
    role: config.role,
    pid: String(process.pid),
    uptimeSec: String(Math.round((Date.now() - startedAt) / 1000)),
    sockets: String(io.sockets.sockets.size),
    online: String(await countOnline()),
    matches: String(live.length),
    matchPlayers: String(humans),
    matchBots: String(bots),
    matchesByGame: JSON.stringify(byGame),
    queue: JSON.stringify(queue),
    eventLog: JSON.stringify(eventLogStats()),
    // Surfaced rather than left in a boot log: replays going to a container's
    // temporary disk look fine until the day somebody needs one.
    evidence: evidenceBackend(),
    replay: JSON.stringify(replayStats()),
    rssMb: String(Math.round(process.memoryUsage().rss / 1048576)),
  };

  // Once a minute, the same numbers go into Postgres as well. The live
  // snapshot answers "what is happening"; this answers "what WAS happening" —
  // and, because a minute with no row is a minute nothing was written, it is
  // also the only record of an outage that happened while nobody was watching.
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== lastHistoryMinute) {
    lastHistoryMinute = minute;
    void writeHistory(snapshot, queue).catch((err) => console.error("[ops] history:", err));
  }

  await redis
    .multi()
    .hset(liveKey(config.instanceId), snapshot)
    .expire(liveKey(config.instanceId), SNAPSHOT_TTL_SEC)
    .set(liveMatchesKey(config.instanceId), JSON.stringify(live), "EX", SNAPSHOT_TTL_SEC)
    .exec();
}

export function startOpsSnapshot(io: Server): void {
  if (timer) return;
  const tick = () => {
    // A snapshot failure is never allowed to matter: it is telemetry, and the
    // console showing a stale number beats the game server logging an unhandled
    // rejection every two seconds.
    void writeSnapshot(io).catch((err) => console.error("[ops] snapshot failed:", err));
  };
  tick();
  timer = setInterval(tick, SNAPSHOT_MS);
  timer.unref();
}

export function stopOpsSnapshot(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Used by the self-check, and by the console when it wants one fresh read
 *  rather than whatever the last tick left. */
export const writeSnapshotNow = writeSnapshot;

/** The minute whose row has already been written, so a two-second snapshot
 *  writes one row a minute rather than thirty. */
let lastHistoryMinute = 0;

async function writeHistory(snapshot: Record<string, string>, queue: Record<string, number>): Promise<void> {
  const { db } = await import("../db/client.js");
  const { platformHistory } = await import("../db/schema.js");
  await db
    .insert(platformHistory)
    .values({
      at: new Date(Math.floor(Date.now() / 60_000) * 60_000),
      instance: config.instanceId,
      online: Number(snapshot.online),
      sockets: Number(snapshot.sockets),
      matches: Number(snapshot.matches),
      matchPlayers: Number(snapshot.matchPlayers),
      matchBots: Number(snapshot.matchBots),
      queued: Object.values(queue).reduce((n, v) => n + v, 0),
      rssMb: Number(snapshot.rssMb),
      byGame: JSON.parse(snapshot.matchesByGame) as Record<string, number>,
    })
    // Two snapshots in the same minute (a restart, a clock nudge) must not be
    // an error: the first one written is the one that stands.
    .onConflictDoNothing();
}

/** Thirty days of minutes, then they go — the same rule as everything else. */
export async function sweepHistory(): Promise<number> {
  const { db } = await import("../db/client.js");
  const { platformHistory } = await import("../db/schema.js");
  const { sql } = await import("drizzle-orm");
  const gone = await db
    .delete(platformHistory)
    .where(sql`${platformHistory.at} < now() - interval '30 days'`)
    .returning({ id: platformHistory.id });
  if (gone.length > 0) console.log(`✔ Swept ${gone.length} minute(s) of platform history`);
  return gone.length;
}
