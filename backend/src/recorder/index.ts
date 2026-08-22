// The recorder process.
//
// It owns exactly one job: whatever the registry says should be recorded, is
// being recorded. It does not decide anything — who is flagged, budgets,
// retention and the console all live elsewhere and are unchanged.
//
// Everything here is built around the assumption that this process WILL die at
// a bad moment, because eventually it will:
//
//   the registry is durable       — a session missed while restarting is
//                                   picked up by the next sweep, not lost
//   the sweep is the mechanism    — pub/sub only makes the usual case instant
//   files are uploaded as they go — a crash costs one flush, not a session
//   orphans are recovered at boot — part-written files still reach the bucket
//   open rows are closed at boot  — the console never shows a ghost recording
//   SIGTERM finishes cleanly      — a deploy ends files properly, and this is
//                                   the path that runs on almost every restart
import { config } from "../config.js";
import { redis } from "../redis.js";
import {
  allSessions,
  beatRecorder,
  claimSession,
  refreshLease,
  releaseSession,
  watchSessions,
  type RecordedSession,
} from "./registry.js";
import { RecordingSession, closeStaleRows } from "./session.js";
import { recoverOrphanFiles } from "./writer.js";

/** How often reality is compared with the registry. Short enough that a missed
 *  nudge is a blip, long enough to be free. */
const SWEEP_MS = 15_000;
const BEAT_MS = 10_000;
/** Leases are refreshed far more often than they expire, and on their own
 *  timer: tying it to the sweep would mean a slow sweep silently dropping a
 *  session to another recorder mid-sentence. */
const LEASE_MS = 5_000;

const live = new Map<string, RecordingSession>();
/** Sessions being opened right now, so a nudge and a sweep cannot both open
 *  the same room and end up with two recorders in it. */
const opening = new Set<string>();

/** Which sessions belong to this instance. One instance takes everything;
 *  several split the work by key, so scaling out is configuration rather than
 *  a rewrite. */
function mine(key: string): boolean {
  const { shard, shards } = config.recorder;
  if (shards <= 1) return true;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % shards === shard;
}

async function open(spec: RecordedSession): Promise<void> {
  if (live.has(spec.key) || opening.has(spec.key) || !mine(spec.key)) return;
  if (live.size >= config.recorder.maxSessions) {
    console.warn(`[rec] at capacity (${live.size}); not opening ${spec.key}`);
    return;
  }
  opening.add(spec.key);
  // One recorder per session. A rolling deploy runs two containers at once for
  // a few seconds, and without this both would join the room and write two of
  // every file.
  if (!(await claimSession(spec.key, config.instanceId))) {
    opening.delete(spec.key);
    return;
  }
  const session = new RecordingSession(spec);
  try {
    await session.open();
    live.set(spec.key, session);
  } catch (err) {
    console.error(`[rec] could not open ${spec.key}:`, err);
    await session.close().catch(() => undefined);
    await releaseSession(spec.key, config.instanceId).catch(() => undefined);
  } finally {
    opening.delete(spec.key);
  }
}

async function close(key: string): Promise<void> {
  const session = live.get(key);
  if (!session) return;
  live.delete(key);
  await session.close().catch((err) => console.error(`[rec] closing ${key}:`, err));
  await releaseSession(key, config.instanceId).catch(() => undefined);
}

/** Make reality match the registry: open what should be open, close what
 *  should not, and stop anything that has run past its ceiling. */
async function sweep(): Promise<void> {
  let specs: RecordedSession[];
  try {
    specs = await allSessions();
  } catch (err) {
    console.error("[rec] could not read the registry:", err);
    return;
  }
  const wanted = new Map(specs.filter((s) => mine(s.key)).map((s) => [s.key, s]));

  for (const spec of wanted.values()) if (!live.has(spec.key)) await open(spec);
  for (const key of [...live.keys()]) if (!wanted.has(key)) await close(key);

  // A match ends by itself; a party does not. Nothing is lost when this fires:
  // the file is closed and kept, and a new one starts if talking continues.
  const capMinutes = config.voiceRecording.maxSessionMinutes;
  if (capMinutes > 0) {
    for (const [key, session] of live) {
      if (session.seconds > capMinutes * 60) {
        console.log(`[rec] ${key}: past the ${capMinutes}-minute ceiling, closing`);
        await close(key);
      }
    }
  }
}

export async function startRecorder(): Promise<void> {
  console.log(
    `✔ Recorder starting (shard ${config.recorder.shard + 1}/${config.recorder.shards}, ` +
      `flush every ${config.recorder.flushSeconds}s)`
  );
  // Before anything new: rescue what the last run left behind.
  await recoverOrphanFiles();
  // Rows for sessions ANOTHER recorder currently holds are left alone: they
  // are not abandoned, they are being written right now.
  await closeStaleRows(new Set());
  await sweep();

  const unwatch = watchSessions((kind, key) => {
    void (async () => {
      if (kind === "stop") return close(key);
      const spec = (await allSessions()).find((s) => s.key === key);
      if (spec) await open(spec);
    })().catch((err) => console.error("[rec] nudge failed:", err));
  });

  const leases = setInterval(() => {
    void (async () => {
      for (const key of [...live.keys()]) {
        if (await refreshLease(key, config.instanceId).catch(() => true)) continue;
        console.warn(`[rec] ${key}: lease lost, handing over`);
        const session = live.get(key);
        live.delete(key);
        await session?.close().catch(() => undefined);
      }
    })().catch((err) => console.error("[rec] lease:", err));
  }, LEASE_MS);
  const sweeper = setInterval(() => void sweep().catch((err) => console.error("[rec] sweep:", err)), SWEEP_MS);
  const beat = setInterval(() => void beatRecorder(live.size).catch(() => undefined), BEAT_MS);
  await beatRecorder(0);

  // A deploy is the most common way this process ends, so it is the path that
  // gets the care: every file is finished and uploaded before the exit.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[rec] ${signal}: finishing ${live.size} session(s)…`);
    clearInterval(sweeper);
    clearInterval(leases);
    clearInterval(beat);
    unwatch();
    await Promise.all([...live.keys()].map((key) => close(key)));
    await redis.del("rec:alive").catch(() => undefined);
    console.log("[rec] all files closed");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // A crash in a stray promise must not leave half the sessions writing.
  process.on("uncaughtException", (err) => {
    console.error("[rec] uncaught:", err);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (err) => {
    console.error("[rec] unhandled rejection:", err);
  });
}

export const liveSessionCount = (): number => live.size;
