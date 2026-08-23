// What a party looked like, recorded the way a match is.
//
// A match replay works because a match is fully described by its inputs. A
// party is simpler still: it is fully described by WHO WAS STANDING THERE, in
// what, and what they said. So this records exactly that — the member list
// whenever it changes, plus chat and emotes — and the console replays it
// through the game's own lobby scene. No video, no capture: a two-hour party
// is a few kilobytes, and it costs the players nothing.
//
// Two rules keep it free:
//
//   NOTHING IS WRITTEN WHEN NOTHING CHANGED. Every broadcast is fingerprinted
//   and compared with the last; a repeat returns without touching Redis. Most
//   broadcasts are repeats.
//   NOTHING IS AWAITED. Callers fire and forget. A party is a lobby, not a
//   match, but it is still somebody's screen.
//
// A session is a GROUP: it opens when a second person arrives and closes when
// the group falls apart. One player alone in their own lobby is not a party
// and is not recorded.
import { and, eq, isNull, sql } from "drizzle-orm";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { partySessions } from "../db/schema.js";
import { config } from "../config.js";
import { redis } from "../redis.js";
import { putEvidence } from "./evidence.js";

/** The open session for a lobby, and its event log. */
const openKey = (lobbyId: string) => `party:open:${lobbyId}`;
const logKey = (sessionKey: string) => `party:log:${sessionKey}`;
/** Last state fingerprint, so an unchanged broadcast costs one comparison. */
const signKey = (lobbyId: string) => `party:sign:${lobbyId}`;
/** A party cannot run for ever; the keys expire if a session is ever orphaned. */
const LIVE_TTL = 12 * 60 * 60;

export interface PartyMember {
  uid: string;
  name: string;
  character: string;
  weapon: string | null;
  isLeader: boolean;
  avatarUrl: string | null;
  /** A teammate from the server population (W3).
   *
   *  The CONSOLE is told and the players are not — the same line the Worlds
   *  screen draws, and for the same reason: a moderator reading a party has to
   *  know which of the four pedestals belongs to somebody they can act on.
   *  Absent on every member of every party recorded before W3, which reads
   *  correctly as "a person". */
  bot?: boolean;
}

/** How somebody came to be in the party. Worth recording because it is the
 *  first question about a group that turns out to matter: a party someone was
 *  INVITED into reads differently from one they walked into with a code. */
export type JoinVia = "code" | "invite" | "friend" | "request" | "self";

export type PartyEvent =
  /** Everyone in the party, as they were. The studio draws the last one at or
   *  before the moment it is showing. */
  | { t: number; k: "state"; mode: string; game: string | null; members: PartyMember[] }
  | { t: number; k: "chat"; uid: string; name: string; body: string }
  | { t: number; k: "emote"; uid: string; name: string; id: string }
  | { t: number; k: "join"; uid: string; name: string; via: JoinVia; by: string | null; byName: string | null }
  /** The group went off to play, and came back.
   *
   *  Between these two the lobby is frozen BY DESIGN: everyone standing in it
   *  is in a match, so nothing about the party changes and nothing is written.
   *  Without this pair the studio shows a still picture for ten minutes and an
   *  admin has no way to tell "nobody did anything" from "they were not here".
   *  It is the same match id the match studio is keyed by, so the recording of
   *  what they were actually doing is one click away. */
  | { t: number; k: "match"; phase: "start" | "end"; matchId: string; game: string | null }
  /** The party changed hands.
   *
   *  Worth its own line because it is the question an admin asks first when a
   *  party misbehaves — "who was running this at the time" — and the answer
   *  used to be unanswerable: leadership was the lobby's NAME, so a transfer
   *  ended one recording and started another, and the two were not visibly the
   *  same group. One recording now spans the whole life of the group, and this
   *  is where the crown moves inside it. */
  /** Somebody walked out. The member list in the next state shows it too, but
   *  only as an absence — and an absence does not say WHO left or when, which
   *  is the whole question when a party falls apart. */
  | { t: number; k: "leave"; uid: string; name: string; why: "left" | "kicked" | "quiet" | "dropped" }
  /** Opened or closed their microphone. Worth recording separately from what
   *  was actually SAID: a player who opens a mic and says nothing has still
   *  done something, and a player whose mic was shut cannot be responsible for
   *  what was heard. Neither is answerable from the audio alone. */
  | { t: number; k: "mic"; uid: string; name: string; on: boolean }
  /** Said they are ready to play what is picked, or took it back. Drawn as a
   *  tick beside their name, exactly as the squad saw it. */
  /** Went looking for a match, or stopped looking. The global log has this
   *  too, but a party's own recording is where the run-up to a match is read —
   *  and a search that was cancelled never becomes a match, so without this it
   *  leaves no trace in the one record that covers the group. */
  | { t: number; k: "search"; uid: string; name: string; on: boolean; game: string | null }
  | { t: number; k: "ready"; uid: string; name: string; on: boolean }
  /** The leader chose a game. The state carries the pick too, but only as a
   *  field that quietly changes; this says WHO changed it and when. */
  | { t: number; k: "pick"; uid: string; name: string; game: string | null }
  /** The group stopped being a group. Always the last event. */
  | { t: number; k: "end"; why: "empty" | "alone" }
  | {
      t: number;
      k: "leader";
      uid: string;
      name: string;
      fromUid: string | null;
      fromName: string | null;
      /** "handed" — the leader chose to. "left" — they walked out or dropped. */
      why: "handed" | "left";
    };

/** In-memory mirror of the open session per lobby, so the common path does not
 *  even ask Redis. Rebuilt lazily; Redis remains the truth across restarts. */
const openCache = new Map<string, { key: string; startedAt: number }>();

/** One queue per lobby, so writes about it land in the order they happened.
 *
 *  Everything here is deliberately fire-and-forget — a lobby broadcast must
 *  never wait on a log — but "not awaited" turned into "not ordered", and that
 *  lost the single most interesting event in a party's life. When the SECOND
 *  person arrives, two writes start at almost the same moment: the state that
 *  OPENS the recording, and the join that says how they got there. The join
 *  usually won, found no session open yet, and returned without writing. So
 *  every party began with the one arrival nobody could account for — the one
 *  that created the group.
 *
 *  A promise chain per lobby fixes it without making any caller wait: they all
 *  still return immediately, they just queue behind each other.
 */
const writes = new Map<string, Promise<unknown>>();

function inOrder(lobbyId: string, fn: () => Promise<void>): Promise<void> {
  const done = (writes.get(lobbyId) ?? Promise.resolve()).then(fn, fn);
  // The chain must never reject, or every later write for this lobby is
  // dropped with it.
  writes.set(
    lobbyId,
    done.catch((err: unknown) => console.error(`[party] write on ${lobbyId}:`, err))
  );
  // A party that has gone quiet should not keep a promise alive for ever.
  if (writes.size > 500) writes.clear();
  return done;
}

const RETENTION_DAYS = 10;

/** Called whenever a lobby's state is broadcast — which is exactly when
 *  something about it may have changed. */
export function noteLobbyState(
  lobbyId: string,
  mode: string,
  members: PartyMember[],
  game: string | null
): Promise<void> {
  return inOrder(lobbyId, async () => {
    // A group, not a person sitting alone in their own lobby.
    //
    // PEOPLE, not members. One player who asked the world for teammates and
    // got three from the server population is standing in a full squad — but
    // a party recording is a record of what people did with each other, and
    // opening one for every solo player who pressed "team up" would bury the
    // groups a moderator is actually looking for under thousands that have
    // nobody in them to look at. The bots still appear in the roster of a
    // party that IS a group; they simply cannot make one on their own.
    const isGroup = members.filter((m) => !m.bot).length >= 2;
    const open = await currentSession(lobbyId);

    if (!isGroup) {
      if (open) await closeSession(lobbyId, open.key, members);
      return;
    }

    const session = open ?? (await openSession(lobbyId));
    // The fingerprint is what makes this cheap: a broadcast that says the same
    // thing as the last one writes nothing at all, and most of them do.
    const sign = fingerprint(mode, game, members);
    const last = await redis.get(signKey(lobbyId));
    if (last === sign) return;
    await redis.set(signKey(lobbyId), sign, "EX", LIVE_TTL);
    await append(session, { t: Date.now() - session.startedAt, k: "state", mode, game, members });
  });
}

export function noteLobbyChat(lobbyId: string, uid: string, name: string, body: string): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "chat", uid, name, body });
  });
}

export function noteLobbyEmote(lobbyId: string, uid: string, name: string, id: string): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "emote", uid, name, id });
  });
}

/** How this person got here. Called after the move has landed, so the party
 *  session exists to write it to. */
export function noteLobbyJoin(
  lobbyId: string,
  uid: string,
  name: string,
  via: JoinVia,
  by: { uid: string; name: string } | null
): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, {
      t: Date.now() - open.startedAt,
      k: "join",
      uid,
      name,
      via,
      by: by?.uid ?? null,
      byName: by?.name ?? null,
    });
  });
}

/** The party went into a match, or came back out of one. Fire-and-forget like
 *  everything else here: a match starting must not wait on a party log. */
export function noteLobbyMatch(
  lobbyId: string,
  phase: "start" | "end",
  matchId: string,
  game: string | null
): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "match", phase, matchId, game });
  });
}

/** The party has a new leader. */
export function noteLobbyLeader(
  lobbyId: string,
  who: { uid: string; name: string; fromUid: string | null; fromName: string | null; why: "handed" | "left" }
): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "leader", ...who });
  });
}

/** Somebody walked out, and why. */
export function noteLobbyLeave(
  lobbyId: string,
  uid: string,
  name: string,
  why: "left" | "kicked" | "quiet" | "dropped"
): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "leave", uid, name, why });
  });
}

/** The party went looking for a match, or stopped. */
export function noteLobbySearch(
  lobbyId: string,
  uid: string,
  name: string,
  on: boolean,
  game: string | null
): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "search", uid, name, on, game });
  });
}

/** Somebody said they are ready, or took it back. */
export function noteLobbyReady(lobbyId: string, uid: string, name: string, on: boolean): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "ready", uid, name, on });
  });
}

/** The leader picked a game (or cleared the pick). */
export function noteLobbyPick(lobbyId: string, uid: string, name: string, game: string | null): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "pick", uid, name, game });
  });
}

/** A microphone was opened or closed. */
export function noteLobbyMic(lobbyId: string, uid: string, name: string, on: boolean): Promise<void> {
  return inOrder(lobbyId, async () => {
    const open = await currentSession(lobbyId);
    if (!open) return;
    await append(open, { t: Date.now() - open.startedAt, k: "mic", uid, name, on });
  });
}

// ---------------------------------------------------------------------------
// Invites
//
// An invite and the join it leads to are two separate events, minutes apart —
// the friend has to accept. So the invite is remembered briefly and looked up
// when they arrive, which is the only way "who invited whom" can be answered
// at all. One short-lived key per invite, written on a deliberate tap.
// ---------------------------------------------------------------------------
const inviteKey = (userId: string, lobbyId: string) => `party:invite:${userId}:${lobbyId}`;
/** Long enough for somebody to notice and accept, short enough that a join an
 *  hour later is not credited to a forgotten invite. */
const INVITE_TTL = 10 * 60;

export const noteInvite = (targetUserId: string, lobbyId: string, from: { uid: string; name: string }): Promise<unknown> =>
  redis.set(inviteKey(targetUserId, lobbyId), JSON.stringify(from), "EX", INVITE_TTL);

export async function takeInvite(targetUserId: string, lobbyId: string): Promise<{ uid: string; name: string } | null> {
  const raw = await redis.get(inviteKey(targetUserId, lobbyId));
  if (!raw) return null;
  await redis.del(inviteKey(targetUserId, lobbyId));
  return JSON.parse(raw) as { uid: string; name: string };
}

/** The session key for a lobby, if one is open. Also what voice recording
 *  attaches to, so the audio and the simulation share one timeline. */
export async function currentSession(lobbyId: string): Promise<{ key: string; startedAt: number } | null> {
  const cached = openCache.get(lobbyId);
  if (cached) return cached;
  const raw = await redis.get(openKey(lobbyId));
  if (!raw) return null;
  const [key, startedAt] = raw.split("|");
  const found = { key, startedAt: Number(startedAt) };
  openCache.set(lobbyId, found);
  return found;
}

async function openSession(lobbyId: string): Promise<{ key: string; startedAt: number }> {
  const key = `party-${randomUUID().slice(0, 12)}`;
  const startedAt = Date.now();
  await db.insert(partySessions).values({ key, room: lobbyId, roster: [], events: [] });
  await redis.set(openKey(lobbyId), `${key}|${startedAt}`, "EX", LIVE_TTL);
  openCache.set(lobbyId, { key, startedAt });
  return { key, startedAt };
}

/** The group has dissolved. The log is packed into one small object and the
 *  row points at it; the live keys go away. */
async function closeSession(lobbyId: string, key: string, members: PartyMember[]): Promise<void> {
  openCache.delete(lobbyId);
  await redis.del(openKey(lobbyId), signKey(lobbyId));
  const raw = await redis.lrange(logKey(key), 0, -1);
  await redis.del(logKey(key));
  const events = raw.map((r) => JSON.parse(r) as PartyEvent);
  // A last state, so the studio shows the party emptying rather than freezing
  // on the moment before — and then a line saying so in words, because a
  // recording that simply stops looks the same as one that was cut off.
  const startedAt = (await sessionStart(key)) ?? Date.now();
  events.push({ t: Date.now() - startedAt, k: "state", mode: "solo", game: null, members });
  events.push({ t: Date.now() - startedAt, k: "end", why: members.length === 1 ? "alone" : "empty" });

  const roster = rosterOf(events);
  const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, events }), "utf8"));
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const r2Key = `parties/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${key}.json.gz`;
  try {
    await putEvidence(r2Key, body, "application/gzip");
  } catch (err) {
    console.error(`[party] could not store ${key}:`, err);
  }
  await db
    .update(partySessions)
    .set({
      endedAt: sql`now()`,
      roster,
      events: [],
      r2Key,
      bytes: body.length,
      eventCount: events.length,
      expiresAt: new Date(Date.now() + RETENTION_DAYS * 86_400_000),
    })
    .where(eq(partySessions.key, key));
}

async function sessionStart(key: string): Promise<number | null> {
  const [row] = await db.select({ at: partySessions.startedAt }).from(partySessions).where(eq(partySessions.key, key));
  return row ? new Date(row.at).getTime() : null;
}

/** Everyone who was ever in it, with the name they had at the time. Derived
 *  from the log rather than tracked separately: one source, no drift. */
function rosterOf(events: PartyEvent[]): { uid: string; username: string | null; firstSeen: number }[] {
  const seen = new Map<string, { uid: string; username: string | null; firstSeen: number }>();
  for (const e of events) {
    if (e.k !== "state") continue;
    for (const m of e.members) {
      if (!seen.has(m.uid)) seen.set(m.uid, { uid: m.uid, username: m.name, firstSeen: e.t });
    }
  }
  return [...seen.values()];
}

const fingerprint = (mode: string, game: string | null, members: PartyMember[]): string =>
  `${mode}|${game ?? "-"}|` +
  members
    .map((m) => `${m.uid}:${m.character}:${m.weapon ?? "-"}:${m.isLeader ? 1 : 0}`)
    .sort()
    .join(",");

async function append(session: { key: string; startedAt: number }, event: PartyEvent): Promise<void> {
  await redis.rpush(logKey(session.key), JSON.stringify(event));
  await redis.expire(logKey(session.key), LIVE_TTL);
}

/** The log of a session that is still running. */
export async function liveEvents(key: string): Promise<PartyEvent[]> {
  const raw = await redis.lrange(logKey(key), 0, -1);
  return raw.map((r) => JSON.parse(r) as PartyEvent);
}

/** Retention: party simulations are kept for ten days, like a short-lived
 *  match replay, and then they go. Same rule as everything else here — by
 *  expiry, never by hand. */
export async function sweepParties(limit = 200): Promise<number> {
  const { deleteEvidence } = await import("./evidence.js");
  const due = await db
    .select({ id: partySessions.id, key: partySessions.r2Key })
    .from(partySessions)
    .where(and(sql`${partySessions.expiresAt} is not null`, sql`${partySessions.expiresAt} <= now()`))
    .limit(limit);
  if (due.length === 0) return 0;
  await deleteEvidence(due.map((d) => d.key).filter((k): k is string => !!k));
  for (const d of due) await db.delete(partySessions).where(eq(partySessions.id, d.id));
  console.log(`✔ Swept ${due.length} expired party recording(s)`);
  return due.length;
}

/** Sessions still marked live at boot cannot be — nobody is in them. Closed so
 *  the console never shows a party that ended when the server did. */
export async function closeStaleParties(): Promise<number> {
  const open = await db
    .select({ key: partySessions.key, room: partySessions.room })
    .from(partySessions)
    .where(isNull(partySessions.endedAt));
  let closed = 0;
  for (const row of open) {
    if (await redis.exists(openKey(row.room))) continue;
    await closeSession(row.room, row.key, []);
    closed++;
  }
  if (closed > 0) console.log(`✔ Closed ${closed} party recording(s) left open by a previous run`);
  return closed;
}

export const partyRetentionDays = RETENTION_DAYS;
export const partyEnabled = () => config.voiceRecording.partyReplays;
