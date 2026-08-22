#!/usr/bin/env node
// DEV ONLY — proves a party recording starts and ENDS with the group it
// belongs to, against a RUNNING backend:
//
//   npm run e2e:party                            (backend on :4000)
//   PORT=4100 npm run e2e:party                  (the test backend)
//
// Why this exists
// ---------------
// A party session is opened and closed by broadcastLobby: two people in a
// lobby opens one, fewer than two closes it. Every path that dissolves a group
// therefore has to broadcast the lobby it just emptied — and leadership
// transfer did not. The group moved to the new leader's lobby id, a second
// session opened there, and the FIRST one stayed live: for the twelve-hour key
// TTL, or until the server restarted and swept it. The console showed a party
// still running under a leader who had handed it over, stamped as lasting the
// whole time although nobody was in it after the transfer, and the voice
// recorder stayed joined to a room with nobody in it.
//
// It is checked here rather than in a unit test because the bug lived in the
// wiring, not in any one function: every piece worked, and the call that ties
// them together was missing. Only a real socket crossing the real handler can
// tell you the wiring is right.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const back = (p: string) => import(path.join(root, "backend", "node_modules", p));
const front = (p: string) => import(path.join(root, "frontend", "node_modules", p));

const { config } = await back("dotenv/lib/main.js");
config({ path: path.join(root, "backend", ".env") });
const { default: pg } = await back("pg/lib/index.js");
const { default: jwt } = await back("jsonwebtoken/index.js");
const { io } = await front("socket.io-client/build/esm/index.js");
const { Redis } = await back("ioredis/built/index.js");

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error("backend/.env is missing JWT_SECRET or DATABASE_URL");
  process.exit(2);
}

const API = `http://localhost:${process.env.PORT || 4000}`;
const MARK = `ptl-${Date.now()}`;
let fails = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  ✓ " : "  ✗ ") + m);
  if (!c) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A POOL, not a single client. This test polls the database while sockets do
// their work, and a managed Postgres behind a proxy will now and then hang up
// a connection mid-run — which a pg.Client cannot recover from (it does not
// reconnect) and reports as an unhandled 'error' event that takes the whole
// run down with it, after every assertion has already passed. A pool replaces
// a dead connection and carries on.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
db.on("error", (err: Error) => console.log(`    (database link hiccup, recovering: ${err.message})`));
const ids: string[] = [];

// A run killed mid-flight never reaches its own cleanup, and throwaway
// accounts must not accumulate in a table the console reads as real players.
{
  const { rows } = await db.query("select id from users where google_id like 'ptl-%'");
  const stale = rows.map((r: { id: string }) => r.id);
  if (stale.length > 0) {
    await db.query("delete from event_log where user_id = any($1)", [stale]);
    await db.query("delete from users where id = any($1)", [stale]);
    console.log(`swept ${stale.length} account(s) from an interrupted run`);
  }
}

async function makeUser(n: number) {
  const uid = String(9_300_000_000 + Math.floor(Math.random() * 89_999_999));
  const {
    rows: [u],
  } = await db.query(
    "insert into users (uid, google_id, email, name, username) values ($1,$2,$3,$4,$5) returning id",
    [uid, `${MARK}:${n}`, `${MARK}-${n}@e2e.invalid`, `Party ${n}`, `Ptl${uid.slice(-6)}`]
  );
  ids.push(u.id);
  return {
    id: u.id as string,
    uid,
    lobby: `L${uid}`,
    token: jwt.sign({ userId: u.id, uid, name: `Party ${n}` }, process.env.JWT_SECRET!, { expiresIn: "10m" }),
  };
}

// Real pages send a heartbeat every few seconds and only while they are
// visible; a socket that never sends one is treated by the server as an older
// build and left alone. So the test's sockets beat too — otherwise every one
// of them is marked away during the first long wait and the party under test
// dissolves out from under it. `hush` is how a page is then made to go quiet
// on purpose, which is the thing actually being checked.
const beats = new Map<any, NodeJS.Timeout>();
function beat(s: any): void {
  if (beats.has(s)) return;
  s.emit("presence:beat");
  beats.set(s, setInterval(() => s.emit("presence:beat"), 3000));
}
function hush(s: any): void {
  const t = beats.get(s);
  if (t) clearInterval(t);
  beats.delete(s);
}

/** A connected socket that is READY — the server's connect handler is async,
 *  and a lobby call made before it finishes is answered by a half-built
 *  session. Waiting for the first lobby broadcast is the honest signal. */
function connect(token: string, deviceHash: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = io(API, { auth: { token, deviceHash }, transports: ["websocket"], reconnection: false, timeout: 8000 });
    const t = setTimeout(() => reject(new Error("socket never became ready")), 12_000);
    s.on("connect_error", (e: Error) => {
      clearTimeout(t);
      reject(e);
    });
    s.once("lobby:members", () => {
      clearTimeout(t);
      beat(s);
      resolve(s);
    });
  });
}

/** The next lobby broadcast this socket receives, while `go` makes it happen.
 *  The lobby is pushed, not polled, so this is how its state is read. */
function nextLobby(s: any, go: () => void, budgetMs = 8000): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      s.off("lobby:members", on);
      resolve(null);
    }, budgetMs);
    const on = (state: unknown) => {
      clearTimeout(t);
      s.off("lobby:members", on);
      resolve(state);
    };
    s.on("lobby:members", on);
    go();
  });
}

/** Emit and wait for the acknowledgement, exactly the way the real client
 *  does it.
 *
 *  The payload is OMITTED when there is none, rather than passed as undefined.
 *  Socket.IO sends undefined as a null argument, which shifts the callback
 *  into second place — and a handler declared as `(ack) => …`, which is how
 *  every no-payload event here is written, then treats that null as its
 *  acknowledgement and never replies. The action still happens; the answer
 *  never comes. That is silent unless somebody reads the result, and for a
 *  long time nothing did. */
const emit = (s: any, ev: string, payload?: unknown): Promise<any> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: `${ev} timed out` }), 8000);
    const done = (r: unknown) => {
      clearTimeout(t);
      resolve(r);
    };
    if (payload === undefined) s.emit(ev, done);
    else s.emit(ev, payload, done);
  });

// ONE client for the run. These are read in polling loops — a connection per
// poll would open a hundred of them to answer one question.
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });

/** Which lobby Redis says this user is in. */
const lobbyOf = (userId: string): Promise<string | null> => redis.get(`user:lobby:${userId}`);
const memberCount = (lobbyId: string): Promise<number> => redis.scard(`lobby:${lobbyId}:members`);

/** Party rows for a lobby id, newest first. */
const sessionsFor = async (room: string) =>
  (
    await db.query(
      `select key, room, started_at, ended_at,
              round(extract(epoch from (coalesce(ended_at, now()) - started_at))) as seconds
         from party_sessions where room = $1 order by started_at desc`,
      [room]
    )
  ).rows as { key: string; room: string; ended_at: string | null; seconds: string }[];

/** Wait for a condition against the database rather than sleeping a guessed
 *  number of milliseconds: the party log is written fire-and-forget, so how
 *  long it takes is not something this test gets to know. */
async function until<T>(what: string, fn: () => Promise<T | null>, budgetMs = 15_000): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    // One failed query is a hiccup, not an answer: keep asking until the
    // budget runs out rather than reporting a network blip as a verdict.
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) {
      console.log(`    (gave up waiting for ${what})`);
      return null;
    }
    await sleep(300);
  }
}

/** Wait for buffered activity-log rows to reach Postgres. logEvent does not
 *  write on the spot — it buffers and flushes on a timer, so that recording
 *  something costs the request nothing. A query fired straight after the call
 *  is racing that timer, and losing. */
async function loggedRows(sql: string, args: unknown[] = [], want = 1, budgetMs = 8000): Promise<any[]> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { rows } = await db.query(sql, args);
    if (rows.length >= want || Date.now() > deadline) return rows;
    await sleep(300);
  }
}

const sockets: any[] = [];
try {
  // One at a time: these share a pg client, and two queries on one client is
  // a deprecation warning printed into the middle of the results.
  const u1 = await makeUser(1);
  const u2 = await makeUser(2);
  const u3 = await makeUser(3);
  // A device hash each: two accounts sharing one would look like the very
  // multi-boxing the enforcement layer is built to stop.
  const s1 = await connect(u1.token, "a1b2".repeat(8));
  const s2 = await connect(u2.token, "c3d4".repeat(8));
  const s3 = await connect(u3.token, "e5f6".repeat(8));
  sockets.push(s1, s2, s3);

  console.log("\na group forms");
  ok((await emit(s1, "lobby:mode", { mode: "squad" })).ok, "the leader opens a squad");
  ok((await emit(s2, "lobby:join", { lobbyId: u1.lobby })).ok, "a second player joins it");

  // The moment it is a group it stops being anybody's personal lobby and gets
  // a name of its own — which it will keep for the rest of its life, whatever
  // happens to its leadership.
  const partyLobby = await until("the group to become a party", async () => {
    const id = await lobbyOf(u2.id);
    return id && id.startsWith("P") ? id : null;
  });
  ok(partyLobby, `the group has an id of its own, not its leader's (${partyLobby})`);
  ok((await lobbyOf(u1.id)) === partyLobby, "and the player whose lobby it was came with it");
  ok((await emit(s3, "lobby:join", { lobbyId: partyLobby })).ok, "and a third joins that");
  const opened = await until("the party recording to open", async () => {
    const rows = await sessionsFor(partyLobby!);
    return rows.find((r) => !r.ended_at) ?? null;
  });
  ok(opened, `a party recording opened for it${opened ? ` (${opened.key})` : ""}`);
  if (!opened) throw new Error("no party session — nothing further can be checked");

  console.log("\nthe arrival that made it a group");
  {
    // THE ONE EVENT THAT WENT MISSING. Two writes start at almost the same
    // moment when the second person arrives: the state that OPENS the
    // recording, and the join that says how they got there. Nothing ordered
    // them, the join usually won, found no recording open yet and returned
    // without writing — so every party began with the single arrival nobody
    // could account for: the one that created the group.
    const log = await until("the party log to have the arrivals", async () => {
      const raw = await redis.lrange(`party:log:${opened.key}`, 0, -1);
      const evs = raw.map((r) => JSON.parse(r) as { k: string; uid?: string; via?: string });
      return evs.some((e) => e.k === "join" && e.uid === u2.uid) ? evs : null;
    });
    ok(log, "the person whose arrival turned this into a group is in its record");
    const first = log?.find((e) => e.k === "join" && e.uid === u2.uid);
    ok(first?.via, `and how they got in was kept (${first?.via ?? "nothing"})`);
    ok(
      log?.some((e) => e.k === "join" && e.uid === u3.uid),
      "so is everybody who came after them"
    );
  }

  console.log("\nthe crown moves to somebody else");
  {
    // THE POINT OF ALL THIS. A party used to be NAMED after whoever led it,
    // so handing it on renamed it — ending one recording, starting another,
    // and leaving the console showing two groups where there was one. A party
    // is named once now and keeps that name for life.
    const handed = await emit(s1, "lobby:transferLead", { targetUid: u2.uid });
    ok(handed.ok, `leadership transfers (${handed.error ?? "ok"})`);

    const after = await until("the transfer to settle", async () => {
      const state = await nextLobby(s3, () => void emit(s3, "lobby:sayReady", { ready: false }));
      return state?.members?.some((m: any) => m.uid === u2.uid && m.isLeader) ? state : null;
    });
    ok(after, "the new leader is the one the party is told about");
    ok(after?.lobbyId === opened.room, `and the party did NOT change its id (${after?.lobbyId})`);

    const rows = await sessionsFor(opened.room);
    ok(rows.length === 1, `one recording, not two (${rows.length})`);
    ok(rows[0] && !rows[0].ended_at, "still the same one, still running — the group never went anywhere");
    ok(
      (await memberCount(opened.room)) === 3,
      `with everybody still in it (${await memberCount(opened.room)})`
    );
  }

  console.log("\nready-up");
  {
    // u2 leads now, with u1 and u3 in the party. Starting needs a game and
    // everybody's agreement; this checks the agreement half, which is the new
    // rule — a leader can no longer drag a party into a game nobody said yes
    // to.
    const picked = await emit(s2, "lobby:pickGame", { gameId: "ludo" });
    ok(picked.ok, "the leader picks a game");
    // Everybody reports a finished download. The pack gate is older than the
    // ready-up gate and fires first, so without this the start is refused for
    // the wrong reason and this section proves nothing.
    for (const s of [s1, s2, s3]) s.emit("game:progress", { pct: 100 });
    await sleep(600);
    const early = await emit(s2, "lobby:start");
    ok(
      typeof early.error === "string" && /ready/i.test(early.error),
      `start is refused while a teammate has not said they are ready (${early.error ?? "no error"})`
    );

    const said = await emit(s1, "lobby:sayReady", { ready: true });
    ok(said.ok, "a member can say they are ready");
    const listed = await until("the ready-up to reach everyone", async () => {
      const state = await nextLobby(s3, () => void emit(s3, "lobby:sayReady", { ready: true }));
      return state?.ready?.includes(u1.uid) && state.ready.includes(u3.uid) ? state : null;
    });
    ok(listed, "and everybody in the party is told who has");

    // Withdrawing has to work too, or "ready" is a trap door.
    const withdrew = await emit(s1, "lobby:sayReady", { ready: false });
    ok(withdrew.ok, "and can take it back");
    const afterWithdraw = await emit(s2, "lobby:start");
    ok(
      typeof afterWithdraw.error === "string" && /ready/i.test(afterWithdraw.error),
      "which stops the start again"
    );

    // Only the leader starts; that has not changed.
    const notLeader = await emit(s1, "lobby:start");
    ok(
      typeof notLeader.error === "string" && /leader/i.test(notLeader.error),
      `a member still cannot start (${notLeader.error ?? "no error"})`
    );

    // …but a member CAN object, which is the polite alternative to leaving.
    const objected = await emit(s3, "lobby:objectGame");
    ok(objected.ok, `a member can ask for a different game (${objected.error ?? "ok"})`);
    const leaderObjects = await emit(s2, "lobby:objectGame");
    ok(
      typeof leaderObjects.error === "string",
      "the leader cannot object to their own pick — there is nobody to ask"
    );
  }

  console.log("\nholding a game, and barring one player from it");
  {
    // A HOLD stops anybody starting it; matches already running are not
    // touched. Written straight into Redis here — the console's own route is
    // covered by the admin suite; what this proves is that the LOBBY obeys it.
    await redis.hset("game:blocked", "ludo", "Ludo is unavailable for a moment.");
    const picked = await emit(s2, "lobby:pickGame", { gameId: "ludo" });
    ok(
      typeof picked.error === "string" && picked.error.includes("unavailable"),
      `a held game cannot be picked, and says why (${picked.error ?? "no error"})`
    );
    await redis.hdel("game:blocked", "ludo");
    ok((await emit(s2, "lobby:pickGame", { gameId: "ludo" })).ok, "and can be picked again once released");

    // Held BETWEEN the pick and the press is the ordinary case: a hold goes on
    // while parties are already sitting in front of the game.
    await redis.hset("game:blocked", "ludo", "Ludo is unavailable for a moment.");
    const late = await emit(s2, "lobby:start");
    ok(
      typeof late.error === "string" && late.error.includes("unavailable"),
      `and a hold applied after the pick still stops the start (${late.error ?? "no error"})`
    );
    await redis.hdel("game:blocked", "ludo");

    // ONE PLAYER barred stops the party — and is named, because a start that
    // fails without saying who is a party arguing with itself.
    await redis.hset(`game:ban:ludo`, u3.id, "Repeatedly ruining Ludo.");
    const blocked = await emit(s2, "lobby:start");
    ok(
      typeof blocked.error === "string" && blocked.error.includes("cannot play"),
      `one barred member stops the party (${blocked.error ?? "no error"})`
    );
    ok(
      typeof blocked.error === "string" && blocked.error.includes(u3.uid.slice(-6)),
      `and the party is told WHICH member (${blocked.error ?? ""})`
    );

    // The party is told through the broadcast too, not only when it fails.
    const told = await nextLobby(s2, () => void emit(s2, "lobby:pickGame", { gameId: "ludo" }));
    ok(
      told?.barred?.some((b: { uid: string }) => b.uid === u3.uid),
      "the lobby itself carries who is barred, so it can be shown before anybody presses start"
    );
    await redis.hdel(`game:ban:ludo`, u3.id);

    // Picking a game CLEARS what everybody had downloaded and agreed to —
    // deliberately, since neither carries to a different game — and this
    // section picked several times. Put both back for the section below.
    for (const sock of [s1, s2, s3]) sock.emit("game:progress", { pct: 100 });
    await sleep(700);
  }

  console.log("\nstopping a search nobody wants");
  {
    // Everybody is ready again, so the leader can actually queue.
    for (const s of [s1, s3]) await emit(s, "lobby:sayReady", { ready: true });
    const started = await emit(s2, "lobby:start");
    ok(started.ok, `the leader starts the search (${started.error ?? "queued"})`);

    // THE POINT: a member pulls the handle. Starting stays the leader's call;
    // being kept in a queue for a game you did not want is not.
    const ended = new Promise<any>((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      s2.once("match:searchEnded", (p: unknown) => {
        clearTimeout(t);
        resolve(p);
      });
    });
    const cancelled = await emit(s1, "lobby:cancelSearch");
    ok(cancelled.ok, `a member can stop the search (${cancelled.error ?? "ok"})`);
    const told = await ended;
    ok(told, "and the whole party is told it ended");
    ok(told?.by?.uid === u1.uid, `by name, so it is not a mystery (${told?.by?.name ?? "nobody"})`);

    // BOTH HALVES ON THE RECORD. Only the consequence used to be logged — a
    // match appearing — so a search that was cancelled, or that never filled,
    // left nothing at all behind. Pressing start is an act; so is stopping.
    const asked = await loggedRows(
      "select type, uid, game_id, data from event_log where type = 'lobby.search' and uid = $1 order by at desc limit 1",
      [u2.uid]
    );
    ok(asked.length === 1, "pressing start is on the record, not just the match it may become");
    ok(asked[0]?.game_id === "ludo", "with the game that was asked for");
    ok(asked[0]?.data?.solo === false, "and whether they were on their own or in a group");

    const stopped = await loggedRows(
      "select type, uid, data from event_log where type = 'lobby.cancel' and uid = $1 order by at desc limit 1",
      [u1.uid]
    );
    ok(stopped.length === 1, "and so is stopping it");
    ok(stopped[0]?.data?.leader === false, "saying it was not the leader who did — which is the interesting case");

    // …and a copy in the PARTY's own recording, because that is where the
    // run-up to a match gets watched back. A cancelled search never becomes a
    // match, so without this it leaves no trace in the group's record at all.
    const inParty = await until("the search to reach the party's record", async () => {
      const raw = await redis.lrange(`party:log:${opened.key}`, 0, -1);
      const evs = raw.map((r) => JSON.parse(r) as { k: string; on?: boolean; uid?: string });
      const both = evs.filter((e) => e.k === "search");
      return both.some((e) => e.on) && both.some((e) => !e.on) ? both : null;
    });
    ok(inParty, "the party's own record has the search too");
    ok(
      inParty?.some((e) => e.on && e.uid === u2.uid),
      "naming who went looking"
    );
    ok(
      inParty?.some((e) => !e.on && e.uid === u1.uid),
      "and who stopped it — a different person, which is the whole reason to name them"
    );
  }

  console.log("\na leader who vanishes");
  {
    // u2 leads. Kill the leader's socket outright — a closed tab, a dead
    // phone, a train tunnel. The party used to be left standing under a lobby
    // named after somebody who was gone, so nobody in it could pick a game,
    // change the mode or press start. Now the crown simply moves, and the
    // party itself does not notice: same id, same recording, same room.
    s2.close();
    const promoted = await until(
      "the group to find a new leader",
      async () => {
        const leader = await redis.get(`lobby:${partyLobby}:leader`);
        return leader && leader !== u2.id ? leader : null;
      },
      20_000
    );
    ok(promoted, "the group is handed to somebody who is still there");
    ok(promoted === u1.id, "the longest-present member, exactly as when a leader presses Leave");
    ok((await lobbyOf(u1.id)) === partyLobby, "and nobody was moved anywhere to do it");
    const rows = await sessionsFor(partyLobby!);
    ok(rows.length === 1 && !rows[0].ended_at,
       `still one recording, still running (${rows.length} row(s))`);
  }

  console.log("\nwho is actually here");
  // Checked on a player standing on their OWN, deliberately. Going quiet now
  // also takes you out of your group, so running this on somebody inside the
  // party would dissolve the very party the next section needs — which is the
  // rule working, but it makes for a test that fails on a race.
  const s2b = await connect(u2.token, "c3d4".repeat(8));
  sockets.push(s2b);
  {
    // A connected socket is not a player. The page says "I am still here"
    // every few seconds and ONLY while it is visible, so a phone in a pocket
    // or a tab behind six others stops counting as online — which is the
    // whole point: an "online" that means "a socket is up" tells a friend
    // nothing about whether anyone will answer them.
    const here = await until("the heartbeat to land", async () =>
      (await redis.exists(`here:${u2.id}`)) === 1 ? true : null, 8000);
    ok(here, "a page that says it is here counts as online");

    // …then it stops, as a minimised game does. Ten seconds of silence.
    hush(s2b);
    const gone = await until("the player to go quiet", async () =>
      (await redis.exists(`here:${u2.id}`)) === 0 ? true : null, 25_000);
    ok(gone, "and stops counting when it goes quiet, without disconnecting");

    // THE THING THAT MUST NOT BREAK. Away is not gone: invites, kicks and
    // match joins are all delivered through the socket registry, and a
    // player who put their phone down is still someone they must reach.
    ok((await redis.exists(`presence:${u2.id}`)) === 1,
       "but is still reachable — away is not the same as disconnected");

    beat(s2b);
    const back = await until("the player to come back", async () =>
      (await redis.exists(`here:${u2.id}`)) === 1 ? true : null, 8000);
    ok(back, "and one heartbeat brings them straight back");
  }

  console.log("\nbeing thrown out is not the same as leaving");
  {
    // FALSE EVIDENCE IS WORSE THAN NONE. A kick used to write two lines — the
    // move itself said "left the party", and the handler said "was removed" —
    // and the first one was a lie about the thing the record exists to settle.
    // u2 is standing on their own by now, and their socket is already open —
    // connecting a SECOND socket for somebody who is in the party would drop
    // their first one, which takes them out of the party and dissolves it.
    ok((await emit(s2b, "lobby:join", { lobbyId: partyLobby })).ok, "somebody joins the party");
    beat(s2b);
    await sleep(600);

    const leaderId = (await redis.get(`lobby:${partyLobby}:leader`)) as string | null;
    const boss = [
      { u: u1, s: s1 },
      { u: u3, s: s3 },
    ].find((p) => p.u.id === leaderId);
    ok(boss, `the party has a leader to do the removing (${leaderId})`);
    if (!boss) throw new Error("no leader to kick with — the party is gone");
    const kicked = await emit(boss.s, "lobby:kick", { targetUid: u2.uid });
    ok(kicked.ok, `the leader removes them (${kicked.error ?? "ok"})`);

    const said = await until("the removal to be written down", async () => {
      const raw = await redis.lrange(`party:log:${opened.key}`, 0, -1);
      const evs = raw.map((r) => JSON.parse(r) as { k: string; uid?: string; why?: string });
      const mine = evs.filter((e) => e.k === "leave" && e.uid === u2.uid);
      return mine.length > 0 ? mine : null;
    });
    ok(said, "the party's record says they went");
    // The LAST one, because this player has left this party before — their
    // socket died earlier in the run and that is a true line of its own. What
    // must not happen is the kick producing a second, contradictory line.
    ok(
      said?.[said.length - 1]?.why === "kicked",
      `and this time says they were REMOVED (${said?.map((e) => e.why).join(" → ")})`
    );
    ok(
      said?.filter((e) => e.why === "kicked").length === 1,
      `once, not twice (${said?.filter((e) => e.why === "kicked").length})`
    );
    ok(
      !said?.some((e, i) => e.why === "left" && i >= said.findIndex((x) => x.why === "kicked")),
      "and never as walking out — that would be the wrong answer, in writing, to the question the record settles"
    );
  }

  console.log("\nsomebody who stops answering");
  {
    // Now put that player into the party and let them go quiet again. A group
    // is people waiting on each other, and one who is not there holds up
    // everyone who is: nobody can start while a ready-up is missing, and
    // nobody can tell whether they are coming back.
    const rejoined = await emit(s2b, "lobby:join", { lobbyId: partyLobby });
    ok(rejoined.ok, `they can join the party that carried on without them (${rejoined.error ?? "joined"})`);
    await sleep(500);
    ok((await lobbyOf(u2.id)) === partyLobby, "and it is the same party, under the same id as before");

    // No disconnect — the socket stays wide open, exactly like a game
    // minimised behind something else.
    hush(s2b);
    // Wait for where they END UP, not for the first sign of movement: leaving
    // clears the membership key a moment before the move home writes it, and
    // a test that stops at "not in the party any more" reads that gap and
    // reports an empty answer as a wrong one.
    const dropped = await until(
      "the quiet player to be dropped",
      async () => ((await lobbyOf(u2.id)) === u2.lobby ? true : null),
      25_000
    );
    ok(dropped, "ten seconds of silence and they are out of the party, not left in it");
    ok((await memberCount(partyLobby!)) === 2, "and the party carries on without them");
  }

  console.log("\na party is not held by other people's matches");
  {
    // THE TRAP. A match is assembled from several parties and strangers, and
    // its lobby binding used to be cleared only when the LAST of them was
    // done — so a group that finished early was held in a match by people
    // they had never met. They could not start another, could not change the
    // mode, and the leader could not even remove the teammate still playing,
    // because every one of those asked whether the PARTY was in a match.
    //
    // Written straight into Redis: standing up a real four-player match with
    // a stranger in it is the multiplayer harness's job, not this suite's.
    // What is checked here is the rule those bindings drive.
    await redis.set(`lobby:${partyLobby}:match`, "someone-elses-match", "EX", 60);
    const held = await emit(s1, "lobby:mode", { mode: "squad" });
    void held;

    // The leader is NOT in that match — only the lobby is marked. Everything a
    // leader needs in order to get on with their day must still work.
    const canLeave = await emit(s3, "lobby:leave");
    ok(canLeave.ok, `somebody whose own match is over can leave the party (${canLeave.error ?? "ok"})`);
    // …and lands in their own lobby, free to get on with it — which is the
    // point of leaving. (The party they left had one member after that, so it
    // dissolved: a group of one is not a group.)
    ok((await lobbyOf(u3.id)) === u3.lobby, "and lands in their own lobby");
    const canAct = await emit(s3, "lobby:mode", { mode: "squad" });
    ok(canAct.ok, `free to open a party of their own (${canAct.error ?? "ok"})`);
    await redis.del(`lobby:${partyLobby}:match`);

    // …and starting is still refused while somebody in the party really is in
    // one, because that would deal them into two matches at once.
    await redis.set(`user:match:${u3.id}`, "someone-elses-match", "EX", 60);
    const stopped = await emit(s3, "lobby:leave");
    ok(
      typeof stopped.error === "string" && /match/i.test(stopped.error),
      `while somebody who IS in a match is still told to finish it (${stopped.error ?? "no error"})`
    );
    await redis.del(`user:match:${u3.id}`);
  }

  console.log("\nmaintenance is enforced by the server, not drawn by the client");
  {
    // A curtain in the page is a picture of a closed door. Anybody with dev
    // tools deletes the element — so what is checked here is the SERVER: the
    // routes, the socket, and the handshake, none of which can be edited from
    // a browser.
    const before = await fetch(`${API}/api/games`, { headers: { authorization: `Bearer ${u1.token}` } });
    ok(before.status === 200, `the game API answers normally (${before.status})`);

    await redis.hset("platform:flags", { maintenance: "1", maintenanceMessage: "Shut by a test." });
    // The gate is held in memory and refreshed by a watch, so give it a moment
    // rather than assuming an implementation detail about when it notices.
    const shut = await until("the platform to shut", async () => {
      const r = await fetch(`${API}/api/games`, { headers: { authorization: `Bearer ${u1.token}` } });
      return r.status === 503 ? r : null;
    }, 15_000);
    ok(shut, `every game route is refused with 503 (${shut?.status ?? "still open"})`);
    if (shut) {
      const body = (await shut.json()) as { code?: string; error?: string };
      ok(body.code === "MAINTENANCE", "saying why, so a client can tell this from a crash");
      ok(body.error === "Shut by a test.", `in the admin's own words (${body.error})`);
    }

    // …and the socket, which is the one a deleted curtain would leave working.
    //
    // Checked by EFFECT, not by the reply. A socket middleware refuses the
    // event before any handler runs, so there is no acknowledgement to read —
    // which is fine for the thing being proven here: the point is not what the
    // player is told, it is that pressing the button changes nothing.
    const modeBefore = await redis.get(`lobby:${partyLobby}:mode`);
    await emit(s1, "lobby:mode", { mode: "duo" });
    ok(
      (await redis.get(`lobby:${partyLobby}:mode`)) === modeBefore,
      `and a socket event changes nothing (${modeBefore} → ${await redis.get(`lobby:${partyLobby}:mode`)})`
    );

    // A brand new connection cannot get in either.
    const denied = await connect(u1.token, "aaaa".repeat(8)).then(
      () => null,
      (e: Error) => e.message
    );
    ok(denied === "MAINTENANCE", `and the handshake turns new arrivals away (${denied})`);

    await redis.hdel("platform:flags", "maintenance", "maintenanceMessage");
    const open = await until("the platform to reopen", async () => {
      const r = await fetch(`${API}/api/games`, { headers: { authorization: `Bearer ${u1.token}` } });
      return r.status === 200 ? r : null;
    }, 15_000);
    ok(open, "and it all comes back when the window is over");
  }

  console.log("\nevent media is fetchable the way a browser fetches it");
  {
    // AN <img> TAG CANNOT SEND A BEARER TOKEN. The media route was behind the
    // auth gate, so the only thing that ever asks it got a 401 every time —
    // which is what "the image does not load" was. This asks the way a browser
    // does: no Authorization header at all.
    const { rows } = await db.query(
      `insert into events (title, kind, body, pinned, created_by)
       values ('media check', 'image', $1, false, 'ptl@e2e.invalid') returning id`,
      ["events/ptl-check.png"]
    );
    const evId = rows[0].id as string;
    // A real one-pixel PNG in the bucket, so this is a round trip and not a
    // 404 dressed up as a pass.
    const { putEvidence } = await import(
      new URL("../../backend/src/platform/evidence.js", import.meta.url).href
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    await putEvidence("events/ptl-check.png", png, "image/png");

    const anon = await fetch(`${API}/api/events/${evId}/media`);
    ok(anon.status === 200, `media loads with no token, as an <img> tag asks for it (${anon.status})`);
    ok(
      (anon.headers.get("content-type") ?? "").startsWith("image/"),
      `and says what it is (${anon.headers.get("content-type")})`
    );
    const body = Buffer.from(await anon.arrayBuffer());
    ok(body.length === png.length, `and is the file that was uploaded (${body.length} bytes)`);

    // The LIST behind it still needs a token — only the picture is public.
    const listAnon = await fetch(`${API}/api/events`);
    ok(listAnon.status === 401, `while the list of events still needs signing in (${listAnon.status})`);

    await db.query("delete from events where id = $1", [evId]);
  }

  console.log("\nthe group breaks up");
  await emit(s1, "lobby:leave");
  await emit(s3, "lobby:leave");
  const ended = await until("the party to end", async () => {
    const rows = await sessionsFor(partyLobby!);
    return rows.length > 0 && rows.every((r) => r.ended_at) ? true : null;
  });
  ok(ended, "the recording ends when the group does");
  // One player left in a party is not a party: whoever is last goes home
  // rather than standing in a group of one.
  const homes = await until("everybody to be home", async () => {
    const where = await Promise.all([u1, u2, u3].map((u) => lobbyOf(u.id)));
    return where.every((w) => !w || !w.startsWith("P")) ? where : null;
  });
  ok(homes, `nobody is left standing in a party of one (${homes?.join(", ")})`);
} finally {
  for (const s of sockets) {
    try {
      hush(s);
      s.close();
    } catch {
      /* already gone */
    }
  }
  // The party rows point at objects in the evidence bucket, so they are handed
  // to the normal sweeper rather than deleted behind its back — expiring them
  // is how everything else here goes, and it takes the files with it.
  const { rows } = await db.query("select uid from users where id = any($1)", [ids]);
  const rooms = rows.map((r: { uid: string }) => `L${r.uid}`);
  if (rooms.length > 0) {
    await db.query("update party_sessions set expires_at = now() where room = any($1)", [rooms]);
  }
  if (ids.length > 0) {
    await db.query("delete from event_log where user_id = any($1)", [ids]);
    // The rows this run wrote about ITSELF, which are keyed by uid rather than
    // by user_id on some paths.
    await db.query("delete from event_log where uid = any($1)", [
      // eslint-disable-next-line no-undef
      (await db.query("select uid from users where id = any($1)", [ids])).rows.map((r: { uid: string }) => r.uid),
    ]);
    await db.query("delete from users where id = any($1)", [ids]);
  }
  redis.disconnect();
  await db.end();
}

console.log(fails === 0 ? "\nPARTY LIFECYCLE PROVEN" : `\n${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
