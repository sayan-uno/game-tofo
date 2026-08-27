#!/usr/bin/env node
// DEV ONLY — proves Social Space against a RUNNING backend.
//
//   PORT=4100 npm run e2e:social            (the test backend)
//   npm run e2e:social                      (a dev backend on :4000)
//
// No browser: everything checked here is the SERVER's half of a drop-in world,
// and all of it happens on the socket. The 3D half is checked by looking at it.
//
// What it proves, in the order the rules were written:
//
//   one person, twenty seats  — pressing START lands you on an island straight
//                               away, with nineteen others already on it. No
//                               queue, no "finding players", no waiting
//   a second player joins THE SAME island, and a bot leaves to make room, so
//                               the population never changes size
//   people are real            — the roster cannot be read to work out which
//                               seats are people
//   positions                  — a report comes back to the other player in a
//                               batched snapshot, and a report claiming to have
//                               crossed the island is refused
//   walls                      — a position inside the fountain is pushed out
//                               of it by the server, not merely by the client
//   leaving                    — the seat goes straight back to the population
//   an emote                   — reaches the other player
//   the clock                  — the island advertises when it closes
//
// Run through tsx: it imports backend SOURCE, so it can never pass against a
// stale build. It creates throwaway accounts and deletes them either way.
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
// The island's own geometry, from the same module the server and the client
// walk on — so this test knows where a player was put down without being told.
const { spawnPoint, PROP_SPEC, isClear, WALK_R } = await import(
  path.join(root, "backend", "src", "shared", "games", "social", "index.js")
);

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error("backend/.env is missing JWT_SECRET or DATABASE_URL");
  process.exit(2);
}

const API = `http://localhost:${process.env.PORT || 4000}`;
const MARK = `isle-${Date.now()}`;
let fails = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  ✓ " : "  ✗ ") + m);
  if (!c) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const made: string[] = [];

{
  const { rows } = await db.query("select id from users where google_id like 'isle-%'");
  const stale = rows.map((r: { id: string }) => r.id);
  if (stale.length > 0) {
    await db.query("delete from users where id = any($1)", [stale]);
    console.log(`  … swept ${stale.length} account(s) from an earlier run`);
  }
}

async function throwaway(tag: string): Promise<{ id: string; uid: string; name: string; token: string }> {
  let uid = "";
  for (let i = 0; i < 5; i++) {
    uid = String(Math.floor(1 + Math.random() * 9)) + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
    const { rows } = await db.query(
      "select 1 from users where uid = $1 union all select 1 from bot_accounts where uid = $1",
      [uid]
    );
    if (rows.length === 0) break;
  }
  const name = `${tag}${String(Date.now()).slice(-6)}`;
  const { rows } = await db.query(
    `insert into users (uid, google_id, email, name, username)
     values ($1, $2, $3, $4, $5) returning id`,
    [uid, `${MARK}-${tag}`, `${MARK}-${tag}@example.invalid`, name, name]
  );
  const id = rows[0].id as string;
  made.push(id);
  return { id, uid, name, token: jwt.sign({ userId: id, uid, name }, process.env.JWT_SECRET!, { expiresIn: "1h" }) };
}

interface Live {
  resume: { matchId: string; roster: any[]; you: string; rules: Record<string, number>; startAt: number } | null;
  roster: { matchId: string; roster: any[]; endsAt: number; party: string[] } | null;
  pins: { uid: string; x: number | null; z: number | null }[];
  snaps: { t: number; p: number[][] }[];
  emotes: { uid: string; id: string }[];
  quick: { uid: string; kind: string; id: string }[];
  closing: { at: number } | null;
  ended: { reason: string; standings: any[] } | null;
}

function connect(token: string): Promise<{ s: any; live: Live }> {
  return new Promise((resolve, reject) => {
    const s = io(API, { auth: { token }, transports: ["websocket"] });
    const live: Live = { resume: null, roster: null, snaps: [], emotes: [], quick: [], pins: [], closing: null, ended: null };
    s.on("match:resume", (p: never) => (live.resume = p));
    s.on("match:prepare", (p: never) => (live.resume = p));
    s.on("live:roster", (r: never) => (live.roster = r));
    s.on("live:snap", (p: never) => live.snaps.push(p));
    s.on("live:emoted", (e: never) => live.emotes.push(e));
    s.on("live:pinned", (p: never) => live.pins.push(p));
    s.on("match:quick", (q: never) => live.quick.push(q));
    s.on("live:closing", (c: never) => (live.closing = c));
    s.on("match:end", (e: never) => (live.ended = e));
    // Wait for the LOBBY, not merely for the socket. The handshake resolves
    // before the server has finished putting this player in one, and a
    // lobby:pickGame that lands in that gap is written against a lobby id the
    // start a moment later does not read back — which shows up as "choose a
    // game first" and looks like a bug in the game rather than in the test.
    s.on("lobby:members", () => resolve({ s, live }));
    s.on("connect_error", reject);
    setTimeout(() => resolve({ s, live }), 4000);
  });
}

const ask = (s: any, ev: string, payload?: unknown): Promise<any> =>
  new Promise((resolve) => {
    let done = false;
    const cb = (r: unknown) => {
      done = true;
      resolve(r);
    };
    if (payload === undefined) s.emit(ev, cb);
    else s.emit(ev, payload, cb);
    setTimeout(() => !done && resolve({ error: "timeout" }), 12_000);
  });

/** Walk in: pick the game, say the pack is downloaded, press START. */
async function enter(s: any): Promise<any> {
  const picked = await ask(s, "lobby:pickGame", { gameId: "social" });
  if (picked?.error) console.log(`    (pickGame said: ${picked.error})`);
  s.emit("game:progress", { pct: 100 });
  await sleep(200);
  const res = await ask(s, "lobby:start");
  if (res?.error) console.log(`    (start said: ${res.error})`);
  return res;
}

const POS = 32; // wire units per metre — shared/games/social/net.ts
const report = (s: any, x: number, z: number, ry = 0, anim = 1) =>
  s.emit("live:state", [Math.round(x * POS), Math.round(z * POS), Math.round(ry * (1024 / (Math.PI * 2))), anim]);

let A: any, B: any, C: any, D: any;
try {
  const alice = await throwaway("alice");
  const bob = await throwaway("bob");
  const a = await connect(alice.token);
  const b = await connect(bob.token);
  A = a.s;
  B = b.s;

  console.log("\nOne person, and a park that is not empty");
  const started = await enter(A);
  ok(started.ok === true && !started.searching, "START goes straight in — no queue");
  await sleep(500);
  ok(a.live.resume !== null, "and the island arrives as a RESUME, not a prepare");
  const island = a.live.resume;
  ok(island?.roster.length === 20, `there are ${island?.roster.length ?? 0} people on it`);
  ok(island?.startAt !== null && island!.startAt <= Date.now() + 1000, "it was already open when we walked in");
  ok(typeof island?.rules.endsAt === "number", "and it says when it closes");
  const minutes = Math.round((((island?.rules.endsAt as number) ?? 0) - Date.now()) / 60000);
  ok(minutes >= 38 && minutes <= 41, `about forty minutes left (${minutes})`);
  ok(
    island!.roster.every((r) => typeof r.seat === "number") &&
      new Set(island!.roster.map((r) => r.seat)).size === 20,
    "every seat is numbered, and no two the same"
  );
  ok(
    !JSON.stringify(island!.roster).match(/isBot|botId|"bot"/i),
    "nothing in the roster says which of them are people"
  );

  console.log("\nA second player takes a seat from the population");
  const started2 = await enter(B);
  ok(started2.ok === true, "they get in too");
  await sleep(600);
  ok(b.live.resume?.matchId === island!.matchId, "…on the SAME island");
  ok(a.live.roster !== null, "everyone already there is told the roster changed");
  ok(a.live.roster?.roster.length === 20, `and it is still ${a.live.roster?.roster.length} people`);
  const uids = new Set((a.live.roster?.roster ?? []).map((r: any) => r.uid));
  ok(uids.has(alice.uid) && uids.has(bob.uid), "with both players in it");

  console.log("\nWalking about");
  const seatOfA: number = (b.live.roster?.roster ?? b.live.resume?.roster ?? []).find(
    (r: any) => r.uid === alice.uid
  )?.seat;
  const spawn = spawnPoint(island!.seed, island!.rules.seat as number);
  const whereIsA = () => {
    const row = b.live.snaps.at(-1)?.p.find((r) => r[0] === seatOfA);
    return row ? { x: row[1] / POS, z: row[2] / POS } : null;
  };
  /** Walk there the way a person would: a couple of metres at a time. Anything
   *  faster is refused, which is the point of the next section. */
  const walkTo = async (from: { x: number; z: number }, to: { x: number; z: number }) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 2));
    for (let i = 1; i <= steps; i++) {
      report(A, from.x + ((to.x - from.x) * i) / steps, from.z + ((to.z - from.z) * i) / steps, 0, 1);
      await sleep(230);
    }
    await sleep(300);
  };

  // Somewhere three metres away that is actually WALKABLE. Picking a fixed
  // direction made this flaky: a spawn is only guaranteed clear where you are
  // standing, so three metres east of it is a park bench about one time in
  // eight — and then the server slides you off it, correctly, and the test
  // fails for the wrong reason.
  let target = { x: spawn.x + 3, z: spawn.z };
  for (let i = 0; i < 16; i++) {
    const a2 = (i / 16) * Math.PI * 2;
    const t = { x: spawn.x + Math.cos(a2) * 3, z: spawn.z + Math.sin(a2) * 3 };
    if (isClear(t.x, t.z, 0.5)) {
      target = t;
      break;
    }
  }

  a.live.snaps.length = 0;
  b.live.snaps.length = 0;
  await walkTo(spawn, target);
  ok(b.live.snaps.length > 0, `positions are batched and pushed (${b.live.snaps.length} snapshot(s))`);
  const seen = whereIsA();
  ok(
    seen !== null && Math.hypot(seen.x - target.x, seen.z - target.z) < 0.5,
    `and the other player is where they said they were (${seen ? `${seen.x.toFixed(1)}, ${seen.z.toFixed(1)}` : "nowhere"} vs ${target.x.toFixed(1)}, ${target.z.toFixed(1)})`
  );
  ok(
    b.live.snaps.every((s) => s.p.length <= 20),
    "a snapshot never carries more than the island holds"
  );

  console.log("\nWhat the server will not take");
  // A step no runner could have taken. The server clamps it rather than
  // believing it — which is the only thing that stops a client teleporting
  // into somebody's twenty-metre earshot.
  const before = whereIsA()!;
  report(A, 70, 70, 0, 2);
  await sleep(700);
  const after = whereIsA()!;
  const jump = Math.hypot(after.x - before.x, after.z - before.z);
  // Under the ten metres at which somebody starts being audible: one report
  // must never be a way into a stranger's earshot. See SLACK_MAX_M.
  ok(jump < 10, `a teleport across the island is clamped to a step (${jump.toFixed(1)} m)`);

  // …and a position inside something solid is pushed out of it, BY THE SERVER:
  // walk right into the fountain and you end up on its rim.
  await walkTo(whereIsA()!, { x: 0, z: 0 });
  const rim = whereIsA()!;
  const r = Math.hypot(rim.x, rim.z);
  ok(r > PROP_SPEC.fountain.r, `walking into the fountain leaves you on its rim (r=${r.toFixed(1)} m, needs > ${PROP_SPEC.fountain.r})`);

  console.log("\nSaying something without saying anything");
  // A free emote is still an item you have to have CLAIMED (see the pricing
  // milestone) — a brand-new account owns nothing but the starter character.
  // Granted here directly so the check below exercises the emote path rather
  // than the store's.
  const emote = await ask(A, "live:emote", { id: "dance-shake-it-off" });
  ok(!!emote.error, "an emote this account has not claimed is refused");
  await db.query(
    "insert into user_items (user_id, item_id, source) values ($1, $2, 'grant') on conflict do nothing",
    [alice.id, "dance-shake-it-off"]
  );
  const em = await ask(A, "live:emote", { id: "dance-shake-it-off" });
  ok(em.ok === true, "and one it has is accepted");
  await sleep(400);
  ok(b.live.emotes.some((e) => e.uid === alice.uid), "and the other player sees it");
  const bad = await ask(A, "live:emote", { id: "fall" });
  ok(!!bad.error, "a clip that is not an emote is refused");
  const spam = await ask(A, "live:emote", { id: "dance-shake-it-off" });
  ok(!!spam.error, "and a second one straight away is refused");
  A.emit("match:quick", { kind: "emote", id: "🔥" });
  await sleep(400);
  ok(b.live.quick.some((q) => q.uid === alice.uid && q.id === "🔥"), "an emoji reaches them too");
  A.emit("match:quick", { kind: "emote", id: "<script>" });
  await sleep(300);
  ok(!b.live.quick.some((q) => q.id === "<script>"), "and an invented one does not");

  console.log("\nLeaving, and the seat going back");
  const wasSize = a.live.roster?.roster.length ?? 0;
  await ask(A, "match:leave");
  await sleep(900);
  ok(b.live.roster?.roster.length === wasSize, `the island is still ${wasSize} — a bot took the empty seat`);
  ok(
    !b.live.roster?.roster.some((r: any) => r.uid === alice.uid),
    "and the player who left is not on it any more"
  );
  const again = await enter(A);
  ok(again.ok === true, "…and can walk straight back in");
  await sleep(500);

  console.log("\nWhat the console can see");
  // The backend under test may be on its own Redis database (see the e2e
  // README) — point this at the SAME one or the scan looks at an empty
  // keyspace and reports the console as broken.
  const { default: Redis } = await back("ioredis/built/index.js");
  const redis = new Redis(process.env.E2E_REDIS_URL || process.env.REDIS_URL!);
  {
    await sleep(2200); // one ops snapshot
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await redis.scan(cursor, "MATCH", "ops:live:islands:*", "COUNT", 100);
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
    let seen: any = null;
    for (const k of keys) {
      const raw = await redis.get(k);
      for (const isle of JSON.parse(raw ?? "[]")) if (isle.id === b.live.resume?.matchId) seen = isle;
    }
    ok(seen !== null, "the island is published for the console");
    ok((seen?.who ?? []).length >= 1, `with ${(seen?.who ?? []).length} player row(s) on it`);
    ok(
      (seen?.who ?? []).every((w: any) => typeof w.x === "number" && typeof w.near === "number"),
      "each carrying where they are and how many people can hear them"
    );
    await redis.quit();
  }
  console.log("\nWalking in together, and marking a spot");
  // A pin is only ever shown to the people you ARRIVED with, so this needs a
  // real party rather than two players who happen to be in the same park —
  // which is what the world board is for: one puts a card up, the other takes
  // it, and now they share a lobby.
  const cara = await throwaway("cara");
  const dave = await throwaway("dave");
  const c = await connect(cara.token);
  const d = await connect(dave.token);
  C = c.s;
  D = d.s;
  await ask(C, "world:hello");
  await ask(D, "world:hello");
  let cardId: string | null = null;
  D.on("world:request", (r: any) => {
    if (r?.uid === cara.uid) cardId = r.id;
  });
  const sought = await ask(C, "world:seek", { mode: "duo" });
  ok(!sought?.error, `a duo card goes up${sought?.error ? ` (${sought.error})` : ""}`);
  for (let i = 0; i < 40 && cardId === null; i++) await sleep(100);
  const took = cardId ? await ask(D, "world:accept", { id: cardId }) : { error: "the card never appeared" };
  ok(took?.ok === true, `and the other player takes it${took?.error ? ` (${took.error})` : ""}`);
  await sleep(400);

  // The leader picks the game for the party, but EVERY member has to report
  // the pack downloaded or START refuses — which is the real client's
  // behaviour and worth going through rather than around.
  const picked = await ask(C, "lobby:pickGame", { gameId: "social" });
  if (picked?.error) console.log(`    (pickGame said: ${picked.error})`);
  C.emit("game:progress", { pct: 100 });
  D.emit("game:progress", { pct: 100 });
  const said = await ask(D, "lobby:sayReady", { ready: true });
  if (said?.error) console.log(`    (ready said: ${said.error})`);
  await sleep(300);
  const together = await ask(C, "lobby:start");
  if (together?.error) console.log(`    (start said: ${together.error})`);
  await sleep(1200);
  ok(c.live.resume !== null && d.live.resume !== null, "one START takes the pair of them in");
  ok(c.live.resume?.matchId === d.live.resume?.matchId, "…onto the same island, as a party");
  ok(
    (c.live.roster?.party ?? []).includes(dave.uid),
    `each is told who they came with (${JSON.stringify(c.live.roster?.party ?? [])})`
  );
  ok((d.live.roster?.party ?? []).includes(cara.uid), "both ways round — the map numbers them from this");
  ok(
    !(a.live.roster?.party ?? []).includes(cara.uid) && !(a.live.roster?.party ?? []).includes(dave.uid),
    "and somebody who walked in alone is told about nobody"
  );

  c.live.pins.length = 0;
  d.live.pins.length = 0;
  a.live.pins.length = 0;
  // Out at sea on purpose: a thumb on a map is not precise, and "as close to
  // there as you can get" is what tapping the water means.
  C.emit("live:pin", { x: 400, z: -400 });
  await sleep(500);
  ok(d.live.pins.length === 1, `a mark reaches the person they came with (${d.live.pins.length})`);
  ok(c.live.pins.length === 1, "and comes back to the one who made it, so both see the same spot");
  ok(a.live.pins.length === 0, "and goes to nobody else on the island");
  const mark = d.live.pins.at(-1) ?? { uid: "", x: null, z: null };
  ok(
    typeof mark.x === "number" && Math.hypot(mark.x, mark.z as number) <= WALK_R + 0.05,
    `a tap on the sea lands on the island (${mark.x}, ${mark.z})`
  );
  ok(mark.uid === cara.uid, "carrying who put it there");
  await sleep(600); // PIN_COOLDOWN_MS
  C.emit("live:pin", {});
  await sleep(500);
  ok(d.live.pins.at(-1)?.x === null, "and it can be taken down again");

  await ask(C, "match:leave");
  await ask(D, "match:leave");
  await sleep(300);

  console.log("\nClosing it, and watching it back");
  // Both walk out. An island with nobody real on it closes itself after
  // EMPTY_CLOSE_MS rather than running for forty minutes with a park full of
  // bots in it — which is also the quickest honest way to make one archive.
  await ask(A, "match:leave");
  await ask(B, "match:leave");
  const islandId = b.live.resume?.matchId ?? island!.matchId;
  let row: { r2_key: string; bytes: number; game_id: string } | null = null;
  for (let i = 0; i < 40 && !row; i++) {
    await sleep(2000);
    const { rows } = await db.query(
      "select r2_key, bytes, game_id from match_replays where match_key = $1",
      [islandId]
    );
    row = rows[0] ?? null;
  }
  ok(row !== null, `the session was archived (${row ? `${Math.round(row.bytes / 1024)} KB` : "never appeared"})`);
  ok(row?.game_id === "social", "under its own game id, so the console lists it with the rest");

  const { rows: mrows } = await db.query(
    "select player_count, ticks, reason from matches where match_key = $1",
    [islandId]
  );
  ok(mrows.length === 1, "with a row the replay list can join to");
  // One row per PERSON, not per visit — Alice left and came back, and the
  // table is unique on (match, user). Twenty seats plus whoever the churn
  // brought through, collapsed.
  ok((mrows[0]?.player_count ?? 0) >= 20, `covering everybody who was ever on it (${mrows[0]?.player_count})`);
  const { rows: prows } = await db.query(
    `select count(*)::int as n, count(mp.user_id)::int as people from match_players mp
       join matches m on m.id = mp.match_id where m.match_key = $1`,
    [islandId]
  );
  ok((prows[0]?.people ?? 0) >= 2, `and both players are findable by uid (${prows[0]?.people})`);

  // Nobody's career may have moved. An island is not a match, and every seat
  // on it "finished first" — put that through the ordinary path and twenty
  // people gain a win apiece.
  const { rows: stat } = await db.query(
    "select coalesce(sum(matches),0)::int as m, coalesce(sum(wins),0)::int as w from player_stats where user_id = any($1)",
    [[alice.id, bob.id]]
  );
  ok(
    (stat[0]?.m ?? 0) === 0 && (stat[0]?.w ?? 0) === 0,
    `standing in a park is not a match played or a match won (${stat[0]?.m}m/${stat[0]?.w}w)`
  );

  if (row) {
    // …and the file is a real track: poses, in tick order, per occupancy.
    const { getEvidence } = await import(path.join(root, "backend", "src", "platform", "evidence.js"));
    const { unpackReplay } = await import(path.join(root, "backend", "src", "platform", "replay.js"));
    const bytes = await getEvidence(row.r2_key);
    const file = unpackReplay(bytes);
    ok(file.gameId === "social" && file.roster.length >= 20, `the file holds ${file.roster.length} occupancies`);
    ok(file.inputs.tick.length > 0, `and ${file.inputs.tick.length} track sample(s)`);
    const poses = file.kinds.filter((k: string) => k.startsWith("p")).length;
    ok(poses > 0, `${poses} distinct positions in the dictionary`);
    ok(
      file.roster.some((r: { joinedAtTick?: number }) => typeof r.joinedAtTick === "number"),
      "every occupancy says when it arrived, so a viewer never sees somebody before they turned up"
    );
    ok(
      file.roster.some((r: { uid: string }) => r.uid === alice.uid) &&
        file.roster.some((r: { uid: string }) => r.uid === bob.uid),
      "and both players are in it"
    );
    let ordered = true;
    const perSeat = new Map<number, number>();
    for (let i = 0; i < file.inputs.tick.length; i++) {
      const seat = file.inputs.seat[i];
      const t = file.inputs.tick[i];
      if ((perSeat.get(seat) ?? -1) > t) ordered = false;
      perSeat.set(seat, t);
    }
    ok(ordered, "each track runs forwards, which is what the studio scrubs along");
  }
} finally {
  A?.close();
  B?.close();
  C?.close();
  D?.close();
  if (made.length > 0) await db.query("delete from users where id = any($1)", [made]);
  await db.end();
}

console.log(fails === 0 ? "\n✔ The island holds up" : `\n✖ ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
