// Verification suite for the carrom simulation — run it after ANY change to
// shared/games/carrom.
//
//     npm run check:carrom
//
// It reads the shared SOURCE (via tsx), so it can never pass against a stale
// build. What it proves, and why each check exists:
//
//   arithmetic    — the simulation contains NO trigonometry, no pow and no
//                   hypot. That is the whole determinism argument in one grep:
//                   +, -, *, / and sqrt are correctly rounded by IEEE-754 and
//                   therefore identical on every device; sin and its friends
//                   are not specified that tightly, and one of them in the
//                   solver would put a coin in a pocket on one phone and
//                   against the wall on another, with no way back
//   board         — nineteen coins really do pack, nine of each colour, and
//                   the arrangement is FAIR: turning it half a turn gives the
//                   same board with the colours swapped, so neither side starts
//                   better placed. Derived by walking the layout rather than
//                   typed out, so a single wrong cell would be caught
//   seating       — partners sit opposite, the turn alternates sides round the
//                   board, and a party seated contiguously stays together
//   physics       — nothing escapes the square, nothing tunnels through
//                   anything, every shot settles, and a pocketed disc is
//                   pocketed the same way from every direction
//   rules         — the striker foul, the missed shot, the queen's cover, the
//                   too-early queen, and clearing nine to win
//   authority     — a player's own inputs move NOTHING. This is the whole
//                   safety argument for a shared board on a platform that
//                   relays inputs to everyone except their sender
//   replay parity — live stepping, a cold replay, and a sim fed every input
//                   LATE and out of order all agree BIT FOR BIT. This is the
//                   netcode, and on a physics board "close enough" is a
//                   different board a hundred collisions later
//   keyframe      — the turn-top snapshot the client rewinds to produces
//                   exactly the board a full replay does
//   liveness      — bot boards reach a winner, and do it well inside the clock,
//                   with none, one, two and all four seats absent
//   stall         — with the server silent from the first tick, the table still
//                   turns rather than freezing forever
//   fairness      — over hundreds of boards neither colour wins more
//   cost          — the end-of-match replay stays inside a frame's budget
import { readFileSync } from "node:fs";
import {
  AWAY_KIND,
  BACK_KIND,
  BASE_HALF,
  BASE_Y,
  BODY_COUNT,
  CENTRE_R,
  COINS_PER_TEAM,
  COIN_COUNT,
  COIN_R,
  CarromSim,
  DURATION_SEC,
  DURATION_TICKS,
  HALF,
  KIND,
  KIND_DARK,
  KIND_LIGHT,
  KIND_QUEEN,
  LAYOUT,
  MAX_PERFORMANCE,
  MAX_SPEED,
  MIN_SPEED,
  NUDGE_KIND,
  PLACE_POINTS,
  POCKETS,
  POCKET_R,
  QUEEN_INDEX,
  QUIT_KIND,
  STRIKER_INDEX,
  STRIKER_R,
  SUBSTEPS,
  TICK_RATE,
  TURN_TICKS,
  TYPICAL_SEC,
  aimKind,
  anyMoving,
  applyInput,
  askKind,
  awaitingServer,
  baseSpot,
  cloneState,
  coinTeam,
  createState,
  freeSlot,
  isInputKind,
  isOut,
  movesBoard,
  nearestFreeSlot,
  outcome,
  parseInput,
  queenAllowed,
  radiusOf,
  replay,
  scoreOf,
  seatsOfTeam,
  shotKind,
  sideOf,
  slotFree,
  stallShot,
  step,
  stepBodies,
  teamOf,
  teamPocketed,
  toLocal,
  toWorld,
  turnOrder,
  type CarromInput,
  type CarromState,
} from "../../shared/games/carrom/index.js";
// The bot policy is server-side (it is not part of the deterministic sim), but
// its OUTPUT is ordinary inputs, so it is checked with exactly the same tools.
import { chooseShot, thinkTicks } from "../../backend/src/games/carrom/bot.js";
// The server definition is checked too, through the same registry the platform
// reads it from — importing it is what registers it.
import "../../backend/src/games/carrom/index.js";
import { getGame } from "../../backend/src/platform/games.js";
import { _tableTurn } from "../../backend/src/games/carrom/index.js";

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    fails++;
    console.log(`  FAIL ${msg}`);
  }
};
const head = (name: string) => console.log(`\n${name}`);

/** A pinned pseudo-random source, so a failing run can be repeated exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** EXACT. Positions go in at full precision on purpose: a rounded fingerprint
 *  would let two boards that have already diverged compare equal, which is the
 *  one thing this file exists to catch. */
const fingerprint = (s: CarromState): string =>
  [
    s.tick,
    s.phase,
    s.turn,
    s.since,
    s.shots,
    s.queenBy,
    s.queenPending,
    s.winner,
    s.decided ? 1 : 0,
    s.over ? 1 : 0,
    s.coinsBy.join(","),
    s.fouls.join(","),
    s.quit.map((q) => (q ? 1 : 0)).join(""),
    s.away.map((a) => (a ? 1 : 0)).join(""),
    s.alive.join(""),
    s.x.join(","),
    s.y.join(","),
    s.vx.join(","),
    s.vy.join(","),
  ].join("|");

// ---------------------------------------------------------------------------
head("arithmetic — the simulation may only use operations that round the same everywhere");
{
  // Read the SOURCE, not the module: this is a promise about how the code is
  // written, and the only way to keep it is to look at the code.
  const files = ["board.ts", "physics.ts", "sim.ts", "rules.ts"];
  const banned = /Math\.(sin|cos|tan|asin|acos|atan|atan2|pow|hypot|cbrt|log|log2|log10|exp|expm1|random|fround|sign)\b|\*\*/;
  for (const f of files) {
    const src = readFileSync(new URL(`../../shared/games/carrom/${f}`, import.meta.url), "utf8");
    // Comments talk about sin and cos a great deal; only code counts.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const hit = code.match(banned);
    ok(!hit, `${f} uses no loosely-specified maths${hit ? ` (found ${hit[0]})` : ""}`);
  }
  const solver = readFileSync(new URL("../../shared/games/carrom/physics.ts", import.meta.url), "utf8");
  ok(/Math\.sqrt/.test(solver), "…and it does use Math.sqrt, which IS correctly rounded");
}

// ---------------------------------------------------------------------------
head("board — nineteen coins, nine a side, packed and fair");
{
  ok(COIN_COUNT === 19 && BODY_COUNT === 20, `nineteen coins and a striker (${COIN_COUNT} + 1)`);
  let light = 0;
  let dark = 0;
  let queens = 0;
  for (let i = 0; i < COIN_COUNT; i++) {
    if (KIND[i] === KIND_LIGHT) light++;
    else if (KIND[i] === KIND_DARK) dark++;
    else if (KIND[i] === KIND_QUEEN) queens++;
  }
  ok(light === COINS_PER_TEAM && dark === COINS_PER_TEAM && queens === 1, `${light} light, ${dark} dark, ${queens} queen`);
  ok(KIND[QUEEN_INDEX] === KIND_QUEEN, "the queen is body 0, and body 0 is the centre spot");
  ok(LAYOUT[QUEEN_INDEX].x === 0 && LAYOUT[QUEEN_INDEX].y === 0, "…which is exactly the centre");

  // Hex packing: no two coins overlap, and the closest pair is touching.
  let closest = Infinity;
  for (let i = 0; i < COIN_COUNT; i++) {
    for (let j = i + 1; j < COIN_COUNT; j++) {
      const d = Math.hypot(LAYOUT[i].x - LAYOUT[j].x, LAYOUT[i].y - LAYOUT[j].y);
      if (d < closest) closest = d;
    }
  }
  ok(Math.abs(closest - COIN_R * 2) < 1e-12, `the closest two coins are exactly touching (${closest.toFixed(6)} vs ${(COIN_R * 2).toFixed(6)})`);
  const far = Math.max(...LAYOUT.map((s) => Math.hypot(s.x, s.y)));
  ok(far + COIN_R <= CENTRE_R + 1e-9, `the whole rose sits inside the centre circle (${(far + COIN_R).toFixed(3)} ≤ ${CENTRE_R})`);

  // FAIRNESS: half a turn maps the board onto itself with the colours swapped.
  let fair = true;
  for (let i = 0; i < COIN_COUNT; i++) {
    let partner = -1;
    for (let j = 0; j < COIN_COUNT; j++) {
      if (Math.hypot(LAYOUT[j].x + LAYOUT[i].x, LAYOUT[j].y + LAYOUT[i].y) < 1e-12) partner = j;
    }
    if (partner < 0) {
      fair = false;
      break;
    }
    if (KIND[i] === KIND_QUEEN) {
      if (partner !== i) fair = false;
    } else if (KIND[partner] === KIND[i]) {
      fair = false;
    }
  }
  ok(fair, "half a turn gives the same board with the colours swapped — neither side starts better placed");

  // The base line has to be usable: inside the board, clear of the pockets.
  const spot = baseSpot(1);
  ok(Math.abs(spot.x) + STRIKER_R < HALF && BASE_Y + STRIKER_R < HALF, "the striker fits on the board at either end of the base line");
  let nearestPocket = Infinity;
  for (const t of [-1, -0.5, 0, 0.5, 1]) {
    const local = baseSpot(t);
    for (const p of POCKETS) {
      nearestPocket = Math.min(nearestPocket, Math.hypot(local.x - p.x, local.y - p.y));
    }
  }
  ok(nearestPocket > POCKET_R + STRIKER_R, `no legal placement is in a pocket (nearest ${nearestPocket.toFixed(3)} > ${(POCKET_R + STRIKER_R).toFixed(3)})`);
  ok(POCKET_R > COIN_R && POCKET_R > STRIKER_R, "a pocket is wider than anything that can fall in it");
  // A coin pressed into a corner falls in, as it does on a real board.
  const corner = Math.hypot(HALF - COIN_R - HALF, HALF - COIN_R - HALF);
  ok(corner < POCKET_R, `a coin wedged into a corner drops (${corner.toFixed(3)} < ${POCKET_R})`);
}

// ---------------------------------------------------------------------------
head("seating — partners opposite, sides alternating, parties kept whole");
{
  ok(sideOf(0, 2) === 0 && sideOf(1, 2) === 2, "singles is played across the board, not round a corner");
  ok(teamOf(0, 2) === 0 && teamOf(1, 2) === 1, "…and the two of them are on opposite sides");
  const sides = [0, 1, 2, 3].map((s) => sideOf(s, 4));
  ok(new Set(sides).size === 4, `doubles uses all four edges (${sides.join(", ")})`);
  ok(teamOf(0, 4) === teamOf(1, 4) && teamOf(2, 4) === teamOf(3, 4), "seats 0-1 are one side and 2-3 the other — a party stays together");
  ok(teamOf(0, 4) !== teamOf(2, 4), "…and the two pairs are opponents");
  ok(Math.abs(sideOf(0, 4) - sideOf(1, 4)) === 2 && Math.abs(sideOf(2, 4) - sideOf(3, 4)) === 2, "partners sit opposite each other");
  const turns = turnOrder(4);
  ok(turns.length === 4 && new Set(turns).size === 4, `every seat gets a turn (${turns.join(" → ")})`);
  const alt = turns.every((seat, i) => teamOf(seat, 4) !== teamOf(turns[(i + 1) % 4], 4));
  ok(alt, "the turn alternates sides all the way round");
  const clockwise = turns.map((s) => sideOf(s, 4)).join(",");
  ok(clockwise === "0,1,2,3", `and it goes round the board in order (sides ${clockwise})`);
  ok(seatsOfTeam(0, 4).join(",") === "0,1" && seatsOfTeam(1, 4).join(",") === "2,3", "the sides know their own seats");

  // WHO BREAKS IS DRAWN FROM THE SEED. Breaking is a disadvantage — the opener
  // scatters the pack and the next player inherits an open board — so a fixed
  // opener is a fixed handicap on one seat. Measured before the change: the
  // side that always opened won 36% of 150 boards.
  {
    const openers = new Set<number>();
    const sides = new Set<number>();
    for (let seed = 1; seed <= 400; seed++) {
      const st = createState(seed, 4);
      openers.add(st.turn);
      sides.add(teamOf(st.turn, 4));
    }
    ok(openers.size === 4, `every seat opens some boards (${[...openers].sort().join(",")})`);
    ok(sides.size === 2, "so both sides get the break");
    const again = createState(12345, 4);
    ok(again.turn === createState(12345, 4).turn, "…and the same seed always opens the same way");
  }

  // The local frame: four rotations that undo each other exactly.
  let exact = true;
  for (let side = 0; side < 4; side++) {
    for (const [x, y] of [
      [0.3, -0.7],
      [-0.9, 0.1],
      [BASE_HALF, -BASE_Y],
    ]) {
      const w = toWorld(side, x, y);
      const back = toLocal(side, w.x, w.y);
      if (back.x !== x || back.y !== y) exact = false;
    }
  }
  ok(exact, "local ⇄ world is exact in both directions — no rounding anywhere in the rotation");
}

// ---------------------------------------------------------------------------
head("inputs — what a client may say, and what only the server may");
{
  ok(isInputKind(askKind(0, 0, 1000, 500)), "a player may ask for a flick");
  ok(isInputKind(aimKind(0, 0, 1000, 500)), "…and may show the table what they are lining up");
  ok(isInputKind(NUDGE_KIND), "…and may say they are still here");
  ok(parseInput(aimKind(-250, 120, -990, 640))?.type === "aim", "an aim parses as an aim, not a request");
  ok(!movesBoard(aimKind(0, 0, 1000, 500)), "and it moves nothing, so it never enters a log");
  ok(!isInputKind(shotKind(0, 0, 1000, 500)), "a player may NOT write the shot itself");
  ok(!isInputKind(QUIT_KIND) && !isInputKind(AWAY_KIND) && !isInputKind(BACK_KIND), "…nor an empty chair, nor an away flag");
  ok(!isInputKind("a0,0,0,500"), "a flick must go somewhere — a direction of nothing is refused");
  ok(isInputKind("a0,0,-500,500"), "…but it may go ANY way, including back towards the shooter's own frame");
  ok(isInputKind("a0,-1000,-1000,0") && isInputKind("a0,1000,-1,1000"), "the aim really is a full circle");
  ok(!isInputKind("a0,0,1000,1001") && !isInputKind("a2000,0,1000,0"), "out-of-range numbers are refused");
  ok(!isInputKind("a0,0,1000") && !isInputKind("a0,0,1000,500,9"), "so is the wrong number of them");
  ok(!isInputKind("a0,0,1e3,500") && !isInputKind("a 0,0,1000,500") && !isInputKind("a0,0,1000,50x"), "and anything that is not a plain integer");
  ok(!isInputKind("a".repeat(400)), "a very long kind is refused rather than parsed");
  const p = parseInput(shotKind(-250, 120, 990, 640));
  ok(p?.type === "shot" && p.shot.t === -250 && p.shot.dx === 120 && p.shot.dy === 990 && p.shot.p === 640, "a shot round-trips through its kind exactly");
}

// ---------------------------------------------------------------------------
head("authority — nothing a player sends moves a disc");
{
  const s = createState(4242, 4);
  const before = fingerprint(s);
  const rand = rng(11);
  for (let i = 0; i < 800; i++) {
    const seat = Math.floor(rand() * 4);
    applyInput(s, seat, askKind(Math.floor(rand() * 2001) - 1000, Math.floor(rand() * 2001) - 1000, 1 + Math.floor(rand() * 1000), Math.floor(rand() * 1001)));
    applyInput(s, seat, NUDGE_KIND);
  }
  ok(fingerprint(s) === before, "eight hundred requests, from every seat, change nothing at all");
  for (let i = 0; i < 200; i++) applyInput(s, i % 4, aimKind(i - 100, i - 100, 1000 - i, i * 5));
  ok(fingerprint(s) === before, "…and so do two hundred live aims");
  applyInput(s, s.turn, shotKind(0, 0, 1000, 800));
  ok(s.phase === "shoot" && s.alive[STRIKER_INDEX] === 1, "the server's shot is what puts a striker on the board");

  // And the log refuses to carry a request at all, so a flood of late ones
  // cannot make every table in the match rebuild itself.
  const sim = new CarromSim(4242, 4, DURATION_TICKS);
  sim.advanceTo(400);
  const settled = fingerprint(sim.state);
  for (let i = 0; i < 500; i++) sim.addInput({ tick: 20 + (i % 200), seat: i % 4, kind: askKind(0, 0, 1000, 500) });
  sim.advanceTo(400);
  ok(sim.inputs.length === 0, "500 late requests leave the log empty");
  ok(fingerprint(sim.state) === settled, "and the board exactly where it was");
}

// ---------------------------------------------------------------------------
head("physics — nothing escapes, nothing tunnels, everything settles");
{
  const rand = rng(99);
  let escaped = 0;
  let overlapped = 0;
  let unsettled = 0;
  let longest = 0;
  const RUNS = 240;
  for (let r = 0; r < RUNS; r++) {
    const s = createState(70000 + r, 2);
    // A shot from a random placement at a random forward angle and power,
    // including the very hardest the game allows.
    const t = Math.floor(rand() * 2001) - 1000;
    const dx = Math.floor(rand() * 2001) - 1000;
    const dy = 1 + Math.floor(rand() * 1000);
    const p = r % 6 === 0 ? 1000 : Math.floor(rand() * 1001);
    applyInput(s, 0, shotKind(t, dx, dy, p));
    let ticks = 0;
    while (s.phase === "shoot" && ticks < 60 * 60) {
      step(s, DURATION_TICKS);
      ticks++;
      for (let i = 0; i < BODY_COUNT; i++) {
        if (!s.alive[i]) continue;
        const rad = radiusOf(i);
        if (Math.abs(s.x[i]) > HALF - rad + 1e-9 || Math.abs(s.y[i]) > HALF - rad + 1e-9) escaped++;
      }
    }
    if (ticks >= 60 * 60) unsettled++;
    longest = Math.max(longest, ticks);
    // Nothing may be sitting inside anything else once the dust has settled.
    for (let i = 0; i < BODY_COUNT; i++) {
      if (!s.alive[i]) continue;
      for (let j = i + 1; j < BODY_COUNT; j++) {
        if (!s.alive[j]) continue;
        const need = radiusOf(i) + radiusOf(j);
        if (Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]) < need - COIN_R * 0.002) overlapped++;
      }
    }
  }
  ok(escaped === 0, `no disc ever left the board across ${RUNS} shots`);
  ok(overlapped === 0, "no two discs are left visibly overlapping (within a five-hundredth of a coin radius)");
  ok(unsettled === 0, `every shot came to rest (longest ${(longest / TICK_RATE).toFixed(2)} s)`);

  // Tunnelling: the hardest shot in the game must move less per physics step
  // than the smallest pair of radii it could pass through.
  const perStep = MAX_SPEED / (TICK_RATE * SUBSTEPS);
  ok(perStep * 2 < COIN_R * 2, `two discs closing at full speed still overlap before they meet (${(perStep * 2).toFixed(4)} < ${(COIN_R * 2).toFixed(4)})`);

  // The power scale has to mean something at both ends: the weakest flick
  // reaches the rose, the strongest crosses the board and comes back.
  const travel = (power: number): number => {
    const s = createState(1, 2);
    for (let i = 0; i < COIN_COUNT; i++) s.alive[i] = 0;
    s.x[STRIKER_INDEX] = 0;
    s.y[STRIKER_INDEX] = -BASE_Y;
    s.alive[STRIKER_INDEX] = 1;
    s.vx[STRIKER_INDEX] = 0;
    s.vy[STRIKER_INDEX] = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * power;
    const log = { pocketed: [] as number[], contact: false };
    let d = 0;
    let px = s.x[STRIKER_INDEX];
    let py = s.y[STRIKER_INDEX];
    while (anyMoving(s)) {
      stepBodies(s, log);
      d += Math.hypot(s.x[STRIKER_INDEX] - px, s.y[STRIKER_INDEX] - py);
      px = s.x[STRIKER_INDEX];
      py = s.y[STRIKER_INDEX];
      if (!s.alive[STRIKER_INDEX]) break;
    }
    return d;
  };
  const weakest = travel(0);
  const hardest = travel(1);
  const reach = BASE_Y - (Math.max(...LAYOUT.map((l) => l.y)) + COIN_R);
  ok(weakest > 0.9 * (BASE_Y - CENTRE_R), `the weakest flick still reaches the rose (${weakest.toFixed(2)} units, needs ${reach.toFixed(2)})`);
  ok(hardest > 1.5 * HALF * 2 * 0.5, `the hardest crosses the board and comes back (${hardest.toFixed(2)} units)`);
  ok(hardest / Math.max(weakest, 1e-9) > 5, `and there is a real range between them (${(hardest / weakest).toFixed(1)}×)`);
}

// ---------------------------------------------------------------------------
head("rules — fouls, the queen, and clearing nine");
{
  /** Move every coin that this fixture does not care about into a tidy row
   *  along the near wall, BELOW the base line.
   *
   *  Parked rather than removed, and that is the point: a coin that is not on
   *  the board is a coin that has been POCKETED, so clearing the felt the
   *  obvious way hands both sides nine coins and wins the board before the
   *  fixture has taken a shot. Below the base line they are also out of every
   *  shot these tests take, and far enough from it that the striker still fits
   *  on the line. */
  function park(s: CarromState, keep: number[]): void {
    let k = 0;
    for (let i = 0; i < COIN_COUNT; i++) {
      if (keep.includes(i)) continue;
      s.x[i] = -0.86 + k * 0.085;
      s.y[i] = -(HALF - COIN_R);
      s.vx[i] = 0;
      s.vy[i] = 0;
      s.alive[i] = 1;
      k++;
    }
  }
  const coinOf = (kind: number, nth = 0): number => {
    let seen = 0;
    for (let i = 0; i < COIN_COUNT; i++) if (KIND[i] === kind && seen++ === nth) return i;
    return -1;
  };
  /** A board whose FIRST shot is seat 0's.
   *
   *  Who breaks is drawn from the seed (see createState), which is right for a
   *  game and useless for a fixture: every case below stands one of seat 0's
   *  own coins in front of a pocket and then shoots at it. */
  function fixture(seed: number, players: number): CarromState {
    const st = createState(seed, players);
    st.turn = 0;
    st.since = 0;
    st.deadline = TURN_TICKS;
    return st;
  }
  /** The ghost-ball shot that sends a coin at (cx, cy) into a pocket. The same
   *  arithmetic the bot does, without its wobble — so these fixtures are exact. */
  function ghost(fromT: number, cx: number, cy: number, pk: { x: number; y: number }, power: number) {
    const local = baseSpot(fromT);
    const w = toWorld(0, local.x, local.y);
    const ux = cx - pk.x;
    const uy = cy - pk.y;
    const ul = Math.hypot(ux, uy);
    const gx = cx + (ux / ul) * (COIN_R + STRIKER_R);
    const gy = cy + (uy / ul) * (COIN_R + STRIKER_R);
    const ax = gx - w.x;
    const ay = gy - w.y;
    const al = Math.hypot(ax, ay);
    return {
      t: Math.round(fromT * 1000),
      dx: Math.round((ax / al) * 1000),
      dy: Math.max(1, Math.round((ay / al) * 1000)),
      p: power,
    };
  }
  /** Play a shot out to its beat. */
  function fire(s: CarromState, p: { t: number; dx: number; dy: number; p: number }): CarromState {
    applyInput(s, s.turn, shotKind(p.t, p.dx, p.dy, p.p));
    let guard = 0;
    while (s.phase === "shoot" && guard++ < 60 * TICK_RATE) step(s, DURATION_TICKS);
    return s;
  }
  /** A coin parked in the open, where a clean ghost-ball shot reaches it. */
  const OPEN = { x: -0.35, y: 0.45 };
  const CORNER = POCKETS[1]; // top-left

  // A shot that touches nothing at all is a foul.
  {
    const s = fixture(101, 2);
    park(s, []);
    fire(s, { t: 0, dx: 0, dy: 1000, p: 260 });
    ok(s.last?.foul === "miss", `a flick that touches nothing is a foul (${s.last?.foul})`);
    ok(s.fouls[0] === 1 && s.last?.again === false, "…and it costs the shooter the turn");
  }

  // The striker in a pocket is a foul, and it gives a coin back.
  {
    const s = fixture(102, 2);
    park(s, []);
    const sunk = coinOf(KIND_LIGHT, 0);
    s.alive[sunk] = 0; // one of ours already down, for the penalty to take
    const local = baseSpot(0);
    const w = toWorld(0, local.x, local.y);
    const ax = CORNER.x - w.x;
    const ay = CORNER.y - w.y;
    const al = Math.hypot(ax, ay);
    fire(s, { t: 0, dx: Math.round((ax / al) * 1000), dy: Math.max(1, Math.round((ay / al) * 1000)), p: 520 });
    ok(s.last?.foul === "striker", `the striker going down is a foul (${s.last?.foul})`);
    ok(s.alive[sunk] === 1, "…and one of the shooter's own coins comes back on");
    ok(teamPocketed(s, 0) === 0, "which really does take it off their count");
    ok(!s.last?.again, "a foul always ends the turn");
  }

  // Pocketing one of ours: it counts, and we shoot again.
  {
    const s = fixture(103, 2);
    const mine = coinOf(KIND_LIGHT, 0);
    park(s, [mine]);
    s.x[mine] = OPEN.x;
    s.y[mine] = OPEN.y;
    fire(s, ghost(0, OPEN.x, OPEN.y, CORNER, 430));
    ok(s.last?.own === 1 && !s.last.foul, `a clean pocket of our own (${JSON.stringify(s.last)})`);
    ok(teamPocketed(s, 0) === 1 && s.coinsBy[0] === 1, "it counts for the side AND for the person");
    ok(s.last?.again === true, "…and earns another shot");
  }

  // Pocketing one of THEIRS: it counts for them, and the turn passes.
  {
    const s = fixture(104, 2);
    const theirs = coinOf(KIND_DARK, 0);
    park(s, [theirs]);
    s.x[theirs] = OPEN.x;
    s.y[theirs] = OPEN.y;
    fire(s, ghost(0, OPEN.x, OPEN.y, CORNER, 430));
    ok(s.last?.opp === 1 && !s.last.foul, "giving one away is not a foul");
    ok(teamPocketed(s, 1) === 1 && s.coinsBy[0] === 0, "…but it counts for the other side, and for nobody personally");
    ok(s.last?.again === false, "and the turn passes");
  }

  // The queen may not be taken before one of ours is down.
  {
    const s = fixture(105, 2);
    park(s, [QUEEN_INDEX]);
    s.x[QUEEN_INDEX] = OPEN.x;
    s.y[QUEEN_INDEX] = OPEN.y;
    ok(!queenAllowed(s, 0), "with nothing of ours down, the queen is not ours to take");
    fire(s, ghost(0, OPEN.x, OPEN.y, CORNER, 430));
    ok(s.last?.queenReturned === true, `the queen taken too early comes straight back (${JSON.stringify(s.last)})`);
    ok(s.alive[QUEEN_INDEX] === 1 && s.x[QUEEN_INDEX] === 0 && s.y[QUEEN_INDEX] === 0, "…onto the centre spot");
    ok(s.queenBy === -1 && s.queenPending === -1, "and nobody has her");
  }

  // Taken legally, she has to be COVERED on the next shot.
  {
    const s = fixture(106, 2);
    park(s, [QUEEN_INDEX]);
    s.x[QUEEN_INDEX] = OPEN.x;
    s.y[QUEEN_INDEX] = OPEN.y;
    s.alive[coinOf(KIND_LIGHT, 0)] = 0; // one of ours down
    ok(queenAllowed(s, 0), "with one of ours down, she is fair game");
    fire(s, ghost(0, OPEN.x, OPEN.y, CORNER, 430));
    ok(s.last?.queen === true && s.last.again === true, "taking the queen earns another shot");
    ok(s.queenPending === 0 && s.queenBy === -1, "…and leaves a cover owed");
    // The cover is missed: she goes back.
    let guard = 0;
    while (s.phase === "beat" && guard++ < 200) step(s, DURATION_TICKS);
    ok(s.turn === 0 && s.phase === "aim", "the same seat shoots again");
    fire(s, { t: 0, dx: 0, dy: 1000, p: 260 });
    ok(s.alive[QUEEN_INDEX] === 1 && s.queenBy === -1, "a missed cover puts the queen back on the board");
    ok(s.queenPending === -1, "…and the debt is settled either way");
  }

  // Covered on the shot that follows: she is yours, and she stays down.
  {
    const s = fixture(107, 2);
    const mine = coinOf(KIND_LIGHT, 1);
    park(s, [QUEEN_INDEX, mine]);
    s.x[QUEEN_INDEX] = OPEN.x;
    s.y[QUEEN_INDEX] = OPEN.y;
    // A second coin of ours, on the other side, for the cover.
    s.x[mine] = 0.35;
    s.y[mine] = 0.45;
    s.alive[coinOf(KIND_LIGHT, 0)] = 0;
    fire(s, ghost(0, OPEN.x, OPEN.y, CORNER, 430));
    ok(s.queenPending === 0, "the queen is down and a cover is owed");
    let guard = 0;
    while (s.phase === "beat" && guard++ < 200) step(s, DURATION_TICKS);
    fire(s, ghost(0, s.x[mine], s.y[mine], POCKETS[2], 430));
    ok(s.queenBy === 0 && s.queenPending === -1, `covering her on the next shot makes her yours (queenBy ${s.queenBy})`);
    ok(s.alive[QUEEN_INDEX] === 0, "…and she stays off the board");
  }

  // Clearing nine wins the board.
  {
    const s = fixture(108, 2);
    const last = coinOf(KIND_LIGHT, 0);
    park(s, [last]);
    for (let n = 1; n < COINS_PER_TEAM; n++) s.alive[coinOf(KIND_LIGHT, n)] = 0;
    s.x[last] = OPEN.x;
    s.y[last] = OPEN.y;
    ok(teamPocketed(s, 0) === COINS_PER_TEAM - 1, "eight of nine are down");
    fire(s, ghost(0, OPEN.x, OPEN.y, CORNER, 430));
    ok(s.decided && s.winner === 0, `clearing the ninth wins the board (winner ${s.winner}, ${teamPocketed(s, 0)} down)`);
    ok(s.over && s.phase === "over" && s.decidedAt >= 0, "…and the board freezes at that tick");
    ok(isOut(s, 0) && isOut(s, 1), "everyone is out once it is decided");
  }

  // Out of clock is NOT out — the platform would call it "all-out" and announce
  // a winner where there was none.
  {
    const s = fixture(109, 2);
    let guard = 0;
    while (!s.over && guard++ < 200) step(s, 100);
    ok(s.over && !s.decided, "a board that ran out of clock is over but NOT decided");
    ok(!isOut(s, 0) && !isOut(s, 1), "…so nobody is reported out and the platform's clock ends it");
    ok(outcome(s) === -1, "level on coins is a draw, not an invented winner");
  }

  // A coin put back goes on the centre spot, or as near as there is room for.
  {
    const s = fixture(110, 2);
    s.alive[QUEEN_INDEX] = 0;
    const spot = freeSlot(s.x, s.y, s.alive);
    ok(spot.x === 0 && spot.y === 0, "with the centre spot empty, that is where a returned disc goes");
    s.alive[QUEEN_INDEX] = 1;
    // With the whole rose standing there is no room inside it at all, and the
    // search still has to answer — with a spot, never with a stack.
    const next = freeSlot(s.x, s.y, s.alive);
    let clear = true;
    let nearest = Infinity;
    for (let i = 0; i < COIN_COUNT; i++) {
      if (!s.alive[i]) continue;
      const d = Math.hypot(s.x[i] - next.x, s.y[i] - next.y);
      nearest = Math.min(nearest, d);
      if (d < COIN_R * 2 - 1e-9) clear = false;
    }
    ok(clear, `even with a full rose it finds room (nearest coin ${nearest.toFixed(4)} away, needs ${(COIN_R * 2).toFixed(4)})`);
    ok(Math.hypot(next.x, next.y) < HALF - COIN_R, "…and the spot it finds is on the board");
    const rose = Math.max(...LAYOUT.map((l) => Math.hypot(l.x, l.y)));
    ok(Math.hypot(next.x, next.y) > rose, `with no room inside the rose it goes just outside it (${Math.hypot(next.x, next.y).toFixed(3)} > ${rose.toFixed(3)})`);
    // And when there IS a gap, that gap is what it finds — not somewhere past
    // it. A returned coin belongs as near the middle as there is room for.
    const s2 = fixture(112, 2);
    s2.alive[3] = 0;
    const hole = freeSlot(s2.x, s2.y, s2.alive);
    ok(Math.abs(hole.x - LAYOUT[3].x) < 1e-12 && Math.abs(hole.y - LAYOUT[3].y) < 1e-12, "a gap in the ring is filled before anything further out");
  }

  // A BANK OFF YOUR OWN FRAME. The aim used to be forward-only, which meant a
  // coin sitting behind the base line could not be played at all. Now it can:
  // the striker goes back, bounces off the near wall and returns into play.
  {
    const s = fixture(113, 2);
    const mine = coinOf(KIND_LIGHT, 0);
    park(s, [mine]);
    // A coin of ours parked between the base line and the near wall.
    s.x[mine] = 0.30;
    s.y[mine] = -(HALF - COIN_R * 1.2);
    fire(s, { t: 0, dx: 380, dy: -925, p: 300 });
    ok(s.log.contact, "a flick aimed backwards still reaches a coin behind the base line");
    ok(s.last?.foul !== "miss", `…so it is a real shot, not a foul (${s.last?.foul || "clean"})`);
    let inside = true;
    for (let i = 0; i < COIN_COUNT; i++) {
      if (!s.alive[i]) continue;
      if (Math.abs(s.x[i]) > HALF - COIN_R + 1e-9 || Math.abs(s.y[i]) > HALF - COIN_R + 1e-9) inside = false;
    }
    ok(inside, "and everything is still on the board afterwards");
  }

  // A blocked base line moves the striker to the nearest place it fits.
  {
    const s = fixture(111, 2);
    const local = baseSpot(0);
    const w = toWorld(0, local.x, local.y);
    s.x[1] = w.x;
    s.y[1] = w.y;
    ok(!slotFree(0, 0, s.x, s.y, s.alive), "a coin on the base line blocks that placement");
    const moved = nearestFreeSlot(0, 0, s.x, s.y, s.alive);
    ok(moved !== 0 && slotFree(0, moved, s.x, s.y, s.alive), `…and the striker slides to the nearest free one (${moved.toFixed(3)})`);
    ok(Math.abs(moved) < 0.35, "which is genuinely near, not the end of the line");
  }
}

// ---------------------------------------------------------------------------
head("scoring — the score can never contradict the place beside it");
{
  ok(PLACE_POINTS[1] - PLACE_POINTS[2] > MAX_PERFORMANCE, `a place is worth more than any board (${PLACE_POINTS[1] - PLACE_POINTS[2]} > ${MAX_PERFORMANCE})`);
  const best = createState(1, 2);
  best.coinsBy[1] = COINS_PER_TEAM;
  best.queenBy = 1;
  const worst = createState(1, 2);
  ok(scoreOf(worst, 0, 1) > scoreOf(best, 1, 2), "the worst possible winner still outscores the best possible loser");
  ok(scoreOf(best, 1, 2) > scoreOf(worst, 1, 2), "…and among equals, the better board scores higher");
}

// ---------------------------------------------------------------------------
head("replay parity — one board, however the inputs arrive");
{
  /** Play a board with the bot policy and keep every input. */
  function playOut(seed: number, players: number, skill = 0.6, lag = 0) {
    const rand = rng(seed * 31 + 7);
    const sim = new CarromSim(seed, players, DURATION_TICKS);
    const log: CarromInput[] = [];
    let answered = "";
    let thinkKey = "";
    let thinkAt = 0;
    let tick = 1;
    for (; tick <= DURATION_TICKS; tick++) {
      sim.advanceTo(tick);
      const s = sim.state;
      if (s.over) break;
      if (!awaitingServer(s)) continue;
      const key = `${s.turn}:${s.since}`;
      if (answered === key) continue;
      if (thinkKey !== key) {
        thinkKey = key;
        thinkAt = tick + lag + thinkTicks(TICK_RATE, rand);
      }
      if (tick < thinkAt) continue;
      answered = key;
      const p = chooseShot(s, s.turn, skill, rand);
      const input: CarromInput = { tick: tick + 12, seat: s.turn, kind: shotKind(p.t, p.dx, p.dy, p.p) };
      log.push(input);
      sim.addInput(input);
    }
    return { sim, log, endTick: Math.min(tick, DURATION_TICKS) };
  }

  const { sim, log, endTick } = playOut(31337, 4);
  ok(log.length > 20, `a four-handed board produced ${log.length} shots`);
  const cold = replay(31337, 4, log, endTick, DURATION_TICKS);
  ok(fingerprint(cold) === fingerprint(sim.state), "a cold replay of the log lands on the live board, bit for bit");

  const rand = rng(5);
  const scrambled = log.slice().sort(() => rand() - 0.5);
  const shuffled = replay(31337, 4, scrambled, endTick, DURATION_TICKS);
  ok(fingerprint(shuffled) === fingerprint(cold), "the same inputs in a scrambled order give the same board");

  // Every input arriving LATE, which is what a rewind actually is.
  const LAG = 40;
  const late = new CarromSim(31337, 4, DURATION_TICKS);
  let cursor = 0;
  const sorted = log.slice().sort((a, b) => a.tick - b.tick);
  for (let t = 1; t <= endTick; t++) {
    while (cursor < sorted.length && sorted[cursor].tick + LAG <= t) late.addInput(sorted[cursor++]);
    late.advanceTo(t);
  }
  while (cursor < sorted.length) late.addInput(sorted[cursor++]);
  late.advanceTo(endTick);
  ok(fingerprint(late.state) === fingerprint(cold), `every input arriving ${LAG} ticks late converges on exactly the same board`);

  // THE KEYFRAME. A rewind that starts from the top of the current turn has to
  // produce the same board as one that starts from tick zero.
  const key = new CarromSim(31337, 4, DURATION_TICKS);
  cursor = 0;
  let rewinds = 0;
  for (let t = 1; t <= endTick; t++) {
    key.advanceTo(t);
    while (cursor < sorted.length && sorted[cursor].tick <= t) {
      // Deliver it a few ticks after its stamp, so the sim has to go back.
      key.addInput(sorted[cursor++]);
      rewinds++;
    }
  }
  key.advanceTo(endTick);
  ok(rewinds > 10, `${rewinds} inputs were delivered behind the play head`);
  ok(fingerprint(key.state) === fingerprint(cold), "…and the keyframe rewind agrees with the cold replay exactly");

  // Determinism across instances: the same log twice is the same board twice.
  const twice = replay(31337, 4, log, endTick, DURATION_TICKS);
  ok(fingerprint(twice) === fingerprint(cold), "replaying the same log twice gives the same board");

  // A partial replay is a prefix of the whole one.
  const mid = Math.floor(endTick / 2);
  const a = replay(31337, 4, log, mid, DURATION_TICKS);
  const b = cloneState(a);
  ok(fingerprint(a) === fingerprint(b), "a state clone is an exact copy");

  // ---- cost ------------------------------------------------------------
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) replay(31337, 4, log, endTick, DURATION_TICKS);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  ok(ms < 220, `one end-of-match replay takes ${ms.toFixed(1)} ms (${log.length} shots, ${endTick} ticks)`);

  // And the client's worst case: a rewind on a board an hour deep. The keyframe
  // is what makes this survivable — without it this is the whole match again.
  const deep = new CarromSim(31337, 4, DURATION_TICKS);
  for (const i of sorted) deep.addInput(i);
  deep.advanceTo(endTick);
  const t1 = process.hrtime.bigint();
  deep.addInput({ tick: endTick - 4, seat: 0, kind: NUDGE_KIND });
  deep.addInput({ tick: endTick - 4, seat: 0, kind: AWAY_KIND });
  deep.advanceTo(endTick);
  const rewindMs = Number(process.hrtime.bigint() - t1) / 1e6;
  ok(rewindMs < 16, `a late input at the end of a long board rewinds in ${rewindMs.toFixed(2)} ms — inside one frame`);
}

// ---------------------------------------------------------------------------
head("liveness — every board reaches a result, well inside the clock");
{
  function playFull(seed: number, players: number, skill: number, absent: number[] = []) {
    const rand = rng(seed * 977 + 3);
    const sim = new CarromSim(seed, players, DURATION_TICKS);
    for (const seat of absent) sim.addInput({ tick: 2, seat, kind: AWAY_KIND });
    let answered = "";
    let thinkKey = "";
    let thinkAt = 0;
    let tick = 1;
    for (; tick <= DURATION_TICKS; tick++) {
      sim.advanceTo(tick);
      const s = sim.state;
      if (s.over) break;
      if (!awaitingServer(s)) continue;
      const key = `${s.turn}:${s.since}`;
      if (answered === key) continue;
      // An away seat gets no thinking time at all — the server plays it at once,
      // which is the whole point of the flag.
      const away = s.away[s.turn];
      if (thinkKey !== key) {
        thinkKey = key;
        thinkAt = tick + (away ? 1 : thinkTicks(TICK_RATE, rand));
      }
      if (tick < thinkAt) continue;
      answered = key;
      const p = chooseShot(s, s.turn, away ? 0.45 : skill, rand);
      sim.addInput({ tick: tick + 12, seat: s.turn, kind: shotKind(p.t, p.dx, p.dy, p.p) });
    }
    return { s: sim.state, tick: Math.min(tick, DURATION_TICKS) };
  }

  for (const players of [2, 4]) {
    let decided = 0;
    let mins = 0;
    let worst = 0;
    const N = 40;
    for (let i = 0; i < N; i++) {
      const r = playFull(60000 + i * 17 + players, players, 0.5);
      if (r.s.decided) decided++;
      const m = r.tick / TICK_RATE / 60;
      mins += m;
      worst = Math.max(worst, m);
    }
    ok(decided === N, `${decided}/${N} ${players === 2 ? "singles" : "doubles"} boards reach a winner`);
    ok(worst < DURATION_SEC / 60, `and the slowest took ${worst.toFixed(1)} of ${(DURATION_SEC / 60).toFixed(0)} min (average ${(mins / N).toFixed(1)})`);
    ok(mins / N < TYPICAL_SEC / 60 + 4, `the advertised ${(TYPICAL_SEC / 60).toFixed(0)} min is honest (bots average ${(mins / N).toFixed(1)})`);
  }

  // Absent seats. One of them used to be enough to run any Ludo match out of
  // clock; here the same guard has to hold.
  let allDecided = true;
  let worstAbsent = 0;
  for (const absent of [[], [0], [0, 2], [0, 1, 2, 3]]) {
    for (let i = 0; i < 4; i++) {
      const r = playFull(80000 + i * 13 + absent.length, 4, 0.5, absent);
      if (!r.s.decided) allDecided = false;
      worstAbsent = Math.max(worstAbsent, r.tick / TICK_RATE / 60);
    }
  }
  ok(allDecided, "with none, one, two or all four seats absent, every board still reaches a winner");
  ok(worstAbsent < DURATION_SEC / 60, `and the slowest of those took ${worstAbsent.toFixed(1)} of ${(DURATION_SEC / 60).toFixed(0)} min`);

  // The away flag itself: the clock collapses the moment it lands, and one
  // touch gives it straight back.
  const s = createState(1, 4);
  s.turn = 0;
  s.since = 0;
  s.deadline = TURN_TICKS;
  ok(s.deadline === TURN_TICKS, "a present seat gets the whole turn clock");
  applyInput(s, 0, AWAY_KIND);
  ok(s.away[0] && s.deadline === s.since, "an away seat's clock collapses, mid-turn");
  applyInput(s, 0, BACK_KIND);
  ok(!s.away[0] && s.deadline === s.since + TURN_TICKS, "and one touch gives it straight back");
  ok(!isOut(s, 0), "an away seat is still in the running — unlike one that quit");

  // A whole side walking out ends the board for the other one.
  const q = createState(2, 4);
  applyInput(q, 0, QUIT_KIND);
  ok(!q.over, "one of a pair leaving does not end it — their partner plays on");
  applyInput(q, 1, QUIT_KIND);
  ok(q.decided && q.winner === 1, "both of a pair leaving hands the board to the other side");
}

// ---------------------------------------------------------------------------
head("fairness — neither colour wins more");
{
  function quick(seed: number, players: number) {
    const rand = rng(seed * 61 + 1);
    const sim = new CarromSim(seed, players, DURATION_TICKS);
    let answered = "";
    for (let tick = 1; tick <= DURATION_TICKS; tick++) {
      sim.advanceTo(tick);
      const s = sim.state;
      if (s.over) break;
      if (!awaitingServer(s)) continue;
      const key = `${s.turn}:${s.since}`;
      if (answered === key) continue;
      answered = key;
      const p = chooseShot(s, s.turn, 0.5, rand);
      sim.addInput({ tick: tick + 12, seat: s.turn, kind: shotKind(p.t, p.dx, p.dy, p.p) });
    }
    return outcome(sim.state);
  }
  for (const players of [2, 4]) {
    const N = 150;
    let lightWins = 0;
    let draws = 0;
    for (let i = 0; i < N; i++) {
      const w = quick(90000 + i * 7 + players, players);
      if (w === 0) lightWins++;
      else if (w < 0) draws++;
    }
    const share = lightWins / (N - draws);
    ok(share > 0.38 && share < 0.62, `${players === 2 ? "singles" : "doubles"}: light wins ${lightWins}/${N - draws} (${(share * 100).toFixed(0)}%)`);
  }
}

// ---------------------------------------------------------------------------
head("stall — the table turns even when the server has stopped answering");
{
  const sim = new CarromSim(24680, 4, DURATION_TICKS);
  // Long enough for several turns to play themselves: a stall is only broken
  // twenty seconds after a turn clock that was already fourteen.
  const endTick = 200 * TICK_RATE;
  sim.advanceTo(endTick);
  ok(sim.state.shots > 0, `with the server silent the table still turns (${sim.state.shots} shots in ${endTick / TICK_RATE} s)`);
  ok(sim.state.shots >= 3, `…and it keeps turning rather than stopping after one (${sim.state.shots})`);
  const other = new CarromSim(24680, 4, DURATION_TICKS);
  other.advanceTo(endTick);
  ok(fingerprint(other.state) === fingerprint(sim.state), "two tables break the same stall in exactly the same way");
  const a = stallShot(24680, 3);
  const b = stallShot(24680, 3);
  ok(a.t === b.t && a.dx === b.dx && a.dy === b.dy && a.p === b.p, "the stall flick is a pure function of the seed and the shot number");
  ok(a.dy > 0 && Math.abs(a.t) <= 1000 && a.p >= 0 && a.p <= 1000, "and it is a legal flick");
}

// ---------------------------------------------------------------------------
head("server definition — what the platform is handed");
{
  const game = getGame("carrom");
  ok(!!game, "the game registers itself on import");
  if (game) {
    ok(game.pack.bytes === 0, "and publishes no pack, so the lobby has nothing to download");
    ok(!game.planBot, "its bots are not planned up front");
    ok(!!game.serverInputs, "they react instead, through serverInputs");
    ok(game.matchSizeFor("duo") === 2 && game.matchSizeFor("squad") === 4 && game.matchSizeFor("solo") === 4, "duo is singles, squad and solo are doubles");
    ok(game.typicalSec !== undefined && game.typicalSec < game.durationTicks / game.tickRate, "the picker is told the typical length, not the ceiling");
    ok(!game.isValidInputKind(shotKind(0, 0, 1000, 500)), "a client may not write a shot");
    ok(game.isValidInputKind(askKind(0, 0, 1000, 500)), "…only ask for one");

    // Drive the real server definition through a whole board, exactly the way
    // the match runtime does: one sim per seat, serverInputs on a timer, every
    // answer relayed to every seat.
    const seed = 777001;
    const match = { id: "check-carrom-1", players: 4 };
    const views = [0, 1, 2, 3].map((seat) => ({ uid: `u${seat}`, seat, isBot: true, skill: 0.55, left: false }));
    const sims = views.map((v) => game.createSim(seed, v.seat, match));
    // A client's own table, fed the same relay every real client gets.
    const client = new CarromSim(seed, 4, game.durationTicks);
    const relayed: { uid: string; input: { tick: number; kind: string } }[] = [];
    let shots = 0;
    let tick = 1;
    for (; tick <= game.durationTicks; tick++) {
      for (const sm of sims) sm.advanceTo(tick);
      client.advanceTo(tick);
      if (client.state.over) break;
      // The platform asks a few times a second; asking every tick is harsher.
      for (const { uid, input } of game.serverInputs!(match, seed, tick, views)) {
        const seat = views.findIndex((v) => v.uid === uid);
        if (input.kind[0] === "s") shots++;
        relayed.push({ uid, input });
        sims[seat].addInput(input);
        client.addInput({ tick: input.tick, seat, kind: input.kind });
      }
    }
    ok(client.state.over, `the definition plays a whole board (${(Math.min(tick, game.durationTicks) / TICK_RATE / 60).toFixed(1)} min)`);
    ok(client.state.decided, `…and it is decided rather than timed out (winner ${client.state.winner})`);
    ok(shots === client.state.shots, `${shots} flicks authored for ${client.state.shots} shots — exactly one each`);
    ok(shots > 15, `and there were a real number of them (${shots})`);

    // Ranking, from the logs, the way the platform does it at the end.
    const members = views.map((v) => ({
      uid: v.uid,
      name: `P${v.seat}`,
      seat: v.seat,
      inputs: relayed.filter((r) => r.uid === v.uid).map((r) => ({ tick: r.input.tick, kind: r.input.kind })),
      left: false,
      leftAtTick: null,
      isBot: true,
    }));
    const standings = game.rank(members, Math.min(tick, game.durationTicks), seed);
    ok(standings.length === 4, "every seat gets a row");
    const firsts = standings.filter((x) => x.placement === 1);
    ok(firsts.length === 2, `the winning PAIR shares first place (${firsts.length})`);
    ok(new Set(firsts.map((x) => teamOf(members.find((m) => m.uid === x.uid)!.seat, 4))).size === 1, "…and they really are partners");
    ok(standings.every((x) => x.placement === 1 || x.placement === 2), "nobody comes third at carrom");
    const winner = firsts[0];
    const loser = standings.find((x) => x.placement === 2)!;
    ok(winner.score > loser.score, `the winning side outscores the losing one (${winner.score} > ${loser.score})`);
    ok(standings.every((x) => !x.forfeit), "nobody who stayed is marked as having walked out");

    // Leaving BEFORE the end is a forfeit; leaving after it is not.
    const decidedAt = client.state.decidedAt;
    const early = game.rank(
      members.map((m) => (m.seat === 3 ? { ...m, left: true, leftAtTick: Math.max(1, decidedAt - 200) } : m)),
      Math.min(tick, game.durationTicks),
      seed
    );
    ok(early.find((x) => x.uid === "u3")!.forfeit, "walking out mid-board is a forfeit");
    const late = game.rank(
      members.map((m) => (m.seat === 3 ? { ...m, left: true, leftAtTick: decidedAt + 5 } : m)),
      Math.min(tick, game.durationTicks),
      seed
    );
    ok(!late.find((x) => x.uid === "u3")!.forfeit, "…closing the tab once the board is decided is not");

    // An empty chair: said once, and only once, however often it is asked.
    const m2 = { id: "check-carrom-2", players: 4 };
    const s2 = [0, 1, 2, 3].map((seat) => ({ uid: `v${seat}`, seat, isBot: seat > 0, skill: 0.5, left: seat === 0 }));
    for (const v of s2) game.createSim(seed, v.seat, m2);
    let quits = 0;
    for (let t = 1; t <= 120; t++) {
      for (const { input } of game.serverInputs!(m2, seed, t, s2)) if (input.kind === QUIT_KIND) quits++;
    }
    ok(quits === 1, `a seat that walked out is announced exactly once (${quits})`);

    // A LIVE AIM IS NOT A REQUEST TO SHOOT. The server reads a request as
    // "flick now", so if an aim shared that channel the striker would go the
    // instant a thumb moved — which is the whole reason `m…` is its own kind.
    {
      const m4 = { id: "check-carrom-4", players: 4 };
      const v4 = [0, 1, 2, 3].map((seat) => ({ uid: `x${seat}`, seat, isBot: false, skill: 0, left: false }));
      const sims4 = v4.map((v) => game.createSim(seed, v.seat, m4));
      let tick = 1;
      for (; tick <= 20; tick++) {
        for (const sm of sims4) sm.advanceTo(tick);
        game.serverInputs!(m4, seed, tick, v4);
      }
      const holder = _tableTurn(m4.id);
      let shots = 0;
      for (let k = 0; k < 40; k++) {
        sims4[holder].addInput({ tick: tick + k, kind: aimKind(k * 20 - 400, 100, 900, 500) });
        for (const sm of sims4) sm.advanceTo(tick + k);
        for (const { input } of game.serverInputs!(m4, seed, tick + k, v4)) {
          if (parseInput(input.kind)?.type === "shot") shots++;
        }
      }
      ok(shots === 0, `forty live aims from the player holding the turn fired nothing (${shots})`);
      // …and the commit still works afterwards.
      sims4[holder].addInput({ tick: tick + 41, kind: askKind(0, 0, 1000, 600) });
      for (const sm of sims4) sm.advanceTo(tick + 41);
      let committed = 0;
      for (const { input } of game.serverInputs!(m4, seed, tick + 41, v4)) {
        if (parseInput(input.kind)?.type === "shot") committed++;
      }
      ok(committed === 1, `and the request that followed them fired exactly one shot (${committed})`);
    }

    // A BOT THAT NEVER APPEARS TO AIM IS A BOT ANYONE CAN SPOT.
    {
      const m5 = { id: "check-carrom-5", players: 2 };
      const v5 = [0, 1].map((seat) => ({ uid: `y${seat}`, seat, isBot: true, skill: 0.6, left: false }));
      const sims5 = v5.map((v) => game.createSim(seed, v.seat, m5));
      const heard: { tick: number; seat: number; type: string; kind: string }[] = [];
      for (let tick = 1; tick <= 30 * TICK_RATE; tick++) {
        for (const sm of sims5) sm.advanceTo(tick);
        for (const { uid, input } of game.serverInputs!(m5, seed, tick, v5)) {
          const seat = v5.findIndex((v) => v.uid === uid);
          sims5[seat].addInput(input);
          const type = parseInput(input.kind)?.type ?? "?";
          if (type === "aim" || type === "shot") heard.push({ tick, seat, type, kind: input.kind });
        }
        if (heard.filter((h) => h.type === "shot").length >= 4) break;
      }
      const aims = heard.filter((h) => h.type === "aim");
      const shots = heard.filter((h) => h.type === "shot");
      ok(aims.length >= shots.length, `bots show their working too (${aims.length} aims for ${shots.length} shots)`);

      // THE AIM A BOT ADVERTISES LAST IS THE SHOT IT TAKES. Showing one thing
      // and doing another would be a worse tell than showing nothing at all —
      // and it would make every studio replay a lie about what happened.
      let honest = 0;
      for (const shot of shots) {
        const before = aims.filter((a) => a.seat === shot.seat && a.tick <= shot.tick);
        if (before.length === 0) continue;
        const last = parseInput(before[before.length - 1].kind);
        const taken = parseInput(shot.kind);
        if (last?.type !== "aim" || taken?.type !== "shot") continue;
        if (
          last.shot.t === taken.shot.t &&
          last.shot.dx === taken.shot.dx &&
          last.shot.dy === taken.shot.dy &&
          last.shot.p === taken.shot.p
        ) {
          honest++;
        }
      }
      ok(honest === shots.length, `and every shot is the aim it last showed (${honest}/${shots.length})`);
      const rough = aims.filter((a, i) => i % 2 === 0);
      ok(rough.length > 0, "…with a rougher first idea before it, so it reads as adjusting");
    }

    // A silent human seat is declared away, and one touch brings it back.
    const m3 = { id: "check-carrom-3", players: 4 };
    const s3 = [0, 1, 2, 3].map((seat) => ({ uid: `w${seat}`, seat, isBot: seat > 0, skill: 0.5, left: false }));
    const sims3 = s3.map((v) => game.createSim(seed, v.seat, m3));
    const mirror = new CarromSim(seed, 4, game.durationTicks);
    let aways = 0;
    let backs = 0;
    let nudgedAt = 0;
    let cameBack = false;
    for (let t = 1; t <= 200 * TICK_RATE; t++) {
      mirror.advanceTo(t);
      for (const sm of sims3) sm.advanceTo(t);
      if (mirror.state.over) break;
      if (mirror.state.away[0] && nudgedAt === 0) {
        nudgedAt = t;
        sims3[0].addInput({ tick: t + 1, kind: NUDGE_KIND });
      }
      if (nudgedAt > 0 && !mirror.state.away[0]) cameBack = true;
      for (const { uid, input } of game.serverInputs!(m3, seed, t, s3)) {
        const seat = s3.findIndex((v) => v.uid === uid);
        if (input.kind === AWAY_KIND) aways++;
        if (input.kind === BACK_KIND) backs++;
        sims3[seat].addInput(input);
        mirror.addInput({ tick: input.tick, seat, kind: input.kind });
      }
    }
    ok(aways >= 1, `a silent seat is declared away (${aways}×)`);
    ok(nudgedAt > 0, "…and the table stopped waiting for it");
    ok(backs === 1, `its one touch is answered with exactly one "back" (${backs})`);
    ok(cameBack, "and the board really did give it the clock again");
  }
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
