// Carrom rules — the numbers the SERVER owns and every client mirrors.
//
// Carrom is the platform's THIRD game and its first with real physics. That is
// the only interesting thing about this file: a runner and a Ludo board can be
// described by a handful of integers, but a struck disc sliding across a board
// is a continuous thing, and the whole game hangs on every device computing
// exactly the same slide from exactly the same flick.
//
// Two decisions make that possible, and both are here rather than buried in the
// solver, because they are rules and not implementation:
//
//   * THE TICK IS SUBDIVIDED. Inputs are stamped in ticks — that is the
//     platform's only vocabulary for "when" — but a coin crossing the board at
//     four board-widths a second would tunnel straight through another coin in
//     a sixtieth of a second. So each tick runs SUBSTEPS fixed physics steps.
//     Both numbers are constants: change either and every board in the world
//     changes with it, which is why they live next to the rules they are.
//
//   * A FLICK IS AN INTEGER. A player does not send a direction and a speed —
//     they send four whole numbers, which the simulation turns into a velocity
//     with nothing but multiplication, division and a square root. Those are
//     the four operations IEEE-754 requires to be correctly rounded, so the
//     same four integers produce bit-identical motion on every device that has
//     ever run this game. Nothing in the simulation may use sin, cos, atan2,
//     pow or hypot: none of them is specified to the last bit, and one of them
//     in the hot path would split the table between an iPhone and a laptop.
//
// Everything else follows the shape Ludo set: the server is the only thing that
// may move a piece, a player's flick is a REQUEST, and the reasons for that are
// in sim.ts.
import type { PartyMode } from "../../core/protocol.js";

export const GAME_ID = "carrom";

/** Players in a match, by the party mode the leader started from.
 *
 *  Carrom has exactly two sides, always. Two players is singles; four is
 *  DOUBLES — partners sit opposite each other and the turn goes round the
 *  board, so the two teams alternate. There is no such thing as a four-way
 *  carrom board: there are two colours of coin and there always were. */
export const MATCH_SIZE: Record<PartyMode, number> = { solo: 4, duo: 2, squad: 4 };

/** Fixed simulation rate. Every input is stamped in these ticks, and a tick is
 *  also one drawn frame of a moving coin — which is why it is sixty and not
 *  Ludo's twenty. A coin can cross the board in half a second; at twenty frames
 *  a second you would watch it teleport. */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/** Physics steps inside one tick.
 *
 *  Not a quality knob — a rule. The fastest a disc may travel is MAX_SPEED
 *  (below), so the furthest anything moves in one step is MAX_SPEED / (TICK_RATE
 *  * SUBSTEPS) = about 0.012 board units, and two discs closing head-on cover
 *  twice that. The smallest pair of radii that must never pass through each
 *  other sums to 0.082. Six substeps keeps the first number comfortably under
 *  the second; four would not, on the hardest flick in the game. */
export const SUBSTEPS = 6;

/** ---------------------------------------------------------------------------
 *  The match clock — a CEILING, not a schedule (the lesson Ludo paid for).
 *
 *  A board of carrom is nineteen coins and, between two reasonable players,
 *  forty to a hundred shots. Measured by the self-check — a hundred and twenty
 *  boards a side, bots of middling skill taking a second and a half over each
 *  flick — singles averages five and a half minutes and doubles four and a
 *  half, and the slowest board in that run took seventeen. Add the two or three
 *  seconds longer a person takes to line a shot up and a real match is nearer
 *  eight, which is what TYPICAL_SEC says and what the picker shows.
 *
 *  The ceiling is half an hour, five times the average, and that is deliberate:
 *  Ludo's clock was set close to its average and turned out to be a guillotine
 *  rather than a safety net, ending nine games in ten that were being played
 *  perfectly well. A ceiling should only ever stop a board nobody is playing.
 * ------------------------------------------------------------------------- */
export const DURATION_SEC = 30 * 60;
export const DURATION_TICKS = DURATION_SEC * TICK_RATE;
export const TYPICAL_SEC = 8 * 60;

/** Countdown shown before tick 0 (server adds this to `now` for startAt). */
export const COUNTDOWN_MS = 3000;

/** How long a dropped connection keeps its seat. Long, for Ludo's reason: in a
 *  turn game a player is doing nothing on purpose for minutes at a time, so a
 *  dead radio is invisible to them until it has already cost them the board —
 *  and the table loses nothing by waiting, because the server plays for them. */
export const DISCONNECT_GRACE_MS = 60_000;

/** Inputs older than this are rejected (and, below it, rewound into). */
export const INPUT_LATE_LIMIT_MS = 1500;
/** Per-player input rate ceiling per second. One flick a turn plus the odd
 *  "I'm still here" is the whole of the traffic; the rest is a script. */
export const INPUT_MAX_PER_SEC = 6;

/** ---------------------------------------------------------------------------
 *  Turn timings, all in ticks. These are gameplay: the simulation advances
 *  through them, so both sides agree on the exact tick a shot begins, ends and
 *  passes on.
 * ------------------------------------------------------------------------- */

/** How long a player has to place the striker, aim and flick. Longer than
 *  Ludo's turn because there is genuinely more to do — a Ludo turn is one tap
 *  out of at most four, this is a position, an angle and a power. */
export const TURN_TICKS = 14 * TICK_RATE;

/** The hard ceiling on one shot's flight. Friction stops everything long before
 *  this (the fastest flick runs down in about three and a quarter seconds, and
 *  the settle test below cuts the tail off); it exists so that no arrangement of
 *  discs, however pathological, can hold the board open forever. */
export const SHOOT_MAX_TICKS = 8 * TICK_RATE;

/** The beat after the discs stop, before the next player is asked. Long enough
 *  to read what happened — a pocket, a foul, the queen going down — short
 *  enough that sixty of them are not a minute of the match. */
export const BEAT_TICKS = Math.round(0.6 * TICK_RATE);

/** How long past a turn's deadline the table waits for the server before
 *  playing the turn itself. Not a slow answer — the server plays an expired
 *  turn within a fraction of a second — but a server that has stopped
 *  answering, and the alternative to breaking the stall is a frozen board. */
export const STALL_TICKS = 20 * TICK_RATE;

/** Questions a player may let run out before the table stops waiting for them.
 *
 *  Ludo's lesson, and it bites harder here: an absent chair costs the table the
 *  full fourteen seconds every time it comes round, and there are dozens of
 *  turns. After this many unanswered questions the seat still plays — the
 *  server flicks for it — but instantly. One touch of the screen and the clock
 *  is theirs again. */
export const AWAY_AFTER_MISSES = 3;

/** ---------------------------------------------------------------------------
 *  The board rules.
 * ------------------------------------------------------------------------- */

/** Coins per side. Nine white, nine black, one queen: nineteen. */
export const COINS_PER_TEAM = 9;

/** ---------------------------------------------------------------------------
 *  Scoring.
 *
 *  The same discipline as Ludo, for the same reason: the PLACEMENT is decided
 *  by the board — who cleared their nine — and the score is what the results
 *  table prints beside it, so it must never contradict the column next to it.
 *  A losing player who sank eight coins has plainly had a better afternoon than
 *  a winner who sank one, and the table would look broken if it said so in the
 *  score column while calling them second.
 *
 *  So a score is a place plus a garnish, and the gap between the places is
 *  wider than the largest garnish any board can produce. The self-check asserts
 *  that margin, so tuning these numbers past it fails loudly rather than
 *  quietly printing a nonsense table.
 * ------------------------------------------------------------------------- */
export const PLACE_POINTS: readonly number[] = [0, 2000, 900];
/** Per coin the player personally sank for their own side. */
export const POINTS_PER_COIN = 40;
/** Covering the queen. Three coins' worth, which is what the queen is worth in
 *  the paper rules too. */
export const POINTS_QUEEN = 120;

/** The largest garnish any board can produce: every coin of a side sunk by one
 *  person, and the queen covered by them. */
export const MAX_PERFORMANCE = COINS_PER_TEAM * POINTS_PER_COIN + POINTS_QUEEN;

/** ---------------------------------------------------------------------------
 *  Seats, sides and teams.
 *
 *  A SEAT is the platform's index into the roster. A SIDE is a physical edge of
 *  the board. They are deliberately not the same number, and the reason is
 *  parties.
 *
 *  Matchmaking seats whole parties CONTIGUOUSLY (see platform/match.ts), so the
 *  only way to keep friends on the same team is to make the team the first two
 *  seats and the last two — teams {0,1} and {2,3}. But partners in doubles must
 *  sit OPPOSITE each other, and the turn must alternate teams as it goes round
 *  the board. Both are satisfied by seating them out of order:
 *
 *      side 0 (bottom) = seat 0        team 0        turn 1st
 *      side 1 (right)  = seat 2        team 1        turn 2nd
 *      side 2 (top)    = seat 1        team 0        turn 3rd
 *      side 3 (left)   = seat 3        team 1        turn 4th
 *
 *  Partners face each other, the turn goes clockwise round the board, the teams
 *  alternate, and a party of two that queued for squad ends up playing together
 *  rather than against each other. A party of three cannot be kept whole in a
 *  two-a-side game by any arrangement — that is a property of doubles, not of
 *  this code.
 * ------------------------------------------------------------------------- */

/** Which physical edge a seat sits at. 0 bottom, 1 right, 2 top, 3 left. */
export function sideOf(seat: number, players: number): number {
  if (players <= 2) return seat === 0 ? 0 : 2;
  return seat === 0 ? 0 : seat === 1 ? 2 : seat === 2 ? 1 : 3;
}

/** Which side a seat belongs to in the only sense that scores: 0 plays the
 *  light coins, 1 the dark ones. */
export function teamOf(seat: number, players: number): number {
  if (players <= 2) return seat === 0 ? 0 : 1;
  return seat < 2 ? 0 : 1;
}

/** The seats of a team, in turn order. */
export function seatsOfTeam(team: number, players: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < players; s++) if (teamOf(s, players) === team) out.push(s);
  return out;
}

/** Seats in the order they shoot — round the board, so the teams alternate. */
export function turnOrder(players: number): number[] {
  if (players <= 2) return [0, 1];
  return [0, 2, 1, 3];
}

/** Where a seat comes in the turn order (its index in turnOrder). */
export function turnIndexOf(seat: number, players: number): number {
  return turnOrder(players).indexOf(seat);
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
    shootMaxTicks: SHOOT_MAX_TICKS,
    stallTicks: STALL_TICKS,
    coinsPerTeam: COINS_PER_TEAM,
    pointsPerCoin: POINTS_PER_COIN,
    pointsQueen: POINTS_QUEEN,
    // Mirrored so the client never offers a flick the server is about to refuse.
    inputMaxPerSec: INPUT_MAX_PER_SEC,
  };
}
