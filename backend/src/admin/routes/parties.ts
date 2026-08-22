// Recorded parties: the list, and one session in full.
//
// A match has a replay to lay voices over. A party has this instead — who was
// there, when each of them arrived and left, and what was said while they
// were. Without it a party recording is a pile of files with no shape: the
// console showed exactly that, and it was unreadable.
import { desc, eq, inArray, sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import { db } from "../../db/client.js";
import { partySessions, voiceRecordings } from "../../db/schema.js";
import { requestOrigin } from "../../services/clientIp.js";
import { loadSessionVoice } from "../sessionVoice.js";
import { getEvidence } from "../../platform/evidence.js";
import { liveEvents, type PartyEvent } from "../../platform/partyLog.js";
import { publicCatalog } from "../../services/catalog.js";
import { config } from "../../config.js";
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin } from "../guard.js";
import { audit } from "../audit.js";

export const partiesRouter = safeRouter();

partiesRouter.get("/parties", requireAdmin("moderator"), async (req, res) => {
  const uid = typeof req.query.uid === "string" ? req.query.uid.trim() : "";
  // Search by the party's OWN id — the one the activity log prints the moment
  // the group is created, so "who started P3f2…" is a copy, a paste and an
  // answer. Matches either name it goes by: the id of the group itself, and
  // the key of the recording made of it.
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const rows = await db
    .select()
    .from(partySessions)
    // A party lands on a player's page if they were EVER in it, even for two
    // minutes of two hours — which is exactly the case an admin is looking
    // for and would otherwise never find.
    .where(
      uid
        ? sql`${partySessions.roster} @> ${JSON.stringify([{ uid }])}::jsonb`
        : q
          ? sql`${partySessions.room} ilike ${`%${q}%`} or ${partySessions.key} ilike ${`%${q}%`}`
          : sql`true`
    )
    .orderBy(desc(partySessions.startedAt))
    .limit(50);
  if (rows.length === 0) {
    res.json({ parties: [] });
    return;
  }

  // Whether each one has audio, in one query rather than one per party.
  const heard = await db
    .select({ key: voiceRecordings.matchKey, files: sql<number>`count(*)::int` })
    .from(voiceRecordings)
    .where(inArray(voiceRecordings.matchKey, rows.map((r) => r.key)))
    .groupBy(voiceRecordings.matchKey);
  const byKey = new Map(heard.map((c) => [c.key, c.files]));

  res.json({
    parties: rows.map((r) => {
      const roster = (r.roster as { uid: string; username: string | null; firstSeen?: number }[]) ?? [];
      return {
        key: r.key,
        // The group's own id, which outlives every leader it has and every
        // member who passes through it.
        room: r.room,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        live: r.endedAt === null,
        roster,
        members: roster.length,
        voiceFiles: byKey.get(r.key) ?? 0,
        // Where in the party this player first appears, so their page can open
        // the studio at the moment they walked in.
        joinedAt: uid ? (roster.find((p) => p.uid === uid)?.firstSeen ?? 0) : 0,
        seconds: r.endedAt
          ? Math.round((new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)
          : Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000),
      };
    }),
  });
});

partiesRouter.get("/parties/:key", requireAdmin("moderator"), async (req, res) => {
  const [row] = await db.select().from(partySessions).where(eq(partySessions.key, req.params.key));
  if (!row) {
    res.status(404).json({ error: "No such party" });
    return;
  }

  // A live party is read from Redis, a finished one from the bucket. Same
  // shape either way, so the studio does not care which it is looking at —
  // which is what lets an admin watch a party that is still happening and
  // still scrub back through its past.
  const live = row.endedAt === null;
  let events: PartyEvent[] = [];
  if (live) {
    events = await liveEvents(row.key);
  } else if (row.r2Key) {
    const packed = await getEvidence(row.r2Key);
    if (packed) events = (JSON.parse(gunzipSync(packed).toString("utf8")) as { events: PartyEvent[] }).events;
  }

  // Audio is admin-and-above, exactly as everywhere else: a moderator can see
  // who was in a party without hearing them.
  const privileged = req.admin!.role === "admin" || req.admin!.role === "owner";
  const voice = privileged ? await loadSessionVoice(row.key) : [];

  await audit(req.admin!, {
    action: voice.length > 0 ? "voice.play" : "replay.open",
    targetType: "party",
    targetId: row.key,
    after: { files: voice.length, live },
    ip: requestOrigin(req).ip,
  });

  res.json({
    party: {
      key: row.key,
      room: row.room,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      live,
      roster: row.roster,
      expiresAt: row.expiresAt,
    },
    events,
    voice,
    canHear: privileged,
    // The character/weapon catalog, for the same reason the match studio needs
    // it: models live in the platform catalog, not in a game pack.
    catalog: publicCatalog(),
    cdnBase: config.cdnBaseUrl || null,
  });
});
