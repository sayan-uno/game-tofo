// Analytics, anti-cheat signals, and the alt-account graph.
//
// ONE RULE ABOVE ALL: THE DASHBOARD NEVER READS THE RAW LOG. A screen that
// scans event_log gets slower every week and eventually competes for the
// database with the thing it is measuring. So a nightly job writes one row per
// day, and every chart in the console reads those rows — a few hundred of
// them, forever.
//
// The signals and the alt graph are different: they are investigative, opened
// deliberately, one player at a time or one ranked list a day. Those DO read
// the real tables, bounded by a window and a limit, because a stale answer to
// "who is worth watching" is worse than a slow one.
//
// Written as explicit SQL rather than a query builder because every one of
// these is a correlated aggregate, and the table names are qualified in full
// on purpose — an unqualified column inside a subquery binds to the inner
// table first, which is how a count silently returns zero for ever.
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { suspicion, type PlayerSignals, type Suspicion } from "../platform/signals.js";

/** How far back the nightly job rewrites. Yesterday's numbers can still move —
 *  a session that ended after midnight, a match written late — and a cohort
 *  gains its d1 tomorrow and its d30 next month. Cheap to redo, expensive to
 *  get quietly wrong. */
const BACKFILL_DAYS = 3;
const COHORT_DAYS = 35;

const rows = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => {
  const out = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_, i) => lit(params[Number(i) - 1]))));
  return out.rows as T[];
};

/** Values here are days and integers this module computes itself — never user
 *  input — but they still go through a literal-writer rather than string
 *  concatenation, because "never user input" is a property that decays. */
function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.trunc(v)) : "null";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

// ─── The nightly aggregate ──────────────────────────────────────────────────

/** Rebuild one day. Idempotent: running it twice writes the same row. */
export async function aggregateDay(day: Date): Promise<void> {
  const from = `${dayKey(day)}T00:00:00Z`;
  const to = `${dayKey(new Date(day.getTime() + 86_400_000))}T00:00:00Z`;

  const [live] = await rows<{ dau: number; mau: number }>(
    `select
       (select count(distinct user_id)::int from event_log
          where at >= $1 and at < $2 and user_id is not null) as dau,
       (select count(distinct user_id)::int from event_log
          where at >= ($2::timestamptz - interval '30 days') and at < $2 and user_id is not null) as mau`,
    from,
    to
  );

  // The signup funnel is about the people who ARRIVED that day, followed
  // forwards — not about everybody who was around. Where they fall out is the
  // one question a totals dashboard cannot answer.
  const [funnel] = await rows<{ n: number; named: number; played: number }>(
    `select count(*)::int as n,
            count(*) filter (where u.username is not null)::int as named,
            count(*) filter (where exists (
              select 1 from match_players mp where mp.user_id = u.id
            ))::int as played
       from users u
      where u.created_at >= $1 and u.created_at < $2`,
    from,
    to
  );

  const games = await rows<{ game_id: string; n: number }>(
    `select game_id, count(*)::int as n from matches
      where created_at >= $1 and created_at < $2 group by game_id`,
    from,
    to
  );

  const [misc] = await rows<{ matches: number; session: number; reports: number; sanctions: number }>(
    `select
       (select count(*)::int from matches where created_at >= $1 and created_at < $2) as matches,
       (select coalesce(avg(nullif(data->>'seconds','')::int), 0)::int from event_log
          where type = 'session.end' and at >= $1 and at < $2) as session,
       (select count(*)::int from reports where created_at >= $1 and created_at < $2) as reports,
       (select count(*)::int from sanctions where created_at >= $1 and created_at < $2) as sanctions`,
    from,
    to
  );

  const byGame = Object.fromEntries(games.map((g) => [g.game_id, Number(g.n)]));
  await rows(
    `insert into daily_stats
       (day, dau, mau, new_accounts, matches, matches_by_game, avg_session_sec,
        funnel_signed_in, funnel_named, funnel_played, reports, sanctions, computed_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, now())
     on conflict (day) do update set
       dau = excluded.dau, mau = excluded.mau, new_accounts = excluded.new_accounts,
       matches = excluded.matches, matches_by_game = excluded.matches_by_game,
       avg_session_sec = excluded.avg_session_sec,
       funnel_signed_in = excluded.funnel_signed_in, funnel_named = excluded.funnel_named,
       funnel_played = excluded.funnel_played, reports = excluded.reports,
       sanctions = excluded.sanctions, computed_at = now()`,
    dayKey(day),
    Number(live?.dau ?? 0),
    Number(live?.mau ?? 0),
    Number(funnel?.n ?? 0),
    Number(misc?.matches ?? 0),
    JSON.stringify(byGame),
    Number(misc?.session ?? 0),
    Number(funnel?.n ?? 0),
    Number(funnel?.named ?? 0),
    Number(funnel?.played ?? 0),
    Number(misc?.reports ?? 0),
    Number(misc?.sanctions ?? 0)
  );
}

/**
 * Retention, by the day people arrived.
 *
 * "Came back on day N" means EXACTLY day N, not "within N days" — the standard
 * definition, and the one worth having: within-N is monotonic and flatters
 * itself, so it can only ever look like it is going up.
 */
export async function refreshCohorts(days = COHORT_DAYS): Promise<void> {
  await rows(
    `insert into cohorts (day, size, d1, d7, d30, computed_at)
     select c.day::date,
            count(*)::int,
            count(*) filter (where exists (
              select 1 from event_log e
               where e.user_id = c.id
                 and e.at >= c.day + interval '1 day' and e.at < c.day + interval '2 days'))::int,
            count(*) filter (where exists (
              select 1 from event_log e
               where e.user_id = c.id
                 and e.at >= c.day + interval '7 days' and e.at < c.day + interval '8 days'))::int,
            count(*) filter (where exists (
              select 1 from event_log e
               where e.user_id = c.id
                 and e.at >= c.day + interval '30 days' and e.at < c.day + interval '31 days'))::int,
            now()
       from (select id, date_trunc('day', created_at) as day from users
              where created_at >= now() - interval '$1 days') c
      group by c.day
     on conflict (day) do update set
       size = excluded.size, d1 = excluded.d1, d7 = excluded.d7, d30 = excluded.d30,
       computed_at = now()`.replace("'$1 days'", `'${Math.trunc(days)} days'`)
  );
}

/** Yesterday, today so far, and the trailing cohorts. */
export async function runNightly(): Promise<void> {
  const now = new Date();
  for (let i = 0; i < BACKFILL_DAYS; i++) {
    await aggregateDay(new Date(now.getTime() - i * 86_400_000));
  }
  await refreshCohorts();
}

let timer: NodeJS.Timeout | null = null;

/** Hourly rather than nightly, deliberately: "yesterday" is only right after
 *  midnight in one timezone, and an hourly rebuild of three days costs a
 *  handful of aggregate queries against tables with indexes on the columns it
 *  groups by. It also means today's row exists to look at today. */
export function startAnalytics(): void {
  if (timer) return;
  const tick = () => void runNightly().catch((e) => console.error("[analytics]", e));
  // Not on boot: a restart loop would otherwise run this every few seconds.
  timer = setInterval(tick, 60 * 60_000);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
}

export function stopAnalytics(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ─── Reading it back ────────────────────────────────────────────────────────

export interface DailyRow {
  day: string;
  dau: number;
  mau: number;
  newAccounts: number;
  matches: number;
  matchesByGame: Record<string, number>;
  avgSessionSec: number;
  funnelSignedIn: number;
  funnelNamed: number;
  funnelPlayed: number;
  reports: number;
  sanctions: number;
}

export async function readDaily(days = 30): Promise<DailyRow[]> {
  const out = await rows<Record<string, unknown>>(
    `select * from daily_stats where day >= (current_date - $1) order by day`,
    Math.max(1, Math.min(365, days))
  );
  return out.map((r) => ({
    day: String(r.day).slice(0, 10),
    dau: Number(r.dau ?? 0),
    mau: Number(r.mau ?? 0),
    newAccounts: Number(r.new_accounts ?? 0),
    matches: Number(r.matches ?? 0),
    matchesByGame: (r.matches_by_game ?? {}) as Record<string, number>,
    avgSessionSec: Number(r.avg_session_sec ?? 0),
    funnelSignedIn: Number(r.funnel_signed_in ?? 0),
    funnelNamed: Number(r.funnel_named ?? 0),
    funnelPlayed: Number(r.funnel_played ?? 0),
    reports: Number(r.reports ?? 0),
    sanctions: Number(r.sanctions ?? 0),
  }));
}

export interface CohortRow {
  day: string;
  size: number;
  d1: number;
  d7: number;
  d30: number;
}

export async function readCohorts(days = 30): Promise<CohortRow[]> {
  const out = await rows<Record<string, unknown>>(
    `select * from cohorts where day >= (current_date - $1) order by day desc`,
    Math.max(1, Math.min(365, days))
  );
  return out.map((r) => ({
    day: String(r.day).slice(0, 10),
    size: Number(r.size ?? 0),
    d1: Number(r.d1 ?? 0),
    d7: Number(r.d7 ?? 0),
    d30: Number(r.d30 ?? 0),
  }));
}

// ─── Anti-cheat signals ─────────────────────────────────────────────────────

export interface RankedPlayer extends PlayerSignals {
  uid: string;
  username: string | null;
  suspicion: Suspicion;
  /** The most recent match to open in the studio — a ranking with nothing to
   *  watch is a ranking nobody can act on. */
  lastMatchKey: string | null;
}

/**
 * Who is worth watching, most first.
 *
 * A ranking, not an accusation: nothing here is shown to a player, nothing
 * here bans anybody, and every entry carries the reasons in words so that the
 * next step is watching the match rather than trusting the number.
 */
export async function rankSuspicion(opts: { days?: number; limit?: number } = {}): Promise<RankedPlayer[]> {
  const days = Math.max(1, Math.min(90, opts.days ?? 14));
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const out = await rows<Record<string, unknown>>(
    `select u.uid, u.username,
            count(*)::int as matches,
            coalesce(sum(mp.inputs), 0)::int as inputs,
            coalesce(sum(mp.rejects), 0)::int as rejects,
            coalesce(sum(coalesce(nullif(mp.reject_kinds->>'rate','')::int, 0)), 0)::int as rate_rejects,
            coalesce(sum(coalesce(nullif(mp.reject_kinds->>'early','')::int, 0)), 0)::int as early_rejects,
            avg(mp.cadence) filter (where mp.cadence is not null) as cadence,
            count(*) filter (where mp.placement = 1)::int as wins,
            count(*) filter (where (
              select count(*) from match_players peer
               where peer.match_id = mp.match_id and peer.is_bot = false
            ) > 1)::int as contested,
            (select m2.match_key from matches m2
              join match_players mp2 on mp2.match_id = m2.id
             where mp2.user_id = u.id order by m2.created_at desc limit 1) as last_match
       from match_players mp
       join matches m on m.id = mp.match_id
       join users u on u.id = mp.user_id
      where m.created_at >= now() - interval '$1 days'
        and mp.is_bot = false
      group by u.uid, u.username, u.id
      order by (coalesce(sum(mp.rejects), 0) + count(*)) desc
      limit $2`.replace("'$1 days'", `'${days} days'`),
    limit
  );

  return out
    .map((r) => {
      const s: PlayerSignals = {
        matches: Number(r.matches ?? 0),
        inputs: Number(r.inputs ?? 0),
        rejects: Number(r.rejects ?? 0),
        rateRejects: Number(r.rate_rejects ?? 0),
        earlyRejects: Number(r.early_rejects ?? 0),
        cadence: r.cadence === null || r.cadence === undefined ? null : Math.round(Number(r.cadence)),
        wins: Number(r.wins ?? 0),
        contested: Number(r.contested ?? 0),
      };
      return {
        ...s,
        uid: String(r.uid),
        username: (r.username as string | null) ?? null,
        suspicion: suspicion(s),
        lastMatchKey: (r.last_match as string | null) ?? null,
      };
    })
    .filter((p) => p.suspicion.score > 0)
    .sort((a, b) => b.suspicion.score - a.suspicion.score);
}

// ─── The alt-account graph ──────────────────────────────────────────────────

export interface AltEdge {
  a: string;
  b: string;
  /** device — the same browser and machine. Strong.
   *  ip — the same address. Weak on its own: families, campuses and mobile
   *  carriers put strangers behind one address all day. */
  kind: "device" | "ip";
  seen: number;
}

export interface AltNode {
  uid: string;
  username: string | null;
  banned: boolean;
}

/**
 * Everybody connected to one player, and how.
 *
 * The point is ban evasion: ban the person, not the account, and see at a
 * glance whether a "new player" is somebody removed last week. Two hops, so a
 * shared device that leads to another shared device is visible, and capped so
 * that one address behind a carrier NAT cannot return the whole platform.
 */
export async function altGraph(uid: string): Promise<{ nodes: AltNode[]; edges: AltEdge[] }> {
  const edges = await rows<Record<string, unknown>>(
    `with seed as (select id, uid from users where uid = $1),
     -- Strong: the same browser on the same machine.
     dev as (
       select ua.uid as a, ub.uid as b, 'device' as kind, count(*)::int as seen
         from user_devices da
         join user_devices db2 on db2.device_hash = da.device_hash and db2.user_id <> da.user_id
         join users ua on ua.id = da.user_id
         join users ub on ub.id = db2.user_id
        where da.user_id in (select id from seed)
           or db2.user_id in (select id from seed)
        group by ua.uid, ub.uid
     ),
     -- Weak: the same address. Capped hard, because one carrier NAT can put a
     -- thousand strangers behind one IP and drown the real edges.
     ips as (
       select ea.uid as a, eb.uid as b, 'ip' as kind, count(*)::int as seen
         from event_log ea
         join event_log eb on eb.ip = ea.ip and eb.user_id <> ea.user_id
        where ea.user_id in (select id from seed)
          and ea.ip is not null
          and ea.at > now() - interval '90 days'
          and eb.at > now() - interval '90 days'
        group by ea.uid, eb.uid
       having count(*) >= 3
        limit 40
     )
     select * from dev union all select * from ips`,
    uid
  );

  const seen = new Map<string, AltEdge>();
  const ids = new Set<string>([uid]);
  for (const e of edges) {
    const a = String(e.a);
    const b = String(e.b);
    if (a === b) continue;
    // One edge per pair per kind, however the join found it.
    const key = [a, b].sort().join("|") + String(e.kind);
    if (!seen.has(key)) seen.set(key, { a, b, kind: e.kind as "device" | "ip", seen: Number(e.seen ?? 1) });
    ids.add(a);
    ids.add(b);
  }

  const people = ids.size
    ? await rows<Record<string, unknown>>(
        `select u.uid, u.username,
                exists (select 1 from sanctions s
                         where s.user_id = u.id and s.type = 'ban' and s.revoked_at is null
                           and (s.expires_at is null or s.expires_at > now())) as banned
           from users u where u.uid in (${[...ids].map((i) => lit(i)).join(",")})`
      )
    : [];

  return {
    nodes: people.map((p) => ({
      uid: String(p.uid),
      username: (p.username as string | null) ?? null,
      banned: p.banned === true,
    })),
    edges: [...seen.values()],
  };
}
