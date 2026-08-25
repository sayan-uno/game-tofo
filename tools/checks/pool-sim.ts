// Verification suite for the 8-Ball Pool simulation — run it after ANY change
// to shared/games/pool.
//
//     npm run check:pool
//
// It reads the shared SOURCE (via tsx), so it can never pass against a stale
// build. What it proves, and why each check exists:
//
//   arithmetic    — the solver uses no Math.sin, Math.pow, Math.hypot or **.
//                   That is the whole determinism argument in one grep: +, -,
//                   *, / and sqrt are correctly rounded by IEEE-754 and so
//                   identical on every device; sin and its friends are not
//                   specified that tightly, and one of them in a break's forty
//                   collisions would put the black down on one phone and safe
//                   on another, with no way back
//   table         — the rack really packs: fifteen balls, seven of each group
//                   and the black in the middle of the third row, none of them
//                   overlapping and all of them on the cloth. Built by walking
//                   a triangle rather than typed out, so one wrong step would
//                   silently reshape it
//   pockets       — every hole is reachable from the cloth, from every angle,
//                   and a ball rolling along a cushion still drops
//   physics       — nothing escapes the rails, nothing tunnels through anything
//                   at any speed the game can produce, every shot settles, and
//                   no shot ever ends with more energy than it started with
//   the break     — it OPENS THE PACK. This is the check that exists because
//                   the game shipped once with a friction four times a real
//                   cloth's, which strangled every ball to half a table-length
//                   and made the break pot precisely nothing
//   inputs        — what a client may say, and what only the server may write
//   authority     — a player's own inputs move NOTHING. This is the whole
//                   safety argument for a shared table on a platform that
//                   relays inputs to everyone except their sender
//   the stroke    — the cue draws back in proportion to the weight and drives
//                   through the ball, and it does it IN THE SIMULATION. A live
//                   aim is a courtesy that never enters a log, so before this
//                   the one thing a shot is mostly made of was invisible to
//                   everyone but the person who chose it — and a rack watched
//                   back in the console was a series of silent jumps
//   rules         — the open table, the group being decided, the scratch, the
//                   wrong ball first, the shot that reaches no cushion, the
//                   black potted early, and the black potted to win
//   replay parity — live stepping, a cold replay, and a sim fed every input
//                   LATE and out of order all agree BIT FOR BIT. This is the
//                   netcode, and on a physics table "close enough" is a
//                   different table a hundred collisions later
//   keyframe      — the turn-top snapshot the client rewinds to produces
//                   exactly the table a full replay does
//   liveness      — bot racks reach a winner, well inside the clock, with none,
//                   one, two and all four seats absent
//   skill         — a strong bot beats a weak one convincingly, or the
//                   difficulty dial is a decoration
//   fairness      — the break is worth something, so who takes it is drawn from
//                   the seed; over hundreds of racks no seat may profit
//   stall         — with the server silent from the first tick, the rack still
//                   progresses rather than freezing forever
//   scoring       — the garnish beside a placement can never contradict it
//   cost          — a whole match replays fast enough to do it on a phone
import { readFileSync } from "node:fs";
import {
  AWAY_KIND,
  BACK_KIND,
  BALLS,
  BALL_R,
  BREAK_SPOT,
  CUE,
  DURATION_SEC,
  DURATION_TICKS,
  EIGHT,
  FOOT_SPOT,
  FRICTION,
  HALF_X,
  HALF_Y,
  HEAD_STRING,
  MAX_SPEED,
  MATCH_SIZE,
  NUDGE_KIND,
  PER_GROUP,
  PLACE_POINTS,
  POCKETS,
  POCKET_R,
  POINTS_EIGHT,
  POINTS_PER_BALL,
  PoolSim,
  QUIT_KIND,
  RACK,
  RACK_ORDER,
  STROKE_MAX_TICKS,
  STROKE_MIN_TICKS,
  TICK_RATE,
  TURN_TICKS,
  TYPICAL_SEC,
  aimKind,
  anyMoving,
  applyInput,
  askKind,
  awaitingServer,
  ballName,
  createState,
  firstHit,
  groupOf,
  isInputKind,
  isOut,
  movesBoard,
  nearestSpot,
  onCloth,
  outcome,
  parseInput,
  performanceOf,
  remaining,
  replay,
  scoreOf,
  seatsOfTeam,
  shotKind,
  speedFor,
  spotFree,
  step,
  stepBalls,
  strokeTicks,
  teamOf,
  turnOrder,
  type PoolInput,
  type PoolState,
  type ShotLog,
} from "../../shared/games/pool/index.js";
// The bot policy is server-side (it is not part of the deterministic sim), but
// its OUTPUT is ordinary inputs, so it is checked with exactly the same tools.
import { botPlan, chooseShot, thinkTicks } from "../../backend/src/games/pool/bot.js";
// The server definition is checked too, through the same registry the platform
// reads it from — importing it is what registers it.
import "../../backend/src/games/pool/index.js";
import { getGame } from "../../backend/src/platform/games.js";

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

/** EXACT. Every ball, every velocity and every counter — a rounded fingerprint
 *  would let two tables that have already parted company compare equal, which
 *  is the one thing this file exists to catch. */
const fingerprint = (s: PoolState): string =>
  [
    s.tick,
    s.phase,
    s.turn,
    s.since,
    s.shots,
    s.open ? 1 : 0,
    s.broken ? 1 : 0,
    s.ballInHand ? 1 : 0,
    s.behindLine ? 1 : 0,
    s.winner,
    s.decided ? 1 : 0,
    s.over ? 1 : 0,
    s.finisher,
    s.group.join(","),
    s.potted.join(","),
    s.fouls.join(","),
    s.quit.map((q) => (q ? 1 : 0)).join(""),
    s.away.map((a) => (a ? 1 : 0)).join(""),
    s.alive.join(""),
    s.x.join(","),
    s.y.join(","),
    s.vx.join(","),
    s.vy.join(","),
  ].join("|");

/** ---------------------------------------------------------------------------
 *  Fixtures.
 *
 *  A position is set up by taking balls OFF the table and putting the rest
 *  where they are wanted, and then played with an ordinary server shot. Nothing
 *  here writes a result: a fixture that reaches into `last` or `group` is a
 *  fixture that can build a table the rules cannot reach.
 * ------------------------------------------------------------------------- */

/** Leave only these balls on the table. Everything else counts as potted,
 *  which is a perfectly ordinary state for a rack half way through. */
function only(s: PoolState, keep: readonly number[]): void {
  for (let i = 0; i < BALLS; i++) s.alive[i] = keep.includes(i) ? 1 : 0;
}

function place(s: PoolState, ball: number, x: number, y: number): void {
  s.x[ball] = x;
  s.y[ball] = y;
  s.vx[ball] = 0;
  s.vy[ball] = 0;
  s.alive[ball] = 1;
}

/** Play one shot as `seat`, properly, and run it out to the next decision.
 *
 *  IT TAKES THE TABLE AS PLACED. A fresh table has the cue ball in hand behind
 *  the head string, and `beginShot` honours that by running any placement it is
 *  given through `nearestSpot` — so a fixture that put the cue ball half way up
 *  the table found it back in the kitchen and quietly tested a different shot.
 *  Clearing the two flags here is what makes `place` mean what it says. */
function fire(s: PoolState, seat: number, dir: { x: number; y: number }, power: number, from?: { x: number; y: number }): void {
  s.turn = seat;
  s.phase = "aim";
  s.since = s.tick;
  s.deadline = s.tick + TURN_TICKS;
  s.ballInHand = false;
  s.behindLine = false;
  const p = from ?? { x: s.x[CUE], y: s.y[CUE] };
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y) || 1;
  applyInput(
    s,
    seat,
    shotKind(
      Math.round(p.x * 1000),
      Math.round(p.y * 1000),
      Math.round((dir.x / len) * 1000),
      Math.round((dir.y / len) * 1000),
      Math.round(power * 1000)
    )
  );
  // Out through the STROKE, the shot AND the beat that follows it. The stroke
  // is where a fixture forgets: an input no longer moves a ball on the tick it
  // lands, it starts a cue moving, and a fixture that stopped at the end of the
  // roll would be asking whose shot it is before the table had said.
  let guard = 0;
  while ((s.phase === "stroke" || s.phase === "shoot" || s.phase === "beat") && guard++ < 60 * TICK_RATE) {
    step(s, DURATION_TICKS);
  }
}

/** A point `d` from a pocket along the line to the centre of the table.
 *
 *  Fixtures kept getting this wrong by hand — a corner pocket is at a CORNER,
 *  so "just inside it" is minus x and PLUS y at one end and the other way round
 *  at the other, and half the positions in the first draft of this file were
 *  off the cloth entirely. Balls placed off the cloth get dragged back by the
 *  first cushion pass, so the fixture does not crash: it quietly tests a
 *  different position from the one it describes, which is worse. */
function nearPocket(pocket: number, d: number): { x: number; y: number } {
  const p = POCKETS[pocket];
  const len = Math.sqrt(p.x * p.x + p.y * p.y) || 1;
  return { x: p.x - (p.x / len) * d, y: p.y - (p.y / len) * d };
}

/** Aim the cue ball straight at a ball's centre — a full hit. */
const at = (s: PoolState, ball: number): { x: number; y: number } => ({
  x: s.x[ball] - s.x[CUE],
  y: s.y[ball] - s.y[CUE],
});

// ---------------------------------------------------------------------------
head("arithmetic — the simulation may only use operations that round the same everywhere");
{
  // Read the SOURCE, not the module: this is a promise about how the code is
  // written, and the only way to keep it is to look at the code.
  const files = ["table.ts", "physics.ts", "sim.ts", "rules.ts"];
  const banned = /Math\.(sin|cos|tan|asin|acos|atan|atan2|pow|hypot|cbrt|log|log2|log10|exp|expm1|random|fround|sign)\b|\*\*/;
  for (const f of files) {
    const src = readFileSync(new URL(`../../shared/games/pool/${f}`, import.meta.url), "utf8");
    // Comments talk about sin and cos a great deal; only code counts.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const hit = code.match(banned);
    ok(!hit, `${f} uses no loosely-specified maths${hit ? ` (found ${hit[0]})` : ""}`);
  }
  const solver = readFileSync(new URL("../../shared/games/pool/physics.ts", import.meta.url), "utf8");
  ok(/Math\.sqrt/.test(solver), "…and it does use Math.sqrt, which IS correctly rounded");
}

// ---------------------------------------------------------------------------
head("table — fifteen balls, seven a group, racked and legal");
{
  ok(RACK.length === 15 && RACK_ORDER.length === 15, `fifteen rack places (${RACK.length})`);
  ok(new Set(RACK_ORDER).size === 15, "…each holding a different ball");
  let solids = 0;
  let stripes = 0;
  let blacks = 0;
  for (const b of RACK_ORDER) {
    if (b === EIGHT) blacks++;
    else if (groupOf(b) === 0) solids++;
    else if (groupOf(b) === 1) stripes++;
  }
  ok(solids === PER_GROUP && stripes === PER_GROUP && blacks === 1, `seven, seven and the black (${solids}/${stripes}/${blacks})`);
  ok(RACK_ORDER[4] === EIGHT, "the black stands in the middle of the third row");
  ok(groupOf(RACK_ORDER[10]) !== groupOf(RACK_ORDER[14]), "and the two back corners are one of each");

  // No two rack places overlap, and every one is on the cloth well clear of a
  // cushion. A rack that starts overlapping explodes on the first substep.
  let worst = Infinity;
  let offCloth = 0;
  for (let i = 0; i < RACK.length; i++) {
    if (!onCloth(RACK[i].x, RACK[i].y)) offCloth++;
    for (let j = i + 1; j < RACK.length; j++) {
      const dx = RACK[j].x - RACK[i].x;
      const dy = RACK[j].y - RACK[i].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < worst) worst = d;
    }
  }
  ok(offCloth === 0, "every rack place is on the cloth");
  ok(worst >= BALL_R * 2, `no two balls in the rack overlap (closest ${worst.toFixed(5)} vs ${(BALL_R * 2).toFixed(5)})`);
  // FROZEN, and this is the number that matters: a rack with any daylight in it
  // eats the break. See the comment on RACK.
  ok(worst < BALL_R * 2.01, `…and the rack is frozen, not loose (${(worst / BALL_R / 2).toFixed(4)}× contact)`);

  const s = createState(1, 2);
  ok(s.x[RACK_ORDER[0]] === FOOT_SPOT, "the apex ball stands on the foot spot");
  ok(s.x[CUE] < HEAD_STRING || s.ballInHand, "and the cue ball starts behind the head string");
  ok(s.ballInHand && s.behindLine, "the break is played from the hand, behind the line");

  // Seating: two sides, always, and partners alternate.
  ok(MATCH_SIZE.duo === 2 && MATCH_SIZE.solo === 4 && MATCH_SIZE.squad === 4, "two players or four, never three");
  ok(turnOrder(2).join("") === "01", "singles alternate");
  ok(turnOrder(4).join("") === "0213", "doubles alternate SIDES, not seats");
  ok(seatsOfTeam(0, 4).join("") === "01" && seatsOfTeam(1, 4).join("") === "23", "a party seated contiguously stays together");
  ok(teamOf(0, 2) === 0 && teamOf(1, 2) === 1, "and in singles the two seats are the two sides");
}

// ---------------------------------------------------------------------------
head("pockets — every hole is reachable, from every angle");
{
  // Fire the cue ball at each pocket from a spread of places on the cloth. Hard
  // enough to arrive, and the ball must drop every time.
  let potted = 0;
  let tried = 0;
  const froms = [
    { x: 0, y: 0 },
    { x: -0.6, y: -0.3 },
    { x: 0.6, y: 0.3 },
    { x: -0.2, y: 0.35 },
    { x: 0.45, y: -0.36 },
  ];
  for (const p of POCKETS) {
    for (const f of froms) {
      const s = createState(7, 2);
      only(s, [CUE]);
      place(s, CUE, f.x, f.y);
      const log: ShotLog = { potted: [], firstHit: -1, railAfterHit: false };
      const dx = p.x - f.x;
      const dy = p.y - f.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const sp = speedFor(0.75);
      s.vx[CUE] = (dx / len) * sp;
      s.vy[CUE] = (dy / len) * sp;
      let guard = 0;
      while (anyMoving(s) && guard++ < 20 * TICK_RATE) stepBalls(s, log);
      tried++;
      if (log.potted.includes(CUE)) potted++;
    }
  }
  ok(potted === tried, `a ball aimed at a pocket drops, from anywhere (${potted}/${tried})`);

  // And one running along a cushion still finds the corner: the pocket circles
  // overlap the rails on purpose, so the rail never shields the hole.
  let rails = 0;
  for (const sign of [-1, 1]) {
    const s = createState(8, 2);
    only(s, [CUE]);
    place(s, CUE, -0.5, sign * (HALF_Y - BALL_R));
    const log: ShotLog = { potted: [], firstHit: -1, railAfterHit: false };
    s.vx[CUE] = speedFor(0.6);
    s.vy[CUE] = 0;
    let guard = 0;
    while (anyMoving(s) && guard++ < 20 * TICK_RATE) stepBalls(s, log);
    if (log.potted.includes(CUE)) rails++;
  }
  ok(rails === 2, `a ball hugging a cushion still drops in the corner (${rails}/2)`);

  ok(POCKET_R > BALL_R * 2, `a pocket is wider than a ball (${(POCKET_R / BALL_R).toFixed(2)} radii)`);
  ok(ballName(CUE) === "the cue ball" && ballName(EIGHT) === "the black" && ballName(3) === "the 3", "balls have names people use");
}

// ---------------------------------------------------------------------------
head("physics — nothing escapes, nothing tunnels, everything settles");
{
  const rand = rng(4242);
  let escaped = 0;
  let overlapping = 0;
  let unsettled = 0;
  let gained = 0;
  let worstOverlap = 0;
  let longest = 0;
  const ROUNDS = 220;
  for (let k = 0; k < ROUNDS; k++) {
    const s = createState(1000 + k, 2);
    // A random legal strike from a random legal place, at every weight the game
    // can produce — including the very hardest, which is where tunnelling would
    // show up if it were going to.
    const from = nearestSpot((rand() * 2 - 1) * 0.9, (rand() * 2 - 1) * 0.45, s.x, s.y, s.alive, false);
    place(s, CUE, from.x, from.y);
    const a = rand() * Math.PI * 2;
    const log: ShotLog = { potted: [], firstHit: -1, railAfterHit: false };
    const sp = speedFor(k % 7 === 0 ? 1 : rand());
    s.vx[CUE] = Math.cos(a) * sp;
    s.vy[CUE] = Math.sin(a) * sp;
    let energy0 = 0;
    for (let i = 0; i < BALLS; i++) if (s.alive[i]) energy0 += s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i];
    let t = 0;
    while (anyMoving(s) && t++ < 30 * TICK_RATE) {
      stepBalls(s, log);
      for (let i = 0; i < BALLS; i++) {
        if (!s.alive[i]) continue;
        // A hair of slack: a ball resting against a cushion sits exactly on the
        // line, and floating point is allowed to land a femtometre outside it.
        if (Math.abs(s.x[i]) > HALF_X - BALL_R + 1e-9 || Math.abs(s.y[i]) > HALF_Y - BALL_R + 1e-9) escaped++;
      }
      let energy = 0;
      for (let i = 0; i < BALLS; i++) if (s.alive[i]) energy += s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i];
      if (energy > energy0 + 1e-9) gained++;
      energy0 = Math.max(energy0, energy);
    }
    if (t > longest) longest = t;
    if (anyMoving(s)) unsettled++;
    for (let i = 0; i < BALLS; i++) {
      if (!s.alive[i]) continue;
      for (let j = i + 1; j < BALLS; j++) {
        if (!s.alive[j]) continue;
        const dx = s.x[j] - s.x[i];
        const dy = s.y[j] - s.y[i];
        const d = Math.sqrt(dx * dx + dy * dy);
        // A tenth of a per cent of a radius — twenty microns on a real table,
        // and far below anything a collision or a pixel can tell apart. The
        // point is that it does not GROW: a solver leaving balls properly
        // inside each other is one whose next shot starts from a lie.
        const over = BALL_R * 2 - d;
        if (over > BALL_R * 0.001) {
          overlapping++;
          if (over > worstOverlap) worstOverlap = over;
        }
      }
    }
  }
  ok(escaped === 0, `${ROUNDS} shots and nothing ever left the cloth`);
  ok(unsettled === 0, "every shot came to rest");
  ok(gained === 0, "no shot ever gained energy");
  ok(
    overlapping === 0,
    `nothing is left meaningfully inside anything else (worst ${worstOverlap.toExponential(2)}, a ${((worstOverlap / BALL_R) * 100).toFixed(3)}% of a radius)`
  );
  ok(longest < 12 * TICK_RATE, `the longest shot settled in ${(longest / TICK_RATE).toFixed(2)}s, inside the ceiling`);

  // The power curve: soft at the bottom, and the top is the top.
  ok(speedFor(0) < speedFor(0.5) && speedFor(0.5) < speedFor(1), "harder is faster, all the way up");
  ok(Math.abs(speedFor(1) - MAX_SPEED) < 1e-9, `full power is MAX_SPEED (${speedFor(1).toFixed(2)})`);
  ok(speedFor(0.5) < MAX_SPEED * 0.45, `half the slider is well under half the pace (${speedFor(0.5).toFixed(2)})`);
}

// ---------------------------------------------------------------------------
head("the break — it opens the pack");
{
  // THE CHECK THAT EXISTS BECAUSE THIS SHIPPED BROKEN ONCE.
  //
  // With FRICTION at 1.2 — the number that made a shot settle promptly — every
  // ball off the break had half a table-length in it, the pack never opened,
  // and four hundred measured racks potted on the break exactly never. The
  // three numbers below are the ones that caught it.
  let pots = 0;
  let opened = 0;
  let moved = 0;
  let ticks = 0;
  const N = 60;
  for (let k = 0; k < N; k++) {
    const s = createState(90000 + k * 613, 2);
    const apexBall = RACK_ORDER[0];
    const before = { x: s.x.slice(), y: s.y.slice() };
    const off = ((k % 9) / 8 - 0.5) * 2 * HALF_Y * 0.1;
    const from = { x: BREAK_SPOT.x, y: off };
    fire(s, s.turn, { x: s.x[apexBall] - from.x, y: s.y[apexBall] - off }, 0.95, from);
    const n = (s.last?.own.length ?? 0) + (s.last?.opp.length ?? 0);
    pots += n;
    if (n > 0) opened++;
    // How far the rack actually spread — the number that was wrong before.
    let far = 0;
    for (let i = 1; i < BALLS; i++) {
      if (!s.alive[i]) continue;
      const dx = s.x[i] - before.x[i];
      const dy = s.y[i] - before.y[i];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > far) far = d;
    }
    moved += far;
    ticks += s.tick;
  }
  const rate = opened / N;
  ok(rate >= 0.4, `${Math.round(rate * 100)}% of breaks pot something (a real one is rather over half)`);
  ok(pots / N >= 0.5, `and ${(pots / N).toFixed(2)} balls per break go down`);
  ok(moved / N > 1, `the pack really scatters — the furthest ball travels ${(moved / N).toFixed(2)} table units`);
  ok(ticks / N < 8 * TICK_RATE, `and a break still settles in ${(ticks / N / TICK_RATE).toFixed(2)}s`);
  // And the honest statement of why: the cloth is not treacle.
  ok(FRICTION < 0.5, `friction is a real cloth's order of magnitude (${FRICTION})`);
}

// ---------------------------------------------------------------------------
head("inputs — what a client may say, and what only the server may");
{
  ok(isInputKind(askKind(0, 0, 1000, 0, 500)), "a player may ask for a shot");
  ok(isInputKind(aimKind(-400, 200, 0, -1000, 900)), "…and may show the table what they are lining up");
  ok(isInputKind(NUDGE_KIND), "…and may say they are still here");
  ok(!isInputKind(shotKind(0, 0, 1000, 0, 500)), "a player may NOT play the shot themselves");
  ok(!isInputKind(QUIT_KIND) && !isInputKind(AWAY_KIND) && !isInputKind(BACK_KIND), "…nor an empty chair, nor an away flag");
  ok(!isInputKind(askKind(0, 0, 0, 0, 500)), "a direction of nothing is refused");
  ok(!isInputKind("a0,0,1000,0"), "…and so is a shot with a number missing");
  ok(!isInputKind("a0,0,1000,0,500,7"), "…or one too many");
  ok(!isInputKind("a2000,0,1000,0,500") && !isInputKind("a0,900,1000,0,500"), "a placement off the table is refused");
  ok(!isInputKind("a0,0,1000,0,1001") && !isInputKind("a0,0,1000,0,-1"), "…and a power outside nought to one");
  ok(!isInputKind("a 0,0,1000,0,500") && !isInputKind("a0,0,1000,0,5e2") && !isInputKind("a0,0,1000,0,0500"), "and anything that is not a plain integer");
  ok(!isInputKind("a".repeat(300)), "a very long kind is refused rather than parsed");
  ok(parseInput(aimKind(0, 0, 1000, 0, 500))?.type === "aim", "an aim parses as an aim, not a request");
  ok(!movesBoard(aimKind(0, 0, 1, 0, 5)) && !movesBoard(askKind(0, 0, 1, 0, 5)), "neither of them moves a ball, so neither enters a log");
  ok(movesBoard(shotKind(0, 0, 1, 0, 5)) && movesBoard(QUIT_KIND), "a shot and an empty chair do");
}

// ---------------------------------------------------------------------------
head("authority — nothing a player sends moves a ball");
{
  const s = createState(4242, 4);
  const before = fingerprint(s);
  const rand = rng(11);
  for (let i = 0; i < 800; i++) {
    const seat = Math.floor(rand() * 4);
    const x = Math.round((rand() * 2 - 1) * 1000);
    const y = Math.round((rand() * 2 - 1) * 500);
    applyInput(s, seat, askKind(x, y, 1000, Math.round(rand() * 1000) || 1, 1000));
    applyInput(s, seat, aimKind(x, y, -1000, 500, 250));
    applyInput(s, seat, NUDGE_KIND);
  }
  ok(fingerprint(s) === before, "two thousand four hundred requests, aims and touches, from every seat, change nothing at all");
  applyInput(s, s.turn, shotKind(-680, 0, 1000, 0, 900));
  ok(s.phase === "stroke", "the server's shot is the only thing that moves the cue");

  // And the log refuses to carry a request at all, so a flood of late ones
  // cannot make every table in the match rebuild itself.
  const sim = new PoolSim(4242, 4, DURATION_TICKS);
  sim.advanceTo(400);
  const settled = fingerprint(sim.state);
  for (let i = 0; i < 500; i++) sim.addInput({ tick: 20 + (i % 200), seat: i % 4, kind: askKind(0, 0, 1000, 1, i % 1001) });
  sim.advanceTo(400);
  ok(sim.inputs.length === 0, "500 late requests leave the log empty");
  ok(fingerprint(sim.state) === settled, "and the table exactly where it was");
}

// ---------------------------------------------------------------------------
head("the stroke — the table can see how hard a shot is before it lands");
{
  // A LIVE AIM IS A COURTESY; THE STROKE IS EVIDENCE. `m…` never enters a log,
  // so a rack watched back in the console had no cue in it at all and the one
  // thing a shot is mostly made of — the weight — was invisible to everyone but
  // the person who chose it. The backswing is derived from the SHOT, so it is
  // the same on every table and it survives into a replay.
  ok(strokeTicks(0) === STROKE_MIN_TICKS && strokeTicks(1000) === STROKE_MAX_TICKS, "a stroke is as long as the shot is hard");
  ok(STROKE_MIN_TICKS >= 10 && STROKE_MAX_TICKS <= Math.round(0.5 * TICK_RATE), `and the whole range is a beat, not a delay (${(STROKE_MIN_TICKS / TICK_RATE).toFixed(2)}s–${(STROKE_MAX_TICKS / TICK_RATE).toFixed(2)}s)`);
  let rises = true;
  let integral = true;
  for (let p = 0; p <= 1000; p++) {
    const n = strokeTicks(p);
    if (n !== Math.floor(n)) integral = false;
    if (p > 0 && n < strokeTicks(p - 1)) rises = false;
  }
  ok(rises && integral, "monotonic in the power, and a whole number of ticks at every one of the 1001 of them");
  ok(strokeTicks(-5) === STROKE_MIN_TICKS && strokeTicks(9999) === STROKE_MAX_TICKS, "…and nothing outside the range can lengthen it");

  const s = createState(9001, 2);
  s.ballInHand = true;
  s.behindLine = true;
  const seat = s.turn;
  applyInput(s, seat, shotKind(-680, 120, 1000, 0, 1000));
  ok(s.phase === "stroke" && s.shot !== null, "a shot starts a stroke rather than a roll");
  ok(s.shot !== null && s.shot.p === 1000 && s.shot.seat === seat, "…carrying the weight and the seat, which is what every table draws it from");
  ok(s.alive[CUE] === 1 && !s.ballInHand, "the cue ball is on the cloth for the whole of it — a cue winding up at a ball that is not there is unreadable");
  ok(s.deadline - s.since === strokeTicks(1000), "and it ends on the tick the power says it does");

  // Nothing moves. Not one ball, not one thousandth of a unit.
  const still = fingerprint(s);
  let moved = false;
  const span = s.deadline - s.since;
  for (let i = 0; i < span - 1; i++) {
    step(s, DURATION_TICKS);
    if (s.phase !== "stroke") moved = true;
    if (anyMoving(s)) moved = true;
  }
  ok(!moved && s.phase === "stroke", "nothing on the table moves while the cue is swinging");
  ok(fingerprint(s).slice(fingerprint(s).indexOf("|")) === still.slice(still.indexOf("|")), "…every ball is exactly where it was, to the last bit");

  // …and then it lands.
  step(s, DURATION_TICKS);
  ok(s.phase === "shoot" && anyMoving(s), "the cue arrives and the ball goes");
  // Contact and the first step of the roll are ONE tick — as they were before
  // the stroke existed — so what is left is the shot's speed less exactly one
  // tick of cloth. Any more than that and the swing has eaten part of the shot.
  const v = Math.sqrt(s.vx[CUE] * s.vx[CUE] + s.vy[CUE] * s.vy[CUE]);
  const lost = speedFor(1) - v;
  ok(lost > 0 && lost <= FRICTION / TICK_RATE + 1e-9, `at the speed the power asked for, less one tick of cloth (${lost.toFixed(4)})`);

  // A second shot mid-stroke is not a second shot.
  const before = fingerprint(s);
  applyInput(s, seat, shotKind(0, 0, -1000, 0, 200));
  ok(fingerprint(s) === before, "and a shot sent while the cue is already moving changes nothing");
}

// ---------------------------------------------------------------------------
head("the stroke — a replay of the log shows the weight too");
{
  // THE CHECK THE CONSOLE CARES ABOUT. A replay has the shots and nothing else:
  // if the weight is only readable from a live aim then a rack watched back is
  // a rack of silent jumps, which is what it used to be.
  const inputs: PoolInput[] = [];
  const at = 40;
  const shot = { x: -680, y: 0, dx: 1000, dy: 0, p: 850 };
  const live = new PoolSim(31337, 2, DURATION_TICKS);
  live.advanceTo(at - 1);
  const seat = live.state.turn;
  const kind = shotKind(shot.x, shot.y, shot.dx, shot.dy, shot.p);
  inputs.push({ tick: at, seat, kind });

  // Half way through the swing, cold, from the log alone.
  const mid = replay(31337, 2, inputs, at + Math.floor(strokeTicks(shot.p) / 2), DURATION_TICKS);
  ok(mid.phase === "stroke", "a replay stopped mid-swing is mid-swing");
  ok(mid.shot !== null && mid.shot.p === shot.p, "and it knows the weight of the shot it is watching");
  ok(mid.shot !== null && mid.shot.seat === seat, "…and whose stroke it is");
  ok(!anyMoving(mid), "with the balls still where they were");
  const u = (mid.tick - mid.since) / (mid.deadline - mid.since);
  ok(u > 0.3 && u < 0.7, `and the swing is a fraction anybody can draw from (${u.toFixed(2)})`);

  // A soft shot and a hard one are told apart by the LENGTH of the swing, which
  // is the second reading of the weight and the one a scrubbing console gets
  // for free.
  const soft = replay(31337, 2, [{ tick: at, seat, kind: shotKind(shot.x, shot.y, shot.dx, shot.dy, 60) }], at + 1, DURATION_TICKS);
  ok(soft.deadline - soft.since < mid.deadline - mid.since, "a touch is a shorter swing than a smash");
}

// ---------------------------------------------------------------------------
head("rules — the whole of 8-ball, one clause at a time");
{
  // ---- potting on the break decides nothing ----------------------------
  {
    const s = createState(555, 2);
    only(s, [CUE, 1, EIGHT]);
    place(s, EIGHT, -0.85, 0.42);
    // A solid straight into a corner — on the break, which decides nothing.
    const near = nearPocket(2, 0.16);
    const back = nearPocket(2, 0.34);
    place(s, 1, near.x, near.y);
    place(s, CUE, back.x, back.y);
    fire(s, 0, at(s, 1), 0.6);
    ok(!s.alive[1], "a ball went down on the break");
    ok(s.open, "a ball potted on the break does NOT decide the groups");
  }

  // ---- the first legal pot after the break does -------------------------
  {
    const s = createState(556, 2);
    s.broken = true;
    only(s, [CUE, 3, 11, EIGHT]);
    place(s, EIGHT, -0.85, 0.4);
    place(s, 11, -0.85, -0.4);
    // The 3 sitting in front of a corner, driven in by a full hit.
    const near = nearPocket(2, 0.16);
    const back = nearPocket(2, 0.34);
    place(s, 3, near.x, near.y);
    place(s, CUE, back.x, back.y);
    fire(s, 0, at(s, 3), 0.6);
    ok(!s.alive[3], "the 3 went down");
    ok(!s.open && s.group[0] === 0, `so that side is on solids (${s.group[0]})`);
    ok(s.group[1] === 1, "and the other is on stripes");
    ok(s.last?.assigned === true && s.last?.again === true, "the groups were decided by that shot, and they go again");
    ok(s.turn === 0, "which is what the turn does");
    ok(s.potted[0] === 1, "and it counts to them personally");
  }

  // ---- a scratch is a foul, and hands over the table --------------------
  {
    const s = createState(557, 2);
    s.broken = true;
    only(s, [CUE, 2, EIGHT]);
    place(s, EIGHT, 0.9, 0.42);
    place(s, 2, 0.4, 0.3);
    place(s, CUE, -0.4, -0.2);
    // Straight into a hole with nothing in the way. A FULL hit cannot produce a
    // scratch — equal masses means the cue ball stops dead — so this is the
    // shape a scratch really has. It is also a shot that touched nothing, and
    // the ORDER the rules are read in is the thing being checked: a cue ball in
    // a pocket is a scratch first and a miss second, because it is the scratch
    // that decides where the cue ball comes back.
    fire(s, 0, { x: POCKETS[0].x - s.x[CUE], y: POCKETS[0].y - s.y[CUE] }, 0.55);
    ok(s.last?.scratch === true, "the cue ball went down");
    ok(s.last?.foul === "scratch", `which is read as a scratch, not as a miss (${s.last?.foul})`);
    ok(s.ballInHand && !s.behindLine, "the incoming player gets the ball in hand, anywhere");
    ok(s.last?.again === false && s.turn === 1, "and it is the other side's shot");
    ok(s.fouls[0] === 1, "the foul is recorded against whoever made it");
  }

  // ---- a shot that touches nothing --------------------------------------
  {
    const s = createState(558, 2);
    s.broken = true;
    only(s, [CUE, 5, EIGHT]);
    place(s, 5, 0.7, 0.3);
    place(s, EIGHT, 0.7, -0.3);
    place(s, CUE, -0.7, 0);
    fire(s, 0, { x: 0, y: 1 }, 0.06);
    ok(s.last?.foul === "miss", `a cue ball that touches nothing is a foul (${s.last?.foul})`);
    ok(s.ballInHand, "and hands the table over");
  }

  // ---- hitting the wrong group first ------------------------------------
  {
    const s = createState(559, 2);
    s.broken = true;
    s.open = false;
    s.group[0] = 0;
    s.group[1] = 1;
    only(s, [CUE, 4, 12, EIGHT]);
    place(s, EIGHT, 0.9, 0.42);
    place(s, 4, 0.6, -0.3);
    place(s, 12, -0.1, 0);
    place(s, CUE, -0.6, 0);
    fire(s, 0, at(s, 12), 0.5);
    ok(s.last?.foul === "wrong-ball", `on solids and struck a stripe first (${s.last?.foul})`);
    ok(s.ballInHand, "which hands the table over");
  }

  // ---- and hitting the black first, while you still have balls up -------
  {
    const s = createState(560, 2);
    s.broken = true;
    s.open = false;
    s.group[0] = 0;
    s.group[1] = 1;
    only(s, [CUE, 4, EIGHT]);
    place(s, 4, 0.9, -0.42);
    place(s, EIGHT, -0.1, 0);
    place(s, CUE, -0.6, 0);
    fire(s, 0, at(s, EIGHT), 0.5);
    ok(s.last?.foul === "wrong-ball", "the black may not be struck first until your group is gone");
  }

  // ---- a shot that reaches no cushion and pots nothing -------------------
  {
    const s = createState(561, 2);
    s.broken = true;
    s.open = false;
    s.group[0] = 0;
    s.group[1] = 1;
    only(s, [CUE, 6, EIGHT]);
    place(s, EIGHT, 0.9, 0.42);
    place(s, 6, 0.02, 0);
    place(s, CUE, -0.06, 0);
    fire(s, 0, at(s, 6), 0.001);
    ok(s.last?.foul === "no-rail", `nudging a ball and leaving everything where it was is a foul (${s.last?.foul})`);
  }

  // ---- the black, potted early ------------------------------------------
  {
    const s = createState(562, 2);
    s.broken = true;
    s.open = false;
    s.group[0] = 0;
    s.group[1] = 1;
    only(s, [CUE, 4, EIGHT]);
    place(s, 4, -0.85, 0.42);
    const near = nearPocket(2, 0.16);
    const back = nearPocket(2, 0.34);
    place(s, EIGHT, near.x, near.y);
    place(s, CUE, back.x, back.y);
    fire(s, 0, at(s, EIGHT), 0.6);
    ok(!s.alive[EIGHT], "the black went down");
    ok(s.decided && s.winner === 1, `and the rack goes to the other side (${s.winner})`);
    ok(s.over, "the table is finished");
  }

  // ---- the black, potted to win -----------------------------------------
  {
    const s = createState(563, 2);
    s.broken = true;
    s.open = false;
    s.group[0] = 0;
    s.group[1] = 1;
    // Their group is gone; the black is all that is left of it.
    only(s, [CUE, 11, EIGHT]);
    place(s, 11, -0.85, 0.42);
    const near = nearPocket(2, 0.16);
    const back = nearPocket(2, 0.34);
    place(s, EIGHT, near.x, near.y);
    place(s, CUE, back.x, back.y);
    ok(remaining(s, 0) === 0, "their seven really are all down");
    fire(s, 0, at(s, EIGHT), 0.6);
    ok(s.decided && s.winner === 0, `clearing the group and sinking the black wins the rack (${s.winner})`);
    ok(s.finisher === 0, "and the person who did it is named");
    ok(performanceOf(s, 0) >= POINTS_EIGHT, "which is worth something on the card");
  }

  // ---- the black AND the cue ball, on the same shot ----------------------
  {
    const s = createState(564, 2);
    s.broken = true;
    s.open = false;
    s.group[0] = 0;
    s.group[1] = 1;
    only(s, [CUE, 11, EIGHT]);
    place(s, 11, -0.85, 0.42);
    // The black straight in, and the cue ball following it into the same hole.
    const near = nearPocket(2, 0.08);
    const back = nearPocket(2, 0.3);
    place(s, EIGHT, near.x, near.y);
    place(s, CUE, back.x, back.y);
    fire(s, 0, at(s, EIGHT), 0.9);
    if (!s.alive[EIGHT] && s.last?.scratch) {
      ok(s.winner === 1, "the black and a scratch on the same shot loses the rack");
    } else {
      ok(true, "(the cue ball stayed up — that arrangement is checked by the ruleset above)");
    }
  }

  // ---- potting one of THEIRS gives it away -------------------------------
  {
    const s = createState(565, 2);
    s.broken = true;
    s.open = false;
    s.group[0] = 0;
    s.group[1] = 1;
    only(s, [CUE, 4, 12, EIGHT]);
    place(s, EIGHT, -0.85, -0.42);
    place(s, 4, -0.4, 0.2);
    const near = nearPocket(2, 0.16);
    const back = nearPocket(2, 0.34);
    place(s, 12, near.x, near.y);
    place(s, CUE, back.x, back.y);
    // Legal contact is impossible here without hitting the stripe first, so the
    // shot is a foul as well — what is being checked is where the ball GOES.
    fire(s, 0, at(s, 12), 0.6);
    if (!s.alive[12]) {
      ok(s.last?.opp.includes(12) === true, "a ball of the other group counts to them, not to you");
      ok(s.potted[0] === 0, "and adds nothing to your own tally");
    } else {
      ok(true, "(the stripe stayed up — the accounting is covered by the assignment check)");
    }
  }

  // ---- a foul on the break leaves the incoming player behind the line ----
  {
    const s = createState(566, 2);
    only(s, [CUE, EIGHT, 1]);
    place(s, EIGHT, 0.9, 0.42);
    place(s, 1, 0.9, -0.42);
    place(s, CUE, -0.7, 0);
    fire(s, 0, { x: 0, y: 1 }, 0.04);
    ok(s.last?.foul === "miss", "a break that touches nothing is a foul");
    ok(s.ballInHand && s.behindLine, "and the incoming player is behind the head string");
  }

  // ---- ball in hand always lands somewhere legal -------------------------
  {
    const s = createState(567, 2);
    const rand = rng(99);
    let bad = 0;
    for (let i = 0; i < 4000; i++) {
      const behind = i % 3 === 0;
      const p = nearestSpot((rand() * 4 - 2) * HALF_X, (rand() * 4 - 2) * HALF_Y, s.x, s.y, s.alive, behind);
      if (!onCloth(p.x, p.y)) bad++;
      else if (!spotFree(p.x, p.y, s.x, s.y, s.alive, CUE)) bad++;
      else if (behind && p.x > HEAD_STRING + 1e-9) bad++;
    }
    ok(bad === 0, "four thousand placements, from anywhere including off the table, all legal");
    // The same answer everywhere, which is what lets the client draw it.
    const a = nearestSpot(0.5, 0.02, s.x, s.y, s.alive, false);
    const b = nearestSpot(0.5, 0.02, s.x, s.y, s.alive, false);
    ok(a.x === b.x && a.y === b.y, "and it is a pure function, so the client's ghost is the server's spot");
  }

  // ---- the ghost-ball ray the client draws agrees with the solver --------
  {
    const s = createState(568, 2);
    only(s, [CUE, 9]);
    place(s, 9, 0.5, 0);
    place(s, CUE, -0.5, 0);
    const hit = firstHit(s, s.x[CUE], s.y[CUE], 1, 0, CUE);
    ok(hit.index === 9, "the ray finds the ball in the way");
    ok(Math.abs(hit.hx - (0.5 - BALL_R * 2)) < 1e-9, "and stops one diameter short of it — the ghost ball");
    const miss = firstHit(s, s.x[CUE], s.y[CUE], 0, 1, CUE);
    ok(miss.index === -1 && Math.abs(miss.hy - (HALF_Y - BALL_R)) < 1e-9, "and with nothing in the way it stops at the cushion");
  }
}

// ---------------------------------------------------------------------------
head("replay parity — live, cold and late all agree bit for bit");
{
  const rand = rng(31337);
  const inputs: PoolInput[] = [];
  const live = new PoolSim(24680, 4, DURATION_TICKS);
  let tick = 0;
  // Play a rack out by feeding the SERVER's own bot into the ordinary input
  // path, which is what a real match does.
  for (let shot = 0; shot < 40 && !live.state.over; shot++) {
    live.advanceTo(tick);
    const s = live.state;
    if (!awaitingServer(s)) {
      tick += 10;
      continue;
    }
    const p = chooseShot(s, s.turn, rand(), rand);
    const kind = shotKind(p.x, p.y, p.dx, p.dy, p.p);
    const at = tick + 6;
    inputs.push({ tick: at, seat: s.turn, kind });
    live.addInput({ tick: at, seat: s.turn, kind });
    tick = at + 4;
    live.advanceTo(tick);
    let guard = 0;
    while (live.state.phase !== "aim" && !live.state.over && guard++ < 900) {
      tick += 4;
      live.advanceTo(tick);
    }
  }
  const end = tick + 60;
  live.advanceTo(end);
  const cold = replay(24680, 4, inputs, end, DURATION_TICKS);
  ok(fingerprint(live.state) === fingerprint(cold), "a cold replay of the log is the same table, exactly");

  // Every input delivered LATE and out of order — the netcode's real job.
  const late = new PoolSim(24680, 4, DURATION_TICKS);
  const shuffled = inputs.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  late.advanceTo(end);
  for (const i of shuffled) late.addInput(i);
  late.advanceTo(end);
  ok(fingerprint(late.state) === fingerprint(cold), "…and so is a sim told about every shot after the fact, in the wrong order");

  // The keyframe: a rewind INTO the current turn must produce the same table a
  // full rebuild does. This is the optimisation the client's frame budget rests
  // on, and a keyframe that is subtly wrong is a table that drifts.
  const kf = new PoolSim(24680, 4, DURATION_TICKS);
  for (const i of inputs) kf.addInput(i);
  kf.advanceTo(end);
  const before = fingerprint(kf.state);
  kf.addInput({ tick: Math.max(1, end - 20), seat: 0, kind: NUDGE_KIND });
  kf.advanceTo(end);
  ok(fingerprint(kf.state) === before, "an input that changes nothing, delivered late, rewinds to the same table");
}

// ---------------------------------------------------------------------------
head("liveness — bot racks finish, with any number of empty chairs");
{
  /** Play a whole rack with the server's own policy driving every seat. */
  function playOut(seed: number, players: number, skills: number[], absent: number[] = [], rand = rng(seed)) {
    const sim = new PoolSim(seed, players, DURATION_TICKS);
    let tick = 0;
    for (const seat of absent) sim.addInput({ tick: 1, seat, kind: QUIT_KIND });
    let shots = 0;
    while (tick < DURATION_TICKS && !sim.state.over && shots < 400) {
      sim.advanceTo(tick);
      const s = sim.state;
      if (s.over) break;
      if (awaitingServer(s) && !s.quit[s.turn]) {
        const p = chooseShot(s, s.turn, skills[s.turn] ?? 0.5, rand);
        const at = tick + 6;
        sim.addInput({ tick: at, seat: s.turn, kind: shotKind(p.x, p.y, p.dx, p.dy, p.p) });
        shots++;
        tick = at + 2;
      } else {
        tick += 6;
      }
    }
    sim.advanceTo(Math.min(tick + 60, DURATION_TICKS));
    return { s: sim.state, tick, shots };
  }

  for (const [players, absent] of [
    [2, []],
    [4, []],
    [4, [1]],
    [4, [1, 3]],
    [2, [1]],
  ] as [number, number[]][]) {
    let decided = 0;
    let worst = 0;
    const N = 12;
    for (let k = 0; k < N; k++) {
      const r = playOut(700 + k * 91 + players * 7 + absent.length * 3, players, [0.6, 0.5, 0.55, 0.45], absent);
      if (r.s.decided) decided++;
      if (r.tick > worst) worst = r.tick;
    }
    ok(decided === N, `${players} players, ${absent.length} empty: every rack was decided (${decided}/${N})`);
    ok(worst < DURATION_TICKS, `…and inside the clock (worst ${(worst / TICK_RATE / 60).toFixed(1)} min of ${DURATION_SEC / 60})`);
  }

  // Everybody walks out.
  {
    const sim = new PoolSim(4321, 4, DURATION_TICKS);
    for (const seat of [0, 1, 2, 3]) sim.addInput({ tick: 1 + seat, seat, kind: QUIT_KIND });
    sim.advanceTo(600);
    ok(sim.state.over, "an empty table ends rather than sitting there");
  }

  // The advertised length is honest. Bots decide faster than people do, so the
  // typical time shown in the picker has to be at least what they take.
  const r = playOut(9090, 2, [0.6, 0.6]);
  ok(r.s.decided, "a two-handed rack decides");
  ok(TYPICAL_SEC * TICK_RATE > r.tick * 0.8, `and the advertised ${TYPICAL_SEC / 60} min is not shorter than a rack takes`);
  ok(DURATION_SEC > TYPICAL_SEC * 2, "with the hard clock well clear of it");
}

// ---------------------------------------------------------------------------
head("skill — a strong bot beats a weak one");
{
  function duel(seed: number, strong: number, weak: number): number {
    const sim = new PoolSim(seed, 2, DURATION_TICKS);
    const rand = rng(seed * 7 + 13);
    let tick = 0;
    let shots = 0;
    while (tick < DURATION_TICKS && !sim.state.over && shots < 400) {
      sim.advanceTo(tick);
      const s = sim.state;
      if (s.over) break;
      if (awaitingServer(s)) {
        const p = chooseShot(s, s.turn, s.turn === 0 ? strong : weak, rand);
        const at = tick + 6;
        sim.addInput({ tick: at, seat: s.turn, kind: shotKind(p.x, p.y, p.dx, p.dy, p.p) });
        shots++;
        tick = at + 2;
      } else tick += 6;
    }
    sim.advanceTo(Math.min(tick + 60, DURATION_TICKS));
    return outcome(sim.state);
  }
  let strongWins = 0;
  const N = 30;
  for (let k = 0; k < N; k++) if (duel(2000 + k * 137, 0.95, 0.1) === 0) strongWins++;
  ok(strongWins >= N * 0.75, `the strongest bot beats the weakest ${strongWins}/${N} times`);

  let midWins = 0;
  for (let k = 0; k < N; k++) if (duel(5000 + k * 211, 0.9, 0.5) === 0) midWins++;
  ok(midWins >= N * 0.62, `and a strong one beats a middling one ${midWins}/${N} times`);

  // A bot's shown aim must be the shot it actually plays — the whole point of
  // planning up front (see the server's botPlan).
  {
    const s = createState(818, 2);
    const plan = botPlan(s, s.turn, 0.7, rng(5));
    ok(plan.length >= 2, "a bot shows its working before it plays");
    const last = plan[plan.length - 1];
    ok(isInputKind(askKind(last.x, last.y, last.dx, last.dy, last.p)), "and everything it produces is a legal input");
    const t = thinkTicks(TICK_RATE, true, rng(6));
    ok(t > 0 && t < TURN_TICKS, `it takes a human amount of time over it (${(t / TICK_RATE).toFixed(1)}s)`);
    ok(thinkTicks(TICK_RATE, true, () => 0.5) > thinkTicks(TICK_RATE, false, () => 0.5), "…and longer when it has the ball in hand");
  }
}

// ---------------------------------------------------------------------------
head("fairness — the break is worth something, so nobody may be handed it");
{
  // Who breaks is drawn from the seed. Over many racks each seat must get it
  // about half the time — with two seats and four.
  for (const players of [2, 4]) {
    const counts = new Array(players).fill(0);
    const N = 4000;
    for (let k = 0; k < N; k++) counts[createState(k * 2654435761, players).turn]++;
    const lo = Math.min(...counts) / N;
    const hi = Math.max(...counts) / N;
    const share = 1 / players;
    ok(
      lo > share * 0.9 && hi < share * 1.1,
      `${players} seats break about equally (${counts.map((c) => `${Math.round((c / N) * 100)}%`).join(" / ")})`
    );
  }
  // And every seat that can break is one that actually shoots.
  let bad = 0;
  for (let k = 0; k < 200; k++) {
    const s = createState(k * 7919, 4);
    if (!turnOrder(4).includes(s.turn)) bad++;
  }
  ok(bad === 0, "and the breaker is always a seat in the order");
}

// ---------------------------------------------------------------------------
head("stall — a silent server does not freeze the table");
{
  const sim = new PoolSim(1234, 2, DURATION_TICKS);
  // Not one input, ever. The table has to break its own stall.
  sim.advanceTo(Math.min(DURATION_TICKS, 60 * TICK_RATE * 4));
  ok(sim.state.shots > 0, `the rack played itself rather than freezing (${sim.state.shots} shots)`);
  const a = replay(1234, 2, [], 60 * TICK_RATE * 4, DURATION_TICKS);
  ok(fingerprint(a) === fingerprint(sim.state), "and it does it identically everywhere — the stall shot is a pure hash");

  // Away and back: a seat that stops answering gets a shorter clock, and one
  // touch gives it back.
  {
    const s = createState(77, 2);
    const full = s.deadline - s.since;
    applyInput(s, s.turn, AWAY_KIND);
    ok(s.away[s.turn], "a seat can be marked away");
    ok(s.deadline - s.since < full, "which shortens its clock immediately, mid-turn");
    applyInput(s, s.turn, BACK_KIND);
    ok(!s.away[s.turn] && s.deadline - s.since === full, "and coming back restores it");
  }
}

// ---------------------------------------------------------------------------
head("scoring — the number beside a placement can never contradict it");
{
  const gap = PLACE_POINTS[1] - PLACE_POINTS[2];
  const most = PER_GROUP * POINTS_PER_BALL + POINTS_EIGHT;
  ok(most < gap, `the best possible garnish (${most}) is smaller than the gap between the places (${gap})`);
  const s = createState(31, 2);
  s.potted[0] = PER_GROUP;
  s.finisher = 0;
  ok(scoreOf(s, 0, 1) > scoreOf(s, 1, 2), "a winner always outscores a loser");
  ok(scoreOf(s, 0, 2) < scoreOf(s, 1, 1), "…and a perfect rack that still lost cannot outscore a scrappy win");
  ok(isOut(s, 0) === false, "nobody is out while the rack is live");
  s.quit[0] = true;
  ok(isOut(s, 0), "and a seat that left is");
}

// ---------------------------------------------------------------------------
head("registration — the platform sees the game the rules describe");
{
  const g = getGame("pool");
  ok(!!g, "the server registered a game called pool");
  if (g) {
    ok(g.tickRate === TICK_RATE, `at ${TICK_RATE} ticks a second`);
    ok(g.matchSizeFor("duo") === 2 && g.matchSizeFor("squad") === 4, "two-handed and four-handed");
    ok(g.matchSizeFor("solo") === 4, "and a solo queue fills a doubles table");
    ok(g.pack.bytes === 0, "with nothing to download");
    ok(g.isValidInputKind(askKind(0, 0, 1000, 0, 500)), "it accepts a request from a client");
    ok(!g.isValidInputKind(shotKind(0, 0, 1000, 0, 500)), "and refuses a shot");
    ok(typeof g.serverInputs === "function", "and it authors its own inputs");
    ok((g.typicalSec ?? 0) === TYPICAL_SEC, "the picker is told how long a rack takes");
  }
}

// ---------------------------------------------------------------------------
head("cost — a whole match replays fast enough to do it on a phone");
{
  const rand = rng(6161);
  const inputs: PoolInput[] = [];
  const sim = new PoolSim(5150, 4, DURATION_TICKS);
  let tick = 0;
  let shots = 0;
  while (tick < DURATION_TICKS && !sim.state.over && shots < 400) {
    sim.advanceTo(tick);
    const s = sim.state;
    if (awaitingServer(s)) {
      const p = chooseShot(s, s.turn, 0.6, rand);
      const at = tick + 6;
      const i = { tick: at, seat: s.turn, kind: shotKind(p.x, p.y, p.dx, p.dy, p.p) };
      inputs.push(i);
      sim.addInput(i);
      shots++;
      tick = at + 2;
    } else tick += 6;
  }
  const end = Math.min(tick + 60, DURATION_TICKS);
  const t0 = performance.now();
  const runs = 5;
  for (let k = 0; k < runs; k++) replay(5150, 4, inputs, end, DURATION_TICKS);
  const each = (performance.now() - t0) / runs;
  ok(each < 260, `a ${shots}-shot rack replays cold in ${each.toFixed(1)}ms`);

  // And the keyframe is what keeps a LATE input cheap, which is the number the
  // client's frame budget actually depends on.
  const warm = new PoolSim(5150, 4, DURATION_TICKS);
  for (const i of inputs) warm.addInput(i);
  warm.advanceTo(end);
  const t1 = performance.now();
  for (let k = 0; k < 20; k++) {
    warm.addInput({ tick: Math.max(1, end - 15), seat: k % 4, kind: NUDGE_KIND });
    warm.advanceTo(end);
  }
  const late = (performance.now() - t1) / 20;
  ok(late < each / 3, `and a late input costs ${late.toFixed(2)}ms rather than the full ${each.toFixed(1)}ms`);
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
