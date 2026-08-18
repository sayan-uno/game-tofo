// Finding a player, and everything the console knows about one.
//
// Two rules run through this file.
//
// ROLE. Identity, career and match history are visible to anyone who can open
// the console at all. Addresses, devices and the accounts they link to are
// admin-and-above, because those answer a different question — not "what did
// this player do" but "who is this person, and what else are they" — and that
// is a power worth restricting.
//
// AUDIT. Opening a profile is recorded. Opening the ADDRESSES on a profile is
// recorded separately. "Who has been looking at whom" is a question a
// moderation console must be able to answer about itself.
import { safeRouter } from "../asyncRouter.js";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  eventLog,
  matchPlayers,
  matches,
  playerStats,
  friendships,
  sanctions,
  userDevices,
  users,
} from "../../db/schema.js";
import { getOnlineSet, getUserLobby } from "../../redis.js";
import { getUserMatch } from "../../platform/store.js";
import { requestOrigin } from "../../services/clientIp.js";
import { getSanctions } from "../../services/sanctions.js";
import { requireAdmin } from "../guard.js";
import { audit } from "../audit.js";

export const playersRouter = safeRouter();

/** How the console found them — shown back to the searcher so a surprising
 *  result explains itself. */
type MatchedOn = "uid" | "email" | "username" | "ip" | "device" | "none";

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,45}$/i;
const DEVICE_RE = /^[0-9a-f]{32}$/i;
const UID_RE = /^\d{6,12}$/;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

playersRouter.get("/search", requireAdmin("support"), async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json({ results: [], matchedOn: "none" as MatchedOn });
    return;
  }
  const privileged = req.admin!.role === "admin" || req.admin!.role === "owner";

  let matchedOn: MatchedOn = "username";
  let ids: string[] = [];

  if (UID_RE.test(q)) {
    matchedOn = "uid";
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.uid, q));
    ids = rows.map((r) => r.id);
  } else if (q.includes("@")) {
    matchedOn = "email";
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) like ${`%${q.toLowerCase()}%`}`)
      .limit(25);
    ids = rows.map((r) => r.id);
  } else if (DEVICE_RE.test(q)) {
    // Searching by device is how one person's several accounts become visible.
    if (!privileged) {
      res.status(403).json({ error: "Your role cannot search by device", code: "FORBIDDEN" });
      return;
    }
    matchedOn = "device";
    const rows = await db
      .select({ id: userDevices.userId })
      .from(userDevices)
      .where(eq(userDevices.deviceHash, q.toLowerCase()))
      .limit(25);
    ids = rows.map((r) => r.id);
    await audit(req.admin!, { action: "player.searchDevice", targetType: "user", targetId: q, ip: requestOrigin(req).ip });
  } else if (IP_RE.test(q) && (q.includes(".") || q.includes(":"))) {
    if (!privileged) {
      res.status(403).json({ error: "Your role cannot search by address", code: "FORBIDDEN" });
      return;
    }
    matchedOn = "ip";
    const rows = await db
      .selectDistinct({ id: eventLog.userId })
      .from(eventLog)
      .where(sql`host(${eventLog.ip}) = ${q}`)
      .limit(25);
    ids = rows.map((r) => r.id).filter((v): v is string => v !== null);
    await audit(req.admin!, { action: "player.searchIp", targetType: "user", targetId: q, ip: requestOrigin(req).ip });
  } else {
    // The catch-all also looks at the email address, because a support ticket
    // often quotes only the part before the @ and making someone type the whole
    // thing to be found is a pointless obstacle.
    const like = `%${q.toLowerCase()}%`;
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`lower(${users.username}) like ${like} or lower(${users.name}) like ${like} or lower(${users.email}) like ${like}`
      )
      .limit(25);
    ids = rows.map((r) => r.id);
  }

  if (ids.length === 0) {
    res.json({ results: [], matchedOn });
    return;
  }
  const rows = await db.select().from(users).where(inArray(users.id, ids));
  const online = await getOnlineSet(ids);
  const banned = await Promise.all(rows.map((u) => getSanctions(u.id)));

  res.json({
    matchedOn,
    results: rows.map((u, i) => ({
      uid: u.uid,
      username: u.username,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      online: online.has(u.id),
      sanctions: Object.keys(banned[i]),
    })),
  });
});

// ---------------------------------------------------------------------------
// One player, everything
// ---------------------------------------------------------------------------

playersRouter.get("/:uid", requireAdmin("support"), async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.uid, req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No player with that UID" });
    return;
  }
  const privileged = req.admin!.role === "admin" || req.admin!.role === "owner";
  await audit(req.admin!, { action: "player.view", targetType: "user", targetId: user.uid, ip: requestOrigin(req).ip });

  const [stats] = await db.select().from(playerStats).where(eq(playerStats.userId, user.id));
  const online = await getOnlineSet([user.id]);
  const [lobbyId, matchId, live] = await Promise.all([
    getUserLobby(user.id),
    getUserMatch(user.id),
    getSanctions(user.id),
  ]);

  const history = await db
    .select({
      matchKey: matches.matchKey,
      gameId: matches.gameId,
      createdAt: matches.createdAt,
      reason: matches.reason,
      playerCount: matches.playerCount,
      placement: matchPlayers.placement,
      score: matchPlayers.score,
      forfeit: matchPlayers.forfeit,
      detail: matchPlayers.detail,
    })
    .from(matchPlayers)
    .innerJoin(matches, eq(matchPlayers.matchId, matches.id))
    .where(eq(matchPlayers.userId, user.id))
    .orderBy(desc(matches.createdAt))
    .limit(25);

  const sanctionRows = await db
    .select()
    .from(sanctions)
    .where(eq(sanctions.userId, user.id))
    .orderBy(desc(sanctions.createdAt))
    .limit(25);

  const [{ friends }] = await db
    .select({ friends: sql<number>`count(*)::int` })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(eq(friendships.requesterId, user.id), eq(friendships.addresseeId, user.id))
      )
    );

  const body: Record<string, unknown> = {
    player: {
      uid: user.uid,
      username: user.username,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      equippedCharacter: user.equippedCharacter,
      equippedWeapon: user.equippedWeapon,
      online: online.has(user.id),
      lobbyId,
      matchId,
    },
    stats: stats ?? null,
    matches: history,
    sanctions: sanctionRows,
    activeSanctions: live,
    friends,
    /** So the console can explain a missing panel rather than just omitting it. */
    canSeeAddresses: privileged,
  };

  if (privileged) {
    await audit(req.admin!, { action: "player.viewIps", targetType: "user", targetId: user.uid, ip: requestOrigin(req).ip });

    body.sessions = await db
      .select({
        at: eventLog.at,
        type: eventLog.type,
        ip: sql<string | null>`host(${eventLog.ip})`,
        country: eventLog.ipCountry,
        ua: eventLog.ua,
        deviceHash: eventLog.deviceHash,
        data: eventLog.data,
      })
      .from(eventLog)
      .where(eq(eventLog.userId, user.id))
      .orderBy(desc(eventLog.at))
      .limit(60);

    const devices = await db
      .select()
      .from(userDevices)
      .where(eq(userDevices.userId, user.id))
      .orderBy(desc(userDevices.lastSeenAt));
    body.devices = devices;

    // Alt accounts: anyone else seen on the same device, or at the same
    // address. Bounded to this player's ten most recent addresses so the query
    // stays cheap however long they have been playing.
    const linked = new Map<string, { uid: string; username: string | null; via: string; how: "device" | "ip" }>();

    if (devices.length > 0) {
      const others = await db
        .select({ uid: users.uid, username: users.username, hash: userDevices.deviceHash })
        .from(userDevices)
        .innerJoin(users, eq(users.id, userDevices.userId))
        .where(
          and(
            inArray(userDevices.deviceHash, devices.map((d) => d.deviceHash)),
            ne(userDevices.userId, user.id)
          )
        )
        .limit(50);
      for (const o of others) linked.set(o.uid, { uid: o.uid, username: o.username, via: o.hash.slice(0, 8), how: "device" });
    }

    // The distinct addresses among this player's most recent events. Written
    // as a subquery because Postgres will not accept SELECT DISTINCT ordered
    // by a column that is not selected — and "recent" is an ordering by time,
    // not by address.
    const recentIps = (
      await db.execute<{ ip: string }>(sql`
        select distinct ip from (
          select ip from ${eventLog}
          where ${eventLog.userId} = ${user.id} and ${eventLog.ip} is not null
          order by ${eventLog.at} desc limit 200
        ) recent`)
    ).rows.map((r) => r.ip);

    if (recentIps.length > 0) {
      const others = await db
        .selectDistinct({ uid: users.uid, username: users.username, ip: sql<string>`host(${eventLog.ip})` })
        .from(eventLog)
        .innerJoin(users, eq(users.id, eventLog.userId))
        .where(and(inArray(eventLog.ip, recentIps), ne(eventLog.userId, user.id)))
        .limit(50);
      for (const o of others) {
        if (!linked.has(o.uid)) linked.set(o.uid, { uid: o.uid, username: o.username, via: o.ip, how: "ip" });
      }
    }
    body.linked = [...linked.values()];
  }

  res.json(body);
});
