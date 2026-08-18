// DEV ONLY — put a replay in the archive so the studio has something to open.
//
//   tsx tools/e2e/seed-replay.mts seed <gameId>    → prints the match key
//   tsx tools/e2e/seed-replay.mts clean <matchKey>
//
// It plays a match through the game's REAL server definition — planned bot
// inputs for a runner, the server's own authored inputs for a board game, fed
// back into the sims so the board actually moves — then puts the result through
// the same encoder and the same queue the match runtime uses. So what lands in
// the archive is indistinguishable from a played match, which is the point:
// the studio must be exercised against a real file, not a fixture.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", ".env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { redis } = await import("../../backend/src/redis.js");
const { pool } = await import("../../backend/src/db/client.js");
await import("../../backend/src/games/index.js");
const { getGame } = await import("../../backend/src/platform/games.js");
const { encodeReplay, queueReplay, drainReplays } = await import("../../backend/src/platform/replay.js");
const { deleteEvidence } = await import("../../backend/src/platform/evidence.js");

const mode = process.argv[2];
const arg = process.argv[3] ?? "";
await redis.connect();

if (mode === "clean") {
  const { rows } = await pool.query("select r2_key from match_replays where match_key = $1", [arg]);
  if (rows[0]) await deleteEvidence([rows[0].r2_key]);
  await pool.query("delete from match_replays where match_key = $1", [arg]);
  redis.disconnect();
  await pool.end();
  process.exit(0);
}

const gameId = arg || "ludo";
const game = getGame(gameId);
if (!game) {
  console.error(`unknown game "${gameId}"`);
  process.exit(2);
}

const seed = 0x5eed_1234;
const players = 4;
const matchKey = `seed-${gameId}-${Math.random().toString(36).slice(2, 10)}`;
const ctx = { id: matchKey, players };
const seats = [0, 1, 2, 3];
const inputsBySeat = new Map(seats.map((s) => [s, [] as { tick: number; kind: string }[]]));

if (game.planBot) {
  for (const seat of seats) inputsBySeat.set(seat, game.planBot(seed, seat, 0.6));
}
if (game.serverInputs) {
  const sims = new Map(seats.map((seat) => [seat, game.createSim(seed, seat, ctx)]));
  const view = seats.map((seat) => ({ uid: `u${seat}`, seat, isBot: seat > 0, skill: 0.5, left: false }));
  for (let tick = 1; tick <= game.durationTicks; tick++) {
    for (const sim of sims.values()) sim.advanceTo(tick);
    for (const { uid, input } of game.serverInputs(ctx, seed, tick, view)) {
      const seat = Number(uid.slice(1));
      inputsBySeat.get(seat)?.push(input);
      sims.get(seat)?.addInput(input);
    }
    if ([...sims.values()].every((s) => s.isOut())) break;
  }
}

const NAMES = ["SeedRunner", "Bot Vela", "Bot Kori", "Bot Nyx"];
const members = seats.map((seat) => ({
  uid: `u${seat}`,
  name: NAMES[seat],
  seat,
  inputs: inputsBySeat.get(seat)!,
  left: false,
  leftAtTick: null,
  isBot: seat > 0,
}));
const endTick = game.durationTicks;
const standings = game.rank(members, endTick, seed);
const now = Date.now();

const file = encodeReplay({
  matchKey,
  gameId,
  seed,
  tickRate: game.tickRate,
  durationTicks: game.durationTicks,
  createdAt: now - 120_000,
  startAt: now - 117_000,
  endedAt: now,
  reason: "timeout",
  endTick,
  roster: members.map((m) => ({
    uid: m.uid, seat: m.seat, name: m.name, character: "seraph", weapon: null,
    isBot: m.isBot, userId: null, left: false, leftAtTick: null,
  })),
  inputsBySeat,
  quick: [
    { tick: Math.round(endTick * 0.1), seat: 0, kind: "chat", id: "gg" },
    { tick: Math.round(endTick * 0.3), seat: 1, kind: "emote", id: "🔥" },
    { tick: Math.round(endTick * 0.6), seat: 0, kind: "chat", id: "close" },
  ],
  standings,
  xp: Object.fromEntries(standings.map((s) => [s.uid, 100])),
});

await queueReplay(file, "standard");
await drainReplays();
const { rows } = await pool.query("select bytes from match_replays where match_key = $1", [matchKey]);
if (!rows[0]) {
  console.error("the replay did not reach the archive");
  process.exit(1);
}
// The standings travel with the answer so a test can hold the studio to them:
// what the game draws at the end of a replay must equal what the server
// recorded, or the replay is not the match.
console.log(
  JSON.stringify({
    matchKey,
    gameId,
    bytes: rows[0].bytes,
    inputs: file.inputs.tick.length,
    endTick,
    watch: { uid: "u0", name: NAMES[0] },
    standings: standings.map((st) => ({ uid: st.uid, placement: st.placement, score: st.score })),
  })
);
redis.disconnect();
await pool.end();
