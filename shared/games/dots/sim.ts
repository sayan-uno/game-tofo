// The Dots & Boxes simulation — deterministic, fixed-step, shared.
//
// ONE instance holds the whole grid. Everything in it is an integer, so unlike
// carrom there is no arithmetic here that could round differently on two
// machines: the determinism argument for this game is that there is nothing to
// argue about. What remains is the ORDER inputs are applied in, which is the
// same discipline every game on this platform keeps.
//
// WHY NOTHING A PLAYER SENDS DRAWS A LINE
//
// The platform relays an input to everyone EXCEPT its sender and acknowledges
// nothing. A client that drew its own line would therefore be the one
// participant unable to discover that nobody else had, and one dropped packet
// would leave two grids that can never be reconciled — and on a board where a
// single line decides a chain of six boxes, that is the whole match.
//
// So a tap is a REQUEST (`a…`): it travels on the ordinary input channel and
// this simulation ignores it completely. The SERVER reads the request off its
// own grid, checks that the line is still free and that it is that player's
// turn, and writes the move as its own input (`d…`), which reaches every table
// — including the one that asked — through the same relay.
//
// The round trip is hidden the way the other two board games hide theirs: the
// line lights up under the finger the instant it is chosen, and the answer is
// back long before the drawing animation ends.
import {
  BOX_COUNT,
  BOX_LINES,
  LINE_BOXES,
  LINE_COUNT,
} from "./board.js";
import {
  CLAIM_TICKS,
  DRAW_TICKS,
  DURATION_TICKS,
  PLACE_POINTS,
  POINTS_PER_BOX,
  STALL_TICKS,
  TURN_TICKS,
} from "./rules.js";

/** ---------------------------------------------------------------------------
 *  Inputs. A move is one number: which line.
 * ------------------------------------------------------------------------- */

/** A line the player is ASKING to draw. Draws nothing. */
export const askKind = (line: number): string => `a${line}`;
/** The line the player's finger is currently over.
 *
 *  Draws nothing and decides nothing; it exists so the other people at the
 *  table can watch somebody choose. On a board where every line is visible to
 *  everybody, seeing which one an opponent is hovering over is most of the
 *  tension — and without it the first anyone knew of a move was the move. */
export const hoverKind = (line: number): string => `m${line}`;
/** The line the SERVER decided on. The only thing that draws anything. */
export const drawKind = (line: number): string => `d${line}`;
/** "I am still here" — any touch, any time, whosever turn it is. */
export const NUDGE_KIND = "n";
/** The server: this chair is empty / has stopped answering / is answering again. */
export const QUIT_KIND = "q";
export const AWAY_KIND = "w";
export const BACK_KIND = "b";

/** `d83` is the longest anything gets. */
const KIND_MAX = 4;

export type Parsed =
  | { type: "ask"; line: number }
  | { type: "hover"; line: number }
  | { type: "draw"; line: number }
  | { type: "nudge" }
  | { type: "quit" }
  | { type: "away"; gone: boolean };

/** A strict small-integer reader. Deliberately not parseInt, which reads
 *  "12abc" as 12 — a kind arriving off the wire is attacker-controlled text and
 *  gets no benefit of the doubt. */
function readLine(s: string): number | null {
  if (s.length === 0 || s.length > 2) return null;
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return null;
    v = v * 10 + c;
  }
  return v >= 0 && v < LINE_COUNT ? v : null;
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
  if (head !== "a" && head !== "d" && head !== "m") return null;
  const line = readLine(kind.slice(1));
  if (line === null) return null;
  if (head === "a") return { type: "ask", line };
  if (head === "m") return { type: "hover", line };
  return { type: "draw", line };
}

/** Kinds a PLAYER may send. Requests and hovers only: the move itself, the
 *  empty chair and the away flags are the server's to write, and the input
 *  handler refuses them from a socket on the way in. */
export function isInputKind(kind: unknown): kind is string {
  if (typeof kind !== "string") return false;
  const p = parseInput(kind);
  return p !== null && (p.type === "ask" || p.type === "hover" || p.type === "nudge");
}

/** Does this kind actually change the grid?
 *
 *  Requests and hovers do not, so they never enter a log. Keeping them out
 *  costs nothing and denies a modified client a very cheap trick: eight late
 *  requests a second, each stamped behind the play head, would otherwise make
 *  every table in the match rebuild itself eight times a second. It is also
 *  what lets a hovering finger be broadcast without touching the board. */
export function movesBoard(kind: string): boolean {
  const p = parseInput(kind);
  return p !== null && (p.type === "draw" || p.type === "quit" || p.type === "away");
}

/** One input, tagged with the seat that made it. */
export interface DotsInput {
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
export const order = (a: DotsInput, b: DotsInput): number => a.tick - b.tick || a.seat - b.seat;

export type Phase =
  /** Waiting for the server's line. The turn clock is running. */
  | "turn"
  /** A line is being drawn, and any boxes it closed are filling in. The move is
   *  ALREADY applied; this is only its telling. */
  | "draw"
  | "over";

/** What the last move did. Rules AND presentation: `again` is read by the step
 *  that chooses the next player, and everything else is what the HUD says. */
export interface Move {
  seat: number;
  line: number;
  /** Boxes this line closed — none, one, or two. */
  boxes: readonly number[];
  /** The same seat goes again. */
  again: boolean;
  /** How many boxes this seat has taken in a row, counting this move. */
  run: number;
}

export interface DotsState {
  /** The match seed. Used for two things only: who opens, and the
   *  stall-breaking move. */
  seed: number;
  tick: number;
  players: number;
  /** Who drew each line; -1 while it is still free. */
  line: number[];
  /** Who closed each box; -1 while it is still open. */
  box: number[];
  /** How many of each — cached because every turn asks, and counting eighty-four
   *  entries per frame on a phone is the sort of thing that adds up. */
  drawn: number;
  claimed: number;
  /** Boxes per seat. */
  score: number[];
  /** Lines drawn per seat, and moves that handed the next player a box. Not
   *  rules — they are what the results card and the replay studio print. */
  moves: number[];
  gifts: number[];
  /** Longest unbroken run of boxes each seat has taken. */
  best: number[];
  turn: number;
  phase: Phase;
  /** Tick the current phase began — the painter's clock. */
  since: number;
  /** For `draw`, the tick the animation finishes. For `turn`, the tick the
   *  player's time runs out, after which the SERVER moves for them. The
   *  simulation does not act on the second one — it is drawn as the turn clock,
   *  and the server is what keeps the promise. */
  deadline: number;
  last: Move | null;
  quit: boolean[];
  away: boolean[];
  /** The seat that has won, or -1. Set only when the board can no longer be
   *  caught, which is not always the last line. */
  winner: number;
  /** Decided BY PLAY. Kept apart from `over` because the platform ends a match
   *  early once every runner reports itself out and calls that "all-out": if
   *  running out of clock also made everyone out, a stalled board would be
   *  announced as though somebody had won it. */
  decided: boolean;
  decidedAt: number;
  /** The grid is frozen — decided, or out of clock. */
  over: boolean;
}

/** ---------------------------------------------------------------------------
 *  Two things are drawn from the seed, and both are integers all the way down.
 *
 *  Math.imul throughout, so the multiplications wrap identically in every
 *  engine — the same reason every other game here hashes this way.
 * ------------------------------------------------------------------------- */
function hash32(seed: number, index: number, salt: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** The stall-breaking move.
 *
 *  Reached only when the server has authored nothing for a full STALL_TICKS
 *  past a turn that had already run out — a server that has stopped answering,
 *  not a slow one. Every table picks the same free line on the same tick, so
 *  the board survives rather than freezing. Predictable, but only ever reached
 *  when something is already badly wrong. */
export function stallLine(s: DotsState): number {
  const free = LINE_COUNT - s.drawn;
  if (free <= 0) return -1;
  let n = hash32(s.seed, s.drawn, 11) % free;
  for (let i = 0; i < LINE_COUNT; i++) {
    if (s.line[i] >= 0) continue;
    if (n === 0) return i;
    n--;
  }
  return -1;
}

export function createState(seed: number, players: number): DotsState {
  const n = players >= 3 ? 4 : 2;
  return {
    seed,
    tick: 0,
    players: n,
    line: Array.from({ length: LINE_COUNT }, () => -1),
    box: Array.from({ length: BOX_COUNT }, () => -1),
    drawn: 0,
    claimed: 0,
    score: Array.from({ length: n }, () => 0),
    moves: Array.from({ length: n }, () => 0),
    gifts: Array.from({ length: n }, () => 0),
    best: Array.from({ length: n }, () => 0),
    // WHO OPENS IS DRAWN FROM THE SEED. On a grid this small the opening move
    // matters — the parity of who is forced to break the first chain follows
    // from it — so a fixed first seat would be a fixed advantage. Every client
    // is told the seed, so drawing it costs nothing and every table agrees.
    turn: hash32(seed, 0, 7) % n,
    phase: "turn",
    since: 0,
    deadline: TURN_TICKS,
    last: null,
    quit: Array.from({ length: n }, () => false),
    away: Array.from({ length: n }, () => false),
    winner: -1,
    decided: false,
    decidedAt: -1,
    over: false,
  };
}

export function cloneState(s: DotsState): DotsState {
  return {
    ...s,
    line: s.line.slice(),
    box: s.box.slice(),
    score: s.score.slice(),
    moves: s.moves.slice(),
    gifts: s.gifts.slice(),
    best: s.best.slice(),
    last: s.last ? { ...s.last, boxes: s.last.boxes.slice() } : null,
    quit: s.quit.slice(),
    away: s.away.slice(),
  };
}

/** How many sides of this box are drawn. The one question the whole game is
 *  made of. */
export function sidesOf(s: DotsState, box: number): number {
  const lines = BOX_LINES[box];
  let n = 0;
  for (let i = 0; i < 4; i++) if (s.line[lines[i]] >= 0) n++;
  return n;
}

/** Would drawing this line close anything? */
export function closesBoxes(s: DotsState, line: number): number {
  const boxes = LINE_BOXES[line];
  let n = 0;
  for (let i = 0; i < boxes.length; i++) if (sidesOf(s, boxes[i]) === 3) n++;
  return n;
}

/** Every line still free. Allocated fresh on purpose: the bot walks it a lot
 *  and the alternative — a shared scratch array — is the kind of state that
 *  makes two calls disagree. */
export function freeLines(s: DotsState): number[] {
  const out: number[] = [];
  for (let i = 0; i < LINE_COUNT; i++) if (s.line[i] < 0) out.push(i);
  return out;
}

/** Ticks a seat gets to think. A chair nobody is sitting in gets none. */
const budget = (s: DotsState, seat: number): number => (s.quit[seat] || s.away[seat] ? 0 : TURN_TICKS);

/** Is the simulation waiting on the server rather than on itself? */
export const awaitingServer = (s: DotsState): boolean => s.phase === "turn";

/** Has this seat stopped playing? The platform ends a match when this is true
 *  of everyone — which is why it reads `decided` and not `over`: a grid that
 *  merely ran out of clock was not won by anybody. */
export const isOut = (s: DotsState, seat: number): boolean => s.decided || s.quit[seat];

/** What a seat's play was worth, ignoring where they came. Bounded on purpose:
 *  see the note above PLACE_POINTS — this has to stay under the narrowest gap
 *  between two places or the results table contradicts itself. */
export const performanceOf = (s: DotsState, seat: number): number => s.score[seat] * POINTS_PER_BOX;

/** The number the results table prints: a place, plus that garnish. */
export const scoreOf = (s: DotsState, seat: number, placement: number): number =>
  (PLACE_POINTS[placement] ?? 0) + performanceOf(s, seat);

/** Who is ahead, and by how much — the two numbers everything below asks for. */
function leaders(s: DotsState): { top: number; second: number; who: number } {
  let top = -1;
  let second = -1;
  let who = -1;
  for (let i = 0; i < s.players; i++) {
    const v = s.score[i];
    if (v > top) {
      second = top;
      top = v;
      who = i;
    } else if (v > second) {
      second = v;
    }
  }
  return { top, second: second < 0 ? 0 : second, who };
}

/** Who won, however the grid ended. -1 is a genuine tie at the top. */
export function outcome(s: DotsState): number {
  const { top, who } = leaders(s);
  let tied = 0;
  for (let i = 0; i < s.players; i++) if (s.score[i] === top) tied++;
  return tied > 1 ? -1 : who;
}

/** ---------------------------------------------------------------------------
 *  Turn machinery.
 * ------------------------------------------------------------------------- */

function finish(s: DotsState, decided: boolean): void {
  s.decided = decided;
  if (decided && s.decidedAt < 0) s.decidedAt = s.tick;
  s.winner = outcome(s);
  s.over = true;
  s.phase = "over";
  s.deadline = Number.MAX_SAFE_INTEGER;
}

/** Is there still a game here?
 *
 *  Two ways there is not. Every box is closed, which is the ordinary ending.
 *  Or the leader is further ahead than every box still on the board — at which
 *  point the rest of it is thirty moves of arithmetic nobody can change, and
 *  making four people sit through that is how a five-minute game becomes a
 *  twelve-minute one. */
function checkOver(s: DotsState): boolean {
  if (s.over) return true;
  if (s.claimed >= BOX_COUNT) {
    finish(s, true);
    return true;
  }
  const { top, second } = leaders(s);
  if (top > second + (BOX_COUNT - s.claimed)) {
    finish(s, true);
    return true;
  }
  // Nobody left to play it out.
  let playing = 0;
  for (let i = 0; i < s.players; i++) if (!s.quit[i]) playing++;
  if (playing === 0) {
    finish(s, true);
    return true;
  }
  return false;
}

function startTurn(s: DotsState, seat: number): void {
  s.turn = seat;
  s.phase = "turn";
  s.since = s.tick;
  s.deadline = s.tick + budget(s, seat);
}

function nextTurn(s: DotsState): void {
  if (checkOver(s)) return;
  for (let i = 1; i <= s.players; i++) {
    const c = (s.turn + i) % s.players;
    if (!s.quit[c]) {
      startTurn(s, c);
      return;
    }
  }
  // Unreachable while checkOver holds; leaving the turn where it is beats
  // spinning.
  startTurn(s, s.turn);
}

/** Draw a line. The move is applied here IN FULL — the line, the boxes, the
 *  counters — and the `draw` phase that follows is only its telling. Keeping
 *  the rules settled and the animation merely descriptive is what stops a
 *  rewind leaving the grid half-drawn. */
function drawLine(s: DotsState, seat: number, line: number): void {
  s.line[line] = seat;
  s.drawn++;
  s.moves[seat]++;
  const closed: number[] = [];
  for (const box of LINE_BOXES[line]) {
    if (s.box[box] >= 0) continue;
    if (sidesOf(s, box) !== 4) continue;
    s.box[box] = seat;
    s.score[seat]++;
    s.claimed++;
    closed.push(box);
  }
  const run = closed.length > 0 ? (s.last && s.last.seat === seat ? s.last.run : 0) + closed.length : 0;
  if (run > s.best[seat]) s.best[seat] = run;
  // A move that leaves a box with three sides has handed it to whoever plays
  // next. Not a rule — nothing stops you — but it is the single number that
  // says how well somebody played, so it is counted.
  if (closed.length === 0) {
    for (const box of LINE_BOXES[line]) {
      if (s.box[box] < 0 && sidesOf(s, box) === 3) {
        s.gifts[seat]++;
        break;
      }
    }
  }
  s.last = { seat, line, boxes: closed, again: closed.length > 0, run };
  s.phase = "draw";
  s.since = s.tick;
  s.deadline = s.tick + DRAW_TICKS + closed.length * CLAIM_TICKS;
}

/** Apply one input AT its tick.
 *
 *  Player requests and hovers are read and discarded: they exist so the SERVER
 *  can learn what somebody wants, and they are relayed to the other tables only
 *  so those tables can show a finger moving. Nothing here acts on them. */
export function applyInput(s: DotsState, seat: number, kind: string): void {
  if (s.over || seat < 0 || seat >= s.players) return;
  const input = parseInput(kind);
  if (!input) return;
  switch (input.type) {
    case "ask":
    case "hover":
    case "nudge":
      return;
    case "away": {
      if (s.away[seat] === input.gone) return;
      s.away[seat] = input.gone;
      // Their clock changes the moment they do, including mid-turn: an absent
      // seat stops holding the table up, and a returning one is not rushed.
      if (seat === s.turn && s.phase === "turn") s.deadline = s.since + budget(s, seat);
      return;
    }
    case "quit": {
      if (s.quit[seat]) return;
      s.quit[seat] = true;
      if (checkOver(s)) return;
      // An empty chair does not take its turn: the table moves on at once
      // rather than waiting for the server to play on its behalf.
      if (seat === s.turn && s.phase === "turn") nextTurn(s);
      return;
    }
    case "draw":
      if (s.phase !== "turn" || seat !== s.turn) return;
      if (input.line < 0 || input.line >= LINE_COUNT || s.line[input.line] >= 0) return;
      drawLine(s, seat, input.line);
      return;
  }
}

/** Advance exactly one tick. */
export function step(s: DotsState, durationTicks: number = DURATION_TICKS): void {
  s.tick += 1;
  if (s.over) return;
  if (s.tick >= durationTicks) {
    // The clock ran out. The grid freezes exactly as it stands and the result
    // is read off the boxes — note that `decided` stays false, which is what
    // stops this being announced as a win.
    s.over = true;
    s.phase = "over";
    s.winner = outcome(s);
    return;
  }
  if (s.phase === "turn") {
    if (s.tick >= s.deadline + STALL_TICKS) {
      const line = stallLine(s);
      if (line >= 0) drawLine(s, s.turn, line);
      else checkOver(s);
    }
    return;
  }
  if (s.phase === "draw" && s.tick >= s.deadline) {
    const last = s.last;
    if (checkOver(s)) return;
    // Closing a box earns another line — the rule the whole game turns on.
    if (last && last.again && !s.quit[last.seat]) startTurn(s, last.seat);
    else nextTurn(s);
  }
}

/** Run a fresh grid through an input log up to `toTick`. */
export function replay(
  seed: number,
  players: number,
  inputs: readonly DotsInput[],
  toTick: number,
  durationTicks: number = DURATION_TICKS
): DotsState {
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
  // A finished grid still has to reach the tick it was asked for, so "what tick
  // is it" has one answer whether or not the board has settled.
  if (s.tick < toTick) s.tick = toTick;
  return s;
}

/** ---------------------------------------------------------------------------
 *  DotsSim — the grid, its input log, and the bookkeeping that keeps stepping
 *  cheap. Shared by the client (which draws it) and the server (which judges
 *  it) on purpose: an incremental fast path here and a replay there is exactly
 *  how the two would drift apart, so there is one implementation of both.
 *
 *  No keyframe, unlike carrom. A rewind here is eighty-four array writes and a
 *  walk of the tick range, which is microseconds — the thing that made carrom
 *  need one was replaying every collision of every shot, and there are no
 *  collisions in a grid.
 * ------------------------------------------------------------------------- */
export class DotsSim {
  state: DotsState;
  private log: DotsInput[] = [];
  /** Index of the next input not yet applied on the incremental path. */
  private cursor = 0;
  /** An input arrived for a tick already simulated — rebuild before trusting. */
  private dirty = false;

  constructor(
    readonly seed: number,
    readonly players: number,
    private durationTicks: number = DURATION_TICKS
  ) {
    this.state = createState(seed, players);
  }

  get inputs(): readonly DotsInput[] {
    return this.log;
  }

  /** Record an input, IN ORDER.
   *
   *  Inserted at its sorted position rather than appended — Ludo's hardest-won
   *  line, and it is exactly as load-bearing here. The incremental path applies
   *  a tick's inputs in log order; a rewind applies them in SORTED order. If
   *  those two can differ then a client that happened to rewind and one that did
   *  not end up with different grids, and they CAN differ, because the server
   *  may write several inputs on one tick and a client's own requests thread in
   *  between the ones it receives. */
  addInput(input: DotsInput): void {
    if (!movesBoard(input.kind)) return;
    let i = this.log.length;
    while (i > 0 && order(this.log[i - 1], input) > 0) i--;
    this.log.splice(i, 0, input);
    // Behind the play head, or behind what the incremental path has already
    // applied: either way the grid in hand was built without it.
    if (input.tick <= this.state.tick || i < this.cursor) this.dirty = true;
  }

  /** Bring the grid to `tick`. Incremental when it can be, a full replay when
   *  the log changed behind the current position. */
  advanceTo(tick: number): void {
    if (this.state.tick >= tick && !this.dirty) return;
    if (this.dirty) {
      this.state = replay(this.seed, this.players, this.log, tick, this.durationTicks);
      const at = this.log.findIndex((i) => i.tick > tick);
      this.cursor = at < 0 ? this.log.length : at;
      this.dirty = false;
      return;
    }
    const s = this.state;
    while (s.tick < tick && !s.over) {
      const next = s.tick + 1;
      while (this.cursor < this.log.length && this.log[this.cursor].tick <= next) {
        applyInput(s, this.log[this.cursor].seat, this.log[this.cursor].kind);
        this.cursor++;
      }
      step(s, this.durationTicks);
    }
    if (s.tick < tick) s.tick = tick;
  }
}
