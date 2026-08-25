#!/usr/bin/env node
// DEV ONLY — plays a REAL frame of 8-ball against a RUNNING backend.
//
//   npm run e2e:pool                    (backend on :4000)
//   PORT=4100 npm run e2e:pool          (the test backend)
//
// IF ANOTHER BACKEND IS RUNNING, give this one its own Redis database or the
// match will never be assembled: every backend on a keyspace runs a matchmaker,
// they race for the same waiting party, and the one that loses reports nothing
// at all. `REDIS_URL=<the usual>/4 PORT=4055 npm --prefix backend run dev`, and
// the same REDIS_URL here.
//
// `check:pool` proves the simulation and `check:poolui` proves the client. This
// proves the WIRE between them, and every property here only exists when the
// real server, the real Postgres and the real Redis are running at once:
//
//   * a solo start is matched into scotch doubles, and the empty seats are
//     filled with bots that look like players
//   * a stroke sent as a REQUEST comes back as the server's own SHOT, attributed
//     to the sender — the round trip the whole game depends on
//   * a request made when it is NOT your turn is IGNORED rather than answered
//   * every other seat broadcasts what it is lining up, bots included, so the
//     table can watch somebody think
//   * a client that forges a shot is refused, and the frame carries on
//   * a table built from nothing but the relayed inputs agrees, exactly, with
//     the one the server archived — which is the netcode, end to end
//   * the standings AGREE WITH THE BALLS: the side with fewer of its own group
//     still up comes first, and a rack level on that is an honest DRAW with
//     both sides first. Sixty seconds of a twenty-minute rack is level about
//     one run in six, so a check that simply demanded a winner failed that
//     often on a game that had done nothing wrong
//
// It creates its own throwaway account and deletes it again, pass or fail.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// Each dependency comes from the package that owns it: the repo root resolves
// neither side's node_modules.
const back = (p: string) => import(path.join(root, "backend", "node_modules", p));
const front = (p: string) => import(path.join(root, "frontend", "node_modules", p));

const { config } = await back("dotenv/lib/main.js");
config({ path: path.join(root, "backend", ".env") });
const { default: pg } = await back("pg/lib/index.js");
const { default: jwt } = await back("jsonwebtoken/index.js");
const { io } = await front("socket.io-client/build/esm/index.js");

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error("backend/.env is missing JWT_SECRET or DATABASE_URL");
  process.exit(2);
}

// The game's own code, loaded the way everything else here is: dynamically,
// from source. A STATIC import of a .ts module out of a .mts file resolves to
// an empty namespace under tsx and fails with "does not provide an export
// named …", which reads like a missing export and is nothing of the kind.
const { PER_GROUP, PoolSim, TICK_MS, aimKind, askKind, awaitingServer, parseInput, remaining, seatsOfTeam, shotKind, teamOf } =
  await import("../../shared/games/pool/index.js");
const { chooseShot } = await import("../../backend/src/games/pool/bot.js");

const API = `http://localhost:${process.env.PORT || 4000}`;
const MARK = `poole2e-${Date.now()}`;
const DEVICE = "d081".repeat(8);
let fails = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  ✓ " : "  ✗ ") + m);
  if (!c) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const ids: string[] = [];

// Sweep anything an interrupted run left behind: a throwaway account that
// survives is an account that will look real to a moderator months from now.
{
  const { rows } = await db.query("select id from users where google_id like 'poole2e-%'");
  const stale = rows.map((r: { id: string }) => r.id);
  if (stale.length > 0) {
    await db.query("delete from event_log where user_id = any($1)", [stale]);
    await db.query("delete from match_players where user_id = any($1)", [stale]);
    await db.query("delete from reports where reporter_user_id = any($1) or subject_user_id = any($1)", [stale]);
    await db.query("delete from users where id = any($1)", [stale]);
    console.log(`swept ${stale.length} account(s) from an interrupted run`);
  }
}

async function makeUser() {
  const uid = String(9_500_000_000 + Math.floor(Math.random() * 499_999_999));
  const {
    rows: [u],
  } = await db.query(
    "insert into users (uid, google_id, email, name, username) values ($1,$2,$3,$4,$5) returning id",
    [uid, MARK, `${MARK}@e2e.invalid`, "Pool E2E", `Pool${uid.slice(-6)}`]
  );
  ids.push(u.id);
  return { id: u.id, uid, token: jwt.sign({ userId: u.id, uid, name: "Pool E2E" }, process.env.JWT_SECRET, { expiresIn: "20m" }) };
}

/** Open a socket, run something with it, and always close it. */
function withSocket<T>(token: string, fn: (s: any) => Promise<T>, budgetMs = 160_000): Promise<T | { error: string }> {
  return new Promise((resolve) => {
    const s = io(API, { auth: { token, deviceHash: DEVICE }, transports: ["websocket"], reconnection: false, timeout: 8000 });
    let done = false;
    const finish = (v: any) => {
      if (done) return;
      done = true;
      s.close();
      resolve(v);
    };
    // "connected" is not "ready": the server's connect handler is async and
    // puts the player in a lobby several awaits later. lobby:members is what
    // says that finished.
    let ready = false;
    const start = () => {
      if (ready) return;
      ready = true;
      void fn(s).then(finish, (err: any) => finish({ error: String(err?.message ?? err) }));
    };
    s.on("lobby:members", start);
    s.on("connect", () => setTimeout(start, 3000));
    s.on("connect_error", (e: any) => finish({ error: `connect: ${e.message}` }));
    setTimeout(() => finish({ error: `gave up after ${budgetMs}ms` }), budgetMs);
  });
}

const emit = (s: any, event: string, payload?: unknown) =>
  new Promise<any>((resolve) => {
    const t = setTimeout(() => resolve({ error: "no answer" }), 8000);
    s.emit(event, payload ?? {}, (r: unknown) => {
      clearTimeout(t);
      resolve(r ?? {});
    });
  });

const waitFor = (s: any, event: string, ms = 20000) =>
  new Promise<any>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(event, (payload: unknown) => {
      clearTimeout(t);
      resolve(payload ?? {});
    });
  });

/** How long the frame is actually played for.
 *
 *  Longer than the other games' because a pool turn IS longer: a bot takes a
 *  second or two to decide and the balls then roll for two to five more, so a
 *  minute is about ten shots — two or three of them ours, in a four-handed
 *  frame, which is what the round trip below needs. */
const PLAY_MS = 60_000;

console.log(`8 ball pool, end to end · ${API}`);
try {
  const me = await makeUser();

  console.log("\nthe match");
  const played = await withSocket(me.token, async (s) => {
    const picked = await emit(s, "lobby:pickGame", { gameId: "pool" });
    if (picked?.error) return { error: `pick: ${picked.error}` };
    // No pack to download, so readiness is immediate — the same 100% a real
    // client reports the instant the code chunk lands.
    s.emit("game:progress", { pct: 100 });
    const started = await emit(s, "lobby:start", {});
    if (started?.error) return { error: `start: ${started.error}` };

    // A solo start waits out the 10-second fill deadline before the bots
    // arrive. Generous on top of that: a box busy finishing a browser run
    // should not fail a suite, or the suite gets ignored.
    const prepare = await waitFor(s, "match:prepare", 60_000);
    if (!prepare?.matchId) return { error: "no match was assembled" };

    const relayed: { uid: string; tick: number; kind: string }[] = [];
    s.on("match:input", (i: any) => relayed.push(i));
    let ended: any = null;
    s.on("match:end", (e: any) => (ended = e));

    s.emit("match:ready", {});
    const go = await waitFor(s, "match:go", 20_000);
    if (!go?.startAt) return { error: "the match never started" };

    // Our own table, built from the same seed and fed nothing but what the
    // server relays — exactly what the real client does.
    const players = prepare.roster.length;
    const durationTicks = Math.round(prepare.rules.durationTicks);
    const sim = new PoolSim(prepare.seed, players, durationTicks);
    const seatOf = new Map<string, number>(prepare.roster.map((r: any, i: number) => [r.uid, i]));
    const mySeat = seatOf.get(prepare.you) ?? 0;
    // The server's clock, not ours: prepare carries a sample of it.
    const skew = prepare.serverNow - Date.now();
    const startLocal = go.startAt - skew;

    let asks = 0;
    let aimsSent = 0;
    let forged: { tick: number; kind: string } | null = null;
    let offTurn: { tick: number; kind: string } | null = null;
    let answeredTurn = "";
    let fed = 0;
    const until = Date.now() + PLAY_MS;
    while (Date.now() < until && !ended) {
      while (fed < relayed.length) {
        const i = relayed[fed++];
        const seat = seatOf.get(i.uid);
        if (seat !== undefined) sim.addInput({ tick: i.tick, seat, kind: i.kind });
      }
      const tick = Math.max(0, Math.min(Math.floor((Date.now() - startLocal) / TICK_MS), durationTicks));
      sim.advanceTo(tick);
      const st = sim.state;
      if (st.over) break;
      if (awaitingServer(st) && st.turn === mySeat) {
        const key = `${st.turn}:${st.since}`;
        if (answeredTurn !== key && tick > 0) {
          answeredTurn = key;
          // Play it properly rather than at random: what is being checked is the
          // round trip, and a frame in which nobody ever pots proves less.
          const p = chooseShot(st, mySeat, 0.7);
          // Show the table what we are lining up before we play it, exactly as
          // the real client does while a thumb is on the glass.
          s.emit("match:input", {
            tick: Math.min(tick + 1, durationTicks),
            kind: aimKind(p.x, p.y, p.dx, p.dy, Math.max(0, p.p - 90)),
          });
          aimsSent++;
          s.emit("match:input", { tick: Math.min(tick + 2, durationTicks), kind: askKind(p.x, p.y, p.dx, p.dy, p.p) });
          asks++;
          if (!forged) {
            // And, once, the thing a modified client would do: write the SHOT
            // itself. `isValidInputKind` accepts only requests and aims, so this
            // must change nothing and must not disturb the frame.
            forged = { tick: Math.min(tick + 1, durationTicks), kind: shotKind(p.x, p.y, p.dx, p.dy, 1000) };
            s.emit("match:input", forged);
          }
        }
      } else if (awaitingServer(st) && st.turn !== mySeat && !offTurn && tick > 0) {
        // ONCE, ask for a shot on somebody else's turn — the commonest thing an
        // impatient thumb does. The server must ignore it rather than play it.
        offTurn = { tick: Math.min(tick + 1, durationTicks), kind: askKind(0, 0, 1000, 0, 500) };
        s.emit("match:input", offTurn);
      }
      await sleep(50);
    }

    // Leave, which archives the match — the same path a player closing the tab
    // takes, and the one that produces something to compare against.
    await emit(s, "match:leave", {});
    while (fed < relayed.length) {
      const i = relayed[fed++];
      const seat = seatOf.get(i.uid);
      if (seat !== undefined) sim.addInput({ tick: i.tick, seat, kind: i.kind });
    }
    // Run the table out to the last tick anything was stamped for. The server
    // stamps a shot a fifth of a second AHEAD, so the final one is still in our
    // future when we stop watching — and a table asked what it has played
    // before it has played it will always be one short.
    const lastTick = relayed.reduce((n, i) => Math.max(n, i.tick), 0);
    sim.advanceTo(Math.min(lastTick, durationTicks));
    return {
      matchId: prepare.matchId,
      gameId: prepare.gameId,
      seed: prepare.seed,
      rules: prepare.rules,
      roster: prepare.roster,
      you: prepare.you,
      mySeat,
      relayed,
      asks,
      aimsSent,
      forged,
      offTurn,
      shots: sim.state.shots,
      open: sim.state.open,
      potted: sim.state.potted,
    };
  });

  if ((played as any)?.error) {
    ok(false, `could not play a match (${(played as any).error})`);
  } else {
    const m = played as any;
    ok(Boolean(m.matchId), "a match was assembled");
    ok(m.gameId === "pool", `and it is 8 ball pool (${m.gameId})`);
    ok(m.roster.length === 4, `a solo start filled the table for scotch doubles (${m.roster.length} at it)`);
    ok(m.rules.tickRate === 60 && m.rules.perGroup === 7, "the rules reached the client");
    ok(m.roster.every((r: any) => typeof r.name === "string" && r.name.length > 0), "everyone at the table has a name — nothing marks the bots");

    const shots = m.relayed.filter((i: any) => parseInput(i.kind)?.type === "shot");
    ok(shots.length >= 4, `the server authored real shots (${shots.length} in ${PLAY_MS / 1000}s)`);
    ok(m.asks > 0, `and we asked for some of them ourselves (${m.asks})`);
    const mine = shots.filter((i: any) => i.uid === m.you);
    ok(mine.length > 0, `our request came back as the server's own shot, attributed to us (${mine.length})`);
    ok(
      mine.length >= m.asks - 1,
      `every request of ours became a shot (${mine.length} of ${m.asks} — the last may still be in flight)`
    );
    ok(
      m.relayed.every((i: any) => parseInput(i.kind)?.type !== "ask"),
      "a request is never relayed as though it struck anything"
    );

    // WATCHING SOMEBODY ELSE LINE UP. Bots broadcast what they are aiming at
    // exactly as a person's client does — a seat that went from nothing to a
    // struck ball would be the one tell no roster entry can hide.
    const aims = m.relayed.filter((i: any) => parseInput(i.kind)?.type === "aim");
    ok(aims.length > 0, `the other seats broadcast what they were lining up (${aims.length} aims)`);
    ok(
      new Set(aims.map((i: any) => i.uid)).size > 1,
      `and more than one of them did (${new Set(aims.map((i: any) => i.uid)).size} seats)`
    );
    ok(m.aimsSent > 0, `we broadcast ours too (${m.aimsSent})`);
    // Nothing a player SENT is ever relayed as though it moved a ball. The
    // other kinds a table may hear are the server's own (an empty chair, an
    // away flag), which is why this is stated as an absence rather than as a
    // list of two.
    const kinds = new Map<string, number>();
    for (const i of m.relayed) {
      const t = parseInput(i.kind)?.type ?? "?";
      kinds.set(t, (kinds.get(t) ?? 0) + 1);
    }
    ok(
      !kinds.has("ask") && !kinds.has("nudge") && !kinds.has("?"),
      `nothing a client asked for was relayed as a shot (${[...kinds].map(([k, n]) => `${k}×${n}`).join(", ")})`
    );
    ok(Boolean(m.forged), "we tried to forge a shot once");
    ok(Boolean(m.offTurn), "and asked once for a shot on somebody else's turn");
    ok(shots.length === m.shots, `our table played every shot and no more (${m.shots} struck)`);
    ok(m.potted.reduce((a: number, b: number) => a + b, 0) >= 0, `balls potted by seat: ${m.potted.join(" / ")}`);

    // ---- the archive ------------------------------------------------------
    console.log("\nthe archive");
    let row: any = null;
    for (let i = 0; i < 14 && !row; i++) {
      await sleep(1200);
      const { rows } = await db.query("select * from match_replays where match_key = $1", [m.matchId]);
      row = rows[0] ?? null;
    }
    ok(Boolean(row), "leaving it put a replay in the archive");
    if (row) {
      ok(row.game_id === "pool", "recorded against the right game");
      ok(Number(row.bytes) > 100, `with real content (${row.bytes} bytes)`);
      const { getEvidence } = await import("../../backend/src/platform/evidence.js");
      const { unpackReplay, toRankMembers } = await import("../../backend/src/platform/replay.js");
      await import("../../backend/src/games/index.js");
      const { getGame } = await import("../../backend/src/platform/games.js");
      const bytes = await getEvidence(row.r2_key);
      ok(bytes !== null, "the file is where the row says it is");
      if (bytes) {
        const file = unpackReplay(bytes);
        ok(file.matchKey === m.matchId, "and it is that match");
        ok(file.seed === m.seed, "on the seed we were told");
        ok(file.roster.some((r: any) => r.isBot), "bots included, marked as bots");
        const reranked = getGame("pool")!.rank(toRankMembers(file), file.endTick, file.seed);
        ok(
          JSON.stringify(reranked) === JSON.stringify(file.standings),
          "re-ranking it gives the standings the server recorded — from a REAL match"
        );
        // POOL HAS TWO PLACES, not four: partners share one, because they shared
        // the table.
        ok(
          reranked.every((s: any) => s.placement === 1 || s.placement === 2),
          `every seat is on a winning side or a losing one (${reranked.map((s: any) => s.placement).join(",")})`
        );
        ok(
          reranked.find((s: any) => s.uid === m.you)?.forfeit === true,
          "walking out mid-frame is recorded as a forfeit"
        );
        ok(
          reranked.find((s: any) => s.uid === m.you)?.placement === 2,
          "…and the person who left does not come first, whatever the balls were doing"
        );

        // THE ONE THAT MATTERS. Every rule-bearing input the archive holds is
        // one this client was relayed, and vice versa: a table built from what
        // came down the wire is the table the server judged.
        const members = toRankMembers(file);
        const archived = new Set<string>();
        for (const mem of members) {
          for (const i of mem.inputs) archived.add(`${mem.seat}:${i.tick}:${i.kind}`);
        }
        const seats = new Map<string, number>(m.roster.map((r: any, i: number) => [r.uid, i]));
        const heard = new Set<string>();
        for (const i of m.relayed) {
          if (parseInput(i.kind)?.type === "ask") continue;
          heard.add(`${seats.get(i.uid)}:${i.tick}:${i.kind}`);
        }
        const missing = [...heard].filter((k) => !archived.has(k));
        ok(missing.length === 0, `every input we were relayed is in the archive (${heard.size} of ${archived.size})`);

        // NEITHER FORGERY LANDED — proved by the invariant rather than by
        // hunting for the kind, because a shot played after we left is in the
        // archive too and looks exactly like one we never heard.
        //
        // THE INVARIANT: a shot is only ever struck by the seat whose turn it
        // is. Both things this client tried would break it — the forged `s…`
        // was ours to play but ours to ask for, not to write, and the off-turn
        // request was for a turn that belonged to somebody else. So the table
        // is walked shot by shot and asked whose turn it was.
        const all = members.flatMap((mem: any) => mem.inputs.map((i: any) => ({ tick: i.tick, seat: mem.seat, kind: i.kind })));
        const struck = all.filter((i: any) => parseInput(i.kind)?.type === "shot").sort((a: any, b: any) => a.tick - b.tick);
        const audit = new PoolSim(file.seed, m.roster.length, Math.round(m.rules.durationTicks));
        for (const i of all) audit.addInput(i);
        let wrongSeat = 0;
        for (const shot of struck) {
          audit.advanceTo(Math.max(0, shot.tick - 1));
          if (audit.state.turn !== shot.seat) wrongSeat++;
        }
        ok(wrongSeat === 0, `every shot in the archive was struck by the seat whose turn it was (${struck.length} shots)`);
        ok(
          struck.filter((i: any) => i.seat === m.mySeat && i.kind === m.forged?.kind && i.tick === m.forged?.tick).length === 0,
          "and the shot we forged is nowhere in it"
        );
        // And the two sides really are two sides — AMONG THE PEOPLE WHO STAYED.
        // A walk-out is demoted to second whatever the table did, so a partner
        // who left is expected NOT to share the place their partner won: that
        // is the rule, not a bug, and asserting it flatly would be asserting
        // the opposite of what the server is supposed to do.
        const stayed = reranked
          .map((st: any, i: number) => ({ st, team: teamOf(i, m.roster.length) }))
          .filter((r: any) => !r.st.forfeit);
        const perTeam = new Map<number, Set<number>>();
        for (const r of stayed) {
          if (!perTeam.has(r.team)) perTeam.set(r.team, new Set());
          perTeam.get(r.team)!.add(r.st.placement);
        }
        ok(
          [...perTeam.values()].every((places) => places.size === 1),
          `partners who stayed share a placement (${[...perTeam].map(([t, p2]) => `side ${t}: ${[...p2].join("/")}`).join(", ")})`
        );
        // …AND THE PLACE EACH SIDE GOT IS THE PLACE THE BALLS SAY IT GOT.
        //
        // This used to read "the two sides do not share a placement", which is
        // an assertion that DRAWS DO NOT EXIST — and they very much do here. A
        // rack is twenty minutes and this frame is sixty seconds, so it almost
        // never finishes; an unfinished rack is judged on how many of your own
        // group are still up, fewest wins, and a table level on that is level.
        // It failed about one run in six on a game that had done nothing wrong,
        // which is the worst kind of check: one you learn to ignore.
        //
        // So the balls are counted first, off the archived log, and the
        // standings are asked to AGREE with them. That is a stronger check than
        // the old one as well as an honest one — "different" would pass with
        // the two sides the wrong way round.
        audit.advanceTo(file.endTick);
        const table = audit.state;
        const left = [0, 1].map((side: number) => (table.group[side] < 0 ? PER_GROUP : remaining(table, table.group[side])));
        const wholeSideLeft = [0, 1].map((side: number) =>
          seatsOfTeam(side, m.roster.length).every((seat: number) => members.some((mem: any) => mem.seat === seat && mem.left))
        );
        const placeOf = (side: number): number | null => {
          const places = perTeam.get(side);
          return places ? [...places][0] : null;
        };
        if (wholeSideLeft[0] !== wholeSideLeft[1]) {
          // Walking out beats the balls: a side nobody is sitting at loses it.
          const atTheTable = wholeSideLeft[0] ? 1 : 0;
          ok(
            placeOf(atTheTable) === 1,
            `the side still at the table comes first when the other walked out entirely (side ${atTheTable})`
          );
        } else if (left[0] !== left[1]) {
          const ahead = left[0] < left[1] ? 0 : 1;
          const behind = ahead === 0 ? 1 : 0;
          ok(
            placeOf(ahead) === 1 && placeOf(behind) === 2,
            `the side with fewer of its own still up comes first (${left[0]} v ${left[1]} left, side ${ahead} ahead)`
          );
        } else {
          ok(
            placeOf(0) === 1 && placeOf(1) === 1,
            `a level rack is a DRAW and both sides come first (${left[0]} v ${left[1]} left)`
          );
        }
      }
    }
  }
} finally {
  if (ids.length > 0) {
    await db.query("delete from event_log where user_id = any($1)", [ids]);
    await db.query("delete from match_players where user_id = any($1)", [ids]);
    await db.query("delete from reports where reporter_user_id = any($1) or subject_user_id = any($1)", [ids]);
    await db.query("delete from users where id = any($1)", [ids]);
  }
  await db.end();
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
