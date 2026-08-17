// Verification suite for the Ludo simulation — run it after ANY change to
// shared/games/ludo.
//
//     npm run check:ludo
//
// It reads the shared SOURCE (via tsx), so it can never pass against a stale
// build. What it proves, and why each check exists:
//
//   board         — the fifty-two ring squares really are a ring, the four
//                   starts really are thirteen apart, and each home run really
//                   does leave the ring where its colour turns off. Every one
//                   of those is derived by a walk rather than typed out, so a
//                   single wrong step would silently reshape the board
//   rules         — a six opens the gate and nothing else does, home must be
//                   hit exactly, a capture only happens off the safe squares,
//                   three sixes forfeit the turn
//   authority     — a player's own inputs move NOTHING. This is the whole
//                   safety argument for a shared board on a platform that
//                   relays inputs to everyone except their sender: if a tap
//                   could move a piece, one dropped packet would split the
//                   table in two and nothing would ever put it back
//   replay parity — live stepping, a cold replay, and a sim fed every input
//                   LATE and out of order all agree. This is the netcode
//   liveness      — a full four-player game played by the bot policy reaches a
//                   winner, and does it well inside the match clock. A board
//                   game that can deadlock is worse than one that is unfair
//   stall         — with the server silent from the first tick, the table
//                   still advances rather than freezing forever
//   cost          — the end-of-match replay stays in single-digit milliseconds
import {
  AWAY_AFTER_MISSES,
  AWAY_KIND,
  BACK_KIND,
  CENTRE,
  DURATION_SEC,
  DURATION_TICKS,
  GRID,
  HOME_RUN_CELLS,
  LudoSim,
  MAX_PERFORMANCE,
  PLACE_POINTS,
  POS_HOME,
  POS_YARD,
  QUIT_KIND,
  RING,
  RING_LENGTH,
  RING_STEPS,
  SAFE_RING,
  SPIN_TICKS,
  START_INDEX,
  TICK_RATE,
  TURN_TICKS,
  TOKENS_PER_PLAYER,
  applyInput,
  awaitingServer,
  cellOf,
  cornerOf,
  createState,
  dieKind,
  isInputKind,
  isOut,
  legalMoves,
  playKind,
  replay,
  ringIndexOf,
  step,
  stillPlaying,
  tokensHome,
  yardRect,
  type LudoInput,
  type LudoState,
} from "../../shared/games/ludo/index.js";
// The bot policy is server-side (it is not part of the deterministic sim), but
// its OUTPUT is ordinary inputs, so it is checked with exactly the same tools.
import { chooseToken } from "../../backend/src/games/ludo/bot.js";
// The server definition is checked too, through the same registry the platform
// reads it from — importing it is what registers it.
import "../../backend/src/games/ludo/index.js";
import { getGame } from "../../backend/src/platform/games.js";

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};

/** A small pure generator, so every run of this file is the same run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fields that must agree between two simulations of the same log. */
const fingerprint = (s: LudoState) =>
  JSON.stringify({
    tick: s.tick,
    pos: s.pos,
    turn: s.turn,
    phase: s.phase,
    since: s.since,
    deadline: s.deadline,
    die: s.die,
    rolls: s.rolls,
    sixes: s.sixes,
    homeAt: s.homeAt,
    quit: s.quit,
    captures: s.captures,
    order: s.order,
    over: s.over,
    decided: s.decided,
  });

// ---- 1. the board is the board -------------------------------------------
console.log("board");
{
  ok(RING.length === RING_LENGTH, `the ring is ${RING_LENGTH} squares (${RING.length})`);
  const keys = new Set(RING.map((c) => `${c.col},${c.row}`));
  ok(keys.size === RING_LENGTH, "every ring square is distinct");
  ok(
    RING.every((c) => c.col >= 0 && c.col < GRID && c.row >= 0 && c.row < GRID),
    "every ring square is inside the 15×15 grid"
  );
  // A ring is a ring: every step is to a touching square, and exactly four of
  // them cut a corner of the centre block (see the note in board.ts).
  let stepsOk = true;
  let diagonals = 0;
  for (let i = 0; i < RING_LENGTH; i++) {
    const a = RING[i];
    const b = RING[(i + 1) % RING_LENGTH];
    const dc = Math.abs(a.col - b.col);
    const dr = Math.abs(a.row - b.row);
    if (dc + dr === 1) continue;
    if (dc === 1 && dr === 1) diagonals++;
    else stepsOk = false;
  }
  ok(stepsOk, "every step round the ring is to a touching square, all the way back to the start");
  ok(diagonals === 4, `exactly four of them cut an inner corner (${diagonals})`);
  ok(
    START_INDEX.every((v, i) => v === i * 13),
    `the four starts are thirteen apart (${START_INDEX.join(", ")})`
  );
  // Each colour's start square touches its own yard, and each home run starts
  // one square inward from where that colour turns off the ring.
  let startsOk = true;
  let runsOk = true;
  const homeKeys = new Set<string>();
  for (let corner = 0; corner < 4; corner++) {
    const y = yardRect(corner);
    const start = RING[START_INDEX[corner]];
    const near =
      start.col >= y.col - 1 && start.col <= y.col + y.size && start.row >= y.row - 1 && start.row <= y.row + y.size;
    if (!near) startsOk = false;
    const exit = RING[(START_INDEX[corner] + RING_STEPS - 1) % RING_LENGTH];
    const run = HOME_RUN_CELLS[corner];
    if (run.length !== 5) runsOk = false;
    if (Math.abs(run[0].col - exit.col) + Math.abs(run[0].row - exit.row) !== 1) runsOk = false;
    // The last home square touches the centre BLOCK (cols/rows 6–8), which is
    // where the four triangles are; the middle cell itself is two away.
    const edge = Math.abs(run[4].col - CENTRE.col) + Math.abs(run[4].row - CENTRE.row);
    if (edge !== 2) runsOk = false;
    for (const c of run) {
      if (keys.has(`${c.col},${c.row}`)) runsOk = false; // a home run is nobody else's road
      homeKeys.add(`${c.col},${c.row}`);
    }
  }
  ok(startsOk, "each colour's start square sits against its own yard");
  ok(runsOk, "each home run leaves the ring where its colour turns off and reaches the centre");
  ok(homeKeys.size === 20, `the four home runs are twenty distinct squares (${homeKeys.size})`);
  ok(SAFE_RING.length === 8 && new Set(SAFE_RING).size === 8, "there are eight distinct safe squares");
  ok(
    START_INDEX.every((i) => SAFE_RING.includes(i)),
    "every start square is safe"
  );
  // Walking a full lap from any corner passes every ring square exactly once.
  let lapOk = true;
  for (let corner = 0; corner < 4; corner++) {
    const seen = new Set<number>();
    for (let p = 0; p < RING_STEPS; p++) seen.add(ringIndexOf(corner, p));
    if (seen.size !== RING_STEPS) lapOk = false;
    // …and never touches the one square it turns off before.
    if (seen.has((START_INDEX[corner] + RING_STEPS) % RING_LENGTH)) lapOk = false;
  }
  ok(lapOk, "a lap covers 51 distinct ring squares and stops before its own start");
  // Home tokens rest in their OWN triangle, so four finished sets do not pile
  // onto one square.
  const homes = [0, 1, 2, 3].map((c) => cellOf(c, POS_HOME, 0));
  ok(new Set(homes.map((h) => `${h.col},${h.row}`)).size === 4, "each colour comes home to its own triangle");
  ok(
    homes.every((h) => Math.abs(h.col - CENTRE.col) + Math.abs(h.row - CENTRE.row) < 1),
    "and all four are inside the centre block"
  );
  // Two players sit across the diagonal so they never share an arm.
  ok(cornerOf(0, 2) === 0 && cornerOf(1, 2) === 2, "the two-handed game is played across the diagonal");
}

// ---- 2. the rules ---------------------------------------------------------
console.log("rules");
{
  /** A board with the pieces put where a check wants them. */
  const board = (players = 4): LudoState => {
    const s = createState(1234, players);
    return s;
  };
  /** Give the turn to `seat` with `die` showing and a choice to make. */
  const offer = (s: LudoState, seat: number, die: number) => {
    s.turn = seat;
    s.die = die;
    s.phase = "pick";
    s.since = s.tick;
    s.deadline = s.tick + 999;
  };

  {
    const s = board();
    ok(legalMoves(s, 0, 5).length === 0, "with every token in the yard, a five can play nothing");
    ok(legalMoves(s, 0, 6).length === 1, "a six opens the gate — and offers ONE move, not four identical ones");
  }
  {
    const s = board();
    s.pos[0][0] = 50;
    ok(legalMoves(s, 0, 6).length === 2, "a token near home and three in the yard is two distinct moves on a six");
    ok(legalMoves(s, 0, 6).includes(0), "a six lands on home exactly from 50 and can be played");
    // Home must be hit exactly: from 52, a four arrives and a six overshoots.
    s.pos[0][0] = 52;
    ok(legalMoves(s, 0, 4).includes(0), "from 52 a four reaches home exactly");
    ok(!legalMoves(s, 0, 6).includes(0), "from 52 a six would overshoot home and cannot be played");
  }
  {
    // A capture: seat 1's token parked on a square seat 0 is about to reach.
    const s = board();
    const victim = ringIndexOf(cornerOf(1, 4), 10);
    let landing = -1;
    for (let p = 1; p < RING_STEPS; p++) if (ringIndexOf(cornerOf(0, 4), p) === victim) landing = p;
    s.pos[0][0] = landing - 3;
    s.pos[1][0] = 10;
    offer(s, 0, 3);
    applyInput(s, 0, playKind(0));
    ok(s.pos[1][0] === POS_YARD, "landing on an enemy on an open square sends it back to the yard");
    ok(s.captures[0] === 1, "the knock-out is counted");
    ok(s.hop?.extra === true, "a capture earns another go");
  }
  {
    // The same collision, on a safe square: nothing happens to anybody.
    const s = board();
    const safe = SAFE_RING.find((i) => i !== START_INDEX[0] && i !== START_INDEX[1])!;
    let mine = -1;
    let theirs = -1;
    for (let p = 1; p < RING_STEPS; p++) {
      if (ringIndexOf(cornerOf(0, 4), p) === safe) mine = p;
      if (ringIndexOf(cornerOf(1, 4), p) === safe) theirs = p;
    }
    s.pos[0][0] = mine - 2;
    s.pos[1][0] = theirs;
    offer(s, 0, 2);
    applyInput(s, 0, playKind(0));
    ok(s.pos[0][0] === mine && s.pos[1][0] === theirs, "a safe square shelters whoever is standing on it");
    ok(s.captures[0] === 0, "and nothing is counted as a knock-out");
  }
  {
    // Three sixes forfeit the turn, and the third is not played.
    const s = board();
    s.pos[0][0] = 10;
    s.pos[0][1] = 20;
    let sixes = 0;
    const guard = 400;
    for (let i = 0; i < guard && sixes < 3; i++) {
      if (s.phase === "roll" && s.turn === 0) {
        applyInput(s, 0, dieKind(6));
        sixes++;
      } else if (s.phase === "pick" && s.turn === 0) {
        applyInput(s, 0, playKind(legalMoves(s, 0, s.die)[0]));
      }
      step(s);
    }
    for (let i = 0; i < 60 && s.phase === "spin"; i++) step(s);
    ok(sixes === 3 && s.passReason === "three-sixes", "a third six in a row forfeits the turn");
    const before = JSON.stringify(s.pos[0]);
    for (let i = 0; i < 60 && s.turn === 0; i++) step(s);
    ok(JSON.stringify(s.pos[0]) === before, "and the third six moves nothing");
    ok(s.turn !== 0, "the turn passes on");
  }
  {
    // Bringing the last token home ends that player's game and their turn.
    const s = board();
    for (let t = 0; t < TOKENS_PER_PLAYER; t++) s.pos[0][t] = POS_HOME;
    s.pos[0][3] = 55;
    offer(s, 0, 1);
    applyInput(s, 0, playKind(3));
    for (let i = 0; i < 200 && s.homeAt[0] < 0 && !s.over; i++) step(s);
    ok(tokensHome(s, 0) === 4, "all four tokens are home");
    ok(s.homeAt[0] >= 0, "the seat is recorded as finished");
    ok(s.order[0] === 0, "and takes the first place in the finishing order");
  }
}

// ---- 3. a player's own inputs move nothing --------------------------------
console.log("authority");
{
  ok(isInputKind("roll") && isInputKind("t2"), "a player may ask to roll and to play a token");
  ok(!isInputKind("d6") && !isInputKind("p1") && !isInputKind("quit"), "a player may NOT write a die, a play or a quit");

  const s = createState(99, 4);
  const before = fingerprint(s);
  for (let i = 0; i < 50; i++) {
    for (let seat = 0; seat < 4; seat++) {
      applyInput(s, seat, "roll");
      for (let t = 0; t < 4; t++) applyInput(s, seat, `t${t}`);
    }
  }
  ok(fingerprint(s) === before, "a thousand player requests, from every seat, change nothing at all");

  // …and the server's die does move it.
  applyInput(s, 0, dieKind(6));
  ok(s.phase === "spin" && s.die === 6, "the server's die is what starts the turn moving");

  // Requests do not even reach the log. If they did, a modified client sending
  // six LATE requests a second would land each one behind the play head and
  // force every table in the match — including the server's — to rebuild itself
  // from tick zero, six times a second, for the whole match.
  const flood = new LudoSim(5, 4, DURATION_TICKS);
  flood.advanceTo(300);
  const settled = fingerprint(flood.state);
  for (let i = 0; i < 500; i++) flood.addInput({ tick: 20, seat: i % 4, kind: i % 2 ? "roll" : `t${i % 4}` });
  flood.advanceTo(300);
  ok(flood.inputs.length === 0, "500 late requests leave the log empty");
  ok(fingerprint(flood.state) === settled, "and the board exactly where it was");
}

// ---- 4. a whole game, played by the bot policy ----------------------------
console.log("liveness (a full game played out)");

/** Play a match the way the server does: the table asks, the server answers.
 *  `answerDelay` is how long the server waits before answering — Infinity is a
 *  server that never answers at all. */
function playOut(seed: number, players: number, answerDelay = 3, skill = 0.7) {
  const sim = new LudoSim(seed, players, DURATION_TICKS);
  const rand = rng(seed ^ 0x5bf03635);
  const log: LudoInput[] = [];
  let answered = "";
  let tick = 0;
  for (tick = 1; tick <= DURATION_TICKS; tick++) {
    sim.advanceTo(tick);
    const s = sim.state;
    if (s.over) break;
    if (!awaitingServer(s)) continue;
    const key = `${s.turn}:${s.phase}:${s.since}`;
    if (answered === key || tick - s.since < answerDelay) continue;
    answered = key;
    const input: LudoInput =
      s.phase === "roll"
        ? { tick: tick + 1, seat: s.turn, kind: dieKind(1 + Math.floor(rand() * 6)) }
        : { tick: tick + 1, seat: s.turn, kind: playKind(chooseToken(s, s.turn, skill, rand)) };
    log.push(input);
    sim.addInput(input);
  }
  return { sim, log, endTick: Math.min(tick, DURATION_TICKS) };
}

/** Play until the FIRST player is home and at least two others are still going
 *  — the window in which Ludo's winner has nothing left to do. */
function playOutUntilFirstHome(seed: number, players: number) {
  const sim = new LudoSim(seed, players, DURATION_TICKS);
  const rand = rng(seed ^ 0x77777);
  const log: LudoInput[] = [];
  let answered = "";
  for (let tick = 1; tick <= DURATION_TICKS; tick++) {
    sim.advanceTo(tick);
    const s = sim.state;
    if (s.over) return null;
    if (s.order.length === 1) return { log, winner: s.order[0], endTick: tick };
    if (!awaitingServer(s)) continue;
    const key = `${s.turn}:${s.phase}:${s.since}`;
    if (answered === key || tick - s.since < 3) continue;
    answered = key;
    const input: LudoInput =
      s.phase === "roll"
        ? { tick: tick + 1, seat: s.turn, kind: dieKind(1 + Math.floor(rand() * 6)) }
        : { tick: tick + 1, seat: s.turn, kind: playKind(chooseToken(s, s.turn, 0.8, rand)) };
    log.push(input);
    sim.addInput(input);
  }
  return null;
}

{
  let finished = 0;
  let worstTicks = 0;
  let totalTicks = 0;
  const runs = 60;
  for (let i = 1; i <= runs; i++) {
    const { sim, endTick } = playOut(i * 7919, 4);
    if (sim.state.over && sim.state.order.length >= 1) finished++;
    worstTicks = Math.max(worstTicks, endTick);
    totalTicks += endTick;
  }
  const avgMin = totalTicks / runs / TICK_RATE / 60;
  ok(finished === runs, `${finished}/${runs} four-player games reach a winner`);
  ok(
    worstTicks < DURATION_TICKS,
    `the slowest finished inside the match clock (${(worstTicks / TICK_RATE / 60).toFixed(1)} of ${(DURATION_TICKS / TICK_RATE / 60).toFixed(0)} min)`
  );
  console.log(`    average game: ${avgMin.toFixed(1)} min of simulated time`);

  let duo = 0;
  for (let i = 1; i <= 30; i++) {
    const { sim } = playOut(i * 104729, 2);
    if (sim.state.over && sim.state.order.length >= 1) duo++;
  }
  ok(duo === 30, `${duo}/30 two-player games reach a winner`);
}

// ---- 5. replay parity: the netcode ---------------------------------------
console.log("replay parity");
{
  const { sim, log, endTick } = playOut(4242, 4);
  const cold = replay(4242, 4, log, endTick, DURATION_TICKS);
  ok(fingerprint(cold) === fingerprint(sim.state), "a cold replay of the log lands on the live board, exactly");

  // The same log, shuffled — order on the wire must not matter.
  const shuffled = [...log];
  const r = rng(7);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const outOfOrder = replay(4242, 4, shuffled, endTick, DURATION_TICKS);
  ok(fingerprint(outOfOrder) === fingerprint(cold), "the same inputs in a scrambled order give the same board");

  // Every input delivered LATE, the way a bad connection delivers them: the
  // sim must rewind into them and converge.
  const late = new LudoSim(4242, 4, DURATION_TICKS);
  const LAG = 9;
  let i = 0;
  const sorted = [...log].sort((a, b) => a.tick - b.tick);
  for (let t = 1; t <= endTick; t++) {
    while (i < sorted.length && sorted[i].tick + LAG <= t) late.addInput(sorted[i++]);
    late.advanceTo(t);
  }
  while (i < sorted.length) late.addInput(sorted[i++]);
  late.advanceTo(endTick);
  ok(fingerprint(late.state) === fingerprint(cold), `every input arriving ${LAG} ticks late converges on the same board`);

  // The order two inputs on the SAME TICK are applied in must not depend on
  // which order they happened to arrive in. The server writes several in one
  // batch — an empty chair and a die, say — and a client that rewound past
  // them must fold them in exactly as a client that never rewound applied
  // them. Every arrival order of one such batch, against the cold replay.
  {
    // Three chairs emptying and a die, all on one tick. Order decides whether
    // the die lands before the table is declared over or after it, and the two
    // outcomes are visibly different boards.
    const batch: LudoInput[] = [
      { tick: 40, seat: 1, kind: QUIT_KIND },
      { tick: 40, seat: 0, kind: dieKind(6) },
      { tick: 40, seat: 2, kind: QUIT_KIND },
      { tick: 40, seat: 3, kind: QUIT_KIND },
    ];
    const perms: number[][] = [];
    const walk = (rest: number[], acc: number[]) => {
      if (!rest.length) return void perms.push(acc);
      rest.forEach((v, i) => walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, v]));
    };
    walk([0, 1, 2, 3], []);
    const seen = new Set<string>();
    for (const perm of perms) {
      const sim = new LudoSim(77, 4, DURATION_TICKS);
      // Delivered live, in this order, each before its tick is simulated.
      for (const i of perm) sim.addInput(batch[i]);
      sim.advanceTo(200);
      seen.add(fingerprint(sim.state));
      // …and again, arriving LATE, so the rewind path folds them in instead.
      const late = new LudoSim(77, 4, DURATION_TICKS);
      late.advanceTo(120);
      for (const i of perm) late.addInput(batch[i]);
      late.advanceTo(200);
      seen.add(fingerprint(late.state));
    }
    ok(seen.size === 1, `one batch of same-tick inputs gives one board however it arrives — ${perms.length * 2} deliveries, ${seen.size} board(s)`);
  }

  // A client that joins halfway and is handed the log so far (the resume path).
  const half = Math.floor(endTick / 2);
  const resumed = new LudoSim(4242, 4, DURATION_TICKS);
  for (const inp of log) resumed.addInput(inp);
  resumed.advanceTo(half);
  ok(
    fingerprint(resumed.state) === fingerprint(replay(4242, 4, log, half, DURATION_TICKS)),
    "a client handed the whole log mid-match rebuilds the board it missed"
  );
}

// ---- 6. the stall breaker -------------------------------------------------
console.log("stall");
{
  const { sim, endTick } = playOut(31337, 4, Infinity);
  ok(sim.state.rolls > 0, `with the server silent the table still turns (${sim.state.rolls} rolls in ${endTick} ticks)`);
  ok(
    sim.state.tick >= endTick - 1,
    "and never freezes: the board keeps reaching the tick it is asked for"
  );
  // Two clients with a silent server must break the stall identically, or the
  // insurance would itself be the desync.
  const a = playOut(31337, 4, Infinity).sim.state;
  ok(fingerprint(a) === fingerprint(sim.state), "two tables break the same stall the same way");
}

// ---- 7. cost --------------------------------------------------------------
console.log("cost");
{
  const { log, endTick } = playOut(555, 4);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) replay(555, 4, log, endTick, DURATION_TICKS);
  const ms = (performance.now() - t0) / 5;
  ok(ms < 40, `one end-of-match replay takes ${ms.toFixed(1)} ms (${log.length} inputs, ${endTick} ticks)`);

  // The WORST case, not the usual one: a match that goes the full hour. Every
  // late input rewinds by replaying, on the client as well as the server, so
  // this is the number that has to stay small — and it grew threefold when the
  // ceiling did.
  //
  // A DECIDED game stops stepping the moment it is decided, so replaying its
  // log is not the worst case — a table that never finishes is, because it
  // walks every one of the ceiling's ticks.
  const t1 = performance.now();
  for (let i = 0; i < 5; i++) replay(555, 4, [], DURATION_TICKS, DURATION_TICKS);
  const worstMs = (performance.now() - t1) / 5;
  ok(worstMs < 60, `a replay across every tick of the ${(DURATION_SEC / 60).toFixed(0)}-minute ceiling takes ${worstMs.toFixed(1)} ms (${DURATION_TICKS} ticks)`);
}

// ---- 8. the spin is the round trip ---------------------------------------
console.log("timing");
{
  const s = createState(1, 4);
  applyInput(s, 0, dieKind(4));
  ok(s.phase === "spin" && s.deadline === s.tick + SPIN_TICKS, "the die lands and the tumble runs its course");
  for (let i = 0; i < SPIN_TICKS; i++) step(s);
  ok(s.phase !== "spin", `the face is acted on ${SPIN_TICKS} ticks later`);
  ok(s.rolls === 1, "and the roll is counted once");
}

// ---- 8a. an empty chair must not cost the table ten seconds a turn --------
//
// This is the single thing that decided whether the match clock was a safety
// net or a guillotine. An absent player used to burn the full turn timer every
// time it came round — three hundred-odd times — and ONE of them was enough to
// run a match everybody else was playing properly out of clock.
console.log("away seats");
{
  /** Play a game where `afk` never answer, so their turns can only expire. */
  const withAfk = (seed: number, afk: number[], cap: number) => {
    const sim = new LudoSim(seed, 4, cap);
    const rand = rng(seed ^ 0x99);
    const misses = [0, 0, 0, 0];
    let answered = "";
    for (let tick = 1; tick <= cap; tick++) {
      sim.advanceTo(tick);
      const s = sim.state;
      if (s.over) return { mins: tick / TICK_RATE / 60, decided: s.decided, state: s };
      if (!awaitingServer(s)) continue;
      const key = `${s.turn}:${s.phase}:${s.since}`;
      if (answered === key) continue;
      const gone = afk.includes(s.turn);
      // An engaged player answers in a beat; an absent one only when the
      // server gives up at the deadline.
      if (tick - s.since < (gone ? s.deadline - s.since : 3)) continue;
      answered = key;
      // The server's own bookkeeping, as backend/games/ludo/index.ts does it.
      if (gone) {
        if (++misses[s.turn] >= AWAY_AFTER_MISSES && !s.away[s.turn]) {
          sim.addInput({ tick: tick + 1, seat: s.turn, kind: AWAY_KIND });
        }
      } else misses[s.turn] = 0;
      sim.addInput(
        s.phase === "roll"
          ? { tick: tick + 1, seat: s.turn, kind: dieKind(1 + Math.floor(rand() * 6)) }
          : { tick: tick + 1, seat: s.turn, kind: playKind(chooseToken(s, s.turn, 0.7, rand)) }
      );
    }
    return { mins: cap / TICK_RATE / 60, decided: sim.state.decided, state: sim.state };
  };

  const cap = DURATION_TICKS;
  let allDecided = true;
  let worst = 0;
  for (const afk of [[], [3], [2, 3], [0, 1, 2, 3]]) {
    for (let i = 1; i <= 12; i++) {
      const r = withAfk(i * 7919, afk, cap);
      if (!r.decided) allDecided = false;
      worst = Math.max(worst, r.mins);
    }
  }
  ok(allDecided, "with none, one, two or all four seats absent, every game still reaches a winner");
  ok(worst < DURATION_SEC / 60, `and the slowest of them took ${worst.toFixed(1)} of ${(DURATION_SEC / 60).toFixed(0)} min`);

  // An away seat keeps its turn — it is not skipped like a seat that quit —
  // it simply gets no time to think.
  const s = createState(7, 4);
  ok(s.deadline === TURN_TICKS, "a present seat gets the whole turn clock");
  applyInput(s, 0, AWAY_KIND);
  ok(s.away[0] && s.deadline === s.since, "an away seat's clock collapses, mid-turn");
  applyInput(s, 0, BACK_KIND);
  ok(!s.away[0] && s.deadline === s.since + TURN_TICKS, "and one tap gives it straight back");
  ok(stillPlaying(s).includes(0), "an away seat is still in the running — unlike one that quit");
}

// ---- 8b. running out of clock is not the same as being decided ------------
//
// The platform ends a match early once EVERY runner reports itself out, and
// calls that ending "all-out". If the clock running out also made everyone
// out, a stalemate would be reported as a finish — and the results card would
// tell four players who got nothing home that everything was home.
console.log("clock vs decided");
{
  const short = 60 * TICK_RATE; // a one-minute ceiling, so nobody can finish
  const sim = new LudoSim(4242, 4, short);
  sim.advanceTo(short);
  ok(sim.state.over, "the board freezes when the clock runs out");
  ok(!sim.state.decided, "but the game was not DECIDED");
  ok(
    [0, 1, 2, 3].every((seat) => !isOut(sim.state, seat)),
    "and no seat reports out, so the platform ends it as a timeout rather than a finish"
  );
  const done = playOut(4242, 4).sim;
  ok(done.state.decided, "a game decided by play sets `decided`");
  ok(
    [0, 1, 2, 3].every((seat) => isOut(done.state, seat)),
    "and every seat reports out, which is what ends the match early"
  );
}

// ---- 9. the server definition, driven the way the platform drives it ------
//
// Everything above tests the shared simulation. This tests the half that only
// exists on the server: that `serverInputs` answers each question exactly once
// however often it is asked, that a bot's seat plays itself, that a human's
// REQUEST turns into a move, that an empty chair is dealt with, and that the
// cold replay `rank()` performs produces a sane table.
console.log("server definition");
{
  const game = getGame("ludo")!;
  ok(!!game, "the game registers itself on import");
  ok(game.pack.bytes === 0, "and publishes no pack, so the lobby has nothing to download");
  ok(!game.planBot, "its bots are not planned up front");
  ok(!!game.serverInputs, "they react instead, through serverInputs");

  interface Seat {
    uid: string;
    seat: number;
    isBot: boolean;
    skill: number;
    left: boolean;
    sim: ReturnType<typeof game.createSim>;
    inputs: { tick: number; kind: string }[];
  }
  const ctxId = "check-match-1";
  const seed = 0xc0ffee;
  const match = { id: ctxId, players: 4 };
  const seats: Seat[] = [0, 1, 2, 3].map((seat) => ({
    uid: `u${seat}`,
    seat,
    isBot: seat > 0,
    skill: 0.65,
    left: false,
    sim: game.createSim(seed, seat, match),
    inputs: [],
  }));
  const views = () => seats.map(({ uid, seat, isBot, skill, left }) => ({ uid, seat, isBot, skill, left }));

  // A CLIENT, mirrored alongside the server. It sees exactly what a real one
  // sees — the inputs the server relays — and taps from that, which makes this
  // an end-to-end check of the whole loop rather than of the server half alone.
  // Seat 0 is the person; seats 1–3 play themselves.
  const client = new LudoSim(seed, 4, game.durationTicks);
  // The same rule the real client uses: one request per QUESTION, where a
  // question is a phase instance. Keyed rather than cleared on arrival, because
  // the answer is stamped a few ticks ahead of the tick it acts on.
  let asked = "";
  let ticks = 0;
  let answers = 0;
  let dice = 0;
  for (let tick = 1; tick <= game.durationTicks; tick++) {
    ticks = tick;
    client.advanceTo(tick);
    const view = client.state;
    // The person taps exactly as frontend/src/games/ludo/runtime.ts does: only
    // on their own turn, only what the phase is asking for, and only once until
    // the answer comes back.
    const question = `${view.turn}:${view.phase}:${view.since}`;
    if (!view.over && view.turn === 0 && asked !== question) {
      const moves = view.phase === "pick" ? legalMoves(view, 0, view.die) : [];
      const kind = view.phase === "roll" ? "roll" : moves.length ? `t${moves[0]}` : null;
      if (kind) {
        asked = question;
        const input = { tick: tick + 1, kind };
        seats[0].inputs.push(input);
        seats[0].sim.addInput(input);
        // A request is never relayed back to its sender, so the client's own
        // mirror never sees it. That is the whole point of the design.
      }
    }
    // Asked EVERY tick, which is far more often than the platform's timer —
    // if the once-per-question guard were wrong, two dice would land on one
    // roll and the parity checks below would see the divergence.
    const out = game.serverInputs!(match, seed, tick, views());
    for (const { uid, input } of out) {
      const r = seats.find((s) => s.uid === uid);
      if (!r) continue;
      answers++;
      if (input.kind[0] === "d") dice++;
      r.inputs.push(input);
      r.sim.addInput(input);
      // Relayed to everyone, the asker included.
      client.addInput({ tick: input.tick, seat: r.seat, kind: input.kind });
    }
    for (const s of seats) s.sim.advanceTo(tick);
    if (seats.every((s) => s.sim.isOut())) break;
  }
  client.advanceTo(ticks);

  ok(
    seats.every((s) => s.sim.isOut()),
    `every seat is out by tick ${ticks} (${answers} server-written inputs)`
  );
  ok(
    client.state.over,
    `the game reached a finish rather than the clock — ${(ticks / TICK_RATE / 60).toFixed(1)} of ${(game.durationTicks / TICK_RATE / 60).toFixed(0)} min`
  );
  ok(client.state.order.length >= 1, `somebody got all four home (finish order ${client.state.order.join(", ")})`);
  // ONE die per roll, and no die wasted. More dice than rolls would mean the
  // server answered a question twice — the failure the `answered` guard exists
  // to prevent, and the one that a rewind is most likely to slip past.
  ok(dice === client.state.rolls, `${dice} dice for ${client.state.rolls} rolls — exactly one each`);

  const standings = game.rank(
    seats.map((s) => ({
      uid: s.uid,
      name: s.uid,
      seat: s.seat,
      inputs: s.inputs,
      left: s.left,
      leftAtTick: null,
      isBot: s.isBot,
    })),
    ticks,
    seed
  );
  ok(standings.length === 4, "the table has a row per seat");
  const places = standings.map((s) => s.placement);
  ok(places[0] === 1, "somebody came first");
  ok(
    places.every((p, i) => i === 0 || p >= places[i - 1]),
    "placements never go backwards down the table"
  );
  const winner = standings[0];
  ok(winner.detail.home === 4, `the winner brought all four home (${winner.detail.home})`);
  // The client watched the same match from the outside and reached the same
  // conclusion as the server's cold replay. That is the netcode, end to end.
  ok(
    client.state.order[0] === seats.find((x) => x.uid === winner.uid)?.seat,
    "the client's own board agrees with the server about who won"
  );
  ok(
    standings.every((r, i) => i === 0 || r.score <= standings[i - 1].score),
    "scores never rise as placements fall — the table cannot contradict itself"
  );
  // …and that is arithmetic, not luck: the smallest gap between two places is
  // wider than the biggest garnish any board can produce.
  const gaps = PLACE_POINTS.slice(1).map((v, i) => v - PLACE_POINTS[i + 2]).filter((n) => Number.isFinite(n));
  ok(
    gaps.every((g) => g > MAX_PERFORMANCE),
    `every gap between places (${gaps.join(", ")}) exceeds the largest possible performance score (${MAX_PERFORMANCE})`
  );
  ok(
    standings.every((s) => typeof s.detail.captures === "number" && typeof s.detail.squares === "number"),
    "every row carries the numbers the results screen reads"
  );

  // The same again, with a client whose requests keep arriving from the PAST.
  //
  // Every late request marks the server's table dirty and forces it to rebuild
  // from the first input, underneath the guard that stops it answering a
  // question twice. If that guard were keyed on anything a rebuild disturbs,
  // this is where two dice would land on one roll.
  {
    const m3 = { id: "check-match-3", players: 4 };
    const seed3 = 0xbadbeef;
    const rows = [0, 1, 2, 3].map((seat) => ({
      uid: `w${seat}`,
      seat,
      isBot: seat > 0,
      skill: 0.6,
      left: false,
      sim: game.createSim(seed3, seat, m3),
      inputs: [] as { tick: number; kind: string }[],
    }));
    const view3 = () => rows.map(({ uid, seat, isBot, skill, left }) => ({ uid, seat, isBot, skill, left }));
    const mirror = new LudoSim(seed3, 4, game.durationTicks);
    let asked3 = "";
    let dice3 = 0;
    let late = 0;
    let end3 = 0;
    for (let tick = 1; tick <= game.durationTicks; tick++) {
      end3 = tick;
      mirror.advanceTo(tick);
      const v = mirror.state;
      const q = `${v.turn}:${v.phase}:${v.since}`;
      if (!v.over && v.turn === 0 && asked3 !== q) {
        const moves = v.phase === "pick" ? legalMoves(v, 0, v.die) : [];
        const kind = v.phase === "roll" ? "roll" : moves.length ? `t${moves[0]}` : null;
        if (kind) {
          asked3 = q;
          // Stamped ten ticks in the PAST — inside the platform's late window,
          // and behind everything the server has already simulated.
          const input = { tick: Math.max(1, tick - 10), kind };
          rows[0].inputs.push(input);
          rows[0].sim.addInput(input);
          late++;
        }
      }
      for (const { uid, input } of game.serverInputs!(m3, seed3, tick, view3())) {
        const r = rows.find((x) => x.uid === uid);
        if (!r) continue;
        if (input.kind[0] === "d") dice3++;
        r.inputs.push(input);
        r.sim.addInput(input);
        mirror.addInput({ tick: input.tick, seat: r.seat, kind: input.kind });
      }
      for (const r of rows) r.sim.advanceTo(tick);
      if (rows.every((r) => r.sim.isOut())) break;
    }
    mirror.advanceTo(end3);
    ok(late > 20, `${late} requests arrived from the past`);
    ok(mirror.state.over, "the table still reached a finish under constant rewinding");
    ok(dice3 === mirror.state.rolls, `${dice3} dice for ${mirror.state.rolls} rolls — still exactly one each`);
  }

  // THE WINNER IS THE ONE MOST LIKELY TO LEAVE.
  //
  // Ludo runs on after the first player is home — the others are still racing
  // for second and third — so whoever won has no legal action, no turn, and up
  // to twenty more minutes of the platform's Leave button on screen. A twenty
  // second signal drop does the same thing without them touching anything.
  // Ranking on "did they leave" alone therefore records the player who won the
  // game as last, docks their XP, and tells them "you left the game".
  {
    const firstOut = playOutUntilFirstHome(0x1eaf, 4);
    ok(firstOut !== null, "a game in which one player is home while others still play");
    if (firstOut) {
      const { log, winner, endTick } = firstOut;
      // …and then they leave, exactly as the platform would record it.
      const quitTick = endTick + 1;
      log.push({ tick: quitTick, seat: winner, kind: QUIT_KIND });
      const standings = game.rank(
        [0, 1, 2, 3].map((seat) => ({
          uid: `z${seat}`,
          name: `z${seat}`,
          seat,
          inputs: log.filter((i) => i.seat === seat).map(({ tick, kind }) => ({ tick, kind })),
          left: seat === winner,
          leftAtTick: seat === winner ? quitTick : null,
          isBot: false,
        })),
        quitTick + 1,
        0x1eaf
      );
      const row = standings.find((r) => r.uid === `z${winner}`)!;
      ok(row.placement === 1, `the player who got all four home is still first (was #${row.placement})`);
      ok(!row.forfeit, "and is not recorded as having forfeited");
      ok(row.detail.home === 4, `their row still reads 4/4 home (${row.detail.home})`);
      ok(
        standings.every((r) => r.uid === row.uid || r.score <= row.score),
        "and nobody who stayed out-scores them"
      );
    }
  }

  // The SERVER's side of it: a seat that never answers is declared away, once,
  // and any request at all — on anyone's turn — brings it straight back.
  {
    const m4 = { id: "check-match-4", players: 4 };
    const seatViews = [0, 1, 2, 3].map((seat) => ({
      uid: `y${seat}`,
      seat,
      isBot: seat > 0,
      skill: 0.6,
      left: false,
    }));
    const sims = seatViews.map((v) => game.createSim(seed, v.seat, m4));
    const mirror = new LudoSim(seed, 4, game.durationTicks);
    let aways = 0;
    let backs = 0;
    let nudgedAt = -1;
    let seenAwayAt = -1;
    let cameBack = false;
    // Long enough for a silent seat's turn to come round several times: it
    // takes AWAY_AFTER_MISSES unanswered questions, and its own turn is the
    // slow one in every round precisely because nobody is answering it.
    for (let tick = 1; tick <= 180 * TICK_RATE; tick++) {
      mirror.advanceTo(tick);
      // Seat 0 says nothing at all… until it has been declared away, and then
      // it taps once, whosever turn it is.
      if (mirror.state.away[0] && seenAwayAt < 0) seenAwayAt = tick;
      // A moment later, as a person would — a request stamped at or before the
      // instant they were declared away was sent before they knew, and is
      // rightly ignored.
      if (seenAwayAt > 0 && nudgedAt < 0 && tick > seenAwayAt + 10) {
        nudgedAt = tick;
        sims[0].addInput({ tick, kind: "roll" });
      }
      if (nudgedAt > 0 && !mirror.state.away[0]) cameBack = true;
      for (const { uid, input } of game.serverInputs!(m4, seed, tick, seatViews)) {
        const seat = seatViews.findIndex((v) => v.uid === uid);
        if (input.kind === "away") aways++;
        if (input.kind === "back") backs++;
        sims[seat].addInput(input);
        mirror.addInput({ tick: input.tick, seat, kind: input.kind });
      }
      for (const sm of sims) sm.advanceTo(tick);
    }
    ok(aways >= 1, `a silent seat is declared away (${aways}x — it goes quiet again after its one tap)`);
    ok(nudgedAt > 0, "…and the table stopped waiting for it");
    ok(backs === 1, `its one tap is answered with exactly one "back" (${backs})`);
    ok(cameBack, "and the board really did give it the clock again");
  }

  // An empty chair: said once, and only once, however often it is asked.
  const m2 = { id: "check-match-2", players: 4 };
  const s2 = [0, 1, 2, 3].map((seat) => ({
    uid: `v${seat}`,
    seat,
    isBot: seat > 0,
    skill: 0.5,
    left: seat === 0,
  }));
  for (const v of s2) game.createSim(seed, v.seat, m2);
  let quits = 0;
  for (let tick = 1; tick <= 40; tick++) {
    for (const { input } of game.serverInputs!(m2, seed, tick, s2)) {
      if (input.kind === "quit") quits++;
    }
  }
  ok(quits === 1, `a seat that walked out is announced exactly once (${quits})`);
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
