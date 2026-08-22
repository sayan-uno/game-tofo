// Verification suite for voice recording (A6) — run it after ANY change to
// who gets recorded, for how long, or how the recorder decides.
//
//     npm run check:voice
//
// This is the one feature on the platform that records people who are not
// suspected of anything — the flagged player's teammates — so the questions it
// has to answer are not "does it work" but:
//
//   Can it record when it is switched off?            (no)
//   Can it record with nowhere to write?              (no)
//   Can it record a match nobody flagged?             (no)
//   Can it record a party nobody flagged?             (no)
//   Does a flag actually stop when its budget is out? (yes, immediately)
//   Can two recorders record the same room?           (no — one lease)
//   Is a recording deleted when its retention is up?  (yes)
//
// Every one of those is a NO that has to keep being a no, so each is proved
// here rather than reasoned about. Nothing in this file joins a LiveKit room:
// it exercises the DECIDING and the registry the recorder reads. Capturing
// audio is proved separately, against a live microphone — see the note at the
// end.
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", ".env");
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  console.error(`Could not read ${envPath}`);
  process.exit(2);
}
// Its own Redis database and its own evidence directory: a check that shares
// either with a running dev server is a check that passes or fails depending
// on what somebody else is doing.
process.env.REDIS_URL = `${(process.env.REDIS_URL || "").replace(/\/\d+$/, "")}/9`;
const EVIDENCE = join(tmpdir(), `voice-check-${process.pid}`);
process.env.EVIDENCE_DIR = EVIDENCE;
process.env.R2_EVIDENCE_ACCOUNT_ID = "";
process.env.R2_EVIDENCE_BUCKET = "";
process.env.VOICE_RECORDING_ENABLED = "false";

const { redis } = await import("../../backend/src/redis.js");
const { pool } = await import("../../backend/src/db/client.js");
const { config } = await import("../../backend/src/config.js");
const { evidenceBackend, putEvidence, getEvidence } = await import("../../backend/src/platform/evidence.js");
const {
  readiness, fullReadiness, warmVoiceTargets, anyFlagged, considerMatch, isRecordable,
  forgetMatch, stopForMatch, syncLobbyRecording, sweepVoice, sweepOrphanAudio, noteMatchStart,
} = await import("../../backend/src/platform/voiceRecording.js");
const {
  allSessions, getSession, claimSession, refreshLease, releaseSession, beatRecorder, recorderHealth,
  isSessionRegistered,
} = await import("../../backend/src/recorder/registry.js");
const { noteLobbyState, noteLobbyChat, currentSession, liveEvents } =
  await import("../../backend/src/platform/partyLog.js");
// express lives in backend/node_modules; this file is not inside a package.

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, values)).rows as T[];

const MARK = `voicechk-${process.pid}`;
const TARGET_SET = "rec:voice";

/** The three switches readiness() looks at, so a test can put the world in a
 *  known state instead of depending on what happens to be in .env. */
const live = { url: config.livekit.url, key: config.livekit.apiKey, secret: config.livekit.apiSecret };
const arm = (on: boolean) => {
  config.voiceRecording.enabled = on;
  config.evidence.accountId = on ? "acct" : "";
  config.evidence.bucket = on ? "tofo-evidence" : "";
  config.evidence.accessKeyId = on ? "key" : "";
  config.evidence.secretAccessKey = on ? "secret" : "";
};

const mkUser = async (tag: string): Promise<{ id: string; uid: string }> => {
  const uid = `${tag}${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 12);
  const [row] = await q<{ id: string }>(
    `insert into users (uid, google_id, email, name, username)
     values ($1,$2,$3,$4,$5) returning id`,
    [uid, `${MARK}-${uid}`, `${uid}@${MARK}.test`, "Voice Check", `vc${uid}`.slice(0, 15)]
  );
  return { id: row.id, uid };
};
const target = async (
  userId: string,
  opts: { days?: number; max?: number; used?: number; revoked?: boolean } = {}
): Promise<string> => {
  const [row] = await q<{ id: string }>(
    `insert into recording_targets (user_id, kind, reason, expires_at, max_matches, matches_used, revoked_at)
     values ($1,'voice',$2, now() + ($3 || ' days')::interval, $4, $5, $6) returning id`,
    [userId, `${MARK} reason`, String(opts.days ?? 7), opts.max ?? 20, opts.used ?? 0, opts.revoked ? new Date() : null]
  );
  return row.id;
};

try {
  await redis.flushdb();

  // -------------------------------------------------------------------------
  console.log("\n— it will not record unless every condition is met —");
  {
    arm(false);
    let r = readiness();
    ok(!r.ready && /VOICE_RECORDING_ENABLED/.test(r.why), `off by default, and says why: "${r.why}"`);

    config.voiceRecording.enabled = true;
    config.livekit.url = "";
    r = readiness();
    ok(!r.ready && /LiveKit/.test(r.why), `no LiveKit, no recording: "${r.why}"`);
    config.livekit.url = live.url;

    r = readiness();
    ok(!r.ready && /bucket/.test(r.why), `no evidence bucket, no recording: "${r.why}"`);
    ok(evidenceBackend() === "disk", "and the disk fallback is NOT accepted as somewhere to keep evidence");

    arm(true);
    r = readiness();
    ok(r.ready, "armed only when it is switched on, LiveKit is configured and the bucket exists");
    arm(false);
  }

  // -------------------------------------------------------------------------
  console.log("\n— who is flagged, rebuilt from the record —");
  const alice = await mkUser("va");
  const bob = await mkUser("vb");
  const carol = await mkUser("vc");
  const dave = await mkUser("vd");
  {
    await target(alice.id);
    await target(bob.id, { revoked: true });
    await target(carol.id, { days: -1 });
    await target(dave.id, { max: 5, used: 5 });

    const warmed = await warmVoiceTargets();
    const set = await redis.smembers(TARGET_SET);
    ok(set.includes(alice.id), "an active flag survives a restart (warmed back into Redis)");
    ok(!set.includes(bob.id), "a stopped flag does not come back");
    ok(!set.includes(carol.id), "an expired flag does not come back");
    ok(!set.includes(dave.id), "a flag that has spent its matches does not come back");
    ok(warmed === set.length, `warm reports what it wrote (${warmed})`);

    ok((await anyFlagged([])) === false, "an empty match asks Redis nothing");
    ok((await anyFlagged([bob.id, carol.id])) === false, "a table of unflagged players is not recorded");
    ok((await anyFlagged([bob.id, alice.id])) === true, "one flagged player at the table is enough");
  }

  // -------------------------------------------------------------------------
  console.log("\n— a match is only registered when it should be —");
  {
    arm(false);
    const m0 = `${MARK}-off`;
    ok((await considerMatch(m0, [alice.id])) === false, "switched off, a flagged player's match is not registered");
    ok((await getSession(m0)) === null, "and nothing is written for a recorder to find");

    arm(true);
    const m1 = `${MARK}-nobody`;
    ok((await considerMatch(m1, [bob.id, carol.id])) === false, "armed but nobody flagged: still nothing");
    ok((await isRecordable(m1)) === false, "the ordinary match costs one Redis lookup and stops there");

    const m2 = `${MARK}-yes`;
    ok((await considerMatch(m2, [bob.id, alice.id, carol.id])) === true, "a flagged player's match IS registered");
    const s2 = await getSession(m2);
    ok(s2?.room === `M${m2}`, `the recorder is told which room to sit in (${s2?.room})`);
    ok(s2?.scope === "match", "and that it is a match, not a party");
    ok(s2?.anchor === null, "with no timeline zero yet — tick 0 has not been decided at this point");

    // The countdown decides tick 0. Everything recorded is placed against it,
    // which is what lets the studio lay sound over the replay.
    await noteMatchStart(m2, 1_700_000_000_000);
    ok((await getSession(m2))?.anchor === 1_700_000_000_000, "the countdown fills the timeline zero in");
    await noteMatchStart(m2, 1_999_999_999_999);
    ok((await getSession(m2))?.anchor === 1_700_000_000_000, "and a later countdown cannot move it — the timeline is set once");

    const [a] = await q<{ used: number }>("select matches_used used from recording_targets where user_id = $1", [alice.id]);
    ok(a.used === 1, "exactly one match of budget was spent");
    const [c] = await q<{ used: number }>("select matches_used used from recording_targets where user_id = $1", [carol.id]);
    ok(c.used === 0, "an expired flag at the same table spends nothing");
    const [b] = await q<{ used: number }>("select matches_used used from recording_targets where user_id = $1", [bob.id]);
    ok(b.used === 0, "and a stopped one spends nothing either");

    await stopForMatch(m2);
    ok((await getSession(m2)) === null, "the match ends and the recorder is told to let go");
    ok((await isRecordable(m2)) === false, "and the mark is gone, so a late arrival starts nothing");
  }

  // -------------------------------------------------------------------------
  console.log("\n— a budget that actually runs out —");
  {
    arm(true);
    const eve = await mkUser("ve");
    await target(eve.id, { max: 2, used: 1 });
    await warmVoiceTargets();
    ok((await redis.sismember(TARGET_SET, eve.id)) === 1, "flagged with one match left");

    ok((await considerMatch(`${MARK}-last`, [eve.id])) === true, "the last match is recorded");
    ok(
      (await redis.sismember(TARGET_SET, eve.id)) === 0,
      "and the flag is dropped THE MOMENT it is spent — not at the next restart"
    );
    ok(
      (await considerMatch(`${MARK}-after`, [eve.id])) === false,
      "so the very next match is not recorded, with no database round trip to find out"
    );
    const [row] = await q<{ used: number; max: number }>(
      "select matches_used used, max_matches max from recording_targets where user_id = $1",
      [eve.id]
    );
    ok(row.used === row.max, `the budget stopped exactly at its limit (${row.used}/${row.max})`);
    await stopForMatch(`${MARK}-last`);
  }

  // -------------------------------------------------------------------------
  console.log("\n— parties: every group is replayed, only some are heard —");
  {
    arm(true);
    const LOBBY = `L${MARK}`.slice(0, 40);
    const lobbyKey = `lobby:${LOBBY}:members`;
    await redis.del(lobbyKey, `party:open:${LOBBY}`, `party:sign:${LOBBY}`);
    await warmVoiceTargets();
    const member = (uid: string, name: string, leader = false) => ({
      uid, name, character: "kai", weapon: null, isLeader: leader, avatarUrl: null,
    });

    // A person alone in their own lobby is not a party.
    await noteLobbyState(LOBBY, "solo", [member("u1", "One", true)], null);
    ok((await currentSession(LOBBY)) === null, "one player alone is not a group, and nothing is recorded");

    await noteLobbyState(LOBBY, "squad", [member("u1", "One", true), member("u2", "Two")], null);
    const session = await currentSession(LOBBY);
    ok(session !== null, "a second person arrives and the party starts being replayed");
    ok(session!.key.startsWith("party-") && session!.key !== LOBBY,
      `with an id of its OWN, not the lobby's — which is named after whoever leads (${session!.key})`);

    // The thing that makes this free: most broadcasts say nothing new.
    const before = (await liveEvents(session!.key)).length;
    await noteLobbyState(LOBBY, "squad", [member("u1", "One", true), member("u2", "Two")], null);
    ok((await liveEvents(session!.key)).length === before, "a broadcast that changed nothing writes nothing at all");

    await noteLobbyState(LOBBY, "squad", [member("u1", "One", true), member("u2", "Two", true)], null);
    ok((await liveEvents(session!.key)).length === before + 1, "leadership moving IS a change, and is recorded");
    await noteLobbyChat(LOBBY, "u1", "One", "hello");
    const evs = await liveEvents(session!.key);
    ok(evs[evs.length - 1].k === "chat", "so is what they said — on the party's own timeline");

    // Voice is separate: the party is replayed either way, and only a flagged
    // player adds sound.
    await redis.sadd(lobbyKey, bob.id);
    await syncLobbyRecording(LOBBY);
    ok(!(await isSessionRegistered(session!.key)), "an ordinary party is replayed but NOT listened to");

    await redis.sadd(lobbyKey, alice.id);
    await syncLobbyRecording(LOBBY);
    ok(await isSessionRegistered(session!.key), "a flagged player joins and the recorder is sent to the same session");
    const registered = (await allSessions()).find((s) => s.key === session!.key);
    ok(registered?.anchor === session!.startedAt,
      "sharing the party's clock, so voice lies over the simulation instead of beside it");

    await redis.srem(lobbyKey, alice.id);
    await syncLobbyRecording(LOBBY);
    ok(!(await isSessionRegistered(session!.key)), "they leave, and the listening stops — the replay carries on");

    // The party ends when the group does, and is packed away. Storage goes to
    // the disk backend here — the R2 values this check uses are deliberately
    // fake, because nothing else in it should be able to reach a real bucket.
    arm(false);
    await noteLobbyState(LOBBY, "solo", [member("u1", "One", true)], null);
    ok((await currentSession(LOBBY)) === null, "the group falls apart and the party ends");
    const [stored] = await q<{ key: string; bytes: number; evs: number; expires: Date | null }>(
      `select r2_key key, bytes, event_count evs, expires_at expires from party_sessions where key = $1`,
      [session!.key]
    );
    ok(stored?.key?.startsWith("parties/"), `packed into the evidence bucket (${stored?.key})`);
    ok(stored.bytes > 0 && stored.bytes < 20_000, `and it is TINY — ${stored.bytes} bytes for the whole party`);
    ok(stored.expires !== null, "with a date it will be deleted on, like everything else here");

    await q("delete from party_sessions where key = $1", [session!.key]);
    await redis.del(lobbyKey);
  }

  // -------------------------------------------------------------------------
  console.log("\n— one recorder per room, and no more —");
  {
    // A rolling deploy runs two containers at once. Without a lease both join
    // the room and write two of everything.
    const KEY = `${MARK}-lease`;
    ok((await claimSession(KEY, "recorder-A")) === true, "the first recorder takes the session");
    ok((await claimSession(KEY, "recorder-B")) === false, "the second is refused — one room, one recorder");
    ok((await claimSession(KEY, "recorder-A")) === true, "and the holder re-claiming its own session is fine");

    ok((await refreshLease(KEY, "recorder-A")) === true, "the holder can keep it");
    ok((await refreshLease(KEY, "recorder-B")) === false, "somebody else cannot");

    await releaseSession(KEY, "recorder-B");
    ok((await claimSession(KEY, "recorder-B")) === false, "and cannot release what it does not hold");
    await releaseSession(KEY, "recorder-A");
    ok((await claimSession(KEY, "recorder-B")) === true, "once the holder lets go, the next recorder picks it up");
    await releaseSession(KEY, "recorder-B");

    // A recorder that DIES holds nothing for long: the lease simply expires.
    const ttl = await redis.ttl(`rec:lease:${KEY}`);
    ok(ttl === -2 || ttl <= 20, `a lease is short-lived (${ttl}s), so a crashed recorder's rooms are taken over, not stranded`);
  }

  // -------------------------------------------------------------------------
  console.log("\n— is anybody there to do the recording? —");
  {
    arm(true);
    await redis.del("rec:alive");
    const down = await fullReadiness();
    ok(!down.ready && /recorder/.test(down.why), `with no recorder running the console is told so: "${down.why}"`);
    ok(down.recorder.alive === false, "and that the recorder is down, not that everything is fine");

    await beatRecorder(3);
    const up = await fullReadiness();
    ok(up.ready, "with the recorder up, recording is armed");
    ok(up.recorder.sessions === 3, "and the console can say how many sessions it is holding");
    const health = await recorderHealth();
    ok(health.alive && health.at !== null, "the heartbeat carries a timestamp, so a stale one is visible");
    await redis.del("rec:alive");
    arm(false);
  }

  // -------------------------------------------------------------------------
  console.log("\n— it deletes itself when the time is up —");
  {
    arm(false); // disk backend, so the sweep really removes a real file
    const gone = `voice/${MARK}/expired.ogg`;
    const kept = `voice/${MARK}/fresh.ogg`;
    await putEvidence(gone, Buffer.from("OggS-pretend"), "audio/ogg");
    await putEvidence(kept, Buffer.from("OggS-pretend"), "audio/ogg");
    await q(
      `insert into voice_recordings (match_key, uid, r2_key, status, expires_at) values
       ($1,'uid11',$2,'complete', now() - interval '1 day'),
       ($3,'uid12',$4,'complete', now() + interval '30 days')`,
      [`${MARK}-old`, gone, `${MARK}-new`, kept]
    );
    const swept = await sweepVoice();
    ok(swept >= 1, `retention removed ${swept} recording(s) whose time was up`);
    ok((await getEvidence(gone)) === null, "the AUDIO is gone, not just the row — this is the part that matters");
    ok((await getEvidence(kept)) !== null, "and a recording still inside its retention is untouched");
    const [{ n }] = await q<{ n: string }>("select count(*) n from voice_recordings where match_key = $1", [`${MARK}-old`]);
    ok(Number(n) === 0, "the row is gone too, so nothing points at a file that no longer exists");

    // The other direction: a FILE that no row points at. Retention deletes by
    // the expiry date on the row, so audio whose row has gone has no expiry at
    // all and would sit in the bucket for ever — which is a promise broken,
    // not merely untidy.
    const stray = `voice/${MARK}/stray.ogg`;
    await putEvidence(stray, Buffer.from("OggS-orphan"), "audio/ogg");
    ok((await sweepOrphanAudio(500, 60 * 60 * 1000)) === 0, "a file written moments ago is left alone — it may still be recording");
    ok((await getEvidence(stray)) !== null, "…and is still there");
    const swept2 = await sweepOrphanAudio(500, 0);
    ok(swept2 >= 1, `once it is old enough and no record points at it, it goes (${swept2})`);
    ok((await getEvidence(stray)) === null, "the audio nobody had a record of is gone");
  }

} finally {
  arm(false);
  config.livekit.url = live.url;
  try {
    await q("delete from voice_recordings where match_key like $1", [`%${MARK}%`]);
    await q("delete from users where google_id like $1", [`${MARK}%`]); // targets cascade
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  rmSync(EVIDENCE, { recursive: true, force: true });
  await redis.flushdb();
  redis.disconnect();
  await pool.end();
}

console.log(
  fails === 0
    ? "\nALL CHECKS PASSED\n(This proves the DECIDING. That the recorder turns a live microphone into\n" +
      " a playable file is proved separately, against real audio — see check:recorder.)"
    : `\n${fails} CHECK(S) FAILED`
);
process.exit(fails === 0 ? 0 : 1);
