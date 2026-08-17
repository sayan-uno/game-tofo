// Ludo rules — the numbers the SERVER owns and every client mirrors.
//
// Ludo is a TURN-BASED game living on a platform built for a real-time runner,
// so the first thing to understand is why it still has a tick rate at all.
// Ticks are the platform's only vocabulary for "when": inputs are stamped in
// them, late inputs are judged against them, and the match clock is measured in
// them. Ludo therefore keeps a clock too — a slow one — and every deadline in
// the game (your time to move, how long a token takes to hop, how long the dice
// tumbles) is expressed in ticks so that the same input log produces the same
// board on every device and on the server.
//
// Twenty ticks a second is the whole of it: fine enough that an animation lands
// on the frame it should, coarse enough that replaying a twenty-minute match
// from the first input costs less than a millisecond.
import type { PartyMode } from "../../core/protocol.js";

export const GAME_ID = "ludo";

/** Players in a match, by the party mode the leader started from. Four is the
 *  board's natural number; duo is the classic two-player game across the
 *  diagonal. Empty seats are filled by matchmaking and then by bots. */
export const MATCH_SIZE: Record<PartyMode, number> = { solo: 4, duo: 2, squad: 4 };

/** Fixed simulation rate. Every input is stamped in these ticks. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

/** The match clock — a CEILING, and a backstop rather than a schedule.
 *
 *  Ludo is a long game and there is no honest way around it: four tokens each,
 *  fifty-six squares apiece and a six needed to start any of them comes to
 *  three or four hundred turns between four people. Measured (tools/checks and
 *  the note below), a table of four finishes in about twelve minutes if
 *  everyone taps the instant it is their turn, twenty if they take a second to
 *  think, and thirty-five at two seconds — which is what people actually do.
 *
 *  An earlier twenty-five-minute clock was therefore not a safety net at all:
 *  it cut off nine games in ten that were being played perfectly well. An hour
 *  is chosen so that the clock only ever ends a game nobody is really playing.
 *  The other half of that promise is AWAY_AFTER_MISSES below — an empty chair
 *  used to cost the table ten seconds every time it came round, three hundred
 *  times, and one of them was enough to run any match out of clock.
 *
 *  TYPICAL_SEC is what the picker shows, because advertising the ceiling would
 *  describe the game as twice the length it usually is.
 */
export const DURATION_SEC = 60 * 60;
export const DURATION_TICKS = DURATION_SEC * TICK_RATE;
export const TYPICAL_SEC = 25 * 60;

/** Countdown shown before tick 0 (server adds this to `now` for startAt). */
export const COUNTDOWN_MS = 3000;

/** How long a dropped connection keeps its seat. Three times the platform's
 *  default, because a Ludo player spends most of the match doing nothing on
 *  purpose and would not notice a drop until it had already forfeited them —
 *  and because a missing player costs the table nothing here: the server plays
 *  their turns for them. */
export const DISCONNECT_GRACE_MS = 60_000;

/** Inputs older than this are rejected (and, below it, rewound into). Roomier
 *  than the runner's, because nothing here is frame-perfect: a tap that took an
 *  extra half second to arrive should still count. */
export const INPUT_LATE_LIMIT_MS = 1500;
/** Per-player input rate ceiling per second. A board game needs a handful; the
 *  rest is a script. */
export const INPUT_MAX_PER_SEC = 6;

/** ---------------------------------------------------------------------------
 *  Turn timings, all in ticks.
 *
 *  These are gameplay, not decoration: the sim advances through them, so both
 *  sides agree on exactly which tick a token lands and whose turn it is next.
 *  The view reads the same numbers to interpolate, which is why the animation
 *  can never finish before or after the rules say it did.
 * ------------------------------------------------------------------------- */

/** How long a player has to roll, and then to choose a token. Generous enough
 *  to think, short enough that three people are not held hostage by a fourth. */
export const TURN_TICKS = 10 * TICK_RATE;
/** The dice tumbles for this long once its face has arrived. The tap starts a
 *  tumble on screen straight away, so this is what remains of it after the
 *  server's answer lands — the round trip is spent, not waited out. */
export const SPIN_TICKS = Math.round(0.3 * TICK_RATE);
/** How long past a turn's deadline the table waits for the server before
 *  playing the turn itself. This is not a slow answer — the server plays an
 *  expired turn within a fraction of a second — it is a server that has
 *  stopped answering, and the alternative to breaking the stall is a frozen
 *  board for everyone. */
export const STALL_TICKS = 20 * TICK_RATE;
/** Ticks a token spends on each square it crosses. One, not two: a Ludo game
 *  is four hundred turns long, so every tick spent watching a token walk is
 *  paid four hundred times and the whole match is minutes longer for it. */
export const HOP_TICKS = 1;
/** Added to a hop that ends in a capture, so the knock-out has room to read. */
export const CAPTURE_TICKS = Math.round(0.4 * TICK_RATE);
/** Added to a hop that ends on the home triangle. */
export const HOME_TICKS = Math.round(0.4 * TICK_RATE);
/** A turn that cannot move anything pauses this long, so "no move" is seen
 *  rather than merely skipped. */
export const PASS_TICKS = Math.round(0.6 * TICK_RATE);

/** Questions a player may let run out before the table stops waiting for them.
 *
 *  A chair that is not there costs the full turn clock EVERY time it comes
 *  round — three hundred-odd times in a game — and that one absence is enough
 *  to push a match everybody else is playing properly past its ceiling. After
 *  this many unanswered questions the seat keeps playing, but instantly; one
 *  tap from its owner and the clock is theirs again.
 *
 *  Counted in questions rather than turns because most turns ask only one (a
 *  roll with no choice plays itself), so four is about three turns, or half a
 *  minute of silence. */
export const AWAY_AFTER_MISSES = 4;

/** Rolling this many sixes in a row forfeits the turn — the traditional brake
 *  on a lucky streak, and the reason a six is not simply free. */
export const SIX_STREAK_LIMIT = 3;

/** ---------------------------------------------------------------------------
 *  Scoring.
 *
 *  The PLACEMENT is decided by the rules — who got all four home, and who got
 *  there first. The score is what the results table prints beside it and what
 *  career stats accumulate, and it therefore has one hard obligation: it must
 *  never contradict the number in the column next to it. A second place out-
 *  scoring the winner reads as a bug whatever the arithmetic behind it, and
 *  Ludo makes that easy to reach — a player who knocks four people out and
 *  gets three tokens home has plainly had a better afternoon than someone who
 *  crept home unopposed, but they still lost.
 *
 *  So the score is a place, plus a garnish. The gaps between the places are
 *  wider than everything else here added together, which makes the ordering a
 *  property of the arithmetic rather than a hope — the self-check asserts the
 *  margin, so tuning any of these numbers past it fails loudly.
 * ------------------------------------------------------------------------- */
export const PLACE_POINTS: readonly number[] = [0, 2000, 1200, 700, 300];
export const POINTS_PER_TOKEN_HOME = 25;
export const POINTS_PER_CAPTURE = 15;
/** Squares covered are worth a quarter point each, so a whole lap is worth
 *  about one knock-out. */
export const SQUARES_PER_POINT = 4;
/** Knock-outs past this stop counting. Not a judgement on knocking people out
 *  — it is what keeps the garnish provably smaller than a place. */
export const CAPTURE_CAP = 15;

/** The rules the client must be told. It has its own copy of this file, but the
 *  server is the authority and a mismatched build should still agree. */
export function publicRules(): Record<string, number> {
  return {
    tickRate: TICK_RATE,
    durationTicks: DURATION_TICKS,
    countdownMs: COUNTDOWN_MS,
    turnTicks: TURN_TICKS,
    spinTicks: SPIN_TICKS,
    hopTicks: HOP_TICKS,
    stallTicks: STALL_TICKS,
    sixStreakLimit: SIX_STREAK_LIMIT,
    pointsPerTokenHome: POINTS_PER_TOKEN_HOME,
    pointsPerCapture: POINTS_PER_CAPTURE,
    // Mirrored so the client never offers a tap the server is about to refuse.
    inputMaxPerSec: INPUT_MAX_PER_SEC,
  };
}
