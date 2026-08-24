// The carrom simulation — deterministic, fixed-step, shared by both sides.
//
// ONE instance holds the whole board, exactly as Ludo's does and for the same
// reason: the players are all touching the same discs, so a per-player
// simulation could not answer the only question that matters — where is that
// coin now. The server keeps one per match and hands each runner a thin view of
// it (see backend games/carrom).
//
// WHY NOTHING A PLAYER SENDS MOVES A DISC
//
// The platform relays an input to everyone EXCEPT its sender and acknowledges
// nothing. A client that fired its own striker would therefore be the one
// participant unable to discover that nobody else had, and one dropped packet
// would leave two boards that can never be reconciled. So a flick is a REQUEST
// (`a…`): it travels on the ordinary input channel and this simulation ignores
// it completely. The SERVER reads the request off its own board, decides
// whether it is legal, and writes the shot as its own input (`s…`), which
// reaches every table — including the one that asked — through the same relay.
//
// Three things fall out of that, all wanted. Every table applies an identical
// set of rule-bearing inputs in an identical order, forever. A dropped flick is
// merely a flick that did not happen — the turn clock runs on and the server
// takes the shot for you. And the striker's placement is settled once, on the
// server, so a modified client cannot set it down on top of a coin.
//
// The round trip is hidden the way Ludo hides the dice: the striker springs off
// its own base line the instant SHOOT is pressed, and the answer is back long
// before that animation ends.
//
// DETERMINISM. The rules are physics's rules — see physics.ts, which explains
// why only +, -, *, / and Math.sqrt appear anywhere a coin is moved. Everything
// else is the usual discipline: never read the wall clock or Math.random, apply
// inputs in one fixed order, and treat an input stamped tick T as happening at
// the start of tick T's step however late it arrived.
import {
  BODY_COUNT,
  COIN_COUNT,
  KIND,
  KIND_QUEEN,
  LAYOUT,
  QUEEN_INDEX,
  STRIKER_INDEX,
  baseSpot,
  coinTeam,
  freeSlot,
  nearestFreeSlot,
  toWorld,
} from "./board.js";
import {
  MAX_SPEED,
  MIN_SPEED,
  anyMoving,
  stepBodies,
  type Bodies,
  type ShotLog,
} from "./physics.js";
import {
  BEAT_TICKS,
  COINS_PER_TEAM,
  DURATION_TICKS,
  PLACE_POINTS,
  POINTS_PER_COIN,
  POINTS_QUEEN,
  SHOOT_MAX_TICKS,
  STALL_TICKS,
  TURN_TICKS,
  sideOf,
  seatsOfTeam,
  teamOf,
  turnOrder,
} from "./rules.js";

/** ---------------------------------------------------------------------------
 *  Inputs.
 *
 *  A flick is four whole numbers in the SHOOTER'S OWN FRAME — they are always
 *  at the bottom of their own screen, so this is the only frame a player has an
 *  opinion in:
 *
 *      t   −1000…1000  where along the base line the striker is set down
 *      dx  −1000…1000  aim, across
 *      dy  −1000…1000  aim, along the board — ANY direction, including back
 *                      towards the shooter's own frame
 *      p      0…1000   power
 *
 *  The aim used to be forward-only, on the reasoning that a real striker is
 *  always struck away from the base line. On a board that was simply wrong to
 *  do: it put a hard stop at each end of the sweep, so the aim could not be
 *  turned through a full circle, and a player trying to reach a coin sitting
 *  behind their own line had no shot at all — not even the bank off their own
 *  frame that a real player would take. The only rule left is that a flick has
 *  to go SOMEWHERE: dx and dy may not both be zero.
 *
 *  Integers, and not because they are small on the wire. They are what makes
 *  the shot reproducible: the simulation turns them into a velocity with one
 *  square root and two divisions, all of which are correctly rounded, so the
 *  same four numbers are the same shot on every device forever.
 * ------------------------------------------------------------------------- */

/** A flick the player is ASKING for. Moves nothing. */
export const askKind = (t: number, dx: number, dy: number, p: number): string => `a${t},${dx},${dy},${p}`;
/** WHAT A PLAYER IS CURRENTLY THINKING OF DOING — where they have slid the
 *  striker, where they are pointing it, how hard they have wound it up.
 *
 *  Moves nothing, decides nothing, and the simulation ignores it exactly as it
 *  ignores a request. It exists so that the other three people at the table can
 *  WATCH somebody line a shot up, which is most of what sitting at a carrom
 *  board is. Without it the first anyone else knew of a shot was the shot.
 *
 *  Deliberately its own kind rather than a stream of `a…` requests: the server
 *  reads a request as "take my shot now", so an aim sent that way would fire
 *  the striker the moment a thumb moved. */
export const aimKind = (t: number, dx: number, dy: number, p: number): string => `m${t},${dx},${dy},${p}`;
/** The flick the SERVER decided on. This is the only thing that fires a striker. */
export const shotKind = (t: number, dx: number, dy: number, p: number): string => `s${t},${dx},${dy},${p}`;
/** "I am still here" — any touch, any time, whosever turn it is. Moves nothing;
 *  it exists so an away seat has something to send that is not a flick. */
export const NUDGE_KIND = "n";
/** The server: this chair is empty / this chair has stopped answering / it is
 *  answering again. */
export const QUIT_KIND = "q";
export const AWAY_KIND = "w";
export const BACK_KIND = "b";

/** The longest a kind may be: `s-1000,-1000,-1000,1000` is 22 characters. */
const KIND_MAX = 24;

export interface ShotParams {
  t: number;
  dx: number;
  dy: number;
  p: number;
}

export type Parsed =
  | { type: "ask"; shot: ShotParams }
  | { type: "aim"; shot: ShotParams }
  | { type: "nudge" }
  | { type: "shot"; shot: ShotParams }
  | { type: "quit" }
  | { type: "away"; gone: boolean };

/** A strict small-integer reader. Deliberately not parseInt, which happily
 *  reads "12abc" as 12 and "" as NaN — a kind arriving off the wire is
 *  attacker-controlled text and gets no benefit of the doubt. */
function readInt(s: string, lo: number, hi: number): number | null {
  const n = s.length;
  if (n === 0 || n > 5) return null;
  let i = 0;
  let sign = 1;
  if (s.charCodeAt(0) === 45) {
    if (n === 1) return null;
    sign = -1;
    i = 1;
  }
  let v = 0;
  for (; i < n; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return null;
    v = v * 10 + c;
  }
  v *= sign;
  return v < lo || v > hi ? null : v;
}

function readShot(body: string): ShotParams | null {
  const parts = body.split(",");
  if (parts.length !== 4) return null;
  const t = readInt(parts[0], -1000, 1000);
  const dx = readInt(parts[1], -1000, 1000);
  const dy = readInt(parts[2], -1000, 1000);
  const p = readInt(parts[3], 0, 1000);
  if (t === null || dx === null || dy === null || p === null) return null;
  // A direction of nothing is not a direction: normalising it would divide by
  // zero and the striker would come out with a velocity of NaN, which is a
  // board that never settles.
  if (dx === 0 && dy === 0) return null;
  return { t, dx, dy, p };
}

/** Read one input kind. Unknown kinds parse to null and are ignored the same
 *  way everywhere, so a modified client that invents one changes nothing. */
export function parseInput(kind: string): Parsed | null {
  if (typeof kind !== "string" || kind.length === 0 || kind.length > KIND_MAX) return null;
  if (kind === NUDGE_KIND) return { type: "nudge" };
  if (kind === QUIT_KIND) return { type: "quit" };
  if (kind === AWAY_KIND) return { type: "away", gone: true };
  if (kind === BACK_KIND) return { type: "away", gone: false };
  const head = kind[0];
  if (head !== "a" && head !== "s" && head !== "m") return null;
  const shot = readShot(kind.slice(1));
  if (!shot) return null;
  if (head === "a") return { type: "ask", shot };
  if (head === "m") return { type: "aim", shot };
  return { type: "shot", shot };
}

/** Kinds a PLAYER may send. Requests only: the shot itself, the empty chair and
 *  the away flags are the server's to write, and the input handler refuses them
 *  from a socket on the way in. */
export function isInputKind(kind: unknown): kind is string {
  if (typeof kind !== "string") return false;
  const p = parseInput(kind);
  return p !== null && (p.type === "ask" || p.type === "aim" || p.type === "nudge");
}

/** Does this kind actually move something?
 *
 *  Requests and aims do not, so they never enter a log. Keeping them out costs
 *  nothing and denies a modified client a very cheap trick: six late requests a
 *  second, each stamped behind the play head, would otherwise make every table
 *  in the match rebuild itself six times a second. It is also what lets a live
 *  aim be broadcast several times a turn without any of it touching the board. */
export function movesBoard(kind: string): boolean {
  const p = parseInput(kind);
  return p !== null && (p.type === "shot" || p.type === "quit" || p.type === "away");
}

/** One input, tagged with the seat that made it. */
export interface CarromInput {
  tick: number;
  seat: number;
  kind: string;
}

/** THE order inputs are applied in, everywhere: by tick, then by seat.
 *
 *  Deliberately NOT extended to break ties on the kind as well — see the same
 *  note in Ludo's sim. Two inputs with one tick and one seat were written by
 *  the server in a single batch and every table receives them in that order; a
 *  stable sort keeps it, and JavaScript's sort has been stable since ES2019. */
export const order = (a: CarromInput, b: CarromInput): number => a.tick - b.tick || a.seat - b.seat;

export type Phase =
  /** Waiting for the server's shot. The turn clock is running. */
  | "aim"
  /** Discs are moving. Nobody decides anything until they stop. */
  | "shoot"
  /** They stopped: a beat to read what happened before the next player. */
  | "beat"
  | "over";

export type Foul = "" | "striker" | "miss";

/** What the last resolved shot did. Rules, not decoration — `again` is read by
 *  the step that chooses the next player — but it is also everything the HUD
 *  needs to say what just happened, which is why it is one record. */
export interface ShotResult {
  seat: number;
  /** Coins of the shooter's own colour that stayed down. */
  own: number;
  /** Coins of the other colour that went down (they count for the other side). */
  opp: number;
  /** The queen went down and stayed down. */
  queen: boolean;
  /** The queen went down and came back — uncovered, or taken too early. */
  queenReturned: boolean;
  foul: Foul;
  /** Discs put back on the board by that foul. */
  returned: number;
  /** The same seat shoots again. */
  again: boolean;
}

/** The flick in flight. */
export interface Shot extends ShotParams {
  seat: number;
  /** Where the striker was actually set down, after the base line was checked
   *  for coins — this, not `t`, is what the painter should draw. */
  slot: number;
  startedAt: number;
}

export interface CarromState extends Bodies {
  /** The match seed. Used for one thing only: the stall-breaking flick. */
  seed: number;
  tick: number;
  /** 2 (singles) or 4 (doubles). */
  players: number;
  /** Which body each disc is. Static, but carried on the state so a painter or
   *  a check never has to import the board to ask. */
  kind: readonly number[];
  turn: number;
  phase: Phase;
  /** Tick the current phase began — the painter's clock. */
  since: number;
  /** For `shoot` and `beat`, the tick the phase gives up and resolves itself.
   *  For `aim`, the tick the player's time runs out, after which the SERVER
   *  flicks for them. The simulation does not act on that one — it is drawn as
   *  the turn clock, and the server is what keeps the promise. */
  deadline: number;
  /** Shots taken so far. The stall breaker's sequence number. */
  shots: number;
  shot: Shot | null;
  /** Accumulated across the shot in flight. */
  log: ShotLog;
  last: ShotResult | null;
  /** Coins each seat personally sank for their own side. Never decremented: a
   *  foul takes a coin off the board, not off a career. */
  coinsBy: number[];
  fouls: number[];
  /** The seat that owes a cover for the queen, or -1. */
  queenPending: number;
  /** The seat that covered it, or -1. */
  queenBy: number;
  /** Seats that walked out. Skipped in the turn order. */
  quit: boolean[];
  /** Seats that stopped answering. UNLIKE `quit` they keep their turn and keep
   *  playing — they simply get no time to think, so an empty chair costs the
   *  table a moment rather than fourteen seconds. One touch and it is theirs
   *  again. */
  away: boolean[];
  /** The side that cleared its nine, or that was left standing. -1 while the
   *  board is still being played, and STILL -1 when the clock runs out — that
   *  is a result computed from the coins, not a win (see `outcome`). */
  winner: number;
  /** Decided BY PLAY. Kept apart from `over` for the reason Ludo learned: the
   *  platform ends a match early once every runner reports itself out, and
   *  calls that ending "all-out". If running out of clock also made everyone
   *  out, a half-hour stalemate would be announced as though somebody had won
   *  it. */
  decided: boolean;
  decidedAt: number;
  /** The board is frozen — decided, or out of clock. */
  over: boolean;
}

/** ---------------------------------------------------------------------------
 *  The stall-breaking flick.
 *
 *  Reached only when the server has authored nothing for a full STALL_TICKS
 *  past a turn that had already run out — which is a server that has stopped
 *  answering, not a slow one. A pure integer hash of the seed and the shot's
 *  sequence number, so every table breaks the stall the same way on the same
 *  tick and the board survives rather than freezing. Predictable, but only ever
 *  reached when something is already badly wrong.
 *
 *  Math.imul throughout, so the multiplications wrap identically in every
 *  engine — the same reason Ludo's stall die and the runner's course generator
 *  use it.
 * ------------------------------------------------------------------------- */
function hash32(seed: number, index: number, salt: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

export function stallShot(seed: number, index: number): ShotParams {
  return {
    t: (hash32(seed, index, 0) % 1201) - 600,
    dx: (hash32(seed, index, 1) % 1201) - 600,
    dy: 250 + (hash32(seed, index, 2) % 751),
    p: 380 + (hash32(seed, index, 3) % 521),
  };
}

/** ---------------------------------------------------------------------------
 *  State.
 * ------------------------------------------------------------------------- */

export function createState(seed: number, players: number): CarromState {
  const n = players >= 3 ? 4 : 2;
  const x: number[] = [];
  const y: number[] = [];
  const vx: number[] = [];
  const vy: number[] = [];
  const alive: number[] = [];
  for (let i = 0; i < BODY_COUNT; i++) {
    const spot = i < COIN_COUNT ? LAYOUT[i] : { x: 0, y: 0 };
    x.push(spot.x);
    y.push(spot.y);
    vx.push(0);
    vy.push(0);
    // The striker is only on the board while a shot is in flight.
    alive.push(i < COIN_COUNT ? 1 : 0);
  }
  return {
    seed,
    tick: 0,
    players: n,
    kind: KIND,
    x,
    y,
    vx,
    vy,
    alive,
    // WHO BREAKS IS DRAWN FROM THE SEED, not always seat 0.
    //
    // Breaking is a measurable DISADVANTAGE at carrom — the opener scatters the
    // pack and hands the next player an open board — and with a fixed opener
    // that lands on the same seat every match. Measured over 150 bot boards
    // before this change, the side that always opened won 36% of them, which is
    // an unfairness nothing on the board could explain. The seed is known to
    // every client and to the server, so drawing it costs nothing and every
    // table agrees.
    turn: turnOrder(n)[hash32(seed, 0, 7) % n],
    phase: "aim",
    since: 0,
    deadline: TURN_TICKS,
    shots: 0,
    shot: null,
    log: { pocketed: [], contact: false },
    last: null,
    coinsBy: Array.from({ length: n }, () => 0),
    fouls: Array.from({ length: n }, () => 0),
    queenPending: -1,
    queenBy: -1,
    quit: Array.from({ length: n }, () => false),
    away: Array.from({ length: n }, () => false),
    winner: -1,
    decided: false,
    decidedAt: -1,
    over: false,
  };
}

export function cloneState(s: CarromState): CarromState {
  return {
    ...s,
    x: s.x.slice(),
    y: s.y.slice(),
    vx: s.vx.slice(),
    vy: s.vy.slice(),
    alive: s.alive.slice(),
    log: { pocketed: s.log.pocketed.slice(), contact: s.log.contact },
    shot: s.shot ? { ...s.shot } : null,
    last: s.last ? { ...s.last } : null,
    coinsBy: s.coinsBy.slice(),
    fouls: s.fouls.slice(),
    quit: s.quit.slice(),
    away: s.away.slice(),
  };
}

/** Coins of a side that are off the board. The measure the whole game turns on:
 *  nine of them wins it. */
export function teamPocketed(s: CarromState, team: number): number {
  let n = 0;
  for (let i = 0; i < COIN_COUNT; i++) {
    if (!s.alive[i] && coinTeam(s.kind[i]) === team) n++;
  }
  return n;
}

/** May this side take the queen? Only after it has one of its own coins down —
 *  the paper rule, and the reason nobody opens by potting the queen. */
export const queenAllowed = (s: CarromState, team: number): boolean => teamPocketed(s, team) > 0;

/** Ticks a seat gets to think. A chair nobody is sitting in gets none. */
const budget = (s: CarromState, seat: number): number => (s.quit[seat] || s.away[seat] ? 0 : TURN_TICKS);

/** Is the simulation waiting on the server rather than on itself? */
export const awaitingServer = (s: CarromState): boolean => s.phase === "aim";

/** Has this seat stopped playing? The platform ends a match when this is true
 *  of everyone — which is why it reads `decided` and not `over`: a board that
 *  merely ran out of clock was not won by anybody. */
export const isOut = (s: CarromState, seat: number): boolean => s.decided || s.quit[seat];

/** What a seat's play was worth, ignoring which side won. Bounded on purpose:
 *  see the note above PLACE_POINTS — this has to stay smaller than the gap
 *  between the two places or the results table contradicts itself. */
export const performanceOf = (s: CarromState, seat: number): number =>
  Math.min(s.coinsBy[seat], COINS_PER_TEAM) * POINTS_PER_COIN + (s.queenBy === seat ? POINTS_QUEEN : 0);

/** The number the results table prints: a place, plus that garnish. */
export const scoreOf = (s: CarromState, seat: number, placement: number): number =>
  (PLACE_POINTS[placement] ?? 0) + performanceOf(s, seat);

/** Who won, however the board ended. -1 is a genuine draw.
 *
 *  A board decided by play answers itself. A board that ran out of clock is
 *  decided on coins, then on the queen, and a table level on both really is
 *  level — saying otherwise would invent a winner. */
export function outcome(s: CarromState): number {
  if (s.winner >= 0) return s.winner;
  const a = teamPocketed(s, 0);
  const b = teamPocketed(s, 1);
  if (a !== b) return a > b ? 0 : 1;
  if (s.queenBy >= 0) return teamOf(s.queenBy, s.players);
  return -1;
}

/** ---------------------------------------------------------------------------
 *  Turn machinery.
 * ------------------------------------------------------------------------- */

function stopAll(s: CarromState): void {
  for (let i = 0; i < BODY_COUNT; i++) {
    s.vx[i] = 0;
    s.vy[i] = 0;
  }
  s.alive[STRIKER_INDEX] = 0;
}

function finish(s: CarromState, winner: number): void {
  s.winner = winner;
  s.decided = true;
  s.decidedAt = s.tick;
  s.over = true;
  s.phase = "over";
  s.shot = null;
  s.deadline = Number.MAX_SAFE_INTEGER;
  stopAll(s);
}

/** Has one side been left alone at the board? Then there is nothing left to
 *  play and the other side takes it. */
function checkAbandoned(s: CarromState): boolean {
  if (s.over) return true;
  const here0 = seatsOfTeam(0, s.players).some((seat) => !s.quit[seat]);
  const here1 = seatsOfTeam(1, s.players).some((seat) => !s.quit[seat]);
  if (here0 && here1) return false;
  finish(s, here0 ? 0 : here1 ? 1 : -1);
  return true;
}

function startTurn(s: CarromState, seat: number): void {
  s.turn = seat;
  s.phase = "aim";
  s.since = s.tick;
  s.deadline = s.tick + budget(s, seat);
}

function nextTurn(s: CarromState): void {
  if (checkAbandoned(s)) return;
  const order2 = turnOrder(s.players);
  const at = order2.indexOf(s.turn);
  for (let k = 1; k <= order2.length; k++) {
    const seat = order2[(at + k) % order2.length];
    if (!s.quit[seat]) {
      startTurn(s, seat);
      return;
    }
  }
  // Unreachable while checkAbandoned holds; leaving the turn where it is beats
  // spinning.
  startTurn(s, s.turn);
}

/** Fire the striker. Everything that can go wrong with a placement is settled
 *  HERE — once, in shared code — so the client's preview, the server's shot and
 *  every replay put the striker on the same square inch. */
function beginShot(s: CarromState, p: ShotParams): void {
  const seat = s.turn;
  const side = sideOf(seat, s.players);
  const slot = nearestFreeSlot(side, p.t / 1000, s.x, s.y, s.alive);
  const spot = baseSpot(slot);
  const at = toWorld(side, spot.x, spot.y);
  const len = Math.sqrt(p.dx * p.dx + p.dy * p.dy);
  const dir = toWorld(side, p.dx / len, p.dy / len);
  const speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * (p.p / 1000);
  s.x[STRIKER_INDEX] = at.x;
  s.y[STRIKER_INDEX] = at.y;
  s.vx[STRIKER_INDEX] = dir.x * speed;
  s.vy[STRIKER_INDEX] = dir.y * speed;
  s.alive[STRIKER_INDEX] = 1;
  s.log.pocketed.length = 0;
  s.log.contact = false;
  s.shot = { seat, slot, t: p.t, dx: p.dx, dy: p.dy, p: p.p, startedAt: s.tick };
  s.shots += 1;
  s.phase = "shoot";
  s.since = s.tick;
  s.deadline = s.tick + SHOOT_MAX_TICKS;
}

/** Put one disc back on the board, on the centre spot or as near to it as there
 *  is room for — the paper rule, and `freeSlot` is asked afresh for each one so
 *  that two returning coins never land on top of each other. */
function returnDisc(s: CarromState, i: number): void {
  const spot = freeSlot(s.x, s.y, s.alive);
  s.x[i] = spot.x;
  s.y[i] = spot.y;
  s.vx[i] = 0;
  s.vy[i] = 0;
  s.alive[i] = 1;
}

/** Which already-pocketed coin a foul gives back. Lowest index first, so the
 *  choice is the same on every table and does not depend on the order things
 *  happened to be sunk in. */
function penaltyCoin(s: CarromState, team: number, exclude: readonly number[]): number {
  for (let i = 0; i < COIN_COUNT; i++) {
    if (s.alive[i]) continue;
    if (coinTeam(s.kind[i]) !== team) continue;
    if (exclude.indexOf(i) >= 0) continue;
    return i;
  }
  return -1;
}

/** The discs have stopped. Work out what the shot was worth. */
function resolveShot(s: CarromState): void {
  const shot = s.shot;
  const seat = shot ? shot.seat : s.turn;
  const team = teamOf(seat, s.players);

  // The striker comes off the board whatever happened to it.
  let strikerIn = false;
  let own = 0;
  let opp = 0;
  let queenIn = false;
  const sunkOwn: number[] = [];
  for (const idx of s.log.pocketed) {
    if (idx === STRIKER_INDEX) {
      strikerIn = true;
      continue;
    }
    const k = s.kind[idx];
    if (k === KIND_QUEEN) {
      queenIn = true;
      continue;
    }
    if (coinTeam(k) === team) {
      own++;
      sunkOwn.push(idx);
    } else {
      opp++;
    }
  }
  s.alive[STRIKER_INDEX] = 0;
  s.vx[STRIKER_INDEX] = 0;
  s.vy[STRIKER_INDEX] = 0;

  const foul: Foul = strikerIn ? "striker" : s.log.contact ? "" : "miss";
  const returns: number[] = [];
  let queenReturned = false;

  // A cover that was owed from the previous shot is settled first: this shot
  // either pays it or the queen goes back.
  if (s.queenPending === seat) {
    s.queenPending = -1;
    if (!foul && own > 0) {
      s.queenBy = seat;
    } else {
      queenReturned = true;
      returns.push(QUEEN_INDEX);
    }
  }

  if (foul) {
    s.fouls[seat] += 1;
    // Anything of the shooter's own that went down on a foul shot comes back.
    // The other side's coins do NOT: they are down, and they count for whoever
    // they belong to, which is the harsher and the standard reading.
    for (const i of sunkOwn) returns.push(i);
    if (queenIn) {
      queenReturned = true;
      returns.push(QUEEN_INDEX);
    }
  } else if (queenIn) {
    // `own` has already been taken off the board, so "have they got one down
    // ALREADY" has to discount this shot's own pockets.
    if (teamPocketed(s, team) - own > 0) {
      if (own > 0) s.queenBy = seat;
      else s.queenPending = seat;
    } else {
      queenReturned = true;
      returns.push(QUEEN_INDEX);
    }
  }

  if (foul) {
    const p = penaltyCoin(s, team, returns);
    if (p >= 0) returns.push(p);
  } else {
    s.coinsBy[seat] += own;
  }
  for (const i of returns) returnDisc(s, i);

  const again = !foul && (own > 0 || (queenIn && !queenReturned));
  s.last = {
    seat,
    own: foul ? 0 : own,
    opp,
    queen: queenIn && !queenReturned,
    queenReturned,
    foul,
    returned: returns.length,
    again,
  };
  s.shot = null;

  // The board is won by clearing nine. The shooter's own side is asked first,
  // so a shot that somehow finished both sides at once is credited to the
  // person who played it.
  if (teamPocketed(s, team) === COINS_PER_TEAM) {
    finish(s, team);
    return;
  }
  const other = team === 0 ? 1 : 0;
  if (teamPocketed(s, other) === COINS_PER_TEAM) {
    finish(s, other);
    return;
  }
  if (checkAbandoned(s)) return;
  s.phase = "beat";
  s.since = s.tick;
  s.deadline = s.tick + BEAT_TICKS;
}

/** Apply one input AT its tick.
 *
 *  Player requests are read and discarded: they exist so the SERVER can learn
 *  what somebody wants, and they are relayed to the other tables only so those
 *  tables can show that a hand is on the striker. Nothing here moves on them. */
export function applyInput(s: CarromState, seat: number, kind: string): void {
  if (s.over || seat < 0 || seat >= s.players) return;
  const input = parseInput(kind);
  if (!input) return;
  switch (input.type) {
    case "ask":
    case "aim":
    case "nudge":
      return;
    case "away": {
      if (s.away[seat] === input.gone) return;
      s.away[seat] = input.gone;
      // Their clock changes the moment they do, including mid-turn: an absent
      // seat stops holding the table up, and a returning one is not rushed.
      if (seat === s.turn && s.phase === "aim") s.deadline = s.since + budget(s, seat);
      return;
    }
    case "quit": {
      if (s.quit[seat]) return;
      s.quit[seat] = true;
      if (checkAbandoned(s)) return;
      // An empty chair does not take its shot: the turn moves on at once
      // rather than waiting for the server to flick on its behalf.
      if (seat === s.turn && s.phase === "aim") nextTurn(s);
      return;
    }
    case "shot":
      if (s.phase !== "aim" || seat !== s.turn) return;
      beginShot(s, input.shot);
      return;
  }
}

/** Advance exactly one tick. */
export function step(s: CarromState, durationTicks: number = DURATION_TICKS): void {
  s.tick += 1;
  if (s.over) return;
  if (s.tick >= durationTicks) {
    // The clock ran out. The board freezes exactly as it stands and the result
    // is read off the coins — see `outcome`, and note that `decided` stays
    // false, which is what stops this being announced as a win.
    s.over = true;
    s.phase = "over";
    s.shot = null;
    stopAll(s);
    return;
  }
  if (s.phase === "shoot") {
    stepBodies(s, s.log);
    if (!anyMoving(s) || s.tick >= s.deadline) resolveShot(s);
    return;
  }
  if (s.phase === "aim") {
    if (s.tick >= s.deadline + STALL_TICKS) beginShot(s, stallShot(s.seed, s.shots));
    return;
  }
  if (s.phase === "beat" && s.tick >= s.deadline) {
    const last = s.last;
    if (last && last.again && !s.quit[last.seat]) startTurn(s, last.seat);
    else nextTurn(s);
  }
}

/** Run a fresh board through an input log up to `toTick`. */
export function replay(
  seed: number,
  players: number,
  inputs: readonly CarromInput[],
  toTick: number,
  durationTicks: number = DURATION_TICKS
): CarromState {
  const s = createState(seed, players);
  const sorted = inputs.filter((i) => movesBoard(i.kind)).sort(order);
  let i = 0;
  while (s.tick < toTick && !s.over) {
    const next = s.tick + 1;
    while (i < sorted.length && sorted[i].tick <= next) {
      applyInput(s, sorted[i].seat, sorted[i].kind);
      i++;
    }
    step(s, durationTicks);
  }
  // A finished board still has to reach the tick it was asked for, so "what
  // tick is it" has one answer whether or not the discs have settled.
  if (s.tick < toTick) s.tick = toTick;
  return s;
}

/** ---------------------------------------------------------------------------
 *  CarromSim — the board, its input log, and the bookkeeping that keeps a late
 *  input cheap.
 *
 *  Shared by the client (which draws it) and the server (which judges it) on
 *  purpose: an incremental fast path here and a replay there is exactly how the
 *  two would drift apart, so there is one implementation of both.
 *
 *  THE KEYFRAME is the one thing this has that Ludo's does not, and it is not
 *  an optimisation for its own sake. Rewinding in a board game means replaying
 *  from the beginning, and in Ludo "the beginning" is a few thousand integer
 *  comparisons. Here it is every collision of every shot of the whole match —
 *  tens of milliseconds by the twentieth minute, on the client's animation
 *  thread, for one input that arrived a frame late. So the sim keeps a copy of
 *  the board taken at the top of the current turn, when nothing is moving and
 *  the copy is twenty discs' worth of numbers, and rewinds to THAT instead. An
 *  input older than the keyframe throws it away and the full replay happens, as
 *  it must.
 * ------------------------------------------------------------------------- */
interface Keyframe {
  tick: number;
  cursor: number;
  state: CarromState;
}

export class CarromSim {
  state: CarromState;
  private logInputs: CarromInput[] = [];
  /** Index of the next input not yet applied on the incremental path. */
  private cursor = 0;
  /** An input arrived for a tick already simulated — rebuild before trusting. */
  private dirty = false;
  private key: Keyframe | null = null;

  constructor(
    readonly seed: number,
    readonly players: number,
    private durationTicks: number = DURATION_TICKS
  ) {
    this.state = createState(seed, players);
  }

  get inputs(): readonly CarromInput[] {
    return this.logInputs;
  }

  /** Record an input, IN ORDER.
   *
   *  Inserted at its sorted position rather than appended — Ludo's hardest-won
   *  line, and it is exactly as load-bearing here. The incremental path applies
   *  a tick's inputs in log order; a rewind applies them in SORTED order. If
   *  those two orders can differ then a client that happened to rewind and one
   *  that did not end up with different boards, and they CAN differ, because
   *  the server may write several inputs on one tick and a client's own
   *  requests thread in between the ones it receives.
   *
   *  Ties on (tick, seat) keep their arrival order, which is the order the
   *  server emitted them and therefore the same everywhere. */
  addInput(input: CarromInput): void {
    if (!movesBoard(input.kind)) return;
    let i = this.logInputs.length;
    while (i > 0 && order(this.logInputs[i - 1], input) > 0) i--;
    this.logInputs.splice(i, 0, input);
    // Behind the play head, or behind what the incremental path has already
    // applied: either way the board in hand was built without it.
    if (input.tick <= this.state.tick || i < this.cursor) this.dirty = true;
    // A keyframe is only a shortcut if nothing before it can still change.
    if (this.key && input.tick <= this.key.tick) this.key = null;
  }

  /** Bring the board to `tick`. Incremental when it can be; from the keyframe
   *  when the log changed behind the play head; from tick zero when it changed
   *  behind the keyframe too. */
  advanceTo(tick: number): void {
    if (this.state.tick >= tick && !this.dirty) return;
    if (this.dirty) {
      const key = this.key;
      if (key && key.tick < tick) {
        this.state = cloneState(key.state);
        this.cursor = key.cursor;
      } else {
        this.state = createState(this.seed, this.players);
        this.cursor = 0;
        this.key = null;
      }
      this.dirty = false;
    }
    this.run(tick);
  }

  /** The one stepping loop, used by both paths — see the class note. */
  private run(target: number): void {
    const s = this.state;
    while (s.tick < target && !s.over) {
      const next = s.tick + 1;
      while (this.cursor < this.logInputs.length && this.logInputs[this.cursor].tick <= next) {
        applyInput(s, this.logInputs[this.cursor].seat, this.logInputs[this.cursor].kind);
        this.cursor++;
      }
      const wasAiming = s.phase === "aim";
      step(s, this.durationTicks);
      // Taken as a turn OPENS, not on every tick of it: the top of a turn is
      // the only moment the board is guaranteed still, and one copy a turn is
      // nothing next to one a frame.
      if (!wasAiming && s.phase === "aim") {
        this.key = { tick: s.tick, cursor: this.cursor, state: cloneState(s) };
      }
    }
    if (s.tick < target) s.tick = target;
  }
}
