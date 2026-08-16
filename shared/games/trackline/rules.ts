// Trackline rules — the numbers the SERVER owns and every client mirrors.
// Anything here changes gameplay for everyone at once, so nothing in the
// client duplicates these values; the client imports them from its copy of
// this file and the server sends the ones the client must not guess (see
// MatchPrepare.rules).
import type { PartyMode } from "../../core/protocol.js";

export const GAME_ID = "trackline";

/** Runners in a match, by the party mode the leader started from. Solo and
 *  squad are four-runner matches (filled by matchmaking, then bots); duo is
 *  a two-runner match. */
export const MATCH_SIZE: Record<PartyMode, number> = { solo: 4, duo: 2, squad: 4 };

export const LANES = 4;
/** Metres between lane centres. */
export const LANE_WIDTH = 2.2;

/** Fixed simulation rate. Every input is stamped in these ticks. */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/** Match clock. One constant — raise it later without touching a client. */
export const DURATION_SEC = 120;
export const DURATION_TICKS = DURATION_SEC * TICK_RATE;

/** Speed schedule: v(t) = min(V0 + A·t, VMAX), identical for everyone alive. */
export const SPEED_START = 10; // m/s
export const SPEED_GAIN = 0.1; // m/s per second
export const SPEED_MAX = 22; // m/s
const T_CAP = (SPEED_MAX - SPEED_START) / SPEED_GAIN; // seconds until capped

/** Speed at time t (seconds since start). */
export function speedAt(t: number): number {
  return t >= T_CAP ? SPEED_MAX : SPEED_START + SPEED_GAIN * t;
}

/** Distance covered by time t — the closed-form integral of speedAt, so a
 *  runner's position is a pure function of the clock (no accumulation, no
 *  drift between devices). */
export function distanceAt(t: number): number {
  if (t <= 0) return 0;
  if (t < T_CAP) return SPEED_START * t + 0.5 * SPEED_GAIN * t * t;
  const dCap = SPEED_START * T_CAP + 0.5 * SPEED_GAIN * T_CAP * T_CAP;
  return dCap + SPEED_MAX * (t - T_CAP);
}

/** How long a lane change takes, in ticks (0.18 s). */
export const LANE_CHANGE_TICKS = 11;

/** Nothing stands on the track for the first stretch, so a runner who joins a
 *  few seconds late (slow device, reconnect) is never killed by the opening. */
export const EMPTY_START_METRES = 80;

/** Countdown shown before tick 0 (server adds this to `now` for startAt). */
export const COUNTDOWN_MS = 3500;

/** Inputs older than this are rejected (and, below it, rewound into). */
export const INPUT_LATE_LIMIT_MS = 1000;
/** Per-runner input rate ceiling per second — a swipe storm is not gameplay. */
export const INPUT_MAX_PER_SEC = 10;

/** Points awarded per unit, mirrored in scoreOf(). Here so the results screen
 *  and any future tuning read one place. */
export const POINTS_PER_COIN = 10;
export const POINTS_PER_NEAR_MISS = 25;

/** The rules the client must be told (it could read its own copy, but the
 *  server is the authority and a mismatched build should still agree). */
export function publicRules(): Record<string, number> {
  return {
    tickRate: TICK_RATE,
    durationTicks: DURATION_TICKS,
    lanes: LANES,
    laneWidth: LANE_WIDTH,
    countdownMs: COUNTDOWN_MS,
    pointsPerCoin: POINTS_PER_COIN,
    pointsPerNearMiss: POINTS_PER_NEAR_MISS,
    // The client mirrors this ceiling so it never predicts a move the server
    // is about to refuse — see the note in the runtime's input handler.
    inputMaxPerSec: INPUT_MAX_PER_SEC,
  };
}
