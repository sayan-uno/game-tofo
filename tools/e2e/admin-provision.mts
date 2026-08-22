// DEV ONLY — makes a real console session for the browser test to use, and
// cleans it up afterwards.
//
//   tsx tools/e2e/admin-provision.mts provision   → prints JSON on stdout
//   tsx tools/e2e/admin-provision.mts cleanup <email>
//
// It creates a throwaway owner, enrols an authenticator through the REAL
// sign-in endpoint, and hands back the refresh cookie the server set. Nothing
// is faked: the browser test then resumes that session exactly as a returning
// admin would. The only stage skipped is Google's, which cannot be automated
// without putting a bypass in production code.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
for (const line of readFileSync(new URL("../../backend/.env", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { Client } = requireBackend("pg") as typeof import("pg");
const jwt = requireBackend("jsonwebtoken") as typeof import("jsonwebtoken");
const { generateSync } = requireBackend("otplib") as typeof import("otplib");
const { newEnrolment } = await import("../../backend/src/admin/totp.js");

const mode = process.argv[2];
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// "Did clicking that button flag anybody?" — asked by the browser test after
// a start it expects to have been REFUSED. A recording that leaves a row
// behind when it was refused is the failure that matters here.
// Flags a player for voice recording straight in the database, so the browser
// test can check what the console DOES with one. Starting it through the API
// is not possible here: there is no evidence bucket on a dev machine, which is
// itself one of the things the test proves.
if (mode === "voice-flag") {
  const uid = process.argv[3] ?? "";
  const { rows } = await db.query("select id from users where uid = $1", [uid]);
  if (!rows[0]) {
    console.error(`no user ${uid}`);
    process.exit(1);
  }
  await db.query(
    `insert into recording_targets (user_id, kind, reason, expires_at, max_matches, matches_used)
     values ($1,'voice','e2e — flagged directly to test the console', now() + interval '1 day', 20, 3)`,
    [rows[0].id]
  );
  console.log(JSON.stringify({ ok: true }));
  await db.end();
  process.exit(0);
}

// A player who is NOT currently being recorded, for the voice section to work
// on. Asking for one rather than reusing whoever came up in search: a real
// moderation flag on that account (there was one) turns "Record voice" into
// "Stop recording", and a browser test must never depend on — or touch — live
// moderation state.
// Attach real audio to a seeded match, so the browser test can prove the
// studio plays sound in step with the replay.
//
// It copies an EXISTING recording rather than inventing one: a synthetic file
// would not exercise decoding, and there is no encoder here to make a real
// one. With nothing to copy it says so and the audio checks are skipped —
// better than a test that pretends.
if (mode === "seed-voice" || mode === "clean-voice") {
  const key = process.argv[3] ?? "";
  const { getEvidence, putEvidence, deleteEvidence } = await import("../../backend/src/platform/evidence.js");
  if (mode === "clean-voice") {
    const { rows } = await db.query("select r2_key from voice_recordings where match_key = $1", [key]);
    if (rows.length) await deleteEvidence(rows.map((r: { r2_key: string }) => r.r2_key));
    await db.query("delete from voice_recordings where match_key = $1", [key]);
    console.log(JSON.stringify({ removed: rows.length }));
    await db.end();
    process.exit(0);
  }
  // SEVERAL candidates, not one. This copies a real recording's bytes, and the
  // newest row is not necessarily backed by a file any more — it may have been
  // swept, or be a row seeded by another test for its metadata alone. Taking
  // the first row and giving up if its object is missing made the whole voice
  // half of the browser test silently SKIP, which reads in the output as
  // nothing at all rather than as a failure.
  const { rows } = await db.query(
    `select r2_key, duration_sec from voice_recordings
      where status = 'complete' and duration_sec is not null and bytes > 100000
      order by started_at desc limit 5`
  );
  let bytes: Buffer | null = null;
  let dur = 0;
  for (const candidate of rows) {
    const found = await getEvidence(candidate.r2_key);
    if (found && found.length > 0) {
      bytes = found;
      dur = candidate.duration_sec as number;
      break;
    }
  }
  if (!bytes) {
    console.log(JSON.stringify({ skipped: "no recording with a file behind it to copy" }));
    await db.end();
    process.exit(0);
  }
  const files = [
    { kind: "mix", uid: "room", track: "mix", offset: 0, key: `voice/e2e/${key}/room-mix.ogg` },
    { kind: "track", uid: "e2espeaker", track: "TR_E2E", offset: 3000, key: `voice/e2e/${key}/voice-1.ogg` },
  ];
  for (const f of files) {
    await putEvidence(f.key, bytes, "audio/ogg");
    await db.query(
      `insert into voice_recordings (match_key, scope, kind, uid, track_sid, r2_key, status, offset_ms, duration_sec, bytes)
       values ($1,'match',$2,$3,$4,$5,'complete',$6,$7,$8)`,
      [key, f.kind, f.uid, f.track, f.key, f.offset, dur, bytes.length]
    );
  }
  console.log(JSON.stringify({ files: files.length, durationSec: dur }));
  await db.end();
  process.exit(0);
}

// Writes one distinctive row so a test can prove a refresh actually brings
// NEW data. Counting requests is not proof: the old test did exactly that and
// passed while Refresh and Live re-queried a window frozen at page load, so
// nothing new could ever appear in it.
if (mode === "poke" || mode === "unpoke") {
  const tag = process.argv[3] ?? "poke";
  if (mode === "unpoke") {
    const { rowCount } = await db.query("delete from event_log where data->>'viewed' like 'E2EPOKE%'");
    console.log(JSON.stringify({ removed: rowCount }));
  } else {
    const { rows } = await db.query("select uid from users order by created_at limit 1");
    await db.query(`insert into event_log (type, uid, ip, data) values ('profile.view', $1, '127.0.0.1', $2)`, [
      rows[0].uid,
      JSON.stringify({ viewed: tag }),
    ]);
    console.log(JSON.stringify({ wrote: tag, uid: rows[0].uid }));
  }
  await db.end();
  process.exit(0);
}

// Enough accounts that the Players list has to page. The browser test cannot
// prove "it loads as you scroll" against eight rows: with fewer than a page
// there is only ever one page, and a list that loaded everything at once would
// pass exactly the same assertions.
if (mode === "seed-players" || mode === "clean-players") {
  await db.query("delete from users where google_id like 'e2elist-%'");
  if (mode === "clean-players") {
    console.log(JSON.stringify({ ok: true }));
    await db.end();
    process.exit(0);
  }
  const n = Math.min(200, Math.max(1, Number(process.argv[3] ?? 60)));
  // One statement, not sixty round trips. created_at is spread backwards a
  // minute at a time so the ordering is unambiguous — rows sharing a timestamp
  // would make "newest first" impossible to assert honestly.
  await db.query(
    `insert into users (uid, google_id, email, name, username, created_at, last_login_at)
     select (8100000000 + i)::text, 'e2elist-' || i, 'e2elist-' || i || '@check.invalid',
            'List Seed ' || i, 'ListSeed' || i, now() - (i * interval '1 minute'), now()
       from generate_series(1, $1) as i`,
    [n]
  );
  console.log(JSON.stringify({ seeded: n }));
  await db.end();
  process.exit(0);
}

if (mode === "voice-player") {
  const { rows } = await db.query(
    `select u.uid from users u
      where not exists (
        select 1 from recording_targets t
         where t.user_id = u.id and t.kind = 'voice'
           and t.revoked_at is null and t.expires_at > now())
      order by u.created_at limit 1`
  );
  console.log(JSON.stringify({ uid: rows[0]?.uid ?? null }));
  await db.end();
  process.exit(0);
}

if (mode === "voice-targets") {
  const { rows } = await db.query(
    "select count(*)::int n from recording_targets where kind = 'voice' and revoked_at is null and expires_at > now()"
  );
  console.log(JSON.stringify({ count: rows[0].n }));
  await db.end();
  process.exit(0);
}

if (mode === "cleanup") {
  const email = process.argv[3] ?? "";
  await db.query("delete from admin_audit where admin_email = $1", [email]);
  // The browser test applies a sanction to a real player by clicking through
  // the console; it must not outlive the run.
  await db.query("delete from sanctions where reason like 'e2e%'");
  await db.query("delete from recording_targets where reason like 'e2e%'");
  // The browser test sends a real notice from the Notices screen, because the
  // point of that screen is that a send leaves a row behind.
  await db.query("delete from notices where body like 'e2e %'");
  // A run killed mid-flight never reaches its own clean-up, and these are
  // accounts: they must not be left sitting in the table the console reads as
  // the list of real people.
  await db.query("delete from users where google_id like 'e2elist-%'");
  // Admin activity rows carry no user id, so they need sweeping by address.
  // Two shapes: sign-in rows name the admin under 'email', and the rows an
  // action writes name them under 'by'.
  await db.query("delete from event_log where data->>'email' = $1", [email]);
  await db.query("delete from event_log where data->>'by' = $1", [email]);
  await db.query("delete from admin_users where email = $1", [email]);
  await db.end();
  process.exit(0);
}

const PORT = process.env.ADMIN_PORT || "4031";
const BASE = `http://localhost:${PORT}/${process.env.ADMIN_PATH}`;
const email = `console-${Date.now()}@check.invalid`;

const enrolment = newEnrolment(email);
const { rows } = await db.query(
  "insert into admin_users (email, name, role, totp_secret_enc) values ($1,$2,'owner',$3) returning id",
  [email, "Console e2e", enrolment.secretEnc]
);
const pending = jwt.sign({ sub: rows[0].id, email, stage: "enrol" }, process.env.ADMIN_JWT_SECRET!, {
  audience: "admin-pending",
  issuer: "tofo-admin",
  expiresIn: "5m",
});

const res = await fetch(`${BASE}/session/enrol`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pending, code: generateSync({ secret: enrolment.secret }) }),
});
if (!res.ok) {
  console.error(`enrolment failed: HTTP ${res.status} ${await res.text()}`);
  await db.query("delete from admin_users where email = $1", [email]);
  await db.end();
  process.exit(1);
}
const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("tofo_admin_rt="));
if (!cookie) {
  console.error("no refresh cookie in the response");
  process.exit(1);
}
const value = cookie.split(";")[0].slice("tofo_admin_rt=".length);
const path = /path=([^;]+)/i.exec(cookie)?.[1] ?? "/";
// A real player for the browser test to open, so the profile is exercised
// against actual data rather than a fixture that cannot go stale.
const sample = await db.query(
  "select uid, coalesce(username, name) label from users where username is not null order by created_at limit 1"
);
await db.end();
console.log(
  JSON.stringify({
    email,
    cookieName: "tofo_admin_rt",
    cookieValue: value,
    cookiePath: path,
    port: PORT,
    samplePlayerUid: sample.rows[0]?.uid ?? null,
    samplePlayerLabel: sample.rows[0]?.label ?? null,
    // The browser test needs to answer a sudo prompt, which means computing a
    // real code. Handing over the secret it just generated is the only way to
    // drive the console the way a person does, with the confirmation intact.
    totpSecret: enrolment.secret,
  })
);
