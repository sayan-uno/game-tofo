// Social Space — the numbers both sides run on.
//
// This is not a match. Nobody wins it, nothing is ranked, and the clock is not
// a race — it is how long a PLACE stays open before everybody is sent home and
// a fresh one opens. Everything below follows from that.
//
// Kept in shared/ for the usual reason: the client draws the island and hears
// the voices, the server decides who is standing where, and the admin console
// draws a map of it. Three readers, one set of numbers.

export const GAME_ID = "social";

/** The island has no simulation, so a "tick" here is not a step of anything —
 *  it is the unit its ARCHIVE is timestamped in, and the unit the console's
 *  replay studio scrubs along. Ten a second, matching the position snapshot
 *  rate, so a track sample always lands on a whole one.
 *
 *  Shared because both sides convert with it: the server writes ticks into the
 *  replay, and the client turns them back into moments when the studio plays
 *  it back. */
export const TICK_RATE = 10;

/** People and server population on one island, together. Twenty is the number
 *  the whole design turns on: a bot leaves for every person who arrives, and a
 *  bot returns for every person who goes, so the place always looks the same
 *  size from the inside. */
export const CAPACITY = 20;

/** How long an island stays open. Long enough to actually meet somebody,
 *  short enough that the population reshuffles and you are not stuck in a
 *  quiet one for the evening. */
export const SESSION_MS = 40 * 60_000;

/** The warning at the end: everybody sees the same five seconds tick away and
 *  lands back in their own lobby together. */
export const CLOSING_MS = 5_000;

/** A dropped socket keeps its place for this long and no longer.
 *
 *  Ten seconds, which is FAR shorter than a match's grace, and deliberately:
 *  a seat here is not a scoreboard row, it is a person standing in front of
 *  you. Holding one open for a phone that went into a tunnel means a body
 *  standing motionless in the middle of a conversation, and — worse — a seat a
 *  real arrival cannot have. */
export const DISCONNECT_GRACE_MS = 10_000;

/** A person may be alone on an island for this long before it is closed under
 *  them. Nothing to do with the 40 minutes: this is the case where the last
 *  human walked out of a place that still has 19 bots in it, and keeping that
 *  running costs a timer for nobody. */
export const EMPTY_CLOSE_MS = 20_000;

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/** Metres per second. Walk is the stick; run is the button. */
export const WALK_SPEED = 2.3;
export const RUN_SPEED = 5.4;
/** How fast a character turns to face where it is going, radians/second. */
export const TURN_RATE = 9;

/** How often a client reports where it is, and how often the server tells
 *  everybody.
 *
 *  Fifteen a second each way. Ten was enough for a walk and visibly short for
 *  a RUN — at 5.4 m/s a tenth of a second is over half a metre, so a change of
 *  direction landed as a corner. Fifteen is a third of a metre, and costs
 *  about two kilobytes a second more per player on a channel that is already
 *  the smallest thing in the game.
 *
 *  Twenty players at 15 Hz is ~300 small messages a second on the whole
 *  island — still a fraction of what relaying every client's report to every
 *  other client would cost, which is why the server batches rather than
 *  forwards. */
export const REPORT_HZ = 15;
export const SNAPSHOT_HZ = 15;

/** How far away somebody has to be before they are left out of your snapshot
 *  entirely.
 *
 *  A little further than the island draws a name tag, so nobody ever pops into
 *  existence in front of you — and it is the reason a client cannot be used to
 *  find out where a player it has never met is standing. */
export const SNAPSHOT_RANGE_M = 70;

/** How far BEHIND real time a remote character is drawn.
 *
 *  It has to cover one report interval plus however much the network jitters,
 *  or the window empties and the character stops dead until the next packet
 *  lands. At fifteen a second an interval is 67 ms, so this leaves about
 *  ninety for jitter — and it is still under a sixth of a second, which is
 *  why walking beside somebody feels level rather than delayed.
 *
 *  It shipped at 140 against a 100 ms interval: forty milliseconds of slack,
 *  less than an ordinary mobile connection jitters. */
export const INTERP_DELAY_MS = 160;

/** …and how far PAST the newest sample a character may be carried before it
 *  is held in place. A quarter of a second of the speed they were already
 *  going: long enough to cover a dropped packet, short enough that somebody
 *  who actually stopped does not walk into a wall. */
export const EXTRAPOLATE_MS = 250;

/** The furthest a player may claim to have moved between two reports, as a
 *  multiple of the run speed. Not anti-cheat theatre — it is what stops a
 *  modified client teleporting across the island into somebody's voice range,
 *  which is the only thing position can be abused FOR here. */
export const SPEED_TOLERANCE = 1.6;

// ---------------------------------------------------------------------------
// Voice — the whole point of the place
// ---------------------------------------------------------------------------

/** Inside this, someone is as loud as if they were next to you. */
export const HEAR_FULL_M = 10;
/** Beyond this you cannot hear them at all — and, because it is done by
 *  UNSUBSCRIBING rather than by turning a volume down, their audio is not
 *  arriving at your device in the first place. */
export const HEAR_MAX_M = 20;
/** Subscriptions are taken out a little before the edge and dropped a little
 *  after it, so somebody pacing across the twenty-metre line does not make
 *  their own voice stutter in and out. The gap is the hysteresis. */
export const HEAR_SUBSCRIBE_M = 22;
export const HEAR_DROP_M = 26;

/** How loud somebody standing `d` metres away should be, 0…1.
 *
 *  Full inside HEAR_FULL_M, silent outside HEAR_MAX_M, and in between an
 *  inverse curve rather than a straight line — loudness falls off with
 *  distance in the world, and a linear ramp sounds like a fader being pulled,
 *  which is exactly the thing that gives away that this is a game.
 *
 *  The curve is normalised so it is 1 at HEAR_FULL_M and 0 at HEAR_MAX_M, so
 *  there is no step at either edge. Cheap: two divides and a multiply, called
 *  a few times per player per second. */
export function hearGain(d: number): number {
  if (d <= HEAR_FULL_M) return 1;
  if (d >= HEAR_MAX_M) return 0;
  const raw = HEAR_FULL_M / d; // 1 at the inner edge, 0.5 at the outer
  const floor = HEAR_FULL_M / HEAR_MAX_M;
  return (raw - floor) / (1 - floor);
}

// ---------------------------------------------------------------------------
// Meeting people
// ---------------------------------------------------------------------------

/** How close you have to be to open somebody's card by tapping them. Roughly
 *  "within arm's reach and a step" — far enough that a tap through a crowd
 *  still lands, close enough that it is a deliberate act. */
export const TOUCH_RANGE_M = 4;

/** An emote may be performed this often. The same floor the lobby applies, for
 *  the same reason: an emote costs every nearby player a clip download and a
 *  re-pose. */
export const EMOTE_COOLDOWN_MS = 2500;

/** How long a performed emote is shown on other people's screens before the
 *  character goes back to standing. Clips are 2–6 seconds; this is the ceiling
 *  in case one never reports finishing. */
export const EMOTE_MAX_MS = 8000;

/** Rules the server hands the client at join. Everything here is something the
 *  client would otherwise have to hard-code a second copy of. */
export function publicRules(): Record<string, number> {
  return {
    capacity: CAPACITY,
    sessionMs: SESSION_MS,
    closingMs: CLOSING_MS,
    walkSpeed: WALK_SPEED,
    runSpeed: RUN_SPEED,
    reportHz: REPORT_HZ,
    snapshotHz: SNAPSHOT_HZ,
    hearFullM: HEAR_FULL_M,
    hearMaxM: HEAR_MAX_M,
    touchRangeM: TOUCH_RANGE_M,
    emoteCooldownMs: EMOTE_COOLDOWN_MS,
  };
}
