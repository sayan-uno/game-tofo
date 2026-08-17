// The Ludo simulation — deterministic, fixed-step, shared.
//
// ONE instance holds the whole table, not one per player: in Ludo the players
// touch each other's pieces, so a per-player simulation of the kind the runner
// uses could not answer the only interesting question on the board — whose
// token is standing on that square. The server keeps one of these per match and
// hands each runner a thin view of it (see backend games/ludo).
//
// WHY NOTHING A PLAYER SENDS MOVES A PIECE
//
// The runner can let each client apply its own input the instant it is made,
// because a mispredicted swipe costs one player a little rubber-banding and
// nobody else anything. A board cannot: if one player's tap reaches the server
// and another's does not, two tables have different pieces on them and there is
// no way back. The platform makes that failure easy to reach — an input is
// relayed to everyone EXCEPT its sender, and nothing is acknowledged, so the
// sender is the one participant who can never find out that it was dropped.
//
// So the rules here answer to the SERVER and to nobody else. A player's tap is
// a request (`roll`, `t0`…`t3`); it travels on the ordinary input channel and
// this simulation ignores it completely. The server reads the request, decides,
// and writes the outcome as its own input (`d1`…`d6` for a die, `p0`…`p3` for a
// played token, `quit` for an empty chair). Those reach every client through
// the same relay — including the player who asked — so every table applies the
// identical set of rule-bearing inputs, in the identical order, forever.
//
// Two things fall out of that, both wanted. The dice cannot be foreseen: a
// number derived from the match seed would be deterministic AND predictable,
// since every client is told the seed, and a modified client could read the
// whole game before the first roll. And a dropped tap is now merely a tap that
// did not happen — the turn timer runs on, the server plays for you, and the
// board stays one board.
//
// The cost is a round trip before a piece moves, which is hidden: the die
// tumbles and the token lifts the moment you touch them, and the answer is back
// long before either animation was going to end. Nothing a player can see waits.
//
// The determinism rules are the runner's rules: never read the wall clock or
// Math.random, plain integer arithmetic in a fixed order, and an input stamped
// tick T is applied at the start of tick T's step on every device, however late
// it arrived.
import {
  CAPTURE_TICKS,
  DURATION_TICKS,
  HOME_TICKS,
  HOP_TICKS,
  CAPTURE_CAP,
  PASS_TICKS,
  PLACE_POINTS,
  POINTS_PER_CAPTURE,
  POINTS_PER_TOKEN_HOME,
  SQUARES_PER_POINT,
  SIX_STREAK_LIMIT,
  SPIN_TICKS,
  STALL_TICKS,
  TURN_TICKS,
} from "./rules.js";
import {
  POS_HOME,
  POS_YARD,
  RING_STEPS,
  TOKENS_PER_PLAYER,
  cornerOf,
  isSafeRing,
  ringIndexOf,
} from "./board.js";

/** Kinds a PLAYER may send. They are requests, not moves: the simulation reads
 *  none of them. Anything outside this list is refused by the input handler on
 *  the way in, which is what stops a client authoring its own dice. */
export const INPUT_KINDS: readonly string[] = ["roll", "t0", "t1", "t2", "t3"];
export const isInputKind = (k: unknown): k is string => typeof k === "string" && INPUT_KINDS.includes(k);

/** Kinds the SERVER writes. These are the only things that move a piece. */
export const dieKind = (face: number): string => `d${face}`;
export const playKind = (token: number): string => `p${token}`;
export const QUIT_KIND = "quit";
/** The table has stopped waiting for a seat, and has started again. */
export const AWAY_KIND = "away";
export const BACK_KIND = "back";

export type Parsed =
  /** A player asking to roll. */
  | { type: "ask-roll" }
  /** A player asking to play a token. */
  | { type: "ask-play"; token: number }
  /** The server's die. */
  | { type: "die"; face: number }
  /** The server playing a token. */
  | { type: "play"; token: number }
  /** The server saying a chair is empty. */
  | { type: "quit" }
  /** The server saying a seat has stopped answering, or started again. */
  | { type: "away"; gone: boolean };

/** Read one input kind. Unknown kinds parse to null and are ignored the same
 *  way everywhere, so a modified client that invents one changes nothing. */
export function parseInput(kind: string): Parsed | null {
  if (kind === "roll") return { type: "ask-roll" };
  if (kind === QUIT_KIND) return { type: "quit" };
  if (kind === AWAY_KIND) return { type: "away", gone: true };
  if (kind === BACK_KIND) return { type: "away", gone: false };
  if (kind.length !== 2) return null;
  const n = kind.charCodeAt(1) - 48;
  if (kind[0] === "t" && n >= 0 && n < TOKENS_PER_PLAYER) return { type: "ask-play", token: n };
  if (kind[0] === "p" && n >= 0 && n < TOKENS_PER_PLAYER) return { type: "play", token: n };
  if (kind[0] === "d" && n >= 1 && n <= 6) return { type: "die", face: n };
  return null;
}

/** Does this kind actually move a piece? Player requests do not, so they are
 *  never put in a log: keeping them out costs nothing, and it denies a modified
 *  client a very cheap trick — six late requests a second, each landing behind
 *  the play head, would otherwise make every table in the match rebuild itself
 *  from tick zero six times a second. */
export function movesBoard(kind: string): boolean {
  const p = parseInput(kind);
  return p !== null && (p.type === "die" || p.type === "play" || p.type === "quit" || p.type === "away");
}

/** One input, tagged with the seat that made it. The platform's envelope
 *  carries a uid; the game maps it to a seat once, on the way in. */
export interface LudoInput {
  tick: number;
  seat: number;
  kind: string;
}

/** THE order inputs are applied in, everywhere: by tick, then by seat.
 *
 *  Deliberately NOT extended to break ties on the kind as well. Two inputs
 *  with the same tick and seat were written by the server in one batch and
 *  emitted in that order, so every table already receives them in it; sorting
 *  on their content instead would reorder them differently in a rewind than
 *  in the ordinary path, which is the one thing this must never do. A stable
 *  sort keeps arrival order, and JavaScript's sort has been stable since
 *  ES2019. */
export const order = (a: LudoInput, b: LudoInput): number => a.tick - b.tick || a.seat - b.seat;

export type Phase =
  /** Waiting for the server's die. The turn clock is running. */
  | "roll"
  /** The die is tumbling; its face is known but not yet acted on. */
  | "spin"
  /** More than one token could move; waiting for the server's choice. */
  | "pick"
  /** A token is travelling. The move is already applied; this is its journey. */
  | "hop"
  /** Nothing could move. A beat, so the player sees why. */
  | "pass"
  | "over";

export type PassReason = "none" | "no-move" | "three-sixes";

/** A token in flight. The move it describes is ALREADY applied to `pos` — this
 *  record exists so the painter can show the journey and so the simulation
 *  knows when the journey ends. Keeping the rules settled and the animation
 *  merely descriptive is what stops a rewind leaving the board half-moved. */
export interface Hop {
  seat: number;
  token: number;
  from: number;
  to: number;
  /** Tokens this move knocked back to their yards. */
  taken: readonly { seat: number; token: number }[];
  /** Whether it earns another go. */
  extra: boolean;
}

export interface LudoState {
  /** The match seed. Used for one thing only — the stall-breaking die below. */
  seed: number;
  tick: number;
  players: number;
  /** pos[seat][token] — see board.ts for what the number means. */
  pos: number[][];
  turn: number;
  phase: Phase;
  /** Tick the current phase began — the painter's clock. */
  since: number;
  /** For `spin`, `hop` and `pass`: the tick the phase resolves itself.
   *  For `roll` and `pick`: the tick the player's time runs out, after which
   *  the SERVER plays for them. The simulation does not act on it — it is
   *  shown as the turn clock, and the server is what keeps the promise. */
  deadline: number;
  /** Face in play, 0 while none has been read. */
  die: number;
  /** Rolls resolved so far. */
  rolls: number;
  /** Consecutive sixes by the player holding the turn. */
  sixes: number;
  hop: Hop | null;
  passReason: PassReason;
  /** Tick each seat brought its last token home; -1 while still playing. */
  homeAt: number[];
  /** Seats that walked out. Skipped in the turn order, still on the board. */
  quit: boolean[];
  /** Seats that have stopped answering. UNLIKE `quit` they keep their turn and
   *  keep playing — they simply get no time to think, so an empty chair costs
   *  the table a second rather than ten. One tap and they have it back. */
  away: boolean[];
  captures: number[];
  /** Seats in the order they finished — the placement, as decided by play. */
  order: number[];
  /** The board is frozen — decided, or out of clock. */
  over: boolean;
  /** Decided BY PLAY: only one player was left with anything to play for.
   *
   *  Kept apart from `over` because the platform ends a match early once every
   *  runner reports itself out, and calls that ending "all-out". If running out
   *  of clock also made everyone out, a twenty-five minute stalemate would be
   *  reported as though it had been won — and the results card would tell four
   *  players who got nothing home that everything was home. */
  decided: boolean;
}

/** The stall-breaking die.
 *
 *  Reached only when the server has authored nothing for a full STALL_TICKS
 *  past a turn that had already run out — which is a server that has stopped
 *  answering, not a slow one. It is a pure integer hash of the seed and the
 *  roll's sequence number, so every table breaks the stall the same way on the
 *  same tick and the game survives rather than freezing. Predictable, but only
 *  ever reached when something is already wrong.
 *
 *  Math.imul throughout, so the multiplications wrap identically in every
 *  engine — the same reason the runner's course generator uses it. */
export function stallDie(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h % 6) + 1;
}

export function createState(seed: number, players: number): LudoState {
  const n = Math.max(2, Math.min(4, players));
  return {
    seed,
    tick: 0,
    players: n,
    pos: Array.from({ length: n }, () => Array.from({ length: TOKENS_PER_PLAYER }, () => POS_YARD)),
    turn: 0,
    phase: "roll",
    since: 0,
    deadline: TURN_TICKS,
    die: 0,
    rolls: 0,
    sixes: 0,
    hop: null,
    passReason: "none",
    homeAt: Array.from({ length: n }, () => -1),
    quit: Array.from({ length: n }, () => false),
    away: Array.from({ length: n }, () => false),
    captures: Array.from({ length: n }, () => 0),
    order: [],
    over: false,
    decided: false,
  };
}

/** Ticks a seat gets to act. A seat that has walked out gets none, so the table
 *  is never held up by an empty chair. */
const budget = (s: LudoState, seat: number): number => (s.quit[seat] || s.away[seat] ? 0 : TURN_TICKS);

/** Is the simulation waiting on the server rather than on itself? */
export const awaitingServer = (s: LudoState): boolean => s.phase === "roll" || s.phase === "pick";

/** Tokens this seat could legally move with this face.
 *
 *  Tokens standing on the same square are the same move — a Ludo piece carries
 *  no state of its own beyond where it is — so only the first of each is
 *  offered. That is not a tidying: it is what stops the opening six from asking
 *  which of four identical tokens in the yard should come out, and it is what
 *  makes "there is only one thing you can do" common enough to play itself. */
export function legalMoves(s: LudoState, seat: number, die: number): number[] {
  const out: number[] = [];
  if (die < 1 || seat < 0 || seat >= s.players) return out;
  const row = s.pos[seat];
  const seen = new Set<number>();
  for (let t = 0; t < TOKENS_PER_PLAYER; t++) {
    const p = row[t];
    if (p === POS_HOME || seen.has(p)) continue;
    if (p === POS_YARD) {
      // Only a six opens the gate — the rule the whole game turns on.
      if (die !== 6) continue;
    } else if (p + die > POS_HOME) {
      // Home must be reached exactly; an overshoot simply cannot be played.
      continue;
    }
    seen.add(p);
    out.push(t);
  }
  return out;
}

export const tokensHome = (s: LudoState, seat: number): number =>
  s.pos[seat].reduce((n, p) => n + (p === POS_HOME ? 1 : 0), 0);

/** Squares this seat's tokens have covered between them. The measure of a game
 *  that ran out of clock rather than finishing. */
export const progressOf = (s: LudoState, seat: number): number =>
  s.pos[seat].reduce((n, p) => n + (p > 0 ? p : 0), 0);

/** What a seat's play was worth, ignoring where they came. Bounded on purpose:
 *  see the note above PLACE_POINTS in rules.ts — this has to stay smaller than
 *  the smallest gap between two places, or the results table contradicts
 *  itself. `checkScoreOrdering` in the self-check proves it still does. */
export const performanceOf = (s: LudoState, seat: number): number =>
  tokensHome(s, seat) * POINTS_PER_TOKEN_HOME +
  Math.floor(progressOf(s, seat) / SQUARES_PER_POINT) +
  Math.min(s.captures[seat], CAPTURE_CAP) * POINTS_PER_CAPTURE;

/** The largest garnish any board can produce. Everything is at its ceiling: all
 *  four tokens home (which is also the greatest possible progress) and the
 *  capture count pinned. */
export const MAX_PERFORMANCE =
  TOKENS_PER_PLAYER * POINTS_PER_TOKEN_HOME +
  Math.floor((TOKENS_PER_PLAYER * POS_HOME) / SQUARES_PER_POINT) +
  CAPTURE_CAP * POINTS_PER_CAPTURE;

/** The number the results table prints. A place, plus that garnish. */
export const scoreOf = (s: LudoState, seat: number, placement: number): number =>
  (PLACE_POINTS[placement] ?? 0) + performanceOf(s, seat);

/** Has this seat stopped playing — finished, walked out, or the game is done?
 *  The platform ends a match when this is true of everyone. */
export const isOut = (s: LudoState, seat: number): boolean =>
  s.decided || s.homeAt[seat] >= 0 || s.quit[seat];

/** Seats still in the running. */
export function stillPlaying(s: LudoState): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.players; i++) if (s.homeAt[i] < 0 && !s.quit[i]) out.push(i);
  return out;
}

/** Knock every enemy token off the square this one just landed on.
 *
 *  Safe squares knock nobody, and a token in a home run cannot be reached at
 *  all — those two facts are the whole of Ludo's defence, and both live in
 *  board.ts so the painter can mark them with the same knowledge. */
function capture(s: LudoState, seat: number, pos: number): { seat: number; token: number }[] {
  const taken: { seat: number; token: number }[] = [];
  if (pos < 0 || pos >= RING_STEPS) return taken;
  const ring = ringIndexOf(cornerOf(seat, s.players), pos);
  if (ring < 0 || isSafeRing(ring)) return taken;
  for (let o = 0; o < s.players; o++) {
    if (o === seat) continue;
    const corner = cornerOf(o, s.players);
    for (let t = 0; t < TOKENS_PER_PLAYER; t++) {
      const p = s.pos[o][t];
      if (p < 0 || p >= RING_STEPS) continue;
      if (ringIndexOf(corner, p) !== ring) continue;
      s.pos[o][t] = POS_YARD;
      taken.push({ seat: o, token: t });
    }
  }
  s.captures[seat] += taken.length;
  return taken;
}

function startTurn(s: LudoState, seat: number): void {
  s.turn = seat;
  s.phase = "roll";
  s.since = s.tick;
  s.die = 0;
  s.hop = null;
  s.passReason = "none";
  s.deadline = s.tick + budget(s, seat);
}

/** The game is over once only one player is left with anything to play for.
 *  The straggler takes the last place without having to walk the rest of it. */
function checkOver(s: LudoState): boolean {
  if (s.over) return true;
  if (stillPlaying(s).length > 1) return false;
  s.decided = true;
  s.over = true;
  s.phase = "over";
  s.hop = null;
  s.deadline = Number.MAX_SAFE_INTEGER;
  return true;
}

function nextTurn(s: LudoState): void {
  s.sixes = 0;
  if (checkOver(s)) return;
  for (let i = 1; i <= s.players; i++) {
    const c = (s.turn + i) % s.players;
    if (s.homeAt[c] < 0 && !s.quit[c]) {
      startTurn(s, c);
      return;
    }
  }
  // Unreachable while checkOver holds, but a stuck table is worse than a
  // pointless line: leave the turn where it is rather than spin.
  startTurn(s, s.turn);
}

function pass(s: LudoState, reason: PassReason): void {
  s.phase = "pass";
  s.passReason = reason;
  s.since = s.tick;
  s.deadline = s.tick + PASS_TICKS;
}

/** Play a token. The move is applied here, in full — position, captures, the
 *  home count — and the hop that follows is only its telling. */
function beginHop(s: LudoState, token: number): void {
  const seat = s.turn;
  const from = s.pos[seat][token];
  const steps = from === POS_YARD ? 1 : s.die;
  const to = from === POS_YARD ? 0 : from + s.die;
  s.pos[seat][token] = to;
  const taken = capture(s, seat, to);
  const landedHome = to === POS_HOME;
  let ticks = steps * HOP_TICKS;
  if (taken.length) ticks += CAPTURE_TICKS;
  if (landedHome) ticks += HOME_TICKS;
  s.hop = { seat, token, from, to, taken, extra: s.die === 6 || taken.length > 0 || landedHome };
  s.phase = "hop";
  s.since = s.tick;
  s.deadline = s.tick + ticks;
}

/** The die has finished tumbling: work out what it lets the player do. */
function resolveRoll(s: LudoState): void {
  if (s.die < 1) s.die = 1;
  s.rolls += 1;
  s.sixes = s.die === 6 ? s.sixes + 1 : 0;
  if (s.sixes >= SIX_STREAK_LIMIT) {
    // Three in a row and the whole turn is forfeit — the third six is not
    // played at all. Sixes reset when the turn moves on.
    pass(s, "three-sixes");
    return;
  }
  const moves = legalMoves(s, s.turn, s.die);
  if (moves.length === 0) {
    pass(s, "no-move");
    return;
  }
  // One legal move is not a decision, so it needs no round trip: every table
  // reaches it from the die alone.
  if (moves.length === 1) {
    beginHop(s, moves[0]);
    return;
  }
  s.phase = "pick";
  s.since = s.tick;
  s.deadline = s.tick + budget(s, s.turn);
}

function resolveHop(s: LudoState): void {
  const h = s.hop;
  s.hop = null;
  if (!h) {
    nextTurn(s);
    return;
  }
  if (s.homeAt[h.seat] < 0 && tokensHome(s, h.seat) === TOKENS_PER_PLAYER) {
    s.homeAt[h.seat] = s.tick;
    s.order.push(h.seat);
  }
  if (checkOver(s)) return;
  // Another go for a six, a capture, or a token brought home — unless that was
  // the last token, in which case there is nothing left to play.
  if (h.extra && s.homeAt[h.seat] < 0 && !s.quit[h.seat]) {
    startTurn(s, h.seat);
    return;
  }
  nextTurn(s);
}

/** What a phase does when its own clock runs out.
 *
 *  `roll` and `pick` are not here: they wait on the server, and only the stall
 *  breaker below can end them without it. Everything else is a function of the
 *  state alone, so a client and the server reach the identical board. */
function resolvePhase(s: LudoState): void {
  switch (s.phase) {
    case "spin":
      resolveRoll(s);
      return;
    case "hop":
      resolveHop(s);
      return;
    case "pass":
      nextTurn(s);
      return;
    default:
      return;
  }
}

/** The server has gone quiet for far longer than a late answer: play the turn
 *  from the state alone so the table survives. See stallDie. */
function breakStall(s: LudoState): void {
  if (s.phase === "roll") {
    s.die = stallDie(s.seed, s.rolls);
    s.phase = "spin";
    s.since = s.tick;
    s.deadline = s.tick + SPIN_TICKS;
    return;
  }
  const moves = legalMoves(s, s.turn, s.die);
  if (moves.length === 0) pass(s, "no-move");
  else beginHop(s, moves[0]);
}

/** Apply one input AT its tick.
 *
 *  Player requests are read and discarded: they exist so the SERVER can learn
 *  what someone wants, and the relay carries them to the other tables only so
 *  those tables can show that a hand is hovering. Nothing here moves on them. */
export function applyInput(s: LudoState, seat: number, kind: string): void {
  if (s.over || seat < 0 || seat >= s.players) return;
  const input = parseInput(kind);
  if (!input) return;
  switch (input.type) {
    case "ask-roll":
    case "ask-play":
      return;
    case "away": {
      if (s.away[seat] === input.gone) return;
      s.away[seat] = input.gone;
      // Their clock changes the moment they do, including mid-turn: an absent
      // seat stops holding the table up, and a returning one is not rushed.
      if (seat === s.turn && awaitingServer(s)) s.deadline = s.since + budget(s, seat);
      return;
    }
    case "quit":
      if (s.quit[seat]) return;
      s.quit[seat] = true;
      // If they were the one being waited for, stop waiting: the server sees
      // the collapsed clock on its next pass and plays the turn out at once.
      if (seat === s.turn && awaitingServer(s)) s.deadline = s.tick;
      checkOver(s);
      return;
    case "die":
      if (s.phase !== "roll" || seat !== s.turn) return;
      s.die = input.face;
      s.phase = "spin";
      s.since = s.tick;
      s.deadline = s.tick + SPIN_TICKS;
      return;
    case "play":
      if (s.phase !== "pick" || seat !== s.turn) return;
      if (!legalMoves(s, s.turn, s.die).includes(input.token)) return;
      beginHop(s, input.token);
      return;
  }
}

/** Advance exactly one tick. */
export function step(s: LudoState, durationTicks: number = DURATION_TICKS): void {
  s.tick += 1;
  if (s.over) return;
  if (s.tick >= durationTicks) {
    // The clock ran out. The board freezes exactly as it stands and the
    // ranking is decided on how far everyone got.
    s.over = true;
    s.phase = "over";
    s.hop = null;
    return;
  }
  if (awaitingServer(s)) {
    if (s.tick >= s.deadline + STALL_TICKS) breakStall(s);
    return;
  }
  if (s.tick >= s.deadline) resolvePhase(s);
}

/** Run a fresh table through an input log up to `toTick`.
 *
 *  Cheap enough to redo whole — a twenty-minute match is 24,000 steps and
 *  nearly all of them do one comparison — which is what makes a late or
 *  out-of-order input a non-event: rewind by replaying. */
export function replay(
  seed: number,
  players: number,
  inputs: readonly LudoInput[],
  toTick: number,
  durationTicks: number = DURATION_TICKS
): LudoState {
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
  // A finished game still has to reach the tick it was asked for, so "what
  // tick is it" has one answer whether or not the board has settled.
  if (s.tick < toTick) s.tick = toTick;
  return s;
}

/** ---------------------------------------------------------------------------
 *  LudoSim — the table, its input log, and the bookkeeping that keeps stepping
 *  cheap. Shared by the client (which draws it) and the server (which judges
 *  it) on purpose: an incremental fast path here and a replay there is exactly
 *  how the two would drift apart, so there is one implementation of both.
 * ------------------------------------------------------------------------- */
export class LudoSim {
  state: LudoState;
  private log: LudoInput[] = [];
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

  get inputs(): readonly LudoInput[] {
    return this.log;
  }

  /** Record an input, IN ORDER.
   *
   *  Inserted at its sorted position rather than appended, which is subtler
   *  than it looks and is the difference between a board and two boards. The
   *  incremental path below applies a tick's inputs in log order; a rewind
   *  applies them in SORTED order. If those two orders can differ, then one
   *  client that happened to rewind and one that did not end up with different
   *  boards — and they can differ, because the server may write several inputs
   *  on one tick (an empty chair and a die, say) and a client's own requests
   *  are threaded in between the ones it receives. Sorting on the way in makes
   *  the two orders the same order by construction.
   *
   *  Ties on (tick, seat) keep their arrival order, which is the order the
   *  server emitted them and therefore the same everywhere. */
  addInput(input: LudoInput): void {
    if (!movesBoard(input.kind)) return;
    let i = this.log.length;
    while (i > 0 && order(this.log[i - 1], input) > 0) i--;
    this.log.splice(i, 0, input);
    // Behind the play head, or behind what the incremental path has already
    // applied: either way the state in hand was built without it.
    if (input.tick <= this.state.tick || i < this.cursor) this.dirty = true;
  }

  /** Bring the table to `tick`. Incremental when it can be, a full replay when
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
