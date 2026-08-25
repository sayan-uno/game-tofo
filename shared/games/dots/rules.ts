// Dots & Boxes rules — the numbers the SERVER owns and every client mirrors.
//
// The platform's FOURTH game, and the first with no chance in it at all: no
// dice, no physics, no hidden information. Every player can see the whole
// board and work out the whole future of it, which makes this the one game
// here where the bot's opinion of a position is the entire difficulty curve.
//
// It is also the cheapest game on the platform by a long way. A whole match is
// eighty-four integers and the simulation is a handful of array reads, so a
// cold replay of a finished board costs less than a millisecond and the "pack"
// is nothing at all.
import type { PartyMode } from "../../core/protocol.js";

export const GAME_ID = "dots";

/** Players in a match, by the party mode the leader started from.
 *
 *  Free-for-all at both sizes, unlike carrom: a box belongs to whoever closed
 *  it, so there is nothing to pair up. Four people round one grid is how the
 *  game is actually played at a table when there are four people. */
export const MATCH_SIZE: Record<PartyMode, number> = { solo: 4, duo: 2, squad: 4 };

/** Fixed simulation rate. Twenty a second, as Ludo's: nothing here moves
 *  continuously, and every animation is a line appearing or a box filling. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

/** ---------------------------------------------------------------------------
 *  The grid.
 *
 *  Six boxes a side — a seven-by-seven field of dots, eighty-four lines and
 *  thirty-six boxes. That is the size the whole game is tuned around:
 *
 *    * it is the smallest board on which CHAINS form reliably, and chains are
 *      the entire game. On a four-by-four everything is a scramble and the
 *      better player barely wins more often.
 *    * eighty-four moves between two people is forty-two each, which at a few
 *      seconds a move is about the length of a match this platform wants.
 *    * thirty-six boxes divides evenly by both match sizes, so neither is
 *      played on a board that cannot be shared.
 *
 *  One size for both, deliberately. A grid that changed with the number of
 *  players would mean a player's feel for the board — how long a chain is
 *  worth waiting for — resets every time they switch mode.
 * ------------------------------------------------------------------------- */
export const GRID = 6;

/** ---------------------------------------------------------------------------
 *  The match clock — a CEILING, not a schedule.
 *
 *  Eighty-four lines, and a move is one tap, so the length is almost entirely
 *  human reaction time. Measured against bots that answer in about a second, a
 *  board runs just under two minutes; a person takes two or three seconds over
 *  a move and rather longer over the middlegame, where the whole game is
 *  actually decided, so four is what the picker is shown.
 *
 *  Twenty minutes is the backstop — five times the honest number. It exists to
 *  stop a board nobody is playing, never a board somebody is thinking about,
 *  which is the lesson Ludo's clock cost.
 * ------------------------------------------------------------------------- */
export const DURATION_SEC = 20 * 60;
export const DURATION_TICKS = DURATION_SEC * TICK_RATE;
export const TYPICAL_SEC = 4 * 60;

/** Countdown shown before tick 0 (server adds this to `now` for startAt). */
export const COUNTDOWN_MS = 3000;

/** How long a dropped connection keeps its seat. Long, for the reason every
 *  turn game here has: a player is doing nothing on purpose for minutes at a
 *  time, so a dead radio is invisible until it has already cost them. */
export const DISCONNECT_GRACE_MS = 60_000;

/** Inputs older than this are rejected (and, below it, rewound into). */
export const INPUT_LATE_LIMIT_MS = 1500;
/** Per-player input rate ceiling per second. A move is one tap; the rest of the
 *  budget is the line a finger is hovering over, which is sent at four a
 *  second (see `hoverKind`). */
export const INPUT_MAX_PER_SEC = 8;

/** ---------------------------------------------------------------------------
 *  Turn timings, all in ticks.
 * ------------------------------------------------------------------------- */

/** How long a player has to choose a line. Shorter than carrom's, because
 *  there is one decision rather than three — and longer than it looks, because
 *  a player who closes a box goes again and keeps the clock. */
export const TURN_TICKS = 12 * TICK_RATE;

/** The line drawing itself, and each box filling in after it. Both are read as
 *  much as watched: a box that simply appeared would leave a player unsure
 *  whether the run was still going. */
export const DRAW_TICKS = Math.round(0.22 * TICK_RATE);
export const CLAIM_TICKS = Math.round(0.26 * TICK_RATE);

/** How long past a turn's deadline the table waits for the server before
 *  playing the turn itself. Not a slow answer — a server that has stopped
 *  answering, and the alternative to breaking the stall is a frozen board. */
export const STALL_TICKS = 20 * TICK_RATE;

/** Turns a player may let run out before the table stops waiting for them.
 *  An absent seat still plays, instantly, until its owner touches the screen. */
export const AWAY_AFTER_MISSES = 3;

/** ---------------------------------------------------------------------------
 *  Scoring.
 *
 *  The same discipline as the other games: the PLACEMENT is the board's — who
 *  took the most boxes — and the score printed beside it must never contradict
 *  it. So the score is a place plus a garnish smaller than the narrowest gap
 *  between two places, and the self-check asserts that margin.
 * ------------------------------------------------------------------------- */
export const PLACE_POINTS: readonly number[] = [0, 2000, 1200, 700, 300];
/** Per box taken. Bounded so that thirty-six of them — the whole board — stay
 *  under the four-hundred-point gap between third and fourth. */
export const POINTS_PER_BOX = 10;

/** The rules the client must be told. It has its own copy of this file, but the
 *  server is the authority and a mismatched build should still agree. */
export function publicRules(): Record<string, number> {
  return {
    tickRate: TICK_RATE,
    durationTicks: DURATION_TICKS,
    countdownMs: COUNTDOWN_MS,
    grid: GRID,
    turnTicks: TURN_TICKS,
    drawTicks: DRAW_TICKS,
    claimTicks: CLAIM_TICKS,
    stallTicks: STALL_TICKS,
    pointsPerBox: POINTS_PER_BOX,
    // Mirrored so the client never offers a tap the server is about to refuse.
    inputMaxPerSec: INPUT_MAX_PER_SEC,
  };
}
