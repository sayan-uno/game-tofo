// Worlds, for the console.
//
// The question this screen exists to answer is "who is actually in there" —
// and it is the one screen where the console is told something players are
// deliberately not: which members of a world are people and which are the
// server population. That separation is invisible everywhere else on the
// platform and has to be visible here, because a moderator reading a room
// cannot judge it without knowing which half of it can be moderated.
//
// It reads Redis directly rather than through the game process. The console is
// a different process with no view of the game's memory, but the world state
// IS Redis — so this is a read of the record itself, not a snapshot of
// somebody's opinion of it, and it costs the game server nothing.
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { botAccounts, botStats, users } from "../../db/schema.js";
import { redis } from "../../redis.js";
import {
  WORLD_CAPACITY,
  listRequests,
  listWorldIds,
  recentMessages,
  worldCounts,
} from "../../platform/world.js";
import { listWorldArchive, worldChatVolume } from "../../services/worldChat.js";
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin } from "../guard.js";
import { audit } from "../audit.js";
import { requestOrigin } from "../../services/clientIp.js";

export const worldsRouter = safeRouter();

/** Every world, with what is in it. One screen's worth — a platform with a
 *  thousand worlds is a different problem and would want paging. */
worldsRouter.get("/worlds", requireAdmin("support"), async (_req, res) => {
  const ids = await listWorldIds();
  const [counts, volume] = await Promise.all([
    Promise.all(ids.map(worldCounts)),
    worldChatVolume(24).catch(() => new Map<string, number>()),
  ]);
  const live = await Promise.all(ids.map((id) => listRequests(id).catch(() => [])));
  res.json({
    capacity: WORLD_CAPACITY,
    worlds: counts.map((c, i) => ({
      ...c,
      /** Cards on the board right now, split — a board that is all server
       *  population is a room where nobody real is looking for a game. */
      requests: live[i].length,
      requestsByPlayers: live[i].filter((r) => !r.botId).length,
      /** Lines archived in the last 24 hours. Says which worlds are alive
       *  without opening any of them. */
      messages24h: volume.get(c.id) ?? 0,
    })),
  });
});

/** One world in full: who is in it, what has just been said, and what is being
 *  advertised. `members` is capped — a thousand rows is not a page anybody
 *  reads, and the ones that matter are the most recently seen. */
worldsRouter.get("/worlds/:id", requireAdmin("support"), async (req, res) => {
  const id = String(req.params.id);
  if (!/^W\d{1,6}$/.test(id)) {
    res.status(404).json({ error: "No such world" });
    return;
  }
  const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 200));
  const [counts, humanIds, botIds, requests, ring] = await Promise.all([
    worldCounts(id),
    redis.zrevrange(`world:${id}:humans`, 0, limit - 1, "WITHSCORES"),
    redis.zrevrange(`world:${id}:bots`, 0, limit - 1, "WITHSCORES"),
    listRequests(id),
    recentMessages(id),
  ]);

  const humans = pairs(humanIds);
  const bots = pairs(botIds);
  const [userRows, botRows] = await Promise.all([
    humans.length > 0
      ? db
          .select({ id: users.id, uid: users.uid, username: users.username, name: users.name })
          .from(users)
          .where(inArray(users.id, humans.map((h) => h.member)))
      : [],
    bots.length > 0
      ? db
          .select({ id: botAccounts.id, uid: botAccounts.uid, username: botAccounts.username })
          .from(botAccounts)
          .where(inArray(botAccounts.id, bots.map((b) => b.member)))
      : [],
  ]);
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const botById = new Map(botRows.map((b) => [b.id, b]));

  res.json({
    ...counts,
    members: [
      ...humans.map((h) => {
        const u = userById.get(h.member);
        return {
          kind: "player" as const,
          uid: u?.uid ?? "",
          name: u ? (u.username ?? u.name) : "(deleted account)",
          /** Last sign of life, so a moderator can tell somebody who is
           *  reading the room from somebody whose phone is in a pocket. */
          seenAt: h.score,
        };
      }),
      ...bots.map((b) => {
        const bot = botById.get(b.member);
        return {
          kind: "server" as const,
          uid: bot?.uid ?? "",
          name: bot?.username ?? "(retired)",
          seenAt: b.score,
        };
      }),
    ].sort((a, b) => b.seenAt - a.seenAt),
    requests: requests.map((r) => ({
      id: r.id,
      uid: r.uid,
      name: r.name,
      mode: r.mode,
      need: r.need,
      /** The console DOES get told. See the header. */
      kind: r.botId ? ("server" as const) : ("player" as const),
      lobbyId: r.lobbyId || null,
      at: r.at,
      expiresAt: r.expiresAt,
    })),
    /** The live ring — what is on screen for anybody with the tab open right
     *  now. The archive below it goes back fifteen days. */
    live: ring.map((m) => ({
      id: m.id,
      uid: m.uid,
      name: m.name,
      body: m.body,
      at: m.at,
      kind: m.botId ? ("server" as const) : ("player" as const),
    })),
  });
});

/** The archive: fifteen days of one world's chat, newest first.
 *
 *  Audited by name, exactly like reading somebody's private messages, and for
 *  a reason that is easy to talk yourself out of: this room is public, so
 *  reading it feels harmless. It is not — it is still a record of what named
 *  accounts said, and "who has read whom" has to stay answerable whatever the
 *  room's door policy was. */
worldsRouter.get("/worlds/:id/archive", requireAdmin("moderator"), async (req, res) => {
  const id = String(req.params.id);
  if (!/^W\d{1,6}$/.test(id)) {
    res.status(404).json({ error: "No such world" });
    return;
  }
  const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
  const rows = await listWorldArchive(id, Number(req.query.limit) || 200, before);
  await audit(req.admin!, {
    action: "world.chat.read",
    targetType: "platform",
    targetId: id,
    after: { rows: rows.length },
    ip: requestOrigin(req).ip,
  });
  res.json({
    messages: rows.map((m) => ({
      id: m.id,
      uid: m.uid,
      name: m.name,
      body: m.body,
      at: m.createdAt,
      kind: m.botId ? ("server" as const) : ("player" as const),
    })),
  });
});

/** The server population itself: how big it is, and what the busiest accounts
 *  in it have actually done.
 *
 *  Worth a panel of its own because the numbers are the only honest way to
 *  tune the thing. A population whose top accounts have four hundred matches
 *  each is a population that is too small for the platform it is standing in. */
worldsRouter.get("/bots", requireAdmin("support"), async (_req, res) => {
  const [totals, top] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${botAccounts.status} = 'active')::int`,
        // Seen in the last day: the part of the population that is actually
        // doing anything, which is the number worth tuning against.
        recent: sql<number>`count(*) filter (where ${botAccounts.lastSeenAt} > now() - interval '1 day')::int`,
      })
      .from(botAccounts),
    db
      .select({
        uid: botAccounts.uid,
        name: botAccounts.username,
        skill: botAccounts.skill,
        persona: botAccounts.persona,
        createdAt: botAccounts.createdAt,
        lastSeenAt: botAccounts.lastSeenAt,
        matches: botStats.matches,
        wins: botStats.wins,
        xp: botStats.xp,
      })
      .from(botStats)
      .innerJoin(botAccounts, eq(botAccounts.id, botStats.botId))
      .orderBy(desc(botStats.matches))
      .limit(25),
  ]);
  res.json({
    total: totals[0]?.total ?? 0,
    active: totals[0]?.active ?? 0,
    recent: totals[0]?.recent ?? 0,
    top: top.map((b) => ({ ...b, xp: Number(b.xp) })),
  });
});

/** ZREVRANGE …WITHSCORES comes back as a flat [member, score, member, score…] */
function pairs(flat: string[]): { member: string; score: number }[] {
  const out: { member: string; score: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ member: flat[i], score: Number(flat[i + 1]) });
  return out;
}
