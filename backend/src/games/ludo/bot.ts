// The Ludo bot: which token to play, and how long to look like it thought.
//
// It cannot be planned. A runner's bot knows the whole course before the match
// starts and nobody can interfere with it, so its entire run is written up
// front (see games/trackline/bot.ts). A board bot knows neither the die it is
// about to be given nor where anyone else's tokens will be, because both are
// consequences of choices that have not been made yet. So this decides one move
// at a time, on the server's own copy of the board, and its answers travel as
// ordinary inputs — the same channel, the same relay, the same replay.
//
// The policy is deliberately legible rather than clever. It values, in order:
// finishing a token, knocking one out, getting a fourth token into play, and
// not standing somewhere it can be knocked out itself. Then `skill` decides how
// often it actually takes its own advice — a bot that always played the best
// move would be both unbeatable and boring, and the point of filling a seat is
// to be company, not an opponent nobody can live with.
import {
  POS_HOME,
  POS_YARD,
  RING_LENGTH,
  RING_STEPS,
  TOKENS_PER_PLAYER,
  cornerOf,
  isSafeRing,
  legalMoves,
  ringIndexOf,
  type LudoState,
} from "../../shared/games/ludo/index.js";

/** Ordinary randomness: a bot's choice is not part of the deterministic
 *  simulation (its OUTPUT is), so using the match seed here would only make
 *  every match with the same seed play out identically. Injectable so the
 *  self-check can pin it. */
export type Rand = () => number;

/** ---------------------------------------------------------------------------
 *  What a move is worth. All in the same made-up unit; only the ordering
 *  matters, and the comments say what each number is buying.
 * ------------------------------------------------------------------------- */
/** Bringing a token home ends it — nothing on the board beats it. */
const V_HOME = 900;
/** Turning into the home run puts a token permanently out of reach. */
const V_HOME_RUN = 240;
/** A fourth token in play is a fourth option every turn afterwards. */
const V_LEAVE_YARD = 320;
/** Knocking someone out, plus what their walk was worth to them. */
const V_CAPTURE = 420;
const V_CAPTURE_PER_SQUARE = 4;
/** Standing where nobody can touch you. */
const V_SAFE = 90;
/** Each enemy that could reach a square with one of six faces. */
const V_THREAT = 55;
/** Getting OFF a threatened square is worth most, but not all, of the danger —
 *  otherwise the bot spends the whole game running away instead of forward. */
const RETREAT_SHARE = 0.6;

/** How exposed a ring square is: one unit per enemy token that could land on it
 *  with a single roll. A token that would have to pass its own home turning
 *  counts for nothing — it can never get there. */
function threatAt(s: LudoState, seat: number, ring: number): number {
  if (isSafeRing(ring)) return 0;
  let t = 0;
  for (let o = 0; o < s.players; o++) {
    if (o === seat) continue;
    const corner = cornerOf(o, s.players);
    for (let k = 0; k < TOKENS_PER_PLAYER; k++) {
      const p = s.pos[o][k];
      if (p < 0 || p >= RING_STEPS) continue; // in the yard or already past reach
      const e = ringIndexOf(corner, p);
      if (e < 0) continue;
      const gap = (ring - e + RING_LENGTH) % RING_LENGTH;
      if (gap < 1 || gap > 6) continue;
      if (p + gap >= RING_STEPS) continue; // they would turn off before reaching it
      t += V_THREAT;
    }
  }
  return t;
}

/** What playing this token with this face is worth. */
function valueOf(s: LudoState, seat: number, token: number, die: number): number {
  const corner = cornerOf(seat, s.players);
  const from = s.pos[seat][token];
  const to = from === POS_YARD ? 0 : from + die;
  // Raw progress, so that all else being equal the furthest token advances.
  let v = to;
  if (to === POS_HOME) v += V_HOME;
  else if (to >= RING_STEPS) v += V_HOME_RUN;
  if (from === POS_YARD) v += V_LEAVE_YARD;

  const toRing = ringIndexOf(corner, to);
  if (toRing >= 0) {
    if (isSafeRing(toRing)) {
      v += V_SAFE;
    } else {
      // Anyone standing there is knocked home, and the further they had come
      // the more that hurts them.
      for (let o = 0; o < s.players; o++) {
        if (o === seat) continue;
        const oc = cornerOf(o, s.players);
        for (let k = 0; k < TOKENS_PER_PLAYER; k++) {
          const p = s.pos[o][k];
          if (p < 0 || p >= RING_STEPS) continue;
          if (ringIndexOf(oc, p) === toRing) v += V_CAPTURE + V_CAPTURE_PER_SQUARE * p;
        }
      }
      v -= threatAt(s, seat, toRing);
    }
  }
  // Leaving a square somebody was aiming at is a move in itself.
  const fromRing = ringIndexOf(corner, from);
  if (fromRing >= 0) v += threatAt(s, seat, fromRing) * RETREAT_SHARE;
  return v;
}

/** Which token this bot plays. Always returns a LEGAL token — the caller has
 *  already established that at least one exists. */
export function chooseToken(s: LudoState, seat: number, skill: number, rand: Rand = Math.random): number {
  const moves = legalMoves(s, seat, s.die);
  if (moves.length === 0) return 0;
  if (moves.length === 1) return moves[0];
  // How often it takes its own advice. The weakest bot still plays well a
  // third of the time, which is roughly what a distracted person does.
  const follows = 0.3 + 0.65 * Math.max(0, Math.min(1, skill));
  if (rand() >= follows) return moves[Math.floor(rand() * moves.length) % moves.length];
  let best = moves[0];
  let bestValue = -Infinity;
  for (const t of moves) {
    const v = valueOf(s, seat, t, s.die);
    if (v > bestValue) {
      bestValue = v;
      best = t;
    }
  }
  return best;
}

/** ---------------------------------------------------------------------------
 *  Thinking time. A bot that answered the instant its turn began would be the
 *  one tell no roster entry can hide, so it waits — a shorter beat to pick up
 *  the dice than to choose between four tokens, which is also what people do.
 * ------------------------------------------------------------------------- */
const THINK_ROLL = [0.25, 0.7]; // seconds
const THINK_PICK = [0.4, 1.1];

/** Ticks to wait before acting, drawn once per turn (the caller remembers it —
 *  redrawing every poll would make the bot fire at the first low sample). */
export function thinkTicks(tickRate: number, choosing: boolean, rand: Rand = Math.random): number {
  const [lo, hi] = choosing ? THINK_PICK : THINK_ROLL;
  return Math.round((lo + (hi - lo) * rand()) * tickRate);
}
