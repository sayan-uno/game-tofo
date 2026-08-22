// The audio that belongs to one session — a match or a party — ready to play.
//
// Shared by the studio (which lays it over the replay) and the player page
// (which lists what has been recorded of somebody). One place, because "what
// audio exists for this session, and where does each piece start" is one
// question however it is asked.
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, voiceRecordings } from "../db/schema.js";
import { evidenceUrl } from "../platform/evidence.js";

export interface SessionVoice {
  id: string;
  kind: "track" | "mix";
  scope: "match" | "lobby";
  uid: string;
  username: string | null;
  /** Milliseconds from the session's start — for a match, from tick 0. */
  offsetMs: number;
  durationSec: number | null;
  bytes: number | null;
  startedAt: string;
  url: string | null;
  roster: { uid: string; username: string | null }[] | null;
  /** [startMs, endMs] pairs on the session's timeline: when this person was
   *  actually talking, measured while recording. */
  speech: [number, number][] | null;
}

/** Signed links live an hour rather than the usual minute: a studio session is
 *  long, and a link that dies halfway through a replay takes the audio with it
 *  the moment somebody seeks. The bucket is private either way — this is the
 *  only door out of it, and every use of it is audited by the caller. */
const PLAYBACK_TTL = 3600;

export async function loadSessionVoice(key: string): Promise<SessionVoice[]> {
  const rows = await db
    .select({
      id: voiceRecordings.id,
      kind: voiceRecordings.kind,
      scope: voiceRecordings.scope,
      uid: voiceRecordings.uid,
      username: users.username,
      offsetMs: voiceRecordings.offsetMs,
      durationSec: voiceRecordings.durationSec,
      bytes: voiceRecordings.bytes,
      startedAt: voiceRecordings.startedAt,
      r2Key: voiceRecordings.r2Key,
      roster: voiceRecordings.roster,
      speech: voiceRecordings.speech,
    })
    .from(voiceRecordings)
    .leftJoin(users, eq(users.id, voiceRecordings.userId))
    .where(and(eq(voiceRecordings.matchKey, key), eq(voiceRecordings.status, "complete")))
    .orderBy(asc(voiceRecordings.startedAt));

  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      kind: r.kind as "track" | "mix",
      scope: r.scope as "match" | "lobby",
      uid: r.uid,
      username: r.username,
      offsetMs: r.offsetMs ?? 0,
      durationSec: r.durationSec,
      bytes: r.bytes,
      startedAt: r.startedAt.toISOString(),
      url: await evidenceUrl(r.r2Key, PLAYBACK_TTL),
      roster: (r.roster as { uid: string; username: string | null }[] | null) ?? null,
      speech: (r.speech as [number, number][] | null) ?? null,
    }))
  );
}
