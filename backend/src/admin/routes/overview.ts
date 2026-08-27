// The first screen: is anything on fire, and how big is this thing.
//
// Two sources, and the split is the whole performance story. The numbers about
// RIGHT NOW come from the snapshot the game process writes to Redis every two
// seconds — reading them costs the game nothing, and there is no request from
// the console to the game server at all. The numbers about the WHOLE PLATFORM
// come from Postgres, cached briefly, because a dashboard that is refreshed
// every few seconds must not run count(*) over the users table each time.
import { safeRouter } from "../asyncRouter.js";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { matches, users } from "../../db/schema.js";
import { redis } from "../../redis.js";
import { requireAdmin } from "../guard.js";

export const overviewRouter = safeRouter();

/** Long enough that hammering refresh costs one query, short enough that the
 *  numbers still feel live. */
const TOTALS_TTL_MS = 15_000;
let totalsCache: { at: number; value: Totals } | null = null;

interface Totals {
  players: number;
  newToday: number;
  matchesToday: number;
  matchesByGameToday: Record<string, number>;
}

async function totals(): Promise<Totals> {
  if (totalsCache && Date.now() - totalsCache.at < TOTALS_TTL_MS) return totalsCache.value;
  const [[people], [fresh], byGame] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(users),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(sql`${users.createdAt} >= date_trunc('day', now())`),
    db
      .select({ gameId: matches.gameId, n: sql<number>`count(*)::int` })
      .from(matches)
      .where(sql`${matches.createdAt} >= date_trunc('day', now())`)
      .groupBy(matches.gameId),
  ]);
  const matchesByGameToday: Record<string, number> = {};
  for (const row of byGame) matchesByGameToday[row.gameId] = row.n;
  const value: Totals = {
    players: people.n,
    newToday: fresh.n,
    matchesToday: byGame.reduce((sum, r) => sum + r.n, 0),
    matchesByGameToday,
  };
  totalsCache = { at: Date.now(), value };
  return value;
}

export interface InstanceView {
  instanceId: string;
  role: string;
  pid: number;
  uptimeSec: number;
  rssMb: number;
  sockets: number;
  online: number;
  matches: number;
  matchPlayers: number;
  matchBots: number;
  matchesByGame: Record<string, number>;
  queue: Record<string, number>;
  eventLog: { buffered: number; written: number; dropped: number; failures: number };
  /** How old this snapshot is. Anything more than a few seconds means the
   *  process stopped writing, which is worth seeing rather than smoothing over. */
  ageMs: number;
}

/** Every game server currently publishing. The keys carry a TTL, so a crashed
 *  process simply stops appearing instead of being reported as healthy. */
async function instances(): Promise<InstanceView[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "ops:live:*", "COUNT", 100);
    cursor = next;
    // Only the per-instance HASH is an instance. The two per-instance STRING
    // keys published alongside it (live matches, live islands) share the
    // prefix, and HGETALL against a string is an error that would take the
    // whole overview down.
    for (const k of keys) {
      if (k.startsWith("ops:live:matches:") || k.startsWith("ops:live:islands:")) continue;
      found.push(k);
    }
  } while (cursor !== "0");

  const out: InstanceView[] = [];
  for (const key of found) {
    const h = await redis.hgetall(key);
    if (!h.instanceId) continue;
    const num = (v: string | undefined) => Number(v ?? 0) || 0;
    const json = <T>(v: string | undefined, fallback: T): T => {
      try {
        return v ? (JSON.parse(v) as T) : fallback;
      } catch {
        return fallback;
      }
    };
    out.push({
      instanceId: h.instanceId,
      role: h.role ?? "game",
      pid: num(h.pid),
      uptimeSec: num(h.uptimeSec),
      rssMb: num(h.rssMb),
      sockets: num(h.sockets),
      online: num(h.online),
      matches: num(h.matches),
      matchPlayers: num(h.matchPlayers),
      matchBots: num(h.matchBots),
      matchesByGame: json(h.matchesByGame, {} as Record<string, number>),
      queue: json(h.queue, {} as Record<string, number>),
      eventLog: json(h.eventLog, { buffered: 0, written: 0, dropped: 0, failures: 0 }),
      ageMs: Date.now() - num(h.ts),
    });
  }
  return out.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
}

overviewRouter.get("/", requireAdmin("analyst"), async (_req, res) => {
  const [t, live] = await Promise.all([totals(), instances()]);
  const sum = (pick: (i: InstanceView) => number) => live.reduce((n, i) => n + pick(i), 0);
  res.json({
    totals: t,
    live: {
      online: sum((i) => i.online),
      matches: sum((i) => i.matches),
      matchPlayers: sum((i) => i.matchPlayers),
      matchBots: sum((i) => i.matchBots),
      queued: live.reduce((n, i) => n + Object.values(i.queue).reduce((a, b) => a + b, 0), 0),
      // No game server publishing at all is a headline, not a blank panel.
      instancesUp: live.filter((i) => i.role === "game").length,
    },
    instances: live,
    at: Date.now(),
  });
});

/** The live match list from every instance, for the matches screen (A2) and
 *  for knowing which instance to address a command to. */
overviewRouter.get("/matches", requireAdmin("moderator"), async (_req, res) => {
  const out: unknown[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "ops:live:matches:*", "COUNT", 100);
    cursor = next;
    for (const k of keys) {
      const raw = await redis.get(k);
      const instanceId = k.slice("ops:live:matches:".length);
      try {
        for (const m of JSON.parse(raw ?? "[]") as Record<string, unknown>[]) out.push({ ...m, instanceId });
      } catch {
        /* a half-written snapshot is not worth failing the screen for */
      }
    }
  } while (cursor !== "0");
  res.json({ matches: out });
});
