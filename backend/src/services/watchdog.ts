// The things you would want to know within minutes.
//
// The console already alerts on admin ACCOUNT events — a sign-in, a refused
// one, a recovery code. Those are about whoever is holding the keys. This is
// about the platform itself, and it is the other half of the same argument: an
// admin panel you have to remember to open is one you will not open.
//
// Four watches, chosen because each one is invisible until somebody complains:
//
//   report spike     — twenty reports in an hour is either a brigade or a bug
//   ban wave         — sanctions landing far faster than usual, which is what
//                      a compromised console looks like from the outside
//   matchmaker starving — parties waiting with nothing to match them against
//   error rate       — refused connections climbing, which is how a bad deploy
//                      announces itself before anybody files a ticket
//
// EVERY WATCH LATCHES. An alert that repeats every cycle while a condition
// holds trains you to mute the channel, and a muted channel is worse than no
// channel — so each one fires on the way IN and stays quiet until the
// condition clears.
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { alert } from "../admin/alerts.js";
import { redis } from "../redis.js";

export interface Thresholds {
  reportsPerHour: number;
  sanctionsPerHour: number;
  /** Parties waiting, with no match having started, for this many minutes. */
  queueStarvedMin: number;
  rejectedPerHour: number;
}

export const DEFAULTS: Thresholds = {
  reportsPerHour: 20,
  sanctionsPerHour: 10,
  queueStarvedMin: 10,
  rejectedPerHour: 50,
};

/** What is currently firing. Latching lives here rather than in Redis on
 *  purpose: a restart SHOULD re-announce a condition that is still true,
 *  because a restart is exactly when somebody wants to know. */
const firing = new Set<string>();

/** One pass. Exported so a check can run it without a timer. */
export async function sweepWatchdog(t: Thresholds = DEFAULTS): Promise<string[]> {
  const fired: string[] = [];

  const latch = (key: string, on: boolean, message: string) => {
    if (on && !firing.has(key)) {
      firing.add(key);
      fired.push(key);
      alert(message);
    } else if (!on) {
      firing.delete(key);
    }
  };

  try {
    const res = await db.execute(sql`
      select
        (select count(*)::int from reports where created_at > now() - interval '1 hour') as reports,
        (select count(*)::int from sanctions where created_at > now() - interval '1 hour') as sanctions,
        (select count(*)::int from event_log
          where type = 'session.rejected' and at > now() - interval '1 hour') as rejected`);
    const row = (res.rows[0] ?? {}) as Record<string, unknown>;
    const reports = Number(row.reports ?? 0);
    const sanctions = Number(row.sanctions ?? 0);
    const rejected = Number(row.rejected ?? 0);

    latch(
      "reports",
      reports >= t.reportsPerHour,
      `📣 TOFO: ${reports} reports in the last hour (threshold ${t.reportsPerHour}). Either something is being brigaded or something is broken.`
    );
    latch(
      "sanctions",
      sanctions >= t.sanctionsPerHour,
      `🚨 TOFO: ${sanctions} sanctions applied in the last hour (threshold ${t.sanctionsPerHour}). If that was not you, the console is compromised.`
    );
    latch(
      "rejected",
      rejected >= t.rejectedPerHour,
      `⚠️ TOFO: ${rejected} refused connections in the last hour (threshold ${t.rejectedPerHour}). Check the last deploy.`
    );
  } catch (err) {
    console.error("[watchdog] database sweep failed:", err);
  }

  // The matchmaker, from the live snapshots the game processes publish. READ
  // rather than asked: the console must never call into the game process, and
  // the snapshot keys carry a TTL, so a crashed process simply stops appearing
  // instead of being counted as a healthy one with an empty queue.
  try {
    let cursor = "0";
    let queued = 0;
    let running = 0;
    let fresh = false;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ops:live:*", "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        if (key.startsWith("ops:live:matches:")) continue;
        const h = await redis.hgetall(key);
        if (!h.instanceId || (h.role ?? "game") !== "game") continue;
        if (Date.now() - Number(h.ts ?? 0) > 30_000) continue;
        fresh = true;
        running += Number(h.matches ?? 0) || 0;
        try {
          queued += Object.values(JSON.parse(h.queue ?? "{}") as Record<string, number>).reduce(
            (n, v) => n + Number(v || 0),
            0
          );
        } catch {
          /* a snapshot we cannot parse is one we do not count */
        }
      }
    } while (cursor !== "0");
    // Parties waiting while nothing is running, from a snapshot recent enough
    // to believe. A stale snapshot means the game process is gone, which is a
    // different alarm and not this one's to raise.
    starvedSince = queued > 0 && running === 0 && fresh ? (starvedSince ?? Date.now()) : null;
    const starvedFor = starvedSince ? (Date.now() - starvedSince) / 60_000 : 0;
    latch(
      "queue",
      starvedFor >= t.queueStarvedMin,
      `⏳ TOFO: ${queued} part(ies) have been waiting ${Math.round(starvedFor)} minutes with no match running. The matchmaker may be starved.`
    );
  } catch (err) {
    console.error("[watchdog] snapshot read failed:", err);
  }

  return fired;
}

let starvedSince: number | null = null;
let timer: NodeJS.Timeout | null = null;

export function startWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => void sweepWatchdog().catch(() => {}), 5 * 60_000);
  timer.unref?.();
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
  firing.clear();
  starvedSince = null;
}

/** For the check harness: forget what is currently firing. */
export function resetWatchdog(): void {
  firing.clear();
  starvedSince = null;
}
