// Deciding to record somebody, and listening to what came back.
//
// This is the most intrusive thing the console can do, and the code is shaped
// to say so: it is admin-and-above, it is behind sudo, it demands a written
// reason, it is budgeted in both time and matches, every use is audited, and
// every one of them raises an alert. Playing a recording back is audited
// separately from starting one, because listening is its own act.
//
// The link a browser gets is signed and lives sixty seconds. Nothing in the
// evidence bucket is ever public.
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { matchReplays, matches, recordingTargets, users, voiceRecordings } from "../../db/schema.js";
import { config } from "../../config.js";
import { requestOrigin } from "../../services/clientIp.js";
import { evidenceUrl, getEvidence } from "../../platform/evidence.js";
import { flagVoiceTarget, fullReadiness, unflagVoiceTarget } from "../../platform/voiceRecording.js";
import { partyRetentionDays } from "../../platform/partyLog.js";
import { loadSessionVoice } from "../sessionVoice.js";
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
import { alert } from "../alerts.js";

export const voiceRouter = safeRouter();

/** Anything longer than this and a flag stops being a decision and starts
 *  being a habit. Also the thing that bounds the bill. */
const MAX_DAYS = 30;
const MAX_MATCHES = 100;

// ---- can we even? ---------------------------------------------------------

voiceRouter.get("/voice/status", requireAdmin("moderator"), async (_req, res) => {
  const [{ live }] = await db
    .select({ live: sql<number>`count(*)::int` })
    .from(voiceRecordings)
    .where(sql`${voiceRecordings.status} in ('starting','active')`);
  // Asks the recorder as well: telling an admin that recording is armed when
  // the process that records is down is exactly the lie this screen exists to
  // prevent.
  const state = await fullReadiness();
  res.json({
    ready: state.ready,
    why: state.why,
    running: live,
    recorder: state.recorder,
    maxConcurrent: config.recorder.maxSessions,
    separateTracks: config.voiceRecording.separateTracks,
    mixEnabled: config.voiceRecording.mixEnabled,
    retentionDays: config.voiceRecording.retentionDays,
    partyRetentionDays,
  });
});

// ---- who is being recorded ------------------------------------------------

voiceRouter.get("/voice/targets", requireAdmin("moderator"), async (_req, res) => {
  const rows = await db
    .select({
      id: recordingTargets.id,
      uid: users.uid,
      username: users.username,
      reason: recordingTargets.reason,
      createdAt: recordingTargets.createdAt,
      expiresAt: recordingTargets.expiresAt,
      maxMatches: recordingTargets.maxMatches,
      matchesUsed: recordingTargets.matchesUsed,
    })
    .from(recordingTargets)
    .innerJoin(users, eq(users.id, recordingTargets.userId))
    .where(
      and(
        eq(recordingTargets.kind, "voice"),
        isNull(recordingTargets.revokedAt),
        gt(recordingTargets.expiresAt, sql`now()`)
      )
    )
    .orderBy(desc(recordingTargets.createdAt));
  res.json({ targets: rows });
});

voiceRouter.post("/players/:uid/voice", requireAdmin("admin"), requireSudo, async (req, res) => {
  const state = await fullReadiness();
  if (!state.ready) {
    res.status(409).json({ error: `Voice recording is not available: ${state.why}`, code: "NOT_READY" });
    return;
  }
  const { reason, days, matches } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof reason !== "string" || reason.trim().length < 10) {
    res.status(400).json({ error: "Give a real reason — this records everyone at their table, and the reason is the record of why" });
    return;
  }
  const forDays = Math.min(MAX_DAYS, Math.max(1, Number(days ?? 7)));
  const forMatches = Math.min(MAX_MATCHES, Math.max(1, Number(matches ?? 20)));

  const [user] = await db.select().from(users).where(eq(users.uid, req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No player with that UID" });
    return;
  }
  const [already] = await db
    .select({ id: recordingTargets.id })
    .from(recordingTargets)
    .where(
      and(
        eq(recordingTargets.userId, user.id),
        eq(recordingTargets.kind, "voice"),
        isNull(recordingTargets.revokedAt),
        gt(recordingTargets.expiresAt, sql`now()`)
      )
    );
  if (already) {
    res.status(409).json({ error: "That player is already being recorded" });
    return;
  }

  const expiresAt = new Date(Date.now() + forDays * 86_400_000);
  const [row] = await db
    .insert(recordingTargets)
    .values({
      userId: user.id,
      kind: "voice",
      reason: reason.trim(),
      createdBy: req.admin!.id,
      expiresAt,
      maxMatches: forMatches,
    })
    .returning({ id: recordingTargets.id });
  await flagVoiceTarget(user.id);

  await audit(req.admin!, {
    action: "voice.start",
    targetType: "user",
    targetId: user.uid,
    reason: reason.trim(),
    after: { targetId: row.id, days: forDays, matches: forMatches, until: expiresAt.toISOString() },
    ip: requestOrigin(req).ip,
  });
  alert(
    `🎙️ TOFO: voice recording STARTED on ${user.username ?? user.uid}\n` +
      `by ${req.admin!.email}\nfor ${forDays} days or ${forMatches} matches\nreason: ${reason.trim()}`
  );
  res.json({ ok: true, id: row.id, expiresAt, maxMatches: forMatches });
});

voiceRouter.delete("/voice/targets/:id", requireAdmin("admin"), requireSudo, async (req, res) => {
  const [row] = await db
    .update(recordingTargets)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(recordingTargets.id, req.params.id), isNull(recordingTargets.revokedAt)))
    .returning({ userId: recordingTargets.userId });
  if (!row) {
    res.status(404).json({ error: "No such recording flag, or it was already stopped" });
    return;
  }
  await unflagVoiceTarget(row.userId);
  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  await audit(req.admin!, { action: "voice.stop", targetType: "user", targetId: user?.uid ?? row.userId, ip: requestOrigin(req).ip });
  alert(`🎙️ TOFO: voice recording STOPPED on ${user?.username ?? row.userId} by ${req.admin!.email}`);
  res.json({ ok: true });
});

// ---- the library ----------------------------------------------------------

/** The audio itself, through this process rather than as a link to the bucket.
 *
 *  Deliberate: the studio has to ANALYSE the sound to show who is talking, and
 *  a browser refuses to analyse cross-origin audio unless the bucket serves
 *  CORS headers for the console. Rather than open an evidence bucket up to a
 *  browser origin, the bytes come through here — authenticated, audited, and
 *  on the admin process, which by design carries no player traffic.
 *
 *  Small files: a match mix is a few megabytes. The console fetches this with
 *  its bearer token and plays it from a blob, so seeking is instant. */
voiceRouter.get("/voice/recordings/:id/audio", requireAdmin("admin"), async (req, res) => {
  const [row] = await db.select().from(voiceRecordings).where(eq(voiceRecordings.id, req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such recording" });
    return;
  }
  const bytes = await getEvidence(row.r2Key);
  if (!bytes) {
    res.status(410).json({ error: "That file is no longer in the archive", code: "GONE" });
    return;
  }
  await audit(req.admin!, {
    action: "voice.play",
    targetType: "recording",
    targetId: row.id,
    after: { uid: row.uid, kind: row.kind, session: row.matchKey },
    ip: requestOrigin(req).ip,
  });
  res.setHeader("Content-Type", "audio/ogg");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(bytes);
});
