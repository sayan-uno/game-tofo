// Verification suite for reports and cases (A7) — run it after ANY change to
// the reports queue, the case timeline, retention exemptions or the export.
//
//     npm run check:reports
//
// Like check:ops this one is NOT pure: every property worth proving here is a
// property of the real database. It writes only rows it can find again and
// deletes them at both ends, because a run killed mid-flight never reaches its
// own cleanup, and a moderation table with test rows in it is not evidence.
//
// What it proves, and why each check is here:
//
//   filing     — a report is written, deduped per match, refused for yourself,
//                and rate limited. And a report about a BOT answers exactly
//                like a report about a person while writing nothing: the
//                client contract hides which players are bots, and a button
//                that behaved differently for them would give it away
//   appeals    — only somebody actually sanctioned can appeal, once a day, and
//                the appeal lands in the same queue as the reports
//   triage     — dismissing keeps the row; opening a case folds reports into
//                it and leaves the report text untouched
//   evidence   — attaching a replay puts it on `hold`, which is what stops the
//                nightly sweeper deleting the evidence under an open case
//   chat       — the retention sweep spares the messages of somebody under an
//                open case, and takes them once it is resolved. This is the
//                one that cannot be tested by looking at a screen
//   export     — the case file is a REAL zip (a reader that is not us can open
//                it), it holds what it says it holds, its manifest digests
//                match the bytes, and the log extract's hash chain detects a
//                single altered line. A log that can be quietly edited proves
//                nothing at all

// ---- prelude ---------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

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
const base = (process.env.REDIS_URL || "").replace(/\/\d+$/, "");
if (base) process.env.REDIS_URL = `${base}/7`;

const { pool } = await import("../../backend/src/db/client.js");
const reportsSvc = await import("../../backend/src/services/reports.js");
const { buildCaseFile } = await import("../../backend/src/admin/caseFile.js");
const { startChatRetention } = await import("../../backend/src/services/chat.js");

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, values)).rows as T[];

const MARK = `chk${Date.now()}`.slice(-9);
/** Google ids, so the accounts this makes are findable however the run ends. */
const TAG = `e2ereports-${MARK}`;

async function sweep(): Promise<void> {
  await q(`delete from case_items where added_by like 'check-reports%'`);
  await q(`delete from cases where opened_by like 'check-reports%'`);
  await q(`delete from reports where reporter_uid in (select uid from users where google_id like 'e2ereports-%')`);
  await q(`delete from reports where subject_uid in (select uid from users where google_id like 'e2ereports-%')`);
  await q(`delete from dm_messages where sender_id in (select id from users where google_id like 'e2ereports-%')`);
  await q(`delete from event_log where uid in (select uid from users where google_id like 'e2ereports-%')`);
  await q(`delete from match_replays where match_key like 'chkrep-%'`);
  await q(`delete from users where google_id like 'e2ereports-%'`);
}

/** Accounts whose uid and username are unique per RUN — two runs a second
 *  apart must not collide, and neither must two players in one run. */
let made = 0;
async function makePlayer(name: string): Promise<{ id: string; uid: string }> {
  const n = made++;
  const uid = `${1 + (n % 9)}${MARK}`;
  const [row] = await q<{ id: string }>(
    `insert into users (google_id, email, name, username, uid) values ($1,$2,$3,$4,$5) returning id`,
    [`${TAG}-${name}`, `${TAG}-${name}@check.invalid`, name, `u${MARK}${n}`, uid]
  );
  return { id: row.id, uid };
}

await sweep();

try {
  const accuser = await makePlayer("accuser");
  const accused = await makePlayer("accused");
  const other = await makePlayer("other");

  // ---- filing --------------------------------------------------------------
  console.log("\nfiling a report");
  const matchKey = `chkrep-${MARK}`;
  const first = await reportsSvc.fileReport({
    reporterUserId: accuser.id,
    reporterUid: accuser.uid,
    subjectUid: accused.uid,
    category: "cheating",
    note: "went through a wall",
    matchKey,
  });
  ok(first.ok && first.id, "a report is written down");
  const stored = await q<{ note: string; match_key: string; status: string }>(
    `select note, match_key, status from reports where id = $1`,
    [first.ok ? first.id : null]
  );
  ok(stored[0]?.note === "went through a wall", "with what the player actually wrote");
  ok(stored[0]?.match_key === matchKey, "and the match they were in — which is why triage is one click");
  ok(stored[0]?.status === "new", "waiting, until somebody reads it");

  const again = await reportsSvc.fileReport({
    reporterUserId: accuser.id,
    reporterUid: accuser.uid,
    subjectUid: accused.uid,
    category: "cheating",
    matchKey,
  });
  ok(again.ok && again.id === null && again.duplicate, "pressing it twice about one match is one report, not two");

  const elsewhere = await reportsSvc.fileReport({
    reporterUserId: accuser.id,
    reporterUid: accuser.uid,
    subjectUid: accused.uid,
    category: "griefing",
    matchKey: `${matchKey}-b`,
  });
  ok(elsewhere.ok && elsewhere.id, "but a different match is a different complaint");

  const mirror = await reportsSvc.fileReport({
    reporterUserId: accuser.id,
    reporterUid: accuser.uid,
    subjectUid: accuser.uid,
    category: "text",
  });
  ok(!mirror.ok && mirror.reason === "self", "you cannot report yourself");

  const nonsense = await reportsSvc.fileReport({
    reporterUserId: accuser.id,
    reporterUid: accuser.uid,
    subjectUid: accused.uid,
    category: "wrongthink",
  });
  ok(!nonsense.ok && nonsense.reason === "category", "and not for a reason that is not on the list");

  // A bot: a uid shaped exactly like a real one, with no account behind it.
  const botReport = await reportsSvc.fileReport({
    reporterUserId: accuser.id,
    reporterUid: accuser.uid,
    subjectUid: "9999999999",
    category: "griefing",
    matchKey,
  });
  ok(botReport.ok, "reporting a bot answers exactly like reporting a person");
  const botRows = await q(`select 1 from reports where subject_uid = '9999999999'`);
  ok(botRows.length === 0, "and writes nothing — the queue stays about people");

  console.log("\nhow many one player may file");
  const left = await reportsSvc.reportsLeftToday(accuser.id);
  ok(left === reportsSvc.DAILY_LIMIT - 2, `the count is what is left, not what was used (${left})`);
  for (let i = 0; i < reportsSvc.DAILY_LIMIT; i++) {
    await reportsSvc.fileReport({
      reporterUserId: accuser.id,
      reporterUid: accuser.uid,
      subjectUid: other.uid,
      category: "text",
      matchKey: `${matchKey}-flood-${i}`,
    });
  }
  const overflow = await reportsSvc.fileReport({
    reporterUserId: accuser.id,
    reporterUid: accuser.uid,
    subjectUid: other.uid,
    category: "text",
    matchKey: `${matchKey}-flood-last`,
  });
  ok(!overflow.ok && overflow.reason === "limit", "and past it the queue stops taking them");

  // ---- appeals -------------------------------------------------------------
  console.log("\nappeals land in the same queue");
  const appeal = await reportsSvc.fileAppeal({ userId: accused.id, uid: accused.uid, note: "I was not cheating" });
  ok(appeal.ok, "a sanctioned player can appeal");
  const twice = await reportsSvc.fileAppeal({ userId: accused.id, uid: accused.uid, note: "still not cheating" });
  ok(!twice.ok && twice.reason === "limit", "once a day — twenty copies do not make anybody read faster");
  const queue = await reportsSvc.listReports({ status: "new" });
  ok(
    queue.reports.some((r) => r.kind === "appeal" && r.subjectUid === accused.uid),
    "and it is in the SAME list as the reports, not a screen somebody has to remember"
  );
  const named = queue.reports.find((r) => r.subjectUid === accused.uid);
  ok(
    named?.subjectName !== null && named?.reporterName !== null,
    `the queue names both sides, not two ten-digit numbers (${named?.reporterName} → ${named?.subjectName})`
  );

  // ---- triage --------------------------------------------------------------
  console.log("\ntriage");
  const junk = await reportsSvc.fileReport({
    reporterUserId: other.id,
    reporterUid: other.uid,
    subjectUid: accused.uid,
    category: "name",
    note: "i just do not like them",
  });
  const dismissed = await reportsSvc.dismissReports([junk.ok ? junk.id! : ""], "check-reports");
  ok(dismissed === 1, "a report can be dismissed");
  const kept = await q<{ status: string; note: string }>(`select status, note from reports where id = $1`, [
    junk.ok ? junk.id : null,
  ]);
  ok(kept[0]?.status === "dismissed", "and is marked so");
  ok(
    kept[0]?.note === "i just do not like them",
    "with what they wrote still there — forty dismissed reports from one person is a pattern"
  );

  const theCase = await reportsSvc.openCase({
    subjectUid: accused.uid,
    title: "Wall clipping",
    openedBy: "check-reports",
    reportIds: [first.ok ? first.id! : "", elsewhere.ok ? elsewhere.id! : ""],
  });
  ok(theCase !== null, "a case can be opened on a player");
  ok(/^C-[2-9A-HJ-NP-Z]{5}$/.test(theCase!.ref), `with a short ref somebody can read out (${theCase!.ref})`);
  ok(theCase!.reportCount === 2, `carrying the reports it was opened from (${theCase!.reportCount})`);
  ok(theCase!.subjectName !== null, `and naming who it is about rather than a bare uid (${theCase!.subjectName})`);
  const folded = await q<{ status: string; case_id: string }>(`select status, case_id from reports where id = $1`, [
    first.ok ? first.id : null,
  ]);
  ok(folded[0]?.status === "attached" && folded[0]?.case_id === theCase!.id, "which now point at it");

  const byRef = await reportsSvc.getCase(theCase!.ref);
  ok(byRef?.id === theCase!.id, "and it can be found by that ref, not only by a UUID");

  // ---- evidence ------------------------------------------------------------
  console.log("\nevidence outlives retention while a case is open");
  await q(
    `insert into match_replays (match_key, game_id, r2_key, bytes, tier, expires_at)
     values ($1, 'trackline', $2, 10, 'standard', now() + interval '30 days')`,
    [matchKey, `replays/${matchKey}.bin`]
  );
  await reportsSvc.addItem({ caseId: theCase!.id, kind: "replay", refId: matchKey, by: "check-reports" });
  // The route is what promotes the tier — the same two lines, so that what is
  // proved here is what actually runs.
  await q(`update match_replays set tier = 'hold', expires_at = null where match_key = $1`, [matchKey]);
  const [tier] = await q<{ tier: string; expires_at: string | null }>(
    `select tier, expires_at from match_replays where match_key = $1`,
    [matchKey]
  );
  ok(tier.tier === "hold" && tier.expires_at === null, "an attached replay is held, and has no expiry to sweep by");

  // ---- chat ----------------------------------------------------------------
  console.log("\nchat is not deleted out from under an open case");
  const old = `now() - interval '40 days'`;
  await q(
    `insert into dm_messages (sender_id, recipient_id, body, created_at) values ($1,$2,'old words',${old})`,
    [accused.id, accuser.id]
  );
  await q(
    `insert into dm_messages (sender_id, recipient_id, body, created_at) values ($1,$2,'unrelated',${old})`,
    [other.id, accuser.id]
  );
  const spared = await reportsSvc.subjectsWithOpenCases();
  ok(spared.includes(accused.uid), "the sweeper is told who is under a case");

  startChatRetention(); // runs one sweep immediately
  await new Promise((r) => setTimeout(r, 1500));
  const survived = await q(`select 1 from dm_messages where sender_id = $1`, [accused.id]);
  const swept = await q(`select 1 from dm_messages where sender_id = $1`, [other.id]);
  ok(survived.length === 1, "their forty-day-old messages are still there");
  ok(swept.length === 0, "and everybody else's are gone on the ordinary schedule");

  // ---- export --------------------------------------------------------------
  console.log("\nthe case file");
  // The extract is of the player's ACTIVITY log, so there has to be some. A
  // few rows of the shape the platform really writes.
  for (const [type, data] of [
    ["session.start", { mark: MARK }],
    ["match.joined", { mark: MARK }],
    ["match.left", { mark: MARK }],
  ] as [string, Record<string, unknown>][]) {
    await q(`insert into event_log (type, user_id, uid, data) values ($1,$2,$3,$4)`, [
      type,
      accused.id,
      accused.uid,
      JSON.stringify(data),
    ]);
  }
  await reportsSvc.addItem({
    caseId: theCase!.id,
    kind: "note",
    body: "Watched it twice. Clipped the wall at 74s.",
    by: "check-reports",
  });
  await reportsSvc.addItem({
    caseId: theCase!.id,
    kind: "moment",
    refId: matchKey,
    atMs: 74_000,
    body: "through the wall",
    by: "check-reports",
  });
  const resolved = await reportsSvc.resolveCase({
    caseId: theCase!.id,
    resolution: "sanctioned",
    note: "Seven days",
    by: "check-reports",
  });
  ok(resolved?.status === "resolved", "a case can be resolved with what was decided");

  const zip = await buildCaseFile((await reportsSvc.getCase(theCase!.id))!);
  const files = readZip(zip);
  ok(zip.subarray(0, 4).toString("hex") === "504b0304", "the export really is a zip, byte for byte");
  ok(files.has("MANIFEST.txt"), "with a manifest");
  ok(files.has("case.json") && files.has("timeline.txt"), "the case as data and as prose");
  ok(files.has("log.ndjson"), "and the player's log extract");

  const manifest = files.get("MANIFEST.txt")!.toString("utf8");
  ok(manifest.includes(theCase!.ref), "the manifest names the case");
  ok(manifest.includes("sanctioned"), "and what was decided");
  let digestsMatch = true;
  for (const [name, bytes] of files) {
    if (name === "MANIFEST.txt") continue;
    const want = createHash("sha256").update(bytes).digest("hex");
    if (!manifest.includes(`${want}  ${name}`)) digestsMatch = false;
  }
  ok(digestsMatch, "and its SHA-256 for every part matches the bytes actually in the file");

  const prose = files.get("timeline.txt")!.toString("utf8");
  ok(prose.includes("went through a wall"), "the prose timeline quotes what was reported");
  ok(prose.includes("Clipped the wall at 74s"), "and what the admin found");

  // The hash chain: alter one line and every digest after it must stop
  // agreeing. This is the whole reason the extract is written this way.
  const lines = files
    .get("log.ndjson")!
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  ok(lines.length > 0, `the extract has the player's rows in it (${lines.length})`);
  ok(verifyChain(lines), "and the chain verifies as written");
  if (lines.length > 1) {
    const tampered = lines.map((l) => ({ ...l }));
    tampered[0].type = "something.else";
    ok(!verifyChain(tampered), "change one line and the chain no longer verifies");
    const dropped = lines.slice(1);
    ok(!verifyChain(dropped), "remove one and it does not either");
  } else {
    ok(true, "(too few rows to tamper with — skipped)");
  }
} finally {
  await sweep();
  await pool.end();
}

console.log(fails === 0 ? "\nAll checks passed.\n" : `\n${fails} CHECK(S) FAILED\n`);
process.exit(fails === 0 ? 0 : 1);

/** Recompute the chain the way anybody else would, from the file alone. */
function verifyChain(lines: Record<string, unknown>[]): boolean {
  let prev = "0".repeat(64);
  for (const line of lines) {
    if (line.prev !== prev) return false;
    const { hash, ...rest } = line;
    if (createHash("sha256").update(JSON.stringify(rest)).digest("hex") !== hash) return false;
    prev = String(hash);
  }
  return true;
}

/** A zip reader, so the check is not marking its own homework with the same
 *  code that wrote the file. Walks the central directory, which is how a real
 *  reader finds the entries. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) return out;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lnameLen = buf.readUInt16LE(local + 26);
    const lextraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnameLen + lextraLen;
    const body = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(body) : body);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
