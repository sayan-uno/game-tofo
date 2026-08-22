#!/usr/bin/env node
// DEV ONLY — proves the A0 enforcement path against a RUNNING backend:
// a banned player is turned away at the HTTP API and at the socket handshake,
// lifting the ban lets them straight back in, and an ordinary session leaves
// the trail the admin console will read.
//
//   npm run e2e:enforcement                       (backend on :4000)
//   PORT=4100 npm run e2e:enforcement             (the test backend)
//
// Run through tsx rather than node, because unlike mint.mjs it imports backend
// SOURCE — so it can never pass against a stale build.
//
// Every property here only exists when the real server, the real Postgres and
// the real Redis are all running at once, which is why it lives beside the
// browser tests rather than in tools/checks. It creates its own throwaway
// accounts and deletes everything it wrote, whether it passes or not.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// Same trick as mint.mjs: each dependency is loaded from the package that owns
// it, because the repo root resolves neither side's node_modules.
const back = (p) => import(path.join(root, "backend", "node_modules", p));
const front = (p) => import(path.join(root, "frontend", "node_modules", p));

const { config } = await back("dotenv/lib/main.js");
config({ path: path.join(root, "backend", ".env") });
const { default: pg } = await back("pg/lib/index.js");
const { default: jwt } = await back("jsonwebtoken/index.js");
const { io } = await front("socket.io-client/build/esm/index.js");

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error("backend/.env is missing JWT_SECRET or DATABASE_URL");
  process.exit(2);
}

const API = `http://localhost:${process.env.PORT || 4000}`;
const MARK = `enf-${Date.now()}`;
const DEVICE = "d1e5".repeat(8); // 32 hex, shared by both throwaway accounts
let fails = 0;
const ok = (c, m) => {
  console.log((c ? "  ✓ " : "  ✗ ") + m);
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const ids = [];

// Sweep anything a previous run left behind. A run killed mid-flight never
// reaches its own cleanup, and test rows must not accumulate in the one table
// that is supposed to be evidence.
{
  const { rows } = await db.query("select id from users where google_id like 'enf-%'");
  const stale = rows.map((r) => r.id);
  if (stale.length > 0) {
    await db.query("delete from sanctions where user_id = any($1)", [stale]);
    await db.query("delete from event_log where user_id = any($1)", [stale]);
    // Reports point at users with ON DELETE SET NULL, so they would OUTLIVE
    // the throwaway account and sit in the moderation queue looking real.
    await db.query("delete from reports where reporter_user_id = any($1) or subject_user_id = any($1)", [stale]);
    await db.query("delete from users where id = any($1)", [stale]);
    console.log(`swept ${stale.length} account(s) from an interrupted run`);
  }
}

async function makeUser(n) {
  const uid = String(9_400_000_000 + Math.floor(Math.random() * 599_999_999));
  const {
    rows: [u],
  } = await db.query(
    "insert into users (uid, google_id, email, name, username) values ($1,$2,$3,$4,$5) returning id",
    [uid, `${MARK}:${n}`, `${MARK}-${n}@e2e.invalid`, `Enf ${n}`, `Enf${uid.slice(-6)}`]
  );
  ids.push(u.id);
  return { id: u.id, uid, token: jwt.sign({ userId: u.id, uid, name: `Enf ${n}` }, process.env.JWT_SECRET, { expiresIn: "10m" }) };
}

const api = (token, p = "/api/profile/me") => fetch(API + p, { headers: { Authorization: `Bearer ${token}` } });
const post = (token, p, body) =>
  fetch(API + p, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/** Open a socket, run something with it, and always close it. Every sanction
 *  below is checked through the handler a real client would hit, not by
 *  calling the service that implements it — a check that never crosses the
 *  wire cannot tell you the wiring is right. */
function withSocket(token, fn, budgetMs = 12_000) {
  return new Promise((resolve) => {
    const s = io(API, { auth: { token, deviceHash: DEVICE }, transports: ["websocket"], reconnection: false, timeout: 8000 });
    let done = false;
    const finish = async (v) => {
      if (done) return;
      done = true;
      s.close();
      resolve(v);
    };
    // "connected" is not "ready": the server's connect handler is async and
    // puts the player in a lobby several awaits later. lobby:members is the
    // event that says that finished, and anything asking about a lobby — a
    // voice token, a start — has to wait for it.
    let ready = false;
    const start = () => {
      if (ready) return;
      ready = true;
      // Surface what went wrong rather than resolving null: a helper that
      // swallows the error turns "the socket threw" into "the socket timed
      // out", and those are diagnosed very differently.
      void fn(s).then(finish, (err) => finish({ error: String(err?.message ?? err) }));
    };
    s.on("lobby:members", start);
    s.on("connect", () => setTimeout(start, 3000)); // fallback, never the path
    s.on("connect_error", (e) => void finish({ connectError: e.message }));
    setTimeout(() => void finish({ error: `gave up after ${budgetMs}ms` }), budgetMs);
  });
}
/** Wait for one server-pushed event, or give up. */
const waitFor = (s, event, ms = 20000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload ?? {});
    });
  });

const emit = (s, event, payload) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: "no answer" }), 6000);
    s.emit(event, payload, (r) => {
      clearTimeout(t);
      resolve(r ?? {});
    });
  });

/** Resolves "connected", or the handshake error the server sent back. */
const connect = (token, holdMs = 0) =>
  new Promise((resolve) => {
    const s = io(API, { auth: { token, deviceHash: DEVICE }, transports: ["websocket"], reconnection: false, timeout: 6000 });
    const done = (v) => {
      s.close();
      resolve(v);
    };
    s.on("connect", () => setTimeout(() => done("connected"), holdMs));
    s.on("connect_error", (e) => done(e.message));
    setTimeout(() => done("timeout"), 10_000);
  });

try {
  const a = await makeUser(1);
  const b = await makeUser(2);

  console.log("\nbefore any sanction");
  ok((await api(a.token)).status === 200, "the API serves the player");
  ok((await connect(a.token, 900)) === "connected", "the socket handshake lets them in");

  console.log("\nbanned");
  await db.query(
    "insert into sanctions (user_id, type, reason, expires_at) values ($1,'ban',$2, now() + interval '1 hour')",
    [a.id, "Cheating — e2e"]
  );
  // The console applies bans through applySanction, which writes the Redis key
  // itself. Inserting the row directly and warming instead exercises the OTHER
  // path — the one a restart takes — which is the one that silently fails.
  const { refreshSanctionCache } = await import("../../backend/src/services/sanctions.js");
  /** Apply straight to the record and rebuild the cache — the same path a
   *  restart takes, which is the one that silently fails if warming is wrong.
   *  The console's own route is covered by e2e:admin. */
  async function apply(userId, type, reason) {
    await db.query(
      "insert into sanctions (user_id, type, reason, expires_at) values ($1,$2,$3, now() + interval '1 hour')",
      [userId, type, reason]
    );
    await refreshSanctionCache(userId);
  }
  async function clear(userId) {
    await db.query("update sanctions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
    await refreshSanctionCache(userId);
  }
  await refreshSanctionCache(a.id);

  const res = await api(a.token);
  const body = await res.json();
  ok(res.status === 403, `the API refuses them with 403 (got ${res.status})`);
  ok(body.code === "BANNED", "and marks it as a ban, so the client can show the reason rather than a blank error");
  ok(body.error === "Cheating — e2e", `the player is told the actual reason ("${body.error}")`);
  const err = await connect(a.token);
  ok(String(err).startsWith("BANNED:"), `the socket handshake refuses them too (${err})`);
  ok((await api(b.token)).status === 200, "an unrelated player is unaffected");

  // A ban that also removes the way to say "this is wrong" is a decision with
  // no way back. Everything else is refused; this one route is not — and it is
  // reachable through the guard a real client hits, not by calling the service
  // that implements it.
  const appeal = await post(a.token, "/api/reports/appeal", { note: "I was not cheating — e2e" });
  ok(appeal.status === 200, `a banned player can still appeal (got ${appeal.status})`);
  const [queued] = (
    await db.query("select note, kind, status from reports where reporter_user_id = $1 and kind = 'appeal'", [a.id])
  ).rows;
  ok(queued?.note === "I was not cheating — e2e", "and the appeal is in the queue, in their words");
  ok(queued?.status === "new", "waiting to be read like any other report");
  const twice = await post(a.token, "/api/reports/appeal", { note: "again" });
  ok(twice.status === 429, `but only one a day (got ${twice.status})`);
  // Everything else still refuses them: the hole is exactly one route wide.
  ok((await post(a.token, "/api/reports", { uid: b.uid, category: "text" })).status === 403,
     "and they still cannot report anybody else — the exception is one route wide");

  console.log("\nlifted");
  await db.query("update sanctions set revoked_at = now() where user_id = $1", [a.id]);
  await refreshSanctionCache(a.id);
  ok((await api(a.token)).status === 200, "the API lets them back in at once");
  ok((await connect(a.token)) === "connected", "and so does the socket");

  console.log("\nvoice mute");
  {
    // A voice token is only issued to somebody who is IN a lobby, and a lobby
    // only exists while their socket is open — so the request has to be made
    // from inside a live connection, exactly as the real client makes it.
    const tokenNow = () =>
      withSocket(b.token, async () => {
        const res = await post(b.token, "/api/voice/token", { scope: "party" });
        return { status: res.status, body: await res.json() };
      });

    const before = await tokenNow();
    if (before?.status === 503) {
      console.log("  (LiveKit is not configured here — skipped)");
    } else if (before?.status !== 200) {
      ok(false, `could not get a voice token to test with (HTTP ${before?.status}: ${JSON.stringify(before?.body)})`);
    } else {
      ok(before.body.canPublish === true, "an ordinary player is issued a token that may speak");
      await apply(b.id, "voice", "e2e voice mute");
      const after = await tokenNow();
      ok(after?.body?.canPublish === false, "a muted player is issued a token that may NOT speak");
      ok(Boolean(after?.body?.token), "…and they still get a token, so they can still hear");
      await clear(b.id);
      const lifted = await tokenNow();
      ok(lifted?.body?.canPublish === true, "lifting the mute gives their voice back");
    }
  }

  console.log("\nchat mute");
  {
    const sent = await withSocket(b.token, (s) => emit(s, "chat:dm", { toUid: a.uid, body: "before any mute" }));
    ok(sent?.ok === true, "an ordinary player can send a direct message");

    await apply(b.id, "chat", "e2e chat mute");
    const muted = await withSocket(b.token, (s) => emit(s, "chat:dm", { toUid: a.uid, body: "while muted" }));
    ok(Boolean(muted?.error), `a chat-muted player is refused, and told (${muted?.error})`);
    await clear(b.id);

    const { rows: beforeShadow } = await db.query("select count(*)::int n from dm_messages where sender_id = $1", [b.id]);
    await apply(b.id, "shadow-chat", "e2e shadow mute");
    const shadowed = await withSocket(b.token, (s) => emit(s, "chat:dm", { toUid: a.uid, body: "into the void" }));
    ok(shadowed?.ok === true, "a SHADOW-muted player is told the message sent");
    const { rows: afterShadow } = await db.query("select count(*)::int n from dm_messages where sender_id = $1", [b.id]);
    ok(afterShadow[0].n === beforeShadow[0].n, "…and it reached nobody — nothing was stored or delivered");
    await clear(b.id);
  }

  console.log("\nmatch ban");
  {
    const free = await withSocket(b.token, (s) => emit(s, "lobby:start", {}));
    ok(/choose a game/i.test(free?.error ?? ""), "an ordinary player gets as far as picking a game");
    await apply(b.id, "match", "e2e match ban");
    const barred = await withSocket(b.token, (s) => emit(s, "lobby:start", {}));
    ok(/e2e match ban/.test(barred?.error ?? ""), `a match-banned player is stopped before that, with the reason (${barred?.error})`);
    await clear(b.id);
    const again = await withSocket(b.token, (s) => emit(s, "lobby:start", {}));
    ok(/choose a game/i.test(again?.error ?? ""), "lifting it lets them start again");
  }

  console.log("\nmaintenance mode");
  {
    const { setFlags } = await import("../../backend/src/platform/flags.js");
    await setFlags({ maintenance: true, maintenanceMessage: "e2e" });
    const shut = await withSocket(a.token, async () => "connected");
    ok(shut?.connectError === "MAINTENANCE", `maintenance mode turns everyone away (${shut?.connectError})`);
    await setFlags({ maintenance: false });
    const open = await withSocket(a.token, async () => "connected");
    ok(open === "connected", "and turning it off lets them straight back in");
  }

  console.log("\na match, played and archived");
  {
    // Ludo needs no pack download, so a real match can be started, filled with
    // bots and abandoned inside half a minute. Abandoning it is the point:
    // what is being checked is that ending a match — however it ends — puts a
    // replay in the archive.
    // Generous: a solo start waits out the matchmaking fill deadline before
    // the bots arrive, so this one genuinely takes half a minute.
    const played = await withSocket(a.token, async (s) => {
      const picked = await emit(s, "lobby:pickGame", { gameId: "ludo" });
      if (picked?.error) return { error: `pick: ${picked.error}` };
      s.emit("game:progress", { pct: 100 });
      const started = await emit(s, "lobby:start", {});
      if (started?.error) return { error: `start: ${started.error}` };
      // A solo start waits for the pool, then fills the table with bots.
      // The matchmaker waits out its 10-second fill deadline before the bots
      // arrive. Generous on top of that, because this box is often busy
      // finishing a browser run — a suite that fails when the machine is loaded
      // teaches you to ignore it.
      const prepare = await waitFor(s, "match:prepare", 45000);
      if (!prepare?.matchId) return { error: "no match was assembled" };
      s.emit("match:ready", {});
      await new Promise((r) => setTimeout(r, 1500));
      await emit(s, "match:leave", {});
      return { matchId: prepare.matchId, roster: prepare.roster?.length ?? 0 };
    }, 75_000);

    if (played?.error) {
      ok(false, `could not play a match to archive (${played.error})`);
    } else {
      ok(Boolean(played?.matchId), `a match was assembled and filled (${played?.roster} at the table)`);
      // The archive worker drains every three seconds.
      let row = null;
      for (let i = 0; i < 12 && !row; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        const { rows } = await db.query("select * from match_replays where match_key = $1", [played.matchId]);
        row = rows[0] ?? null;
      }
      ok(Boolean(row), "ending it put a replay in the archive");
      if (row) {
        ok(row.game_id === "ludo", "recorded against the right game");
        ok(row.tier === "standard", "on standard retention, since nobody at the table was flagged");
        ok(Number(row.bytes) > 100, `with real content (${row.bytes} bytes)`);
        ok(row.expires_at !== null, "and an expiry, so retention can sweep it");

        // And the file itself is the match: decode it and re-rank.
        const { getEvidence } = await import("../../backend/src/platform/evidence.js");
        const { unpackReplay, toRankMembers } = await import("../../backend/src/platform/replay.js");
        await import("../../backend/src/games/index.js");
        const { getGame } = await import("../../backend/src/platform/games.js");
        const bytes = await getEvidence(row.r2_key);
        ok(bytes !== null, "the file is where the row says it is");
        if (bytes) {
          const file = unpackReplay(bytes);
          ok(file.matchKey === played.matchId, "and it is that match");
          ok(file.roster.length === played.roster, "with everyone who was at the table");
          ok(file.roster.some((r) => r.isBot), "bots included, marked as bots");
          const reranked = getGame("ludo").rank(toRankMembers(file), file.endTick, file.seed);
          ok(
            JSON.stringify(reranked) === JSON.stringify(file.standings),
            "and re-ranking it gives the standings the server recorded — from a REAL match this time"
          );
        }
        // The row AND the file: deleting only the row leaves an orphan in the
        // archive that no retention sweep will ever find, because sweeping is
        // driven by the rows.
        const { deleteEvidence } = await import("../../backend/src/platform/evidence.js");
        await deleteEvidence([row.r2_key]);
        await db.query("delete from match_replays where match_key = $1", [played.matchId]);
      }
    }
  }

  console.log("\nthe trail");
  await connect(b.token, 1100);
  await sleep(3500); // the buffered writer flushes every 2s
  const { rows } = await db.query(
    "select type, ip is not null has_ip, device_hash, data from event_log where user_id = any($1) order by id",
    [ids]
  );
  const count = (t) => rows.filter((r) => r.type === t).length;
  ok(count("session.start") >= 3, `every connection was recorded as started (${count("session.start")})`);
  ok(count("session.end") >= 3, `and every one as ended (${count("session.end")})`);
  ok(count("session.rejected") === 1, "the refused connection is recorded too — a ban attempt is evidence");
  ok(rows.every((r) => r.has_ip), "every row carries the address it came from");
  ok(rows.every((r) => r.device_hash === DEVICE), "and the device it came from");
  ok(
    rows.some((r) => r.type === "session.end" && typeof r.data?.seconds === "number"),
    "a session records how long it lasted"
  );

  const { rows: dev } = await db.query("select user_id from user_devices where device_hash = $1 and user_id = any($2)", [
    DEVICE,
    ids,
  ]);
  ok(dev.length === 2, `both accounts are linked to the one device (${dev.length}) — this is how ban evasion becomes visible`);

  console.log("\nno leaks");
  const { Redis } = await back("ioredis/built/index.js");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  const online = await redis.smembers("presence:online");
  ok(
    ids.every((id) => !online.includes(id)),
    "nobody is left marked online after disconnecting — the live player count does not drift"
  );
  redis.disconnect();
} finally {
  await db.query("delete from sanctions where user_id = any($1)", [ids]);
  await db.query("delete from event_log where user_id = any($1)", [ids]);
  await db.query("delete from reports where reporter_user_id = any($1) or subject_user_id = any($1)", [ids]);
  await db.query("delete from users where id = any($1)", [ids]);
  await db.end();
}

console.log(fails === 0 ? "\nENFORCEMENT PROVEN" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
