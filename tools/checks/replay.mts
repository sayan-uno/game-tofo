// Verification suite for match replays (A4) — run it after ANY change to the
// replay format, the archive queue or retention.
//
//     npm run check:replay
//
// The question this file exists to answer is the one the whole feature rests
// on: **is a decoded replay the same match?** Not "does it look plausible" —
// the same. It proves it the only way that means anything: it plays a real
// match through a real game's server definition, ranks it, puts the result
// through the encoder, the gzip, the decoder and back into the ranker, and
// requires the standings to be identical. If a single input were dropped,
// reordered or renamed, the scores would move and this would fail.
//
// It also covers the parts around it: interning, the queue and its retries,
// retention tiers, and the sweeper. Storage is the on-disk backend, so no
// cloud account is needed to know the pipeline works.

import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
process.env.REDIS_URL = `${(process.env.REDIS_URL || "").replace(/\/\d+$/, "")}/8`;
const EVIDENCE = join(tmpdir(), `replay-check-${Date.now()}`);
process.env.EVIDENCE_DIR = EVIDENCE;
// Force the disk backend even on a machine that has the real credentials.
process.env.R2_EVIDENCE_ACCOUNT_ID = "";
process.env.R2_EVIDENCE_BUCKET = "";

const { redis } = await import("../../backend/src/redis.js");
const { pool } = await import("../../backend/src/db/client.js");
await import("../../backend/src/games/index.js");
const { getGame } = await import("../../backend/src/platform/games.js");
const {
  encodeReplay, toRankMembers, packReplay, unpackReplay, replayKey, expiryFor,
  queueReplay, drainReplays, sweepReplays, replayStats, tierFor, REPLAY_FORMAT,
} = await import("../../backend/src/platform/replay.js");
const { evidenceBackend, getEvidence } = await import("../../backend/src/platform/evidence.js");
const { randomUUID } = await import("node:crypto");

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, values)).rows as T[];

await redis.connect();
await redis.flushdb();
const MARK = `replaycheck-${Date.now()}`;

/** Play a real match through a real game's server definition and rank it.
 *
 *  Trackline's bots are PLANNED, so their whole input list exists up front.
 *  Ludo's must REACT, so it is stepped a tick at a time and asked what the
 *  server would author — dice included. Either way what comes out is what the
 *  match runtime would have held. */
function playedMatch(gameId: string, seed: number, players: number) {
  const game = getGame(gameId)!;
  const ctx = { id: `${MARK}-${gameId}`, players };
  const seats = Array.from({ length: players }, (_, seat) => seat);
  const inputsBySeat = new Map<number, { tick: number; kind: string }[]>();
  for (const seat of seats) inputsBySeat.set(seat, []);

  if (game.planBot) {
    for (const seat of seats) inputsBySeat.set(seat, game.planBot(seed, seat, 0.55));
  }
  if (game.serverInputs) {
    // A reacting game has to actually be PLAYED: what the server authors next
    // depends on what the board looks like now, so each authored input is fed
    // back into the sims exactly as the match runtime feeds it. Asking for
    // inputs without applying them yields a board that never moves and a
    // "match" that proves very little.
    const sims = new Map(seats.map((seat) => [seat, game.createSim(seed, seat, ctx)]));
    const view = seats.map((seat) => ({ uid: `s${seat}`, seat, isBot: true, skill: 0.5, left: false }));
    for (let tick = 1; tick <= game.durationTicks; tick++) {
      for (const sim of sims.values()) sim.advanceTo(tick);
      for (const { uid, input } of game.serverInputs(ctx, seed, tick, view)) {
        const seat = Number(uid.slice(1));
        inputsBySeat.get(seat)?.push(input);
        sims.get(seat)?.addInput(input);
      }
      if ([...sims.values()].every((sim) => sim.isOut())) break;
    }
  }

  const members = seats.map((seat) => ({
    uid: `s${seat}`,
    name: `Runner ${seat}`,
    seat,
    inputs: inputsBySeat.get(seat)!,
    left: false,
    leftAtTick: null,
    isBot: seat > 0,
  }));
  const endTick = game.durationTicks;
  return { game, members, endTick, standings: game.rank(members, endTick, seed), inputsBySeat };
}

function fileFor(gameId: string, seed: number, played: ReturnType<typeof playedMatch>) {
  return encodeReplay({
    matchKey: `${MARK}-${gameId}`,
    gameId,
    seed,
    tickRate: played.game.tickRate,
    durationTicks: played.game.durationTicks,
    createdAt: 1_700_000_000_000,
    startAt: 1_700_000_003_000,
    endedAt: 1_700_000_090_000,
    reason: "timeout",
    endTick: played.endTick,
    roster: played.members.map((m) => ({
      uid: m.uid, seat: m.seat, name: m.name, character: "seraph", weapon: null,
      isBot: m.isBot, userId: m.isBot ? null : randomUUID(), left: m.left, leftAtTick: m.leftAtTick,
    })),
    inputsBySeat: played.inputsBySeat,
    quick: [
      { tick: 40, seat: 0, kind: "chat" as const, id: "gg" },
      { tick: 95, seat: 2, kind: "emote" as const, id: "🔥" },
    ],
    standings: played.standings,
    xp: Object.fromEntries(played.standings.map((s) => [s.uid, 100])),
  });
}

try {
  // ---- the round trip, per game -------------------------------------------
  for (const [gameId, players] of [["trackline", 4], ["ludo", 4]] as [string, number][]) {
    console.log(`\n${gameId} · the round trip`);
    const seed = 0x51ed_beef;
    const played = playedMatch(gameId, seed, players);
    const totalInputs = [...played.inputsBySeat.values()].reduce((n, l) => n + l.length, 0);
    ok(totalInputs > 20, `the match produced a real input log (${totalInputs} inputs)`);
    ok(played.standings.length === players, `and ranked all ${players} runners`);

    const file = fileFor(gameId, seed, played);
    const packed = packReplay(file);
    const back = unpackReplay(packed);

    ok(back.v === REPLAY_FORMAT, "the file states its format version");
    ok(back.kinds.length > 0 && back.kinds.length <= 12, `kinds are interned into a small dictionary (${back.kinds.length})`);
    ok(back.inputs.tick.length === totalInputs, "every input survives the round trip");

    const members = toRankMembers(back);
    ok(members.length === players, "the roster is rebuilt");
    for (const m of members) {
      const original = played.inputsBySeat.get(m.seat)!;
      const same =
        m.inputs.length === original.length &&
        m.inputs.every((i, n) => i.tick === original[n].tick && i.kind === original[n].kind);
      ok(same, `seat ${m.seat}'s inputs come back in the same ORDER, not merely the same set`);
    }

    // THE check.
    const reranked = played.game.rank(members, back.endTick, back.seed);
    ok(
      JSON.stringify(reranked) === JSON.stringify(played.standings),
      "re-ranking the decoded replay gives the SAME standings the server wrote"
    );

    const kb = (packed.length / 1024).toFixed(1);
    ok(packed.length < 60_000, `and it is small: ${kb} kB gzipped for ${totalInputs} inputs`);
    ok(back.quick.id.length === 2, "what was said during the match is in there too");
    ok(back.quick.id[1] === "🔥", "including an emote, unmangled");
  }

  // ---- a changed input must change the answer ------------------------------
  console.log("\ntamper");
  {
    const seed = 0x51ed_beef;
    const played = playedMatch("trackline", seed, 4);
    const file = fileFor("trackline", seed, played);
    const bent = unpackReplay(packReplay(file));
    // Drop one input. If the standings still matched, this whole suite would
    // be proving nothing.
    bent.inputs.seat.splice(1, 1);
    bent.inputs.tick.splice(1, 1);
    bent.inputs.kind.splice(1, 1);
    const reranked = played.game.rank(toRankMembers(bent), bent.endTick, bent.seed);
    ok(
      JSON.stringify(reranked) !== JSON.stringify(played.standings),
      "removing a single input changes the result — so the check above is actually checking something"
    );
  }

  // ---- retention ----------------------------------------------------------
  console.log("\nretention");
  {
    const at = Date.UTC(2026, 7, 18, 12, 0, 0);
    ok(replayKey("abc123", at) === "replays/2026/08/18/abc123.json.gz", "the key is a dated folder, so a day can be swept as a unit");
    ok(expiryFor("standard", at)!.getTime() === at + 30 * 86_400_000, "standard keeps a replay for 30 days");
    ok(expiryFor("extended", at)!.getTime() === at + 365 * 86_400_000, "a flagged player's matches for a year");
    ok(expiryFor("hold", at) === null, "and a case hold never expires");
    ok((await tierFor([])) === "standard", "a match with no humans is standard");
    ok((await tierFor([randomUUID()])) === "standard", "so is one with nobody flagged");
    await redis.sadd("rec:replay", "flagged-user");
    ok((await tierFor(["someone", "flagged-user"])) === "extended", "one flagged player makes the whole match extended");
  }

  // ---- the queue ----------------------------------------------------------
  console.log("\nthe archive queue");
  {
    ok(evidenceBackend() === "disk", "the check writes to disk, so no cloud account is needed to prove the pipeline");
    const seed = 12345;
    const played = playedMatch("trackline", seed, 2);
    const file = fileFor("trackline", seed, played);
    file.matchKey = `${MARK}-queued`;

    const before = replayStats().archived;
    await queueReplay(file, "standard");
    ok((await redis.llen("replay:queue")) === 1, "queueing puts it in Redis, so a restart does not lose it");
    await drainReplays();
    ok((await redis.llen("replay:queue")) === 0, "draining empties the queue");
    ok(replayStats().archived === before + 1, "and counts what it archived");

    const [row] = await q<{ r2_key: string; bytes: string; tier: string; expires_at: string }>(
      "select r2_key, bytes, tier, expires_at from match_replays where match_key = $1",
      [file.matchKey]
    );
    ok(Boolean(row), "a row records where it went");
    ok(row.tier === "standard", "with its retention tier");
    ok(Number(row.bytes) > 100, `and its size (${row.bytes} bytes)`);

    const stored = await getEvidence(row.r2_key);
    ok(stored !== null, "the file really is in the archive");
    const decoded = unpackReplay(stored!);
    ok(decoded.matchKey === file.matchKey, "and reads back as the same match");
    ok(
      JSON.stringify(played.game.rank(toRankMembers(decoded), decoded.endTick, decoded.seed)) ===
        JSON.stringify(played.standings),
      "…still ranking identically after a trip through storage"
    );

    // Idempotent: a retry after a partial success must not fail on the key.
    await queueReplay(file, "standard");
    await drainReplays();
    const [{ n }] = await q<{ n: string }>("select count(*) n from match_replays where match_key = $1", [file.matchKey]);
    ok(Number(n) === 1, "archiving the same match twice leaves one row, not an error");
  }

  // ---- the sweeper --------------------------------------------------------
  console.log("\nthe sweeper");
  {
    await q(
      "insert into match_replays (match_key, game_id, r2_key, bytes, tier, expires_at) values ($1,'trackline','replays/expired.json.gz',10,'standard', now() - interval '1 day')",
      [`${MARK}-expired`]
    );
    await q(
      "insert into match_replays (match_key, game_id, r2_key, bytes, tier, expires_at) values ($1,'trackline','replays/kept.json.gz',10,'hold', null)",
      [`${MARK}-held`]
    );
    const swept = await sweepReplays();
    ok(swept >= 1, `the sweeper removes what has expired (${swept})`);
    const [{ gone }] = await q<{ gone: string }>("select count(*) gone from match_replays where match_key = $1", [`${MARK}-expired`]);
    ok(Number(gone) === 0, "the expired row is gone");
    const [{ kept }] = await q<{ kept: string }>("select count(*) kept from match_replays where match_key = $1", [`${MARK}-held`]);
    ok(Number(kept) === 1, "and a case hold, which never expires, is untouched");
  }
} finally {
  try {
    await q("delete from match_replays where match_key like $1", [`${MARK}%`]);
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  rmSync(EVIDENCE, { recursive: true, force: true });
  await redis.flushdb();
  redis.disconnect();
  await pool.end();
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
