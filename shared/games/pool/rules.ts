// 8-Ball Pool rules — the numbers the SERVER owns and every client mirrors.
//
// The platform's FIFTH game and its second with real physics, so the whole of
// carrom's determinism argument applies again and is not restated here: a shot
// is a handful of INTEGERS, and the solver uses only +, -, *, / and Math.sqrt —
// the five operations IEEE-754 requires to be correctly rounded and therefore
// the only five that return the same bits on every device. Nothing in this
// simulation may use sin, cos, atan2, pow or hypot; `check:pool` greps the
// source to keep it that way.
//
// WHAT THIS GAME DELIBERATELY DOES NOT HAVE IS SPIN. No draw, no follow, no
// English. That is a design decision rather than an omission: side and screw
// need angular momentum, a friction torque between cloth and ball, and a
// contact model that turns a two-line collision into thirty — and every one of
// those lines is another place for two devices to round differently. What is
// left is the game a person actually plays on a phone with one thumb: aim, cut,
// weight, position. The cue ball still runs on after contact exactly as a
// stunned ball does, because that much falls out of the momentum alone.
import type { PartyMode } from "../../core/protocol.js";

export const GAME_ID = "pool";

/** Players in a match, by the party mode the leader started from.
 *
 *  Pool has two SIDES, always. Two players is singles; four is scotch doubles —
 *  partners alternate shots and one side takes the solids, the other the
 *  stripes. There is no such thing as four-handed 8-ball: there are two groups
 *  of seven and there always were. */
export const MATCH_SIZE: Record<PartyMode, number> = { solo: 4, duo: 2, squad: 4 };

/** Fixed simulation rate. Sixty, as carrom's: a tick is also one drawn frame of
 *  a rolling ball, and a ball crosses this table in under half a second. */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/** Physics steps inside one tick.
 *
 *  Not a quality knob — a rule. The hardest break sends the cue ball at
 *  MAX_SPEED, so the furthest anything moves in one step is MAX_SPEED /
 *  (TICK_RATE * SUBSTEPS) ≈ 0.011 table units, and two balls closing head-on
 *  cover twice that against a radii sum of 0.045. Eight substeps keeps the
 *  first number under the second on every shot in the game; six would not, on
 *  the break. */
export const SUBSTEPS = 8;

/** ---------------------------------------------------------------------------
 *  The match clock — a CEILING, not a schedule.
 *
 *  One rack. Measured against bots that take about a second and a half over a
 *  shot, a rack runs two to four minutes; a person spends rather longer walking
 *  round the table in their head, so the picker is shown six.
 *
 *  Twenty minutes is the backstop, and it only ever stops a rack nobody is
 *  playing — the lesson Ludo's clock cost, kept in every game since.
 * ------------------------------------------------------------------------- */
export const DURATION_SEC = 20 * 60;
export const DURATION_TICKS = DURATION_SEC * TICK_RATE;
export const TYPICAL_SEC = 6 * 60;

/** Countdown shown before tick 0 (server adds this to `now` for startAt). */
export const COUNTDOWN_MS = 3000;

/** How long a dropped connection keeps its seat. Long, for the reason every
 *  turn game here has one: a player is doing nothing on purpose for minutes at
 *  a time, so a dead radio is invisible until it has already cost them. */
export const DISCONNECT_GRACE_MS = 60_000;

/** Inputs older than this are rejected (and, below it, rewound into). */
export const INPUT_LATE_LIMIT_MS = 1500;
/** Per-player input rate ceiling per second. One shot a turn plus the aim the
 *  table watches, which goes out four times a second. */
export const INPUT_MAX_PER_SEC = 6;

/** ---------------------------------------------------------------------------
 *  Turn timings, all in ticks.
 * ------------------------------------------------------------------------- */

/** How long a player has to place, aim and strike. Longer than carrom's,
 *  because a pool shot is a longer decision: which ball, which pocket, and
 *  where the cue ball has to finish for the next one. */
export const TURN_TICKS = 18 * TICK_RATE;

/** The hard ceiling on one shot. Friction stops everything long before this —
 *  the hardest break runs down in about four and a half seconds and the settle
 *  test cuts the tail — so it exists only so that no arrangement of balls,
 *  however pathological, can hold the table open forever. */
export const SHOOT_MAX_TICKS = 12 * TICK_RATE;

/** The beat after the balls stop, before the next player is asked. Long enough
 *  to read what happened — a pot, a foul, a group being decided. */
export const BEAT_TICKS = Math.round(0.7 * TICK_RATE);

/** ---------------------------------------------------------------------------
 *  The stroke — the backswing, and the drive through the ball.
 *
 *  THE ONE THING A TABLE COULD NOT SEE WAS WEIGHT. Where somebody is aiming is
 *  a line anybody can read off the cloth, but how hard they are about to hit it
 *  lived in a slider on their own phone — and the weight IS most of the shot:
 *  the same angle played softly and played at pace are two different shots with
 *  two different outcomes. So the cue now does what a real one does. It draws
 *  back in proportion to the weight, drives through the ball, and NOTHING MOVES
 *  UNTIL IT ARRIVES.
 *
 *  Being part of the SIMULATION rather than an animation is the whole point. A
 *  live aim (`m…`) is a courtesy that never enters a log, so a rack watched
 *  back in the console had no cue in it at all: the balls simply jumped. The
 *  stroke is derived from the SHOT, and the shot is in the log — so the same
 *  backswing plays on the shooter's phone, on every phone watching, on a bot's
 *  table and in a replay scrubbed a week later, tick for tick.
 *
 *  A HARD SHOT ALSO TAKES LONGER TO PLAY, which is true of a real one and is a
 *  second reading of the weight for anyone who misses the first.
 * ------------------------------------------------------------------------- */
export const STROKE_MIN_TICKS = Math.round(0.2 * TICK_RATE);
export const STROKE_MAX_TICKS = Math.round(0.42 * TICK_RATE);

/** How long this stroke takes, from the wire's own power (0…1000).
 *
 *  Integer arithmetic on an integer input, like everything else a table has to
 *  agree about: two devices that disagreed by one tick on the length of a
 *  backswing would strike the cue ball on two different ticks and be playing
 *  two different racks a second later. */
export function strokeTicks(power: number): number {
  const p = power < 0 ? 0 : power > 1000 ? 1000 : Math.floor(power);
  return STROKE_MIN_TICKS + Math.floor(((STROKE_MAX_TICKS - STROKE_MIN_TICKS) * p) / 1000);
}

/** How long past a turn's deadline the table waits for the server before
 *  playing the turn itself. Not a slow answer — a server that has stopped
 *  answering, and the alternative to breaking the stall is a frozen table. */
export const STALL_TICKS = 20 * TICK_RATE;

/** Turns a player may let run out before the table stops waiting for them. */
export const AWAY_AFTER_MISSES = 3;

/** ---------------------------------------------------------------------------
 *  The rack.
 * ------------------------------------------------------------------------- */

/** Balls, by their real numbers: 0 is the cue, 1–7 the solids, 8 the black,
 *  9–15 the stripes. Sixteen bodies, and the numbering is the one printed on
 *  them so that a log is readable without a lookup table. */
export const BALLS = 16;
export const CUE = 0;
export const EIGHT = 8;
export const PER_GROUP = 7;

/** Which group a ball belongs to: 0 solids, 1 stripes, -1 for the cue and the
 *  black. */
export function groupOf(ball: number): number {
  if (ball <= 0 || ball === EIGHT || ball >= BALLS) return -1;
  return ball < EIGHT ? 0 : 1;
}

/** ---------------------------------------------------------------------------
 *  Scoring.
 *
 *  The same discipline as every game here: the PLACEMENT is the table's — who
 *  cleared their seven and sank the black — and the score printed beside it
 *  must never contradict it. A place, plus a garnish smaller than the gap
 *  between the two places, and the self-check asserts that margin.
 * ------------------------------------------------------------------------- */
export const PLACE_POINTS: readonly number[] = [0, 2000, 900];
/** Per ball of your own group that YOU potted. */
export const POINTS_PER_BALL = 60;
/** For the black, potted legally to win. */
export const POINTS_EIGHT = 200;

/** The largest garnish any rack can produce: one player clearing all seven and
 *  finishing it. */
export const MAX_PERFORMANCE = PER_GROUP * POINTS_PER_BALL + POINTS_EIGHT;

/** ---------------------------------------------------------------------------
 *  Seats, sides and teams — carrom's arrangement, and for carrom's reason.
 *
 *  Matchmaking seats whole parties CONTIGUOUSLY, so the only way to keep
 *  friends together is to make the sides the first two seats and the last two.
 *  The turn then has to alternate sides as it goes round, which it does by
 *  running 0, 2, 1, 3 — so a party of two that queued for squad plays together
 *  rather than against each other.
 * ------------------------------------------------------------------------- */

export function teamOf(seat: number, players: number): number {
  if (players <= 2) return seat === 0 ? 0 : 1;
  return seat < 2 ? 0 : 1;
}

export function seatsOfTeam(team: number, players: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < players; s++) if (teamOf(s, players) === team) out.push(s);
  return out;
}

/** Seats in the order they shoot, so the two sides alternate. */
export function turnOrder(players: number): number[] {
  return players <= 2 ? [0, 1] : [0, 2, 1, 3];
}

/** The rules the client must be told. It has its own copy of this file, but the
 *  server is the authority and a mismatched build should still agree. */
export function publicRules(): Record<string, number> {
  return {
    tickRate: TICK_RATE,
    durationTicks: DURATION_TICKS,
    countdownMs: COUNTDOWN_MS,
    substeps: SUBSTEPS,
    turnTicks: TURN_TICKS,
    beatTicks: BEAT_TICKS,
    strokeMinTicks: STROKE_MIN_TICKS,
    strokeMaxTicks: STROKE_MAX_TICKS,
    shootMaxTicks: SHOOT_MAX_TICKS,
    stallTicks: STALL_TICKS,
    perGroup: PER_GROUP,
    pointsPerBall: POINTS_PER_BALL,
    // Mirrored so the client never offers a shot the server is about to refuse.
    inputMaxPerSec: INPUT_MAX_PER_SEC,
  };
}
