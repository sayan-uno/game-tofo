// Which rooms are being recorded, as a fact rather than as a message.
//
// The game process decides (who is flagged, budget, roster) and writes the
// answer here; the recorder reads it and makes reality match. Two channels of
// the same truth:
//
//   a Redis HASH  — durable. If the recorder is restarting, deploying or
//                   briefly dead when a match starts, the session is still
//                   written down and gets picked up on the next sweep.
//   a pub/sub nudge — an optimisation, so the usual case is instant instead of
//                   waiting for the sweep.
//
// That ordering is deliberate. A recorder that learns only from pub/sub misses
// every session that began while it was down, and nobody notices until an
// admin opens a match and finds silence.
import { redis } from "../redis.js";

/** Field per session. Long TTL is not available on hash fields, so stale
 *  entries are pruned by the recorder when their room turns out to be gone. */
const SESSIONS = "rec:sessions";
const CHANNEL = "rec:cmd";

export interface RecordedSession {
  /** Match id or lobby id — what the recording belongs to. */
  key: string;
  /** The LiveKit room to sit in. */
  room: string;
  scope: "match" | "lobby";
  /** Wall clock the session's timeline starts from: for a match, the instant
   *  tick 0 lands, so audio can be laid over the replay. Null until the
   *  countdown has set it — the recorder re-reads this when it opens a file. */
  anchor: number | null;
  /** Parties only: who was in the group when recording began. */
  roster?: { uid: string; username: string | null }[];
  /** Who was in the party when this was written, as user ids. Kept so a later
   *  membership change can tell "nothing to do" from "somebody new arrived"
   *  without going back to the database. */
  memberIds?: string[];
  /** When this was registered, so a session can be aged out. */
  at: number;
}

export async function registerSession(s: RecordedSession): Promise<void> {
  await redis.hset(SESSIONS, s.key, JSON.stringify(s));
  await redis.publish(CHANNEL, JSON.stringify({ kind: "start", key: s.key }));
}

/** Update the timeline anchor once it is known (a match learns it at the
 *  countdown, after the session was already registered). */
export async function setSessionAnchor(key: string, anchor: number): Promise<void> {
  const raw = await redis.hget(SESSIONS, key);
  if (!raw) return;
  const s = JSON.parse(raw) as RecordedSession;
  if (s.anchor !== null) return;
  s.anchor = anchor;
  await redis.hset(SESSIONS, key, JSON.stringify(s));
}

/** Only nudges the recorder if there was actually something to stop.
 *
 *  This is called on EVERY change to EVERY party's membership, and virtually
 *  none of them are being recorded. Publishing regardless would wake every
 *  recorder in the fleet each time anybody joined any lobby, to tell it about
 *  a session that never existed. */
export async function unregisterSession(key: string): Promise<void> {
  const removed = await redis.hdel(SESSIONS, key);
  if (removed > 0) await redis.publish(CHANNEL, JSON.stringify({ kind: "stop", key }));
}

export async function getSession(key: string): Promise<RecordedSession | null> {
  const raw = await redis.hget(SESSIONS, key);
  return raw ? (JSON.parse(raw) as RecordedSession) : null;
}

export async function allSessions(): Promise<RecordedSession[]> {
  const all = await redis.hgetall(SESSIONS);
  return Object.values(all).map((raw) => JSON.parse(raw) as RecordedSession);
}

export const isSessionRegistered = async (key: string): Promise<boolean> =>
  (await redis.hexists(SESSIONS, key)) === 1;

/** A separate connection, because a subscribed client can do nothing else. */
export function watchSessions(onChange: (kind: "start" | "stop", key: string) => void): () => void {
  const sub = redis.duplicate();
  void sub.subscribe(CHANNEL);
  sub.on("message", (_channel, message) => {
    try {
      const m = JSON.parse(message) as { kind: "start" | "stop"; key: string };
      onChange(m.kind, m.key);
    } catch {
      /* a malformed nudge changes nothing: the sweep is the real mechanism */
    }
  });
  return () => {
    void sub.quit();
  };
}

/** Liveness, so the console can say "recording is armed" honestly rather than
 *  hopefully. Refreshed far more often than it expires. */
const ALIVE = "rec:alive";
export const beatRecorder = (sessions: number): Promise<unknown> =>
  redis.set(ALIVE, JSON.stringify({ at: Date.now(), sessions }), "EX", 30);
export async function recorderHealth(): Promise<{ alive: boolean; sessions: number; at: number | null }> {
  const raw = await redis.get(ALIVE);
  if (!raw) return { alive: false, sessions: 0, at: null };
  const h = JSON.parse(raw) as { at: number; sessions: number };
  return { alive: true, sessions: h.sessions, at: h.at };
}

// ---------------------------------------------------------------------------
// Leases
//
// Exactly one recorder may hold a session. Without this, two instances both
// join the room and write two of every file — which is not a hypothetical:
// a rolling deploy starts the new container before stopping the old one, so
// there is always a moment with two.
//
// A lease is short and refreshed while the session is held, so a recorder that
// DIES does not keep its claim: the lease simply expires and the next sweep
// somewhere else picks the session up. That is the same reason it is a lease
// and not a flag — nobody has to clean up after a crash.
// ---------------------------------------------------------------------------

const leaseKey = (key: string) => `rec:lease:${key}`;
/** Long enough to survive a hiccup, short enough that a recorder killed
 *  outright has its sessions picked up quickly. Refreshed every few seconds,
 *  so this is roughly the worst-case gap after a hard crash — a graceful stop
 *  hands the lease back immediately and leaves no gap at all. */
export const LEASE_SECONDS = 20;

/** Take the session, or find out somebody else has it. */
export async function claimSession(key: string, instance: string): Promise<boolean> {
  const got = await redis.set(leaseKey(key), instance, "EX", LEASE_SECONDS, "NX");
  if (got === "OK") return true;
  // Already ours (a refresh that raced with a re-open) counts as claimed.
  return (await redis.get(leaseKey(key))) === instance;
}

/** Keep it. Returns false if it was lost — which means another recorder has
 *  taken over and this one must let go rather than write a second copy. */
const REFRESH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0`;
export async function refreshLease(key: string, instance: string): Promise<boolean> {
  const held = await redis.eval(REFRESH_LUA, 1, leaseKey(key), instance, String(LEASE_SECONDS));
  return held === 1;
}

/** Give it back, but only if it is still ours. */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;
export const releaseSession = (key: string, instance: string): Promise<unknown> =>
  redis.eval(RELEASE_LUA, 1, leaseKey(key), instance);

/** Is anybody recording this right now? Asked before closing rows that look
 *  abandoned — another instance may be part-way through writing them. */
export const isLeased = async (key: string): Promise<boolean> => (await redis.exists(leaseKey(key))) === 1;
