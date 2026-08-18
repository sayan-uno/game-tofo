// Finding a match, and handing the studio everything it needs to play it.
//
// A replay is a few kilobytes of input log, so the detail route sends the whole
// decoded file in one answer rather than making the studio stream it — and
// alongside it the game's pack metadata, because the studio has to load the
// same assets the players had before it can draw anything.
//
// Opening a replay is audited. Watching a match is watching people play, and a
// console that can do that without leaving a trace is one nobody can be held
// to.
import { safeRouter } from "../asyncRouter.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { matchPlayers, matchReplays, matches, users } from "../../db/schema.js";
import { config } from "../../config.js";
import { listGames } from "../../platform/games.js";
import { publicCatalog } from "../../services/catalog.js";
import { getEvidence } from "../../platform/evidence.js";
import { unpackReplay } from "../../platform/replay.js";
import { requestOrigin } from "../../services/clientIp.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";

export const replaysRouter = safeRouter();

/** What the studio needs to fetch a game's pack — the same shape the player
 *  client gets from /api/games, built here from the same registry so the two
 *  cannot drift. */
function packInfo(gameId: string) {
  const g = listGames().find((x) => x.id === gameId);
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    tagline: g.tagline,
    durationSec: Math.round(g.durationTicks / g.tickRate),
    packVersion: g.pack.version,
    packBytes: g.pack.bytes,
    packUrl: config.cdnBaseUrl && g.pack.bytes > 0 ? `${config.cdnBaseUrl}/${g.pack.key}/manifest.json` : null,
  };
}

// ---- the list -------------------------------------------------------------

replaysRouter.get("/", requireAdmin("moderator"), async (req, res) => {
  const uid = typeof req.query.uid === "string" ? req.query.uid : null;
  const gameId = typeof req.query.gameId === "string" ? req.query.gameId : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));

  // The list comes from the ROWS, not from the files: opening fifty archives to
  // draw a table would be absurd, and Postgres already knows who played what.
  const rows = await db
    .select({
      matchKey: matchReplays.matchKey,
      gameId: matchReplays.gameId,
      bytes: matchReplays.bytes,
      tier: matchReplays.tier,
      expiresAt: matchReplays.expiresAt,
      createdAt: matchReplays.createdAt,
      reason: matches.reason,
      playerCount: matches.playerCount,
      ticks: matches.ticks,
    })
    .from(matchReplays)
    .leftJoin(matches, eq(matches.matchKey, matchReplays.matchKey))
    .where(
      and(
        gameId ? eq(matchReplays.gameId, gameId) : sql`true`,
        uid
          ? sql`exists (select 1 from ${matchPlayers} mp join ${matches} m on m.id = mp.match_id
                 join ${users} u on u.id = mp.user_id
                 where m.match_key = ${matchReplays.matchKey} and u.uid = ${uid})`
          : sql`true`
      )
    )
    .orderBy(desc(matchReplays.createdAt))
    .limit(limit);

  // Who was in each one, for the table. One query for the lot.
  const keys = rows.map((r) => r.matchKey);
  const people = keys.length
    ? await db
        .select({
          matchKey: matches.matchKey,
          name: matchPlayers.name,
          placement: matchPlayers.placement,
          isBot: matchPlayers.isBot,
          uid: users.uid,
        })
        .from(matchPlayers)
        .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
        .leftJoin(users, eq(users.id, matchPlayers.userId))
        // inArray, not `= any(...)`: drizzle expands a JS array into a tuple,
        // which Postgres refuses on the right of ANY.
        .where(inArray(matches.matchKey, keys))
    : [];

  const byMatch = new Map<string, typeof people>();
  for (const p of people) {
    const list = byMatch.get(p.matchKey) ?? [];
    list.push(p);
    byMatch.set(p.matchKey, list);
  }

  res.json({
    replays: rows.map((r) => ({
      ...r,
      players: (byMatch.get(r.matchKey) ?? []).sort((a, b) => a.placement - b.placement),
    })),
  });
});

// ---- one replay, decoded --------------------------------------------------

replaysRouter.get("/:matchKey", requireAdmin("moderator"), async (req, res) => {
  const [row] = await db.select().from(matchReplays).where(eq(matchReplays.matchKey, req.params.matchKey));
  if (!row) {
    res.status(404).json({ error: "No replay for that match" });
    return;
  }
  const bytes = await getEvidence(row.r2Key);
  if (!bytes) {
    // The row says there is a file and there is not. Worth saying plainly:
    // it means the archive and the index have come apart.
    res.status(410).json({
      error: "The archive no longer holds that file — it may have been swept, or the storage is misconfigured",
      code: "GONE",
    });
    return;
  }
  await audit(req.admin!, {
    action: "replay.open",
    targetType: "match",
    targetId: row.matchKey,
    ip: requestOrigin(req).ip,
  });
  res.json({
    replay: unpackReplay(bytes),
    game: packInfo(row.gameId),
    // The character models are NOT in a game's pack — they come from the
    // platform catalog, which the player client fills in at sign-in and the
    // console otherwise never would. Without it every runner is a name plate
    // with nobody under it. Sent with the replay because that is exactly when
    // the studio needs it.
    catalog: publicCatalog(),
    // Where those catalog URLs point. The console needs to know so it can send
    // them through its own dev proxy — the CDN's CORS policy names specific
    // origins and the console is not one of them.
    cdnBase: config.cdnBaseUrl || null,
    stored: { tier: row.tier, bytes: row.bytes, expiresAt: row.expiresAt, createdAt: row.createdAt },
  });
});

// ---- keep this one --------------------------------------------------------

/** Pin a replay so retention never sweeps it. The one deliberate exception to
 *  "deletion is by tier and expiry only" — and it only ever makes a replay live
 *  LONGER, so it cannot be used to make one disappear. */
replaysRouter.post("/:matchKey/hold", requireAdmin("moderator"), requireSudo, async (req, res) => {
  const { hold, reason } = (req.body ?? {}) as { hold?: unknown; reason?: unknown };
  const keep = hold !== false;
  const [row] = await db
    .update(matchReplays)
    .set(
      keep
        ? { tier: "hold", expiresAt: null }
        : { tier: "standard", expiresAt: sql`now() + interval '30 days'` }
    )
    .where(eq(matchReplays.matchKey, req.params.matchKey))
    .returning({ tier: matchReplays.tier, expiresAt: matchReplays.expiresAt });
  if (!row) {
    res.status(404).json({ error: "No replay for that match" });
    return;
  }
  await audit(req.admin!, {
    action: keep ? "replay.hold" : "replay.release",
    targetType: "match",
    targetId: req.params.matchKey,
    reason: typeof reason === "string" ? reason : null,
    after: row,
    ip: requestOrigin(req).ip,
  });
  res.json({ ok: true, ...row });
});
