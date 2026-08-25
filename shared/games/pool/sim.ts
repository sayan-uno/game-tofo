// The 8-ball simulation — deterministic, fixed-step, shared by both sides.
//
// ONE instance holds the whole table. The server keeps one per match and hands
// each runner a thin view of it, exactly as the other three board games do.
//
// WHY NOTHING A PLAYER SENDS STRIKES THE CUE BALL
//
// The platform relays an input to everyone EXCEPT its sender and acknowledges
// nothing. A client that played its own shot would be the one participant
// unable to discover that nobody else had, and one dropped packet would leave
// two tables that can never be reconciled — which on a rack where a single shot
// decides the black is the whole match.
//
// So a shot is a REQUEST (`a…`): it travels on the ordinary input channel and
// this simulation ignores it completely. The SERVER reads the request off its
// own table, decides whether it is legal, and writes the shot as its own input
// (`s…`), which reaches every table — including the one that asked — through
// the same relay. Ball in hand is settled the same way: the placement travels
// inside the shot, and the server puts the cue ball where the RULES say it
// goes, once, so the line a player was shown is the line the shot travels.
//
// THE RULES, in the order the resolver applies them. All of them are decided
// from what the physics reports (physics.ts's ShotLog), never from anything a
// client says:
//
//   * a scratch — the cue ball down — is a foul, and the incoming player has
//     ball in hand anywhere on the cloth
//   * touching nothing is a foul, and so is touching the wrong group first
//   * potting nothing and driving nothing to a cushion is a foul, which is what
//     stops the game being two people nudging balls a millimetre
//   * the table is OPEN until somebody legally pots on a shot that is not the
//     break; then the group they potted is theirs and the other is not
//   * the black before your seven is a LOSS; the black after them, cleanly, is
//     the rack
//
// DETERMINISM. The rules are physics's rules — see physics.ts, which explains
// why only +, -, *, / and Math.sqrt appear anywhere a ball is moved.
import {
  BALL_R,
  BREAK_SPOT,
  HALF_X,
  HALF_Y,
  HEAD_STRING,
  RACK,
  RACK_ORDER,
  nearestSpot,
  type Spot,
} from "./table.js";
import {
  MAX_SPEED,
  anyMoving,
  speedFor,
  stepBalls,
  type Balls,
  type ShotLog,
} from "./physics.js";
import {
  BALLS,
  BEAT_TICKS,
  CUE,
  DURATION_TICKS,
  EIGHT,
  PER_GROUP,
  PLACE_POINTS,
  POINTS_EIGHT,
  POINTS_PER_BALL,
  SHOOT_MAX_TICKS,
  STALL_TICKS,
  TURN_TICKS,
  groupOf,
  seatsOfTeam,
  strokeTicks,
  teamOf,
  turnOrder,
} from "./rules.js";

/** ---------------------------------------------------------------------------
 *  Inputs.
 *
 *  A shot is five whole numbers:
 *
 *      x   −1000…1000  where the cue ball is put down, along the table
 *      y    −500…500   and across it — both ignored unless the shooter has
 *                      ball in hand, and both in THOUSANDTHS of the table's
 *                      half-length so that one unit means one thing everywhere
 *      dx  −1000…1000  aim
 *      dy  −1000…1000  aim, and not both zero
 *      p      0…1000   power
 *
 *  Integers, and not because they are small on the wire: they are what makes
 *  the shot reproducible. The simulation turns them into a velocity with one
 *  square root and two divisions, all correctly rounded, so the same five
 *  numbers are the same shot on every device forever.
 * ------------------------------------------------------------------------- */

export const askKind = (x: number, y: number, dx: number, dy: number, p: number): string =>
  `a${x},${y},${dx},${dy},${p}`;
/** WHAT A PLAYER IS CURRENTLY LINING UP — where they have put the cue ball,
 *  where they are pointing it, how hard they have wound it up.
 *
 *  Moves nothing and decides nothing. It exists so the other people at the
 *  table can WATCH somebody choose a shot, which is most of what standing at a
 *  pool table is. Its own kind rather than a stream of requests, because the
 *  server reads a request as "play it now". */
export const aimKind = (x: number, y: number, dx: number, dy: number, p: number): string =>
  `m${x},${y},${dx},${dy},${p}`;
/** The shot the SERVER decided on. The only thing that strikes a cue ball. */
export const shotKind = (x: number, y: number, dx: number, dy: number, p: number): string =>
  `s${x},${y},${dx},${dy},${p}`;
/** "I am still here" — any touch, any time, whosever turn it is. */
export const NUDGE_KIND = "n";
/** The server: this chair is empty / has stopped answering / is answering again. */
export const QUIT_KIND = "q";
export const AWAY_KIND = "w";
export const BACK_KIND = "b";

/** `s-1000,-500,-1000,-1000,1000` is 29 characters. */
const KIND_MAX = 30;

export interface ShotParams {
  x: number;
  y: number;
  dx: number;
  dy: number;
  p: number;
}

export type Parsed =
  | { type: "ask"; shot: ShotParams }
  | { type: "aim"; shot: ShotParams }
  | { type: "shot"; shot: ShotParams }
  | { type: "nudge" }
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
  // ONE SHOT, ONE ENCODING. "0500" and "500" are the same number and would be
  // the same shot, but they are not the same string — and a kind is a string
  // that gets logged, compared and replayed. Refusing the padded form keeps the
  // encoding canonical, and costs nothing: nothing in this codebase writes one.
  if (n - i > 1 && s.charCodeAt(i) === 48) return null;
  if (sign < 0 && n === 2 && s.charCodeAt(1) === 48) return null;
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
  if (parts.length !== 5) return null;
  const x = readInt(parts[0], -1000, 1000);
  const y = readInt(parts[1], -500, 500);
  const dx = readInt(parts[2], -1000, 1000);
  const dy = readInt(parts[3], -1000, 1000);
  const p = readInt(parts[4], 0, 1000);
  if (x === null || y === null || dx === null || dy === null || p === null) return null;
  // A direction of nothing is not a direction: normalising it would divide by
  // zero and the cue ball would come out with a velocity of NaN, which is a
  // table that never settles.
  if (dx === 0 && dy === 0) return null;
  return { x, y, dx, dy, p };
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

/** Kinds a PLAYER may send. Requests and aims only: the shot itself, the empty
 *  chair and the away flags are the server's to write, and the input handler
 *  refuses them from a socket on the way in. */
export function isInputKind(kind: unknown): kind is string {
  if (typeof kind !== "string") return false;
  const p = parseInput(kind);
  return p !== null && (p.type === "ask" || p.type === "aim" || p.type === "nudge");
}

/** Does this kind actually move a ball?
 *
 *  Requests and aims do not, so they never enter a log. Keeping them out costs
 *  nothing and denies a modified client a very cheap trick: six late requests a
 *  second, each stamped behind the play head, would otherwise make every table
 *  in the match rebuild itself six times a second. It is also what lets a live
 *  aim be broadcast several times a turn without touching the table. */
export function movesBoard(kind: string): boolean {
  const p = parseInput(kind);
  return p !== null && (p.type === "shot" || p.type === "quit" || p.type === "away");
}

/** One input, tagged with the seat that made it. */
export interface PoolInput {
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
export const order = (a: PoolInput, b: PoolInput): number => a.tick - b.tick || a.seat - b.seat;

export type Phase =
  /** Waiting for the server's shot. The turn clock is running. */
  | "aim"
  /** The shot has been written and the cue is playing it: back, and through.
   *  Nothing has moved yet, and nothing else can be decided either — see the
   *  note above STROKE_MIN_TICKS for why the backswing is simulated rather than
   *  animated. */
  | "stroke"
  /** Balls are moving. Nobody decides anything until they stop. */
  | "shoot"
  /** They stopped: a beat to read what happened before the next player. */
  | "beat"
  | "over";

export type Foul = "" | "scratch" | "miss" | "wrong-ball" | "no-rail" | "black";

/** What the last shot did. Rules AND presentation: `again` is read by the step
 *  that chooses the next player, and everything else is what the HUD says. */
export interface ShotResult {
  seat: number;
  /** Balls of the shooter's own group that went down. */
  own: number[];
  /** Balls of the other group that went down — they stay down, and they count
   *  for the other side. */
  opp: number[];
  /** The cue ball went in. */
  scratch: boolean;
  /** The black went down on this shot. */
  black: boolean;
  foul: Foul;
  /** The groups were decided by this shot. */
  assigned: boolean;
  /** The same seat shoots again. */
  again: boolean;
}

export interface PoolState extends Balls {
  /** The match seed. Used for one thing only: who breaks. */
  seed: number;
  tick: number;
  /** 2 (singles) or 4 (scotch doubles). */
  players: number;
  turn: number;
  phase: Phase;
  /** Tick the current phase began — the painter's clock. */
  since: number;
  /** For `stroke`, `shoot` and `beat`, the tick the phase gives up and resolves
   *  itself — and for a stroke that is not a backstop but the moment of
   *  contact, so `since`…`deadline` is exactly the swing.
   *  For `aim`, the tick the player's time runs out, after which the SERVER
   *  plays for them. The simulation does not act on that one — it is drawn as
   *  the turn clock, and the server is what keeps the promise. */
  deadline: number;
  /** Shots played so far. The stall breaker's sequence number. */
  shots: number;
  /** The shot being played: the one the cue is swinging at during `stroke`, and
   *  the one in flight during `shoot`. Its `p` is what every table draws the
   *  backswing from, so the weight of a shot is public the moment it is
   *  written rather than a fortnight later in a log. */
  shot: (ShotParams & { seat: number; from: Spot }) | null;
  /** Accumulated across the shot in flight. */
  log: ShotLog;
  last: ShotResult | null;
  /** Which group each SIDE has: -1 while the table is open. */
  group: number[];
  /** True until a legal pot decides the groups. */
  open: boolean;
  /** Nobody has broken yet. */
  broken: boolean;
  /** The seat about to shoot may put the cue ball down, and whether the head
   *  string applies to where. */
  ballInHand: boolean;
  behindLine: boolean;
  /** Balls each SEAT personally potted of their own group, and their fouls.
   *  Presentation and scoring; the rules read `alive` instead. */
  potted: number[];
  fouls: number[];
  /** The seat that potted the black to win, or -1. */
  finisher: number;
  quit: boolean[];
  away: boolean[];
  /** The side that won, or -1 while the rack is still being played — and still
   *  -1 when the clock runs out, which is a result read off the table rather
   *  than a win (see `outcome`). */
  winner: number;
  /** Decided BY PLAY. Kept apart from `over` because the platform ends a match
   *  early once every runner reports itself out and calls that ending
   *  "all-out": if running out of clock also made everyone out, a stalled rack
   *  would be announced as though somebody had won it. */
  decided: boolean;
  decidedAt: number;
  /** The table is frozen — decided, or out of clock. */
  over: boolean;
}

/** ---------------------------------------------------------------------------
 *  Two things are drawn from the seed. Math.imul throughout, so the
 *  multiplications wrap identically in every engine.
 * ------------------------------------------------------------------------- */
function hash32(seed: number, index: number, salt: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** The stall-breaking shot.
 *
 *  Reached only when the server has authored nothing for a full STALL_TICKS
 *  past a turn that had already run out — a server that has stopped answering,
 *  not a slow one. A pure integer hash of the seed and the shot's sequence
 *  number, so every table breaks the stall the same way on the same tick and
 *  the rack survives rather than freezing. */
export function stallShot(seed: number, index: number): ShotParams {
  return {
    x: (hash32(seed, index, 0) % 2001) - 1000,
    y: (hash32(seed, index, 1) % 1001) - 500,
    dx: (hash32(seed, index, 2) % 2001) - 1000,
    dy: (hash32(seed, index, 3) % 2001) - 1000 || 1,
    p: 300 + (hash32(seed, index, 4) % 501),
  };
}

/** ---------------------------------------------------------------------------
 *  State.
 * ------------------------------------------------------------------------- */

export function createState(seed: number, players: number): PoolState {
  const n = players >= 3 ? 4 : 2;
  const x: number[] = [];
  const y: number[] = [];
  const vx: number[] = [];
  const vy: number[] = [];
  const alive: number[] = [];
  for (let i = 0; i < BALLS; i++) {
    x.push(0);
    y.push(0);
    vx.push(0);
    vy.push(0);
    alive.push(1);
  }
  x[CUE] = BREAK_SPOT.x;
  y[CUE] = BREAK_SPOT.y;
  RACK_ORDER.forEach((ball, i) => {
    x[ball] = RACK[i].x;
    y[ball] = RACK[i].y;
  });
  return {
    seed,
    tick: 0,
    players: n,
    x,
    y,
    vx,
    vy,
    alive,
    // WHO BREAKS IS DRAWN FROM THE SEED. The break is worth something — a rack
    // is often decided by who gets the first open table — so a fixed breaker
    // would be a fixed advantage on one side, every match.
    turn: turnOrder(n)[hash32(seed, 0, 7) % n],
    phase: "aim",
    since: 0,
    deadline: TURN_TICKS,
    shots: 0,
    shot: null,
    log: { potted: [], firstHit: -1, railAfterHit: false },
    last: null,
    group: [-1, -1],
    open: true,
    broken: false,
    // The break is played from behind the head string, like every other ball in
    // hand this game gives out on the opening shot.
    ballInHand: true,
    behindLine: true,
    potted: Array.from({ length: n }, () => 0),
    fouls: Array.from({ length: n }, () => 0),
    finisher: -1,
    quit: Array.from({ length: n }, () => false),
    away: Array.from({ length: n }, () => false),
    winner: -1,
    decided: false,
    decidedAt: -1,
    over: false,
  };
}

export function cloneState(s: PoolState): PoolState {
  return {
    ...s,
    x: s.x.slice(),
    y: s.y.slice(),
    vx: s.vx.slice(),
    vy: s.vy.slice(),
    alive: s.alive.slice(),
    log: { potted: s.log.potted.slice(), firstHit: s.log.firstHit, railAfterHit: s.log.railAfterHit },
    shot: s.shot ? { ...s.shot, from: { ...s.shot.from } } : null,
    last: s.last ? { ...s.last, own: s.last.own.slice(), opp: s.last.opp.slice() } : null,
    group: s.group.slice(),
    potted: s.potted.slice(),
    fouls: s.fouls.slice(),
    quit: s.quit.slice(),
    away: s.away.slice(),
  };
}

/** How many of a group are still on the table. */
export function remaining(s: PoolState, group: number): number {
  let n = 0;
  for (let i = 1; i < BALLS; i++) {
    if (i === EIGHT) continue;
    if (s.alive[i] && groupOf(i) === group) n++;
  }
  return n;
}

/** Which balls this SIDE may legally strike first. Open table: anything but the
 *  black. Group decided: their own, or the black once the seven are gone. */
export function legalTargets(s: PoolState, team: number): number[] {
  const out: number[] = [];
  const g = s.group[team];
  if (g < 0) {
    for (let i = 1; i < BALLS; i++) if (s.alive[i] && i !== EIGHT) out.push(i);
    return out;
  }
  const left = remaining(s, g);
  if (left === 0) {
    if (s.alive[EIGHT]) out.push(EIGHT);
    return out;
  }
  for (let i = 1; i < BALLS; i++) if (s.alive[i] && groupOf(i) === g) out.push(i);
  return out;
}

/** Ticks a seat gets to think. A chair nobody is sitting in gets none. */
const budget = (s: PoolState, seat: number): number => (s.quit[seat] || s.away[seat] ? 0 : TURN_TICKS);

/** Is the simulation waiting on the server rather than on itself? */
export const awaitingServer = (s: PoolState): boolean => s.phase === "aim";

/** Has this seat stopped playing? The platform ends a match when this is true
 *  of everyone — which is why it reads `decided` and not `over`: a rack that
 *  merely ran out of clock was not won by anybody. */
export const isOut = (s: PoolState, seat: number): boolean => s.decided || s.quit[seat];

/** What a seat's play was worth, ignoring which side won. Bounded on purpose:
 *  see the note above PLACE_POINTS — this has to stay under the gap between
 *  the two places or the results table contradicts itself. */
export const performanceOf = (s: PoolState, seat: number): number =>
  Math.min(s.potted[seat], PER_GROUP) * POINTS_PER_BALL + (s.finisher === seat ? POINTS_EIGHT : 0);

/** The number the results table prints: a place, plus that garnish. */
export const scoreOf = (s: PoolState, seat: number, placement: number): number =>
  (PLACE_POINTS[placement] ?? 0) + performanceOf(s, seat);

/** Who won, however the rack ended. -1 is a genuine draw.
 *
 *  A rack decided by play answers itself. One that ran out of clock is decided
 *  on how many of your own you had left — fewest wins — and a table level on
 *  that really is level. */
export function outcome(s: PoolState): number {
  if (s.winner >= 0) return s.winner;
  const a = s.group[0] < 0 ? PER_GROUP : remaining(s, s.group[0]);
  const b = s.group[1] < 0 ? PER_GROUP : remaining(s, s.group[1]);
  if (a !== b) return a < b ? 0 : 1;
  return -1;
}

/** ---------------------------------------------------------------------------
 *  Turn machinery.
 * ------------------------------------------------------------------------- */

function stopAll(s: PoolState): void {
  for (let i = 0; i < BALLS; i++) {
    s.vx[i] = 0;
    s.vy[i] = 0;
  }
}

function finish(s: PoolState, winner: number): void {
  s.winner = winner;
  s.decided = true;
  s.decidedAt = s.tick;
  s.over = true;
  s.phase = "over";
  s.shot = null;
  s.deadline = Number.MAX_SAFE_INTEGER;
  stopAll(s);
}

/** Has one side been left alone at the table? Then there is nothing left to
 *  play and the other side takes the rack. */
function checkAbandoned(s: PoolState): boolean {
  if (s.over) return true;
  const here0 = seatsOfTeam(0, s.players).some((seat) => !s.quit[seat]);
  const here1 = seatsOfTeam(1, s.players).some((seat) => !s.quit[seat]);
  if (here0 && here1) return false;
  finish(s, here0 ? 0 : here1 ? 1 : -1);
  return true;
}

function startTurn(s: PoolState, seat: number): void {
  s.turn = seat;
  s.phase = "aim";
  s.since = s.tick;
  s.deadline = s.tick + budget(s, seat);
}

function nextTurn(s: PoolState): void {
  if (checkAbandoned(s)) return;
  const ord = turnOrder(s.players);
  const at = ord.indexOf(s.turn);
  for (let k = 1; k <= ord.length; k++) {
    const seat = ord[(at + k) % ord.length];
    if (!s.quit[seat]) {
      startTurn(s, seat);
      return;
    }
  }
  // Unreachable while checkAbandoned holds; leaving the turn where it is beats
  // spinning.
  startTurn(s, s.turn);
}

/** Take the shot — put the cue ball down, and start the cue moving.
 *
 *  Everything that can go wrong with a placement is settled HERE — once, in
 *  shared code — so the client's preview, the server's shot and every replay
 *  put the cue ball on the same square inch. It is settled at the START of the
 *  stroke and not at contact, because a cue winding up at a ball that is not on
 *  the cloth yet is a stroke nobody can read.
 *
 *  NOTHING MOVES YET. The whole of the shot is now on the table for everyone to
 *  see — where the cue ball is, which way it points, and, in the length of the
 *  backswing, how hard it is about to be hit. */
function beginStroke(s: PoolState, p: ShotParams): void {
  const seat = s.turn;
  let from: Spot = { x: s.x[CUE], y: s.y[CUE] };
  if (s.ballInHand || !s.alive[CUE]) {
    from = nearestSpot(p.x / 1000, p.y / 1000, s.x, s.y, s.alive, s.behindLine);
    s.x[CUE] = from.x;
    s.y[CUE] = from.y;
    s.alive[CUE] = 1;
  }
  s.shot = { ...p, seat, from };
  s.shots += 1;
  s.ballInHand = false;
  s.behindLine = false;
  s.phase = "stroke";
  s.since = s.tick;
  s.deadline = s.tick + strokeTicks(p.p);
}

/** Contact: the tick the cue arrives and the cue ball leaves.
 *
 *  The velocity is built here rather than when the shot was written, so the one
 *  line that turns five integers into a speed runs once per shot, at the same
 *  point of the same tick, on every device. */
function strike(s: PoolState): void {
  const p = s.shot;
  // Unreachable — a stroke exists only because a shot was written — but a
  // missing one must not leave the cue swinging at nothing forever.
  if (!p) {
    nextTurn(s);
    return;
  }
  const len = Math.sqrt(p.dx * p.dx + p.dy * p.dy);
  const speed = speedFor(p.p / 1000);
  s.vx[CUE] = (p.dx / len) * speed;
  s.vy[CUE] = (p.dy / len) * speed;
  s.log.potted.length = 0;
  s.log.firstHit = -1;
  s.log.railAfterHit = false;
  s.phase = "shoot";
  s.since = s.tick;
  s.deadline = s.tick + SHOOT_MAX_TICKS;
}

/** The balls have stopped. Work out what the shot was worth.
 *
 *  Read top to bottom, this is the whole of 8-ball. Every question it asks is
 *  answered by the physics log or by which balls are still on the table; not
 *  one of them is answered by anything a client said. */
function resolveShot(s: PoolState): void {
  const shot = s.shot;
  const seat = shot ? shot.seat : s.turn;
  const team = teamOf(seat, s.players);
  const wasOpen = s.open;
  const breakShot = !s.broken;
  s.broken = true;

  let scratch = false;
  let black = false;
  const own: number[] = [];
  const opp: number[] = [];
  const anyGroup: number[] = [];
  for (const ball of s.log.potted) {
    if (ball === CUE) {
      scratch = true;
      continue;
    }
    if (ball === EIGHT) {
      black = true;
      continue;
    }
    anyGroup.push(ball);
    const g = groupOf(ball);
    if (s.group[team] >= 0 && g === s.group[team]) own.push(ball);
    else if (s.group[team] >= 0) opp.push(ball);
  }

  // ---- the fouls, in the order the rules read them ----------------------
  let foul: Foul = "";
  if (scratch) foul = "scratch";
  else if (s.log.firstHit < 0) foul = "miss";
  else if (!wasOpen && s.group[team] >= 0) {
    const first = s.log.firstHit;
    const need = remaining(s, s.group[team]) + own.length === 0;
    const legal = first === EIGHT ? need : groupOf(first) === s.group[team];
    if (!legal) foul = "wrong-ball";
  } else if (s.log.firstHit === EIGHT) {
    // An open table may be struck anywhere except the black.
    foul = "wrong-ball";
  }
  if (!foul && s.log.potted.length === 0 && !s.log.railAfterHit) foul = "no-rail";

  // ---- the black --------------------------------------------------------
  if (black) {
    // Cleared, and cleanly: the rack. Anything else: the rack, to the other
    // side. That is the whole of it, and the shortness is the point — a rule
    // anybody can recite is a rule nobody argues about.
    const cleared = s.group[team] >= 0 && remaining(s, s.group[team]) === 0;
    const clean = !foul && cleared;
    if (clean) s.finisher = seat;
    s.last = {
      seat,
      own,
      opp,
      scratch,
      black,
      foul: clean ? "" : foul || "black",
      assigned: false,
      again: false,
    };
    if (!clean) s.fouls[seat] += 1;
    s.shot = null;
    finish(s, clean ? team : team === 0 ? 1 : 0);
    return;
  }

  // ---- the groups -------------------------------------------------------
  //
  // The table stays open until somebody pots legally on a shot that is not the
  // break. Potting on the break decides nothing, which is the rule everywhere
  // it matters and the one people forget.
  let assigned = false;
  if (wasOpen && !breakShot && !foul && anyGroup.length > 0) {
    const mine = groupOf(anyGroup[0]);
    s.group[team] = mine;
    s.group[team === 0 ? 1 : 0] = mine === 0 ? 1 : 0;
    s.open = false;
    assigned = true;
    for (const ball of anyGroup) {
      if (groupOf(ball) === mine) own.push(ball);
      else opp.push(ball);
    }
  } else if (wasOpen) {
    // Still open: nothing potted belongs to anybody yet, and the balls stay
    // down. They are counted to whichever side ends up owning them.
    for (const ball of anyGroup) opp.push(ball);
  }

  if (!foul) s.potted[seat] += own.length;
  else s.fouls[seat] += 1;

  const again = !foul && own.length > 0;
  s.last = { seat, own, opp, scratch, black: false, foul, assigned, again };
  s.shot = null;

  if (foul) {
    // Ball in hand, anywhere on the cloth — except after a foul on the break,
    // where the incoming player is still behind the head string.
    s.ballInHand = true;
    s.behindLine = breakShot;
    s.alive[CUE] = 0;
  }

  if (checkAbandoned(s)) return;
  s.phase = "beat";
  s.since = s.tick;
  s.deadline = s.tick + BEAT_TICKS;
}

/** Apply one input AT its tick.
 *
 *  Requests and aims are read and discarded: they exist so the SERVER can learn
 *  what somebody wants, and they are relayed to the other tables only so those
 *  tables can show a cue being lined up. Nothing here acts on them — the only
 *  input that ever moves a cue is the server's `s…`, which is why the stroke
 *  survives into a replay and a live aim does not. */
export function applyInput(s: PoolState, seat: number, kind: string): void {
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
      // An empty chair does not take its shot: the turn moves on at once rather
      // than waiting for the server to play on its behalf.
      if (seat === s.turn && s.phase === "aim") nextTurn(s);
      return;
    }
    case "shot":
      if (s.phase !== "aim" || seat !== s.turn) return;
      beginStroke(s, input.shot);
      return;
  }
}

/** Advance exactly one tick. */
export function step(s: PoolState, durationTicks: number = DURATION_TICKS): void {
  s.tick += 1;
  if (s.over) return;
  if (s.tick >= durationTicks) {
    // The clock ran out. The table freezes exactly as it stands and the result
    // is read off the balls — note that `decided` stays false, which is what
    // stops this being announced as a win.
    s.over = true;
    s.phase = "over";
    s.shot = null;
    stopAll(s);
    return;
  }
  if (s.phase === "stroke") {
    // The swing. Nothing on the cloth moves while it is happening, and the tick
    // it lands on is the tick the cue ball leaves — so this falls THROUGH into
    // the shoot below rather than returning, and contact and the first step of
    // the roll are one tick, exactly as they were before the stroke existed.
    if (s.tick < s.deadline) return;
    strike(s);
  }
  if (s.phase === "shoot") {
    stepBalls(s, s.log);
    if (!anyMoving(s) || s.tick >= s.deadline) resolveShot(s);
    return;
  }
  if (s.phase === "aim") {
    if (s.tick >= s.deadline + STALL_TICKS) beginStroke(s, stallShot(s.seed, s.shots));
    return;
  }
  if (s.phase === "beat" && s.tick >= s.deadline) {
    const last = s.last;
    if (last && last.again && !s.quit[last.seat]) startTurn(s, last.seat);
    else nextTurn(s);
  }
}

/** Run a fresh table through an input log up to `toTick`. */
export function replay(
  seed: number,
  players: number,
  inputs: readonly PoolInput[],
  toTick: number,
  durationTicks: number = DURATION_TICKS
): PoolState {
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
  // A finished rack still has to reach the tick it was asked for, so "what tick
  // is it" has one answer whether or not the balls have settled.
  if (s.tick < toTick) s.tick = toTick;
  return s;
}

/** ---------------------------------------------------------------------------
 *  PoolSim — the table, its input log, and the bookkeeping that keeps a late
 *  input cheap.
 *
 *  THE KEYFRAME is carrom's, and it is here for carrom's reason. Rewinding on a
 *  physics table means replaying every collision of every shot in the rack —
 *  tens of milliseconds by the twentieth, on the client's animation thread, for
 *  one input that arrived a frame late. So the sim keeps a copy of the table
 *  taken at the top of the current turn, when nothing is rolling and the copy is
 *  sixteen balls' worth of numbers, and rewinds to THAT instead. An input older
 *  than the keyframe throws it away and the full replay happens, as it must.
 * ------------------------------------------------------------------------- */
interface Keyframe {
  tick: number;
  cursor: number;
  state: PoolState;
}

export class PoolSim {
  state: PoolState;
  private logInputs: PoolInput[] = [];
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

  get inputs(): readonly PoolInput[] {
    return this.logInputs;
  }

  /** Record an input, IN ORDER.
   *
   *  Inserted at its sorted position rather than appended — Ludo's hardest-won
   *  line, and it is as load-bearing here as anywhere. The incremental path
   *  applies a tick's inputs in log order; a rewind applies them in SORTED
   *  order. If those two can differ then a client that happened to rewind and
   *  one that did not end up with different tables, and they CAN differ,
   *  because the server may write several inputs on one tick and a client's own
   *  requests thread in between the ones it receives. */
  addInput(input: PoolInput): void {
    if (!movesBoard(input.kind)) return;
    let i = this.logInputs.length;
    while (i > 0 && order(this.logInputs[i - 1], input) > 0) i--;
    this.logInputs.splice(i, 0, input);
    if (input.tick <= this.state.tick || i < this.cursor) this.dirty = true;
    if (this.key && input.tick <= this.key.tick) this.key = null;
  }

  /** Bring the table to `tick`. Incremental when it can be; from the keyframe
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
      // Taken as a turn OPENS, not on every tick of it: the top of a turn is the
      // only moment the table is guaranteed still, and one copy a turn is
      // nothing next to one a frame.
      if (!wasAiming && s.phase === "aim") {
        this.key = { tick: s.tick, cursor: this.cursor, state: cloneState(s) };
      }
    }
    if (s.tick < target) s.tick = target;
  }
}

/** Dev-only: the numbers the check harness wants without importing three files. */
export const TABLE = { HALF_X, HALF_Y, BALL_R, HEAD_STRING, MAX_SPEED };
