#!/usr/bin/env node
// DEV ONLY — plays a REAL game of Dots & Boxes against a RUNNING backend.
//
//   npm run e2e:dots                    (backend on :4000)
//   PORT=4100 npm run e2e:dots          (the test backend)
//
// IF ANOTHER BACKEND IS RUNNING, give this one its own Redis database or the
// match will never be assembled: every backend on a keyspace runs a matchmaker,
// they race for the same waiting party, and the one that loses reports nothing
// at all. `REDIS_URL=<the usual>/4 PORT=4055 npm --prefix backend run dev`, and
// the same REDIS_URL here.
//
// `check:dots` proves the simulation and `check:dotsui` proves the client.
// This proves the WIRE between them, and every property here only exists when
// the real server, the real Postgres and the real Redis are running at once:
//
//   * a solo start is matched, and the empty seats are filled with bots that
//     look like players
//   * a tap sent as a REQUEST comes back as the server's own MOVE, attributed to
//     the sender — the round trip the whole board game depends on
//   * a request for a line somebody already took is IGNORED rather than
//     answered with something else, and the next legal one still works
//   * every other seat broadcasts the line it is looking at, bots included, so
//     the table can watch somebody think
//   * a client that forges a move is refused, and the match carries on
//   * a table built from nothing but the relayed inputs agrees, exactly, with
//     the board the server archived — which is the netcode, end to end
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
const { DotsSim, TICK_MS, askKind, awaitingServer, drawKind, freeLines, hoverKind, parseInput } = await import(
  "../../shared/games/dots/index.js"
);
const { chooseLine } = await import("../../backend/src/games/dots/bot.js");

const API = `http://localhost:${process.env.PORT || 4000}`;
const MARK = `dotse2e-${Date.now()}`;
const DEVICE = "d075".repeat(8);
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
  const { rows } = await db.query("select id from users where google_id like 'dotse2e-%'");
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
    [uid, MARK, `${MARK}@e2e.invalid`, "Dots E2E", `Dots${uid.slice(-6)}`]
  );
  ids.push(u.id);
  return { id: u.id, uid, token: jwt.sign({ userId: u.id, uid, name: "Dots E2E" }, process.env.JWT_SECRET, { expiresIn: "20m" }) };
}

/** Open a socket, run something with it, and always close it. */
function withSocket<T>(token: string, fn: (s: any) => Promise<T>, budgetMs = 120_000): Promise<T | { error: string }> {
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

/** How long the table is actually played for. Long enough for several turns to
 *  go round — a solo human against three bots, so most of them are the bots'. */
const PLAY_MS = 45_000;

console.log(`dots & boxes, end to end · ${API}`);
try {
  const me = await makeUser();

  console.log("\nthe match");
  const played = await withSocket(me.token, async (s) => {
    const picked = await emit(s, "lobby:pickGame", { gameId: "dots" });
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
    const sim = new DotsSim(prepare.seed, players, durationTicks);
    const seatOf = new Map<string, number>(prepare.roster.map((r: any, i: number) => [r.uid, i]));
    const mySeat = seatOf.get(prepare.you) ?? 0;
    // The server's clock, not ours: prepare carries a sample of it.
    const skew = prepare.serverNow - Date.now();
    const startLocal = go.startAt - skew;

    let asks = 0;
    let hoversSent = 0;
    let forged = 0;
    let stale = 0;
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
          // round trip, and a board where nobody ever closes a box proves less.
          const line = chooseLine(st, mySeat, 0.7);
          const free = freeLines(st);
          // ONCE, ask for a line that is already drawn — the commonest thing a
          // finger lands on. The server must ignore it rather than answer with
          // something else, and the request that follows must still work.
          if (stale === 0) {
            const taken = st.line.findIndex((owner: number) => owner >= 0);
            if (taken >= 0) {
              stale++;
              s.emit("match:input", { tick: Math.min(tick + 1, durationTicks), kind: askKind(taken) });
            }
          }
          // Show the table which line we are looking at before taking it,
          // exactly as the real client does while a finger is on the glass.
          const looking = free.find((l: number) => l !== line) ?? line;
          s.emit("match:input", { tick: Math.min(tick + 1, durationTicks), kind: hoverKind(looking) });
          hoversSent++;
          s.emit("match:input", { tick: Math.min(tick + 2, durationTicks), kind: askKind(line) });
          asks++;
          if (forged === 0) {
            // And, once, the thing a modified client would do: write the move
            // itself. `isValidInputKind` accepts only requests and hovers, so
            // this must change nothing and must not disturb the match.
            forged++;
            s.emit("match:input", { tick: Math.min(tick + 1, durationTicks), kind: drawKind(line) });
          }
        }
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
    // stamps a move a fifth of a second AHEAD, so the final one is still in our
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
      hoversSent,
      forged,
      stale,
      drawn: sim.state.drawn,
      claimed: sim.state.claimed,
      score: sim.state.score,
    };
  });

  if ((played as any)?.error) {
    ok(false, `could not play a match (${(played as any).error})`);
  } else {
    const m = played as any;
    ok(Boolean(m.matchId), "a match was assembled");
    ok(m.gameId === "dots", `and it is dots & boxes (${m.gameId})`);
    ok(m.roster.length === 4, `a solo start filled the table (${m.roster.length} at it)`);
    ok(m.rules.tickRate === 20 && m.rules.grid === 6, "the rules reached the client");
    ok(m.roster.every((r: any) => typeof r.name === "string" && r.name.length > 0), "everyone at the table has a name — nothing marks the bots");

    const moves = m.relayed.filter((i: any) => parseInput(i.kind)?.type === "draw");
    ok(moves.length >= 5, `the server authored real moves (${moves.length} in ${PLAY_MS / 1000}s)`);
    ok(m.asks > 0, `and we asked for some of them ourselves (${m.asks})`);
    const mine = moves.filter((i: any) => i.uid === m.you);
    ok(mine.length > 0, `our request came back as the server's own move, attributed to us (${mine.length})`);
    ok(
      mine.length >= m.asks - 1,
      `every request of ours became a line (${mine.length} of ${m.asks} — the last may still be in flight)`
    );
    ok(
      m.relayed.every((i: any) => parseInput(i.kind)?.type !== "ask"),
      "a request is never relayed as though it moved something"
    );

    // WATCHING SOMEBODY ELSE CHOOSE. Bots broadcast the line they are looking
    // at exactly as a person's client does — a seat that went from nothing to a
    // drawn line would be the one tell no roster entry can hide.
    const looks = m.relayed.filter((i: any) => parseInput(i.kind)?.type === "hover");
    ok(looks.length > 0, `the other seats broadcast the line they were looking at (${looks.length} hovers)`);
    ok(
      new Set(looks.map((i: any) => i.uid)).size > 1,
      `and more than one of them did (${new Set(looks.map((i: any) => i.uid)).size} seats)`
    );
    ok(m.hoversSent > 0, `we broadcast ours too (${m.hoversSent})`);
    // Nothing a player SENT is ever relayed as though it moved something. The
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
      `nothing a client asked for was relayed as a move (${[...kinds].map(([k, n]) => `${k}×${n}`).join(", ")})`
    );
    ok(m.forged === 1, "we tried to forge a move once");
    ok(m.stale === 1, "and asked once for a line that was already drawn");
    ok(moves.length === m.drawn, `our table played every move and no more (${m.drawn} lines on the grid)`);
    ok(m.claimed >= 0, `boxes taken: ${m.score.join(" / ")}`);

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
      ok(row.game_id === "dots", "recorded against the right game");
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
        const reranked = getGame("dots")!.rank(toRankMembers(file), file.endTick, file.seed);
        ok(
          JSON.stringify(reranked) === JSON.stringify(file.standings),
          "re-ranking it gives the standings the server recorded — from a REAL match"
        );
        ok(
          reranked.every((s: any) => s.placement >= 1 && s.placement <= 4),
          `every seat gets a place (${reranked.map((s: any) => s.placement).join(",")})`
        );
        ok(
          reranked.reduce((n: number, s: any) => n + (s.detail.boxes ?? 0), 0) === m.claimed,
          "and the rows account for every box that was taken"
        );
        ok(
          reranked.find((s: any) => s.uid === m.you)?.forfeit === true,
          "walking out mid-board is recorded as a forfeit"
        );
        // LAST, not merely "not first". This is a free-for-all with four
        // places in it, so a walk-out has to end up behind everybody who
        // stayed however many boxes they happened to be sitting on.
        const mePlace = reranked.find((s: any) => s.uid === m.you)?.placement ?? 0;
        const worst = Math.max(...reranked.map((s: any) => s.placement));
        ok(
          mePlace === worst && mePlace > 1,
          `…and the person who left comes last (${reranked.map((s: any) => s.placement).join(",")})`
        );

        // THE ONE THAT MATTERS. Every rule-bearing input the archive holds is
        // one this client was relayed, and vice versa: a table built from what
        // came down the wire is the table the server judged.
        const archived = new Set<string>();
        for (const mem of toRankMembers(file)) {
          for (const i of mem.inputs) archived.add(`${mem.seat}:${i.tick}:${i.kind}`);
        }
        const seatOf = new Map<string, number>(m.roster.map((r: any, i: number) => [r.uid, i]));
        const heard = new Set<string>();
        for (const i of m.relayed) {
          if (parseInput(i.kind)?.type === "ask") continue;
          heard.add(`${seatOf.get(i.uid)}:${i.tick}:${i.kind}`);
        }
        const missing = [...heard].filter((k) => !archived.has(k));
        ok(missing.length === 0, `every input we were relayed is in the archive (${heard.size} of ${archived.size})`);
        // THE FORGED MOVE IS NOWHERE IN IT — proved by the invariant rather
        // than by hunting for the kind, because a line drawn after we left is
        // in the archive too and looks exactly like one we never heard. A line
        // can only be drawn ONCE; a forgery that landed would be a second `d`
        // for a line that already had one.
        const drawnTimes = new Map<string, number>();
        for (const key of archived) {
          const kind = key.slice(key.lastIndexOf(":") + 1);
          if (kind[0] !== "d") continue;
          drawnTimes.set(kind, (drawnTimes.get(kind) ?? 0) + 1);
        }
        const twice = [...drawnTimes].filter(([, n]) => n > 1);
        ok(twice.length === 0, `no line is drawn twice — the move we forged never landed (${twice.length})`);
        ok(drawnTimes.size === m.drawn, `and the archive holds one move per line on the grid (${drawnTimes.size} of ${m.drawn})`);
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
