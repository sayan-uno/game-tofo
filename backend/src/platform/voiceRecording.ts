// Deciding whose voice gets recorded.
//
// The DECIDING lives here — who is flagged, whether this room is one of
// theirs, whether there is budget left, and when it stops. The CAPTURING lives
// in the recorder process (src/recorder), which sits in the room as a hidden
// participant and writes the files itself.
//
// It used to ask LiveKit's egress to do the capturing. That was replaced
// because egress concurrency is capped per project — two sessions on the free
// plan, five hundred at $500 a month — and a moderation feature whose ceiling
// is somebody else's price list has a cliff in it. A recorder's only limit is
// CPU, and mixing audio is arithmetic.
//
// Three guards, and none of them is optional:
//
//   OFF BY DEFAULT. Recording a flagged player necessarily records everyone in
//   the room with them. It does not switch on by being forgotten.
//   NO BUCKET, NO RECORDING. Rather than record with nowhere to keep it, it
//   refuses and says which piece is missing.
//   BUDGETED. A flag expires by time AND by match count, because this is the
//   one feature here that keeps costing while nobody is watching.
//
// Two kinds of room, and the console always says which a recording came from:
//
//   MATCH  — decided once when the match is assembled; spends a match of the
//            flag's budget.
//   LOBBY  — decided whenever the party's membership changes; spends no
//            budget, because a party is not a match. Bounded instead by the
//            flag's own expiry and by a ceiling on one recording's length,
//            since a match ends by itself and a party does not.
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { recordingTargets, users, voiceRecordings } from "../db/schema.js";
import { config } from "../config.js";
import { redis } from "../redis.js";
import { evidenceBackend } from "./evidence.js";
import { matchVoiceRoom } from "./voice.js";
import { getLobbyMembers } from "../redis.js";
import { currentSession } from "./partyLog.js";
import {
  isSessionRegistered,
  recorderHealth,
  registerSession,
  setSessionAnchor,
  unregisterSession,
} from "../recorder/registry.js";

/** Everyone currently flagged. One Redis set, read once per match. */
const TARGET_SET = "rec:voice";
const matchKey = (matchId: string) => `rec:match:${matchId}`;
/** A recordable match is marked for as long as a match can plausibly run. */
const MATCH_TTL = 3 * 60 * 60;

/** Everything that has to be true before a single byte is recorded. Checked
 *  here rather than at each call site so there is one answer to "why not". */
export function readiness(): { ready: boolean; why: string } {
  if (!config.voiceRecording.enabled) return { ready: false, why: "VOICE_RECORDING_ENABLED is not true" };
  const { url, apiKey, apiSecret } = config.livekit;
  if (!url || !apiKey || !apiSecret) return { ready: false, why: "LiveKit is not configured" };
  if (evidenceBackend() !== "r2") return { ready: false, why: "no evidence bucket — R2_EVIDENCE_* is unset" };
  return { ready: true, why: "" };
}

/** Readiness plus the one thing only the recorder can answer: is anybody there
 *  to do the recording? Asked by the console, which must not tell an admin
 *  that recording is armed when the process that does it is down. */
export async function fullReadiness(): Promise<{ ready: boolean; why: string; recorder: { alive: boolean; sessions: number } }> {
  const base = readiness();
  const health = await recorderHealth().catch(() => ({ alive: false, sessions: 0, at: null }));
  if (!base.ready) return { ...base, recorder: health };
  if (!health.alive) return { ready: false, why: "the recorder process is not running", recorder: health };
  return { ready: true, why: "", recorder: health };
}

// ---------------------------------------------------------------------------
// Who is flagged
// ---------------------------------------------------------------------------

/** Rebuilt at boot from the record, for the same reason the ban cache is. */
export async function warmVoiceTargets(): Promise<number> {
  const rows = await db
    .selectDistinct({ userId: recordingTargets.userId })
    .from(recordingTargets)
    .where(
      and(
        eq(recordingTargets.kind, "voice"),
        isNull(recordingTargets.revokedAt),
        gt(recordingTargets.expiresAt, sql`now()`),
        sql`${recordingTargets.matchesUsed} < ${recordingTargets.maxMatches}`
      )
    );
  await redis.del(TARGET_SET);
  if (rows.length > 0) await redis.sadd(TARGET_SET, ...rows.map((r) => r.userId));
  return rows.length;
}

export const flagVoiceTarget = (userId: string): Promise<number> => redis.sadd(TARGET_SET, userId);
export const unflagVoiceTarget = (userId: string): Promise<number> => redis.srem(TARGET_SET, userId);

/** One Redis round trip against a set that is empty for almost every match. */
export async function anyFlagged(userIds: string[]): Promise<boolean> {
  if (userIds.length === 0) return false;
  try {
    return (await redis.smismember(TARGET_SET, ...userIds)).some((f) => f === 1);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/** Called when a match is assembled: registers it for the recorder to join,
 *  and spends one match of each flagged player's budget. */
export async function considerMatch(matchId: string, userIds: string[]): Promise<boolean> {
  if (!readiness().ready) return false;
  if (!(await anyFlagged(userIds))) return false;

  // The mark goes down FIRST and the budget is spent after it. Match creation
  // calls this without awaiting — it must not put a database write on the path
  // that starts a match — so the recorder may act at any moment, and the only
  // thing it needs is the registration.
  await redis.set(matchKey(matchId), "1", "EX", MATCH_TTL);
  await registerSession({
    key: matchId,
    room: matchVoiceRoom(matchId),
    scope: "match",
    // Not known yet: tick 0 lands when the countdown finishes, and the anchor
    // is filled in then (see noteMatchStart). The recorder re-reads it.
    anchor: null,
    at: Date.now(),
  });

  // Budget is spent per MATCH, not per participant: one table is one unit of
  // "we watched this person play", however many people were at it.
  const spent = await db
    .update(recordingTargets)
    .set({ matchesUsed: sql`${recordingTargets.matchesUsed} + 1` })
    .where(
      and(
        eq(recordingTargets.kind, "voice"),
        isNull(recordingTargets.revokedAt),
        gt(recordingTargets.expiresAt, sql`now()`),
        // inArray, never a raw fragment built by string concatenation. These
        // are our own UUIDs today, but a query assembled that way is one the
        // next person copies somewhere the values are not.
        inArray(recordingTargets.userId, userIds),
        sql`${recordingTargets.matchesUsed} < ${recordingTargets.maxMatches}`
      )
    )
    .returning({ userId: recordingTargets.userId, used: recordingTargets.matchesUsed, max: recordingTargets.maxMatches });
  // A flag that has just spent its last match stops applying immediately,
  // rather than at the next boot.
  for (const row of spent) if (row.used >= row.max) await unflagVoiceTarget(row.userId);
  return true;
}

/** The countdown has set tick 0. Every recording in this match is placed
 *  relative to it, which is what lets the studio lay sound over the replay. */
export async function noteMatchStart(matchId: string, startAt: number): Promise<void> {
  await setSessionAnchor(matchId, startAt).catch(() => undefined);
}

/** The same decision for a room whose roster is NOT settled when it opens.
 *
 *  A match asks once, at assembly, because everybody who will ever be in it is
 *  already in it. A drop-in world cannot: people walk in for forty minutes,
 *  and the flagged player may be the fourteenth through the door. So this is
 *  asked on every arrival, and is written to be cheap in the case that is
 *  almost all of them — one Redis read against a set that is usually empty,
 *  and then nothing.
 *
 *  Once armed, it STAYS armed for the life of the room. Everybody else in
 *  there is only being recorded because of who they are standing with, but the
 *  flagged player leaving does not un-say what was already said, and stopping
 *  halfway would leave a file that ends mid-sentence for no reason anybody
 *  reading it later could reconstruct.
 *
 *  Budget is spent ONCE per room, on the arming, exactly as a match spends one
 *  unit however many people were at the table. */
export async function considerRoom(
  key: string,
  userIds: string[],
  opts: { already: boolean; anchor: number | null }
): Promise<boolean> {
  if (!readiness().ready) return false;
  if (!(await anyFlagged(userIds))) return opts.already;
  if (opts.already || (await isSessionRegistered(key))) return true;

  await redis.set(matchKey(key), "1", "EX", MATCH_TTL);
  await registerSession({
    key,
    room: matchVoiceRoom(key),
    scope: "match",
    anchor: opts.anchor,
    at: Date.now(),
  });
  const spent = await db
    .update(recordingTargets)
    .set({ matchesUsed: sql`${recordingTargets.matchesUsed} + 1` })
    .where(
      and(
        eq(recordingTargets.kind, "voice"),
        isNull(recordingTargets.revokedAt),
        gt(recordingTargets.expiresAt, sql`now()`),
        inArray(recordingTargets.userId, userIds),
        sql`${recordingTargets.matchesUsed} < ${recordingTargets.maxMatches}`
      )
    )
    .returning({ userId: recordingTargets.userId, used: recordingTargets.matchesUsed, max: recordingTargets.maxMatches });
  for (const row of spent) if (row.used >= row.max) await unflagVoiceTarget(row.userId);
  return true;
}

export const isRecordable = async (matchId: string): Promise<boolean> =>
  (await redis.get(matchKey(matchId))) === "1";

export const forgetMatch = (matchId: string): Promise<number> => redis.del(matchKey(matchId));

/** The match is over. The recorder finishes and uploads its files; the rows
 *  are closed by whoever wrote them. */
export async function stopForMatch(matchId: string): Promise<void> {
  await unregisterSession(matchId);
  await forgetMatch(matchId);
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/** Called after ANY change to a party's membership.
 *
 *  A party has no moment of assembly — people drift in and out of it for as
 *  long as they like — so there is nothing to decide *at*, and the question is
 *  asked whenever the answer could have changed: is anybody in this party
 *  flagged, right now? One Redis read of the membership, one of the flag set,
 *  and for almost every party the answer is no and nothing happens.
 *
 *  It is also what STOPS a party recording: everyone else in the room was only
 *  ever recorded because of who they were sitting with, so when the flagged
 *  player leaves, so does the recorder. */
export async function syncLobbyRecording(lobbyId: string): Promise<void> {
  // Switched off: not one byte of work, not one round trip. This runs on every
  // party change on the platform, so the OFF path has to cost nothing at all.
  if (!readiness().ready) return;

  // The party's own session — opened by the simulation log, which records
  // every group whether or not anybody is flagged. Voice attaches to it, so
  // the audio and the simulation share one id and one clock, and the studio
  // can lay one over the other.
  const party = await currentSession(lobbyId);
  if (!party) return;

  const members = await getLobbyMembers(lobbyId);
  if (!(await anyFlagged(members))) {
    // The ordinary party, which is nearly all of them.
    if (await isSessionRegistered(party.key)) await unregisterSession(party.key);
    return;
  }
  if (await isSessionRegistered(party.key)) return;

  await registerSession({
    key: party.key,
    room: lobbyId,
    scope: "lobby",
    // The simulation's zero, so voice sits on the same timeline as the party
    // it belongs to rather than starting its own.
    anchor: party.startedAt,
    roster: await rosterOf(members),
    memberIds: members,
    at: Date.now(),
  });
}

/** Names for a set of user ids, snapshotted — a username can change, and the
 *  record should say who they were at the time. */
async function rosterOf(userIds: string[]): Promise<{ uid: string; username: string | null }[]> {
  if (userIds.length === 0) return [];
  return db.select({ uid: users.uid, username: users.username }).from(users).where(inArray(users.id, userIds));
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Delete recordings whose retention has run out — by expiry only, never by
 *  hand, exactly like replays. Voice is the most sensitive thing the platform
 *  holds, so keeping it a day longer than promised is its own kind of wrong. */
export async function sweepVoice(limit = 200): Promise<number> {
  const { deleteEvidence } = await import("./evidence.js");
  const due = await db
    .select({ id: voiceRecordings.id, key: voiceRecordings.r2Key })
    .from(voiceRecordings)
    .where(and(sql`${voiceRecordings.expiresAt} is not null`, sql`${voiceRecordings.expiresAt} <= now()`))
    .limit(limit);
  if (due.length === 0) return 0;
  await deleteEvidence(due.map((d) => d.key));
  for (const d of due) await db.delete(voiceRecordings).where(eq(voiceRecordings.id, d.id));
  console.log(`✔ Swept ${due.length} expired voice recording(s)`);
  return due.length;
}

/** Audio in the bucket that no row points at.
 *
 *  Retention deletes recordings by their expiry date, and that date lives on
 *  the row — so a file whose row is gone has no expiry and would sit there for
 *  ever. In an evidence store that is not untidiness, it is a promise broken:
 *  the Terms say recordings are deleted after so many days, and this is what
 *  makes that true of every file rather than most of them.
 *
 *  Only files older than a day are considered, so a recording being written
 *  right now — whose row is written first, but only just — is never mistaken
 *  for litter. */
export async function sweepOrphanAudio(limit = 500, olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const { listEvidence, deleteEvidence } = await import("./evidence.js");
  const objects = await listEvidence("voice/", limit);
  const old = objects.filter((o) => Date.now() - o.at > olderThanMs);
  if (old.length === 0) return 0;
  const keys = old.map((o) => o.key);
  const known = new Set(
    (await db.select({ key: voiceRecordings.r2Key }).from(voiceRecordings).where(inArray(voiceRecordings.r2Key, keys)))
      .map((r) => r.key)
  );
  const orphans = keys.filter((k) => !known.has(k));
  if (orphans.length === 0) return 0;
  await deleteEvidence(orphans);
  console.log(`✔ Swept ${orphans.length} audio file(s) that no record pointed at`);
  return orphans.length;
}
