// Going back in time.
//
// The overview says what is happening now. This says what WAS happening — and
// the reason it exists is the question you cannot answer at breakfast: the
// server was unreachable for six minutes at three in the morning, and by the
// time anybody looked, the live snapshot had expired and taken the evidence
// with it.
//
// So: one row a minute, kept for thirty days. The rows carry the numbers; the
// GAPS between them carry the outages, because a minute with no row is a
// minute nothing was able to write one.
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { eventLog, platformHistory, users } from "../../db/schema.js";
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin } from "../guard.js";

export const historyRouter = safeRouter();

/** A minute is the cadence; anything longer than this between rows is a hole
 *  rather than a rounding difference. */
const MINUTE = 60_000;

historyRouter.get("/history/series", requireAdmin("support"), async (req, res) => {
  const hours = Math.min(72, Math.max(1, Number(req.query.hours ?? 12)));
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = new Date(to.getTime() - hours * 3600_000);

  const rows = await db
    .select({
      at: platformHistory.at,
      online: platformHistory.online,
      matches: platformHistory.matches,
      matchPlayers: platformHistory.matchPlayers,
      queued: platformHistory.queued,
      rssMb: platformHistory.rssMb,
    })
    .from(platformHistory)
    .where(and(gte(platformHistory.at, from), lte(platformHistory.at, to)))
    .orderBy(asc(platformHistory.at));

  // Several processes may each write a minute; the platform's number is the
  // sum of what they were carrying, not one of them.
  const byMinute = new Map<number, { at: number; online: number; matches: number; players: number; queued: number; rssMb: number }>();
  for (const r of rows) {
    const key = Math.floor(new Date(r.at).getTime() / MINUTE) * MINUTE;
    const cur = byMinute.get(key) ?? { at: key, online: 0, matches: 0, players: 0, queued: 0, rssMb: 0 };
    cur.online += r.online;
    cur.matches += r.matches;
    cur.players += r.matchPlayers;
    cur.queued += r.queued;
    cur.rssMb += r.rssMb;
    byMinute.set(key, cur);
  }
  const points = [...byMinute.values()].sort((a, b) => a.at - b.at);

  // The holes. Deliberately NOT filled with zeroes: "nobody was online" and
  // "nothing was writing" are different facts, and drawing one as the other is
  // how an outage disappears into a chart.
  const gaps: { from: number; to: number; minutes: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].at - points[i - 1].at;
    if (delta > 2 * MINUTE) {
      gaps.push({ from: points[i - 1].at, to: points[i].at, minutes: Math.round(delta / MINUTE) - 1 });
    }
  }
  // A hole at the end matters most: it means it is down NOW.
  const last = points[points.length - 1];
  if (last && to.getTime() - last.at > 2 * MINUTE) {
    gaps.push({ from: last.at, to: to.getTime(), minutes: Math.round((to.getTime() - last.at) / MINUTE) - 1 });
  }

  res.json({ from: from.toISOString(), to: to.toISOString(), points, gaps });
});

/** Who was here at a given moment, and what happened around it.
 *
 *  Reconstructed from the activity trail rather than stored: for each player,
 *  the last thing they did before that moment was either arriving or leaving.
 *  If it was arriving, they were online. */
historyRouter.get("/history/at", requireAdmin("support"), async (req, res) => {
  const at = new Date(Number(req.query.ts ?? Date.now()));
  const privileged = req.admin!.role === "admin" || req.admin!.role === "owner";

  const latest = await db.execute<{ uid: string; type: string; at: Date; user_id: string | null }>(sql`
    select distinct on (uid) uid, type, at, user_id
      from ${eventLog}
     where type in ('session.start', 'session.end', 'session.away', 'session.back')
       and uid is not null
       and at <= ${at}
       and at > ${new Date(at.getTime() - 24 * 3600_000)}
     order by uid, at desc`);
  // Arriving OR coming back counts as here; leaving or going quiet does not.
  // Whichever happened last for that player is what they were doing.
  const online = latest.rows.filter((r) => r.type === "session.start" || r.type === "session.back");

  const names = online.length
    ? await db
        .select({ id: users.id, uid: users.uid, username: users.username })
        .from(users)
        .where(inArray(users.uid, online.map((o) => o.uid)))
    : [];
  const nameOf = new Map(names.map((n) => [n.uid, n.username]));

  // What was going on either side of that moment — the log an admin actually
  // wants to read after an outage.
  const around = await db
    .select({
      at: eventLog.at,
      type: eventLog.type,
      uid: eventLog.uid,
      matchKey: eventLog.matchKey,
      gameId: eventLog.gameId,
      data: eventLog.data,
      ip: privileged ? sql<string | null>`host(${eventLog.ip})` : sql<null>`null`,
    })
    .from(eventLog)
    .where(and(gte(eventLog.at, new Date(at.getTime() - 5 * 60_000)), lte(eventLog.at, new Date(at.getTime() + 5 * 60_000))))
    .orderBy(desc(eventLog.at))
    .limit(120);

  const [snapshot] = await db
    .select()
    .from(platformHistory)
    .where(lte(platformHistory.at, at))
    .orderBy(desc(platformHistory.at))
    .limit(1);

  res.json({
    at: at.toISOString(),
    // Null when the nearest row is far behind the moment asked about — which
    // is itself the answer: nothing was writing then.
    snapshot:
      snapshot && at.getTime() - new Date(snapshot.at).getTime() < 3 * MINUTE
        ? { at: snapshot.at, online: snapshot.online, matches: snapshot.matches, rssMb: snapshot.rssMb }
        : null,
    online: online.map((o) => ({ uid: o.uid, username: nameOf.get(o.uid) ?? null, since: o.at })),
    events: around,
    canSeeAddresses: privileged,
  });
});

/** The whole activity log, between two moments.
 *
 *  One place that answers "what happened between 2am and 3am", and the same
 *  query narrowed by player answers "what did this person do". Cursor-paged on
 *  (at, id) rather than OFFSET: a log grows while you are reading it, and
 *  OFFSET quietly skips or repeats rows when it does.
 */
historyRouter.get("/log", requireAdmin("support"), async (req, res) => {
  const privileged = req.admin!.role === "admin" || req.admin!.role === "owner";
  // No "to" means "up to now" — and whose now matters. A browser's clock can
  // sit a second, or a minute, behind Postgres's; a row committed inside that
  // gap carries a stamp that looks like the future, falls outside "at <= to",
  // and never appears however many times somebody presses Refresh. So when the
  // caller means now, the window is closed with the database's own clock and
  // no clock of theirs is involved at all.
  const openEnded = !req.query.to;
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 3600_000);
  const uid = typeof req.query.uid === "string" && req.query.uid ? req.query.uid : null;
  const type = typeof req.query.type === "string" && req.query.type ? req.query.type : null;
  // A party id, pasted straight out of the "started a party" line. Everything
  // that group ever did is stamped with it, so this turns one log entry into
  // the whole story of that party.
  const lobby = typeof req.query.lobby === "string" && req.query.lobby.trim() ? req.query.lobby.trim() : null;
  // A match id, pasted out of the "made trackline …" line. Everything stamped
  // with that match — who it was built from, every microphone opened during
  // it — comes back together.
  const match = typeof req.query.match === "string" && req.query.match.trim() ? req.query.match.trim() : null;
  const limit = Math.min(300, Math.max(1, Number(req.query.limit ?? 200)));
  const before = req.query.cursor ? new Date(String(req.query.cursor)) : null;

  // A support account never sees addresses, exactly as on the player page:
  // the column is not selected rather than hidden by the console.
  const rows = await db
    .select({
      id: eventLog.id,
      at: eventLog.at,
      type: eventLog.type,
      uid: eventLog.uid,
      matchKey: eventLog.matchKey,
      gameId: eventLog.gameId,
      lobbyId: eventLog.lobbyId,
      data: eventLog.data,
      ip: privileged ? sql<string | null>`host(${eventLog.ip})` : sql<null>`null`,
      country: privileged ? eventLog.ipCountry : sql<null>`null`,
    })
    .from(eventLog)
    .where(
      and(
        gte(eventLog.at, from),
        before ? lte(eventLog.at, before) : openEnded ? sql`${eventLog.at} <= now()` : lte(eventLog.at, to),
        uid ? eq(eventLog.uid, uid) : sql`true`,
        type ? eq(eventLog.type, type) : sql`true`,
        lobby ? eq(eventLog.lobbyId, lobby) : sql`true`,
        match ? eq(eventLog.matchKey, match) : sql`true`
      )
    )
    .orderBy(desc(eventLog.at))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    events: page,
    // The cursor is the last row's timestamp: "carry on from here".
    cursor: rows.length > limit ? page[page.length - 1].at : null,
    canSeeAddresses: privileged,
  });
});

/** Which kinds of thing exist in the window, and how many of each — so the
 *  filter offers what is actually there instead of a fixed list. */
historyRouter.get("/log/kinds", requireAdmin("support"), async (req, res) => {
  const openEnded = !req.query.to;
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 3600_000);
  const rows = await db
    .select({ type: eventLog.type, n: sql<number>`count(*)::int` })
    .from(eventLog)
    // Same clock, same reason as /log above.
    .where(and(gte(eventLog.at, from), openEnded ? sql`${eventLog.at} <= now()` : lte(eventLog.at, to)))
    .groupBy(eventLog.type)
    .orderBy(desc(sql`count(*)`));
  res.json({ kinds: rows });
});
