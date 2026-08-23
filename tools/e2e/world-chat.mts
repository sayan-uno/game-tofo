#!/usr/bin/env node
// DEV ONLY — proves World chat (W1–W3) against a RUNNING backend:
// a world exists and talks, a card puts a group together within ten seconds
// whether or not anybody real answers it, a bot's card is one a person can
// actually walk into, a real player always outranks a bot for a seat, and the
// teammates who come out of all that own the careers they earn.
//
//   npm run e2e:world                       (backend on :4000)
//   PORT=4100 npm run e2e:world             (the test backend)
//
// Set TRACKLINE_MATCH_SECONDS=30 on the backend to keep the match leg short;
// without it the match check waits out a full two-minute run.
//
// Run through tsx rather than node, because it imports backend SOURCE — so it
// can never pass against a stale build. It creates its own throwaway accounts
// and deletes them, whether it passes or not. The BOT accounts it causes to be
// minted are deliberately left behind: they are real accounts with real match
// histories now, and deleting them would be deleting evidence.
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
const { default: Redis } = await back("ioredis/built/index.js");
const { io } = await front("socket.io-client/build/esm/index.js");

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL || !process.env.REDIS_URL) {
  console.error("backend/.env is missing JWT_SECRET, DATABASE_URL or REDIS_URL");
  process.exit(2);
}

const API = `http://localhost:${process.env.PORT || 4000}`;
// The backend under test may be on its own Redis database (see the README);
// point this at the SAME one or the capacity leg will inspect an empty world.
const REDIS_URL = process.env.E2E_REDIS_URL || process.env.REDIS_URL!;
const MARK = `world-${Date.now()}`;
let fails = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  ✓ " : "  ✗ ") + m);
  if (!c) fails++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const redis = new Redis(REDIS_URL);
const made: string[] = [];

// Sweep anything a previous run left behind — a run killed mid-flight never
// reaches its own cleanup.
{
  const { rows } = await db.query("select id from users where google_id like 'world-%'");
  const stale = rows.map((r: { id: string }) => r.id);
  if (stale.length > 0) {
    await db.query("delete from world_messages where sender_id = any($1)", [stale]);
    await db.query("delete from users where id = any($1)", [stale]);
    console.log(`  … swept ${stale.length} account(s) from an earlier run`);
  }
}

async function throwaway(tag: string): Promise<{ id: string; uid: string; name: string; token: string }> {
  let uid = "";
  for (let i = 0; i < 5; i++) {
    uid = String(Math.floor(1 + Math.random() * 9)) + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
    const { rows } = await db.query("select 1 from users where uid = $1 union all select 1 from bot_accounts where uid = $1", [uid]);
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
  members: { lobbyId: string; members: { uid: string; name: string; character: string }[] } | null;
  cards: Map<string, { id: string; uid: string; name: string; mode: string; need: number }>;
  team: { from: { uid: string; name: string }; body: string }[];
  world: { uid: string; name: string; body: string }[];
  prepare: { roster: { uid: string; name: string }[] } | null;
  ended: { reason: string; standings: unknown[] } | null;
}

function connect(token: string): Promise<{ s: any; live: Live }> {
  return new Promise((resolve, reject) => {
    const s = io(API, { auth: { token }, transports: ["websocket"] });
    const live: Live = { members: null, cards: new Map(), team: [], world: [], prepare: null, ended: null };
    s.on("lobby:members", (m: Live["members"]) => (live.members = m));
    s.on("world:request", (r: { id: string }) => live.cards.set(r.id, r as never));
    s.on("world:requestGone", ({ id }: { id: string }) => live.cards.delete(id));
    s.on("world:msg", (m: never) => live.world.push(m));
    s.on("chat:team", (m: never) => live.team.push(m));
    s.on("match:prepare", (p: never) => {
      live.prepare = p;
      s.emit("match:ready");
    });
    s.on("match:end", (e: never) => (live.ended = e));
    s.on("connect", () => resolve({ s, live }));
    s.on("connect_error", reject);
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

let A: any, B: any;
try {
  const alice = await throwaway("alice");
  const bob = await throwaway("bob");
  const a = await connect(alice.token);
  const b = await connect(bob.token);
  A = a.s;
  B = b.s;

  console.log("\nA world, and a room that talks");
  const hello = await ask(A, "world:hello", {});
  ok(/^W\d+$/.test(hello.worldId ?? ""), `landed in a world (${hello.worldId})`);
  ok(hello.capacity === 1000, `capacity is ${hello.capacity}`);
  ok(hello.online > 0, `${hello.online} online`);
  ok(Array.isArray(hello.blocked), "the block list travels with it");
  ok(hello.fillMs === 10_000, `cards fill after ${hello.fillMs}ms`);
  await ask(B, "world:hello", {});
  await sleep(9000);
  ok(a.live.world.length >= 2, `the room said ${a.live.world.length} thing(s) in 9s`);
  ok(
    !a.live.world.some((m) => "botId" in (m as object) || "isBot" in (m as object)),
    "nothing in a line says who is a bot"
  );

  console.log("\nSaying something");
  const said = await ask(A, "world:say", { body: `hello from ${MARK}` });
  ok(said.ok === true, "a message is accepted");
  await sleep(600);
  ok(a.live.world.some((m) => m.body === `hello from ${MARK}`), "it comes back through the room");
  const flood: any[] = [];
  for (let i = 0; i < 8; i++) flood.push(await ask(A, "world:say", { body: `flood ${i}` }));
  ok(flood.some((r) => r.error), "a flood is refused");

  console.log("\nA card, and a group either way");
  const seek = await ask(A, "world:seek", { mode: "squad" });
  ok(seek.ok === true, "A asks the world for teammates");
  await sleep(900);
  const aCard = [...b.live.cards.values()].find((c) => c.uid === alice.uid);
  ok(!!aCard, "B sees the card");
  if (aCard) {
    const joined = await ask(B, "world:accept", { id: aCard.id });
    ok(joined.ok === true, "B walks in");
    await sleep(900);
    ok(a.live.members?.lobbyId === b.live.members?.lobbyId, "they are in the same party");
  }
  await sleep(12_000);
  const roster = a.live.members?.members ?? [];
  ok(roster.length === 4, `the group filled to four (${roster.map((m) => m.name).join(", ")})`);
  ok(
    !roster.some((m) => "isBot" in (m as object)),
    "nothing in the roster says who is a bot"
  );
  ok(roster.every((m) => typeof m.character === "string" && m.character), "everyone is wearing something real");
  ok(a.live.team.length > 0, `the new teammates said hello (${a.live.team.map((m) => m.body).join(", ")})`);
  ok(![...b.live.cards.values()].some((c) => c.uid === alice.uid), "the card came down");

  console.log("\nOne of them is a real profile");
  const stranger = roster.find((m) => m.uid !== alice.uid && m.uid !== bob.uid)!;
  const res = await fetch(`${API}/api/profile/${stranger.uid}`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  const card = await res.json().catch(() => ({}));
  ok(res.ok && card.user?.uid === stranger.uid, `${stranger.name} has a profile`);
  ok(!!card.rank && typeof card.level === "number", "with a rank and a level on it");
  const add = await fetch(`${API}/api/friends/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uid: stranger.uid }),
  });
  ok(add.status === 200, "adding them does not answer 'no player found'");

  console.log("\nA group somebody else advertised");
  await ask(B, "lobby:leave");
  await sleep(800);
  let theirs: { id: string; uid: string; name: string } | undefined;
  for (let i = 0; i < 30 && !theirs; i++) {
    await sleep(1500);
    theirs = [...b.live.cards.values()].find((c) => c.uid !== alice.uid && c.uid !== bob.uid);
  }
  ok(!!theirs, theirs ? `a card from ${theirs.name}` : "no card from anybody else in 45s");
  if (theirs) {
    b.live.team.length = 0;
    const joined = await ask(B, "world:accept", { id: theirs.id });
    ok(joined.ok === true, "B walks into it");
    await sleep(1200);
    const bRoster = b.live.members?.members ?? [];
    ok(bRoster.some((m) => m.name === theirs!.name), "the name on the card is the one that turns up");
    await sleep(3500);
    ok(b.live.team.length > 0, "and they say hello");
  }

  console.log("\nA real player outranks a bot");
  const world = hello.worldId as string;
  // Stand the world up at ONE seat short of a thousand people, with the rest of
  // the room held by the population — the exact state the rule is about. The
  // ghosts are counted, never resolved: this leg is about the seat arithmetic,
  // and the console's roster is what resolves members to accounts.
  const already = await redis.zcard(`world:${world}:humans`);
  const ghosts = Array.from({ length: Math.max(0, 999 - already) }, (_, i) => `${MARK}-ghost-${i}`);
  if (ghosts.length > 0) {
    const m = redis.multi();
    for (const g of ghosts) m.zadd(`world:${world}:humans`, Date.now(), g);
    await m.exec();
  }
  const botsBefore = await redis.zcard(`world:${world}:bots`);
  ok((await redis.zcard(`world:${world}:humans`)) === 999, "the world is one seat short of a thousand people");
  // Alice is already a member; forgetting her binding makes her arrival a
  // fresh one, which is what a returning player's is.
  await redis.del(`user:world:${alice.id}`);
  await redis.zrem(`world:${world}:humans`, alice.id);
  await redis.zadd(`world:${world}:humans`, Date.now(), `${MARK}-ghost-filler`);
  ghosts.push(`${MARK}-ghost-filler`);
  const again = await ask(A, "world:hello", {});
  const humans = await redis.zcard(`world:${world}:humans`);
  const bots = await redis.zcard(`world:${world}:bots`);
  ok(again.worldId === world, `a person still gets in when the seats are all taken (${again.worldId})`);
  ok(humans === 1000, `they are counted as a person (${humans})`);
  ok(bots < botsBefore, `a bot stood down (${botsBefore} → ${bots})`);
  ok(humans + bots <= 1000, `the world never went over capacity (${humans + bots})`);
  await redis.zrem(`world:${world}:humans`, ...ghosts);

  console.log("\nAnd the careers are real");
  await ask(A, "lobby:leave");
  await sleep(800);
  await ask(A, "world:seek", { mode: "squad" });
  await sleep(13_000);
  const squad = (a.live.members?.members ?? []).filter((mm) => mm.uid !== alice.uid).map((mm) => mm.uid);
  await ask(A, "lobby:pickGame", { gameId: "trackline" });
  A.emit("game:progress", { pct: 100 });
  await sleep(900);
  const started = await ask(A, "lobby:start", {});
  ok(!started.error, "the group starts a match");
  for (let i = 0; i < 40 && !a.live.prepare; i++) await sleep(500);
  ok(!!a.live.prepare, `everyone was dealt in (${a.live.prepare?.roster.length ?? 0} runners)`);
  ok(
    squad.every((u) => a.live.prepare?.roster.some((r) => r.uid === u)),
    "the teammates from the world are the runners in the match"
  );
  for (let i = 0; i < 160 && !a.live.ended; i++) await sleep(1000);
  ok(!!a.live.ended, `the match ended (${a.live.ended?.reason ?? "—"})`);
  await sleep(3000);
  const { rows: careers } = await db.query(
    `select b.username, s.matches, s.wins, s.xp, s.best_placement
       from bot_accounts b join bot_stats s on s.bot_id = b.id
      where b.uid = any($1)`,
    [squad]
  );
  ok(careers.length === squad.length, `every teammate's career grew (${careers.map((r: any) => `${r.username} ${r.matches}m/${r.wins}w/${r.xp}xp`).join(", ")})`);
  const { rows: seats } = await db.query(
    `select mp.is_bot, mp.bot_id is not null as owned from match_players mp
       join matches m on m.id = mp.match_id order by m.created_at desc limit 4`
  );
  ok(seats.filter((r: any) => r.is_bot).every((r: any) => r.owned), "and every bot seat points at the account that played it");
} finally {
  A?.close();
  B?.close();
  if (made.length > 0) {
    await db.query("delete from world_messages where sender_id = any($1)", [made]);
    await db.query("delete from users where id = any($1)", [made]);
  }
  await db.end();
  await redis.quit();
}

console.log(fails === 0 ? "\n✔ World chat holds up" : `\n✖ ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
