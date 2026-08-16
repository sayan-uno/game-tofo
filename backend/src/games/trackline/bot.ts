// How a Trackline bot plays.
//
// A bot's whole run is PLANNED at match creation rather than reacted to tick
// by tick, and that is a deliberate choice, not a shortcut:
//
//   * The course is deterministic and no runner can affect another, so there
//     is nothing a bot could learn by waiting.
//   * The server's own simulations deliberately lag real time by a second so
//     late human inputs can still rewrite it. A bot deciding at that lag would
//     emit inputs a second late, and every client would have to rewind past
//     the replay window to apply them — visible as teleporting.
//   * Planned inputs are released on a timer just BEFORE the tick they belong
//     to, so they arrive like a well-connected player's and clients never
//     rewind for them at all.
//
// What makes the result look human is the policy below, not the timing: a
// reaction margin, a preference for the safe line, occasional bravado over a
// barrier, and honest mistakes whose rate depends on the bot's skill.
import type { MatchInput } from "../../shared/core/protocol.js";
import {
  Course,
  DURATION_TICKS,
  JUMP_TICKS,
  ROLL_TICKS,
  TICK_RATE,
  applyInput,
  createState,
  speedAt,
  step,
  type InputKind,
  type Obstacle,
} from "../../shared/games/trackline/index.js";

/** Deterministic per-decision noise: same bot, same row, same answer, so a
 *  plan can be rebuilt identically if it ever needs to be. */
function roll(seed: number, seat: number, row: number, salt: number): number {
  let h = (seed ^ Math.imul(seat + 1, 0x27d4eb2f) ^ Math.imul(row + 1, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Skill 0..1 → behaviour. A weak bot errs often and mistimes its jumps; a
 *  strong one is precise. Ranges chosen so the best bot is still beatable and
 *  the worst still looks like it is trying.
 *
 *  Note what skill does NOT control: how far ahead a jump is triggered. That
 *  is physics, not ability — see the timing note below. */
function profile(skill: number) {
  return {
    /** Metres before a row at which it decides where to be. Deliberately
     *  under ROW_SPACING (15 m) so the decision is made after the previous
     *  row has been cleared and the runner has settled into its lane. */
    lead: 6 + skill * 7,
    /** Chance of fumbling a given row entirely. */
    mistake: 0.03 * (1 - skill) + 0.002,
    /** Chance of taking the risky line over a clearable barrier. */
    bravado: 0.15 + skill * 0.5,
    /** How far the trigger can be off, as a fraction of the ideal. A weak bot
     *  mistimes by up to half a jump; a strong one is on the apex. */
    timingError: 0.55 * (1 - skill),
  };
}

/** When to start a jump or a roll.
 *
 *  A jump lasts a fixed TIME, so the distance to trigger it at depends on how
 *  fast the runner is going — which changes all match. Getting this wrong is
 *  not a subtle tuning issue: with a fixed 8 m trigger the strong bots landed
 *  before reaching the barrier at the slower early-match speed and died to low
 *  barriers in 102 of 112 runs, while the WEAKER bots (triggering later)
 *  survived. Aim for the middle of the airborne window and let skill decide
 *  how far off that the bot actually is. */
function verbLead(kind: InputKind, tick: number, skill: number, error: number): number {
  const speed = speedAt(tick / TICK_RATE);
  const ticks = kind === "jump" ? JUMP_TICKS : ROLL_TICKS;
  const ideal = speed * (ticks / TICK_RATE) * 0.5;
  return Math.max(1.2, ideal * (1 + error * profile(skill).timingError));
}

const clearable = (o: Obstacle) => o.kind === "low" || o.kind === "high";

/** Plan every input a bot will make, from the start line to the final tick.
 *
 *  Runs the real simulation internally, so the plan can never contain an input
 *  the sim would reject, and a bot that crashes simply stops emitting. Cost is
 *  one 7,200-tick simulation — about a millisecond. */
export function planBotRun(seed: number, seat: number, skill: number): MatchInput[] {
  const course = new Course(seed);
  const p = profile(skill);
  const s = createState(seat);
  const out: MatchInput[] = [];

  /** Row the bot has already made its plan for, and what that plan was. */
  let decidedRow = -1;
  let targetLane = s.lane;
  let verb: InputKind | null = null;
  let verbDone = false;

  const emit = (kind: InputKind, tick: number) => {
    out.push({ tick, kind });
    applyInput(s, kind);
  };

  for (let tick = 1; tick <= DURATION_TICKS && s.alive; tick++) {
    const nextRow = Math.max(0, Course.indexAt(s.distance) + 1);
    const row = course.rowAt(nextRow);
    const ahead = row.z - s.distance;

    // ---- decide, once per row, at the bot's reaction distance ----
    if (nextRow !== decidedRow && ahead <= p.lead) {
      decidedRow = nextRow;
      verb = null;
      verbDone = false;
      const fumble = roll(seed, seat, nextRow, 1) < p.mistake;
      if (fumble) {
        // A real mistake: it stays where it is and takes what comes. Often
        // fatal, sometimes lucky — which is exactly how a person plays.
        targetLane = s.lane;
      } else {
        const here = row.obstacles.find((o) => o.lane === s.lane);
        // Only show off from a settled lane: jumping while still sliding puts
        // the runner across two lanes at the barrier, clearing one and
        // walking into whatever stands in the other.
        const settled = Math.abs(s.x - s.lane) < 0.05;
        const brave = settled && roll(seed, seat, nextRow, 2) < p.bravado;
        if (here && clearable(here) && brave) {
          // Hold the lane and go over or under it — worth points, and it is
          // the flourish that stops bots reading as lane-changing machines.
          targetLane = s.lane;
          verb = here.kind === "low" ? "jump" : "roll";
        } else if (!here) {
          // Already clear: only move if the coins lead elsewhere.
          const wantCoins = roll(seed, seat, nextRow, 3) < 0.6;
          targetLane = wantCoins && Math.abs(row.safeLane - s.lane) <= 1 ? row.safeLane : s.lane;
        } else {
          targetLane = row.safeLane;
        }
      }
    }

    // ---- act on the plan ----
    if (s.lane !== targetLane) {
      // One lane per tick at most; the sim ignores a change while sliding
      // anyway, and a human does not press twice in a frame.
      emit(s.lane < targetLane ? "right" : "left", tick);
    } else if (verb && !verbDone) {
      // Signed error in [-1, 1], fixed for this bot at this row.
      const error = roll(seed, seat, nextRow, 4) * 2 - 1;
      if (ahead <= verbLead(verb, tick, skill, error) && ahead > 0.4) {
        emit(verb, tick);
        verbDone = true;
      }
    }
    step(s, course);
  }
  return out;
}
