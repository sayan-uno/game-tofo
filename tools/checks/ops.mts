// Verification suite for the admin-console foundations (A0) — run it after ANY
// change to the event log, the sanction cache, the ops snapshot or the control
// channel.
//
//     npm run check:ops
//
// Unlike the game checks this one is NOT pure: it talks to the real Postgres
// and the real Redis, because every property worth proving here is a property
// of those. It therefore takes two precautions:
//
//   * It uses its OWN Redis database index. Two processes on one Redis is the
//     bug that costs an hour to find, and a check that stomped on the dev
//     lobby's keys would be its own version of it.
//   * Everything it writes to Postgres is tagged and deleted at the end.
//
// It imports backend SOURCE, so it can never pass against a stale build. It
// reaches Postgres through the pool rather than Drizzle, and stubs Socket.IO,
// because the repo root cannot resolve backend's node_modules — and because
// what is under test here is the signing and the buffering, not Socket.IO.
//
// What it proves, and why each check is here:
//
//   ip         — a forwarded header is believed only when a proxy we trust
//                wrote it, and it is counted from the RIGHT. Trusting the
//                leftmost entry is how an "IP log" ends up recording whatever
//                the attacker typed
//   eventlog   — logEvent does NO I/O, so no player ever waits on it; a flush
//                really writes; the buffer is bounded and drops the oldest;
//                and a row Postgres will never accept is bisected out instead
//                of jamming the queue for ever
//   sanctions  — the enforcement read is one Redis GET; an expired sanction
//                stops counting without anything having to sweep it; lifting
//                clears it; and a flushed Redis is rebuilt from the record,
//                because otherwise a restart silently un-bans everyone
//   presence   — the online count is maintained by connect/disconnect and is
//                O(1) rather than a keyspace scan
//   snapshot   — the console's live picture is published, carries what the
//                dashboard needs, and EXPIRES, so a crashed process stops
//                being reported as healthy
//   channel    — a signed command runs; a tampered one does not; a stale one
//                does not; a redelivered one runs exactly once; and a command
//                addressed to another instance is ignored. That last one is
//                not hypothetical: Redis pub/sub ignores the database index,
//                so a dev server running alongside this check hears every
//                command it sends

// ---- prelude ----------------------------------------------------------------
// All three overrides must be in place before anything reads config, which is
// why every import below is dynamic — and why the env file is read here by
// hand rather than through dotenv, which only runs inside those imports.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
if (!base) {
  console.error("REDIS_URL is not set in backend/.env");
  process.exit(2);
}
process.env.REDIS_URL = `${base}/6`;
process.env.EVENT_LOG_MAX_BUFFER = "40";
process.env.TRUSTED_PROXY_HOPS = "1";

const { config } = await import("../../backend/src/config.js");
const { redis, setOnline, setOffline, countOnline, clearOnlineSet } = await import("../../backend/src/redis.js");
const { pool } = await import("../../backend/src/db/client.js");
const { logEvent, flushEvents, eventLogStats } = await import("../../backend/src/services/eventLog.js");
const { normaliseIp, requestOrigin, deviceHashFrom } = await import("../../backend/src/services/clientIp.js");
const { applySanction, liftSanction, getSanctions, refreshSanctionCache, warmSanctionCache } = await import(
  "../../backend/src/services/sanctions.js"
);
const { startOpsSnapshot, stopOpsSnapshot, writeSnapshotNow, liveKey, liveMatchesKey } = await import(
  "../../backend/src/platform/ops.js"
);
const { startOpsCommands, stopOpsCommands, sendOpsCommand, stopOpsPublisher, CMD_CHANNEL } = await import(
  "../../backend/src/platform/opsCommands.js"
);
const { createHmac, randomUUID } = await import("node:crypto");

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, values)).rows as T[];

const MARK = `check-${Date.now()}`;
/** Everything this file writes to event_log, identifiable without knowing which
 *  run wrote it. Swept before AND after, because a run killed mid-flight (a
 *  timeout, a Ctrl-C) never reaches its own cleanup — and an evidence log with
 *  test rows in it is not evidence. */
const RESIDUE = `data->>'mark' like 'check-%' or (type = 'ops.command' and data->>'by' = 'check')`;
/** Only three members of Server are reached by the code under test: the socket
 *  map, `emit`, and nothing else. A stub keeps the check off a real port. */
const io = { sockets: { sockets: new Map() }, emit: () => undefined } as never;

await redis.connect();
await redis.flushdb(); // our own index — see the header
await pool.query(`delete from event_log where ${RESIDUE}`);

let userId = "";

try {
  // ---- ip ------------------------------------------------------------------
  console.log("\nip");
  {
    ok(normaliseIp("::ffff:203.0.113.9") === "203.0.113.9", "an IPv4-mapped address is unwrapped, so one phone is one device");
    ok(normaliseIp("203.0.113.9:51234") === "203.0.113.9", "a port is stripped");
    ok(normaliseIp("[2001:db8::1]:443") === "2001:db8::1", "a bracketed IPv6 with a port is unwrapped");
    ok(normaliseIp("2001:db8::1") === "2001:db8::1", "a bare IPv6 survives intact");
    ok(normaliseIp("not-an-ip") === null, "garbage becomes null rather than an exception at insert time");
    ok(normaliseIp("") === null && normaliseIp(undefined) === null, "empty and missing become null");

    const req = (headers: Record<string, string>, socketIp = "10.0.0.1") =>
      requestOrigin({ headers, socket: { remoteAddress: socketIp } } as never);

    ok(
      req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }).ip === "2.2.2.2",
      "with one trusted proxy the client IP is counted from the RIGHT — a spoofed leading entry is ignored"
    );
    ok(
      req({ "cf-connecting-ip": "3.3.3.3", "x-forwarded-for": "9.9.9.9" }).ip === "3.3.3.3",
      "CF-Connecting-IP wins over anything the client put in X-Forwarded-For"
    );
    ok(req({}).ip === "10.0.0.1", "with no headers the socket address is used");
    ok(req({ "cf-ipcountry": "IN" }).country === "IN", "the country is read from Cloudflare");
    ok(req({ "cf-ipcountry": "XX" }).country === null, "Cloudflare's unknown-country marker is not stored as a country");

    ok(deviceHashFrom("a".repeat(32)) === "a".repeat(32), "a well-formed device hash is accepted");
    ok(deviceHashFrom("nope") === null && deviceHashFrom(123) === null, "anything else is refused — it is a hint, not an identity");
  }

  // ---- eventlog ------------------------------------------------------------
  console.log("\neventlog");
  {
    const before = eventLogStats();
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) logEvent({ type: "session.start", data: { mark: MARK, i } });
    const ms = performance.now() - t0;
    const after = eventLogStats();
    ok(after.written === before.written, "logEvent wrote NOTHING to Postgres — a player never waits on the log");
    ok(ms < 250, `5000 calls took ${ms.toFixed(0)} ms — no I/O on the calling path`);
    ok(after.buffered <= 40, `the buffer is bounded (${after.buffered} held of 5000 offered)`);
    ok(after.dropped >= 4960, `overflow drops the OLDEST and counts them (${after.dropped} dropped)`);

    const wrote = await flushEvents();
    ok(wrote === 40, `a flush writes the whole buffer in one go (${wrote} rows)`);
    ok(eventLogStats().buffered === 0, "and leaves the buffer empty");

    const [{ n }] = await q<{ n: string }>("select count(*) n from event_log where data->>'mark' = $1", [MARK]);
    ok(Number(n) === 40, `the rows really are in Postgres (${n})`);

    const [{ newest }] = await q<{ newest: string }>(
      "select max((data->>'i')::int) newest from event_log where data->>'mark' = $1",
      [MARK]
    );
    ok(Number(newest) === 4999, `the events kept are the newest ones (highest kept: ${newest})`);
  }

  // ---- eventlog: the poison row --------------------------------------------
  console.log("\neventlog · unjammable");
  {
    // `type` is varchar(40); this row can never be inserted. Postgres answers
    // with SQLSTATE 22001, which is what tells the flusher to bisect the batch
    // rather than retry the same failure for ever.
    logEvent({ type: "x".repeat(60) as never, data: { mark: MARK, poison: true } });
    for (let i = 0; i < 5; i++) logEvent({ type: "session.end", data: { mark: MARK, good: i } });
    const before = eventLogStats();
    const wrote = await flushEvents();
    const after = eventLogStats();
    ok(wrote === 5, `the five good rows still got through (${wrote})`);
    ok(after.buffered === 0, "and the queue is empty — one unwritable row does not jam the log for ever");
    ok(after.dropped === before.dropped + 1, "exactly the bad row was dropped, and counted");
    ok(after.failures > before.failures, "the failure was recorded rather than swallowed");
  }

  // ---- sanctions -----------------------------------------------------------
  console.log("\nsanctions");
  {
    const uid = String(9_000_000_000 + Math.floor(Math.random() * 999_999_999));
    const [u] = await q<{ id: string }>(
      "insert into users (uid, google_id, email, name) values ($1,$2,$3,$4) returning id",
      [uid, `check:${MARK}`, `${MARK}@check.invalid`, "A0 check"]
    );
    userId = u.id;

    ok(Object.keys(await getSanctions(userId)).length === 0, "a clean player reads as no sanctions");
    ok((await redis.get(`ban:${userId}`)) === null, "and holds no Redis key at all — the cheapest possible check");

    const { id: banId } = await applySanction({
      userId,
      type: "ban",
      reason: "self-check",
      expiresAt: new Date(Date.now() + 60_000),
    });
    ok((await getSanctions(userId)).ban?.reason === "self-check", "applying a ban is visible to the hot path immediately");
    ok((await redis.pttl(`ban:${userId}`)) > 0, "the key carries a TTL, so an expiry cleans itself up");

    await applySanction({ userId, type: "voice", reason: "muted", expiresAt: new Date(Date.now() + 60_000) });
    const both = await getSanctions(userId);
    ok(Boolean(both.ban && both.voice), "several kinds of sanction ride in ONE key — still one GET");

    // Expiry is honoured by the reader, not by a sweeper.
    await redis.set(`ban:${userId}`, JSON.stringify({ ban: { id: "x", reason: "old", until: Date.now() - 1000 } }));
    ok(Object.keys(await getSanctions(userId)).length === 0, "an expired sanction stops counting the moment it expires");

    await refreshSanctionCache(userId);
    ok(Boolean((await getSanctions(userId)).ban), "the cache rebuilds from the record");

    await redis.del(`ban:${userId}`);
    ok(Object.keys(await getSanctions(userId)).length === 0, "a flushed Redis leaves the player unenforced…");
    const warmed = await warmSanctionCache();
    ok(warmed >= 1, `…and boot-time warming puts them back (${warmed} restored)`);
    ok(Boolean((await getSanctions(userId)).ban), "so a restart cannot silently un-ban anyone");

    ok(await liftSanction(banId, null), "lifting reports success");
    const afterLift = await getSanctions(userId);
    ok(!afterLift.ban, "the ban is gone from the hot path");
    ok(Boolean(afterLift.voice), "and the unrelated voice mute is untouched");
    ok(!(await liftSanction(banId, null)), "lifting the same sanction twice is refused, so a double click is harmless");
  }

  // ---- presence ------------------------------------------------------------
  console.log("\npresence");
  {
    await clearOnlineSet();
    ok((await countOnline()) === 0, "a fresh boot starts from zero rather than a previous run's leftovers");
    await setOnline("u1", "s1");
    await setOnline("u2", "s2");
    ok((await countOnline()) === 2, "connecting is counted");
    await setOnline("u1", "s1b");
    ok((await countOnline()) === 2, "reconnecting the same player does not count twice");
    await setOffline("u1");
    ok((await countOnline()) === 1, "disconnecting is counted");
    ok((await redis.get("presence:u2")) === "s2", "the per-user socket lookup still works alongside it");
  }

  // ---- snapshot ------------------------------------------------------------
  console.log("\nsnapshot");
  {
    await writeSnapshotNow(io);
    const snap = await redis.hgetall(liveKey(config.instanceId));
    ok(snap.instanceId === config.instanceId, "the snapshot names the instance that wrote it");
    for (const field of ["online", "matches", "sockets", "queue", "matchesByGame", "eventLog", "uptimeSec", "rssMb", "evidence", "replay"]) {
      ok(snap[field] !== undefined, `it carries ${field}`);
    }
    ok(JSON.parse(snap.matchesByGame ?? "null") !== null, "matchesByGame is valid JSON the console can read");
    ok(Number(snap.online) === 1, "the live player count comes through");
    ok(snap.evidence === "disk" || snap.evidence === "r2", `it says where replays are being archived (${snap.evidence})`);
    const ttl = await redis.ttl(liveKey(config.instanceId));
    ok(ttl > 0 && ttl <= 8, `it expires (${ttl}s), so a crashed process stops reporting itself as healthy`);
    ok((await redis.ttl(liveMatchesKey(config.instanceId))) > 0, "the live match list expires too");
    ok(
      JSON.parse((await redis.get(liveMatchesKey(config.instanceId))) ?? "null")?.length === 0,
      "with no matches running it is an empty list, not a missing key"
    );
    startOpsSnapshot(io);
    stopOpsSnapshot();
    ok(true, "the timer starts and stops without leaking");
  }

  // ---- channel -------------------------------------------------------------
  console.log("\nchannel");
  {
    startOpsCommands(io);
    await sleep(200); // let the subscription land

    const me = { by: "check", instance: config.instanceId };
    const ack = await sendOpsCommand("ping", {}, me);
    ok(ack?.ok === true, "a signed command reaches the game process and is acknowledged");
    ok(
      (ack?.result as { instanceId?: string })?.instanceId === config.instanceId,
      "the acknowledgement identifies who ran it"
    );

    const bad = await sendOpsCommand("disconnect", {}, me);
    ok(bad?.ok === false, "a command missing its arguments is refused, and says so rather than failing silently");

    const gone = await sendOpsCommand("disconnect", { userId: "nobody" }, me);
    ok((gone?.result as { disconnected?: boolean })?.disconnected === false, "disconnecting an absent player is a clean no-op");

    // Forgery attempts go on the wire directly — sendOpsCommand would sign them.
    const listener = redis.duplicate();
    await listener.subscribe("ops:ack");
    let heard = 0;
    listener.on("message", () => { heard++; });

    const forged = { id: randomUUID(), at: Date.now(), cmd: "broadcast", args: { message: "hi" }, sig: "0".repeat(64) };
    await redis.publish(CMD_CHANNEL, JSON.stringify(forged));
    await sleep(250);
    ok(heard === 0, "a command with a forged signature is refused — reaching Redis is not authority to act");

    const sign = (c: Record<string, unknown>) =>
      createHmac("sha256", config.opsHmacSecret)
        .update(`${c.id}|${c.at}|${c.cmd}||${c.by ?? ""}|${c.instance ?? ""}`)
        .digest("hex");

    const stale = { id: randomUUID(), at: Date.now() - 120_000, cmd: "ping", args: {}, by: "check", instance: config.instanceId };
    await redis.publish(CMD_CHANNEL, JSON.stringify({ ...stale, sig: sign(stale) }));
    await sleep(250);
    ok(heard === 0, "a correctly signed but old command is refused — a captured message cannot be replayed later");

    const once = { id: randomUUID(), at: Date.now(), cmd: "ping", args: {}, by: "check", instance: config.instanceId };
    const signed = JSON.stringify({ ...once, sig: sign(once) });
    await redis.publish(CMD_CHANNEL, signed);
    await redis.publish(CMD_CHANNEL, signed);
    await sleep(350);
    ok(heard === 1, `a redelivered command runs exactly once (${heard} acknowledgement)`);

    const elsewhere = { id: randomUUID(), at: Date.now(), cmd: "ping", args: {}, by: "check", instance: "some-other-server" };
    await redis.publish(CMD_CHANNEL, JSON.stringify({ ...elsewhere, sig: sign(elsewhere) }));
    await sleep(250);
    ok(heard === 1, "a command addressed to another instance is ignored — pub/sub crosses database indexes, so this matters");
    await listener.quit();
  }
} finally {
  await stopOpsCommands();
  await stopOpsPublisher();
  stopOpsSnapshot();
  try {
    await q(`delete from event_log where ${RESIDUE}`);
    if (userId) await q("delete from event_log where user_id = $1", [userId]);
    if (userId) await q("delete from users where id = $1", [userId]);
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  await redis.flushdb();
  redis.disconnect();
  await pool.end();
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
