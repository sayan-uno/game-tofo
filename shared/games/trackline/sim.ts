// The Trackline runner simulation — deterministic, fixed-step, shared.
//
// One instance per runner. The same input log produces the same state on every
// client and on the server, which is the whole netcode: only inputs travel,
// everybody replays. Rules:
//
//  - Never read the wall clock, Math.random, or anything outside `state` and
//    the inputs. Determinism is the contract.
//  - Every operation is plain arithmetic on doubles in a fixed order — that IS
//    reproducible across engines; transcendental functions are avoided.
//  - Inputs are stamped in ticks. Applying an input for tick T means: it takes
//    effect at the start of tick T's step.
//
// Milestone 1 ships lanes and distance only; jump / roll / obstacles / coins
// land in M2 on this same skeleton.
import { DURATION_TICKS, LANES, LANE_CHANGE_TICKS, TICK_RATE, distanceAt } from "./rules.js";

export type InputKind = "left" | "right" | "jump" | "roll";
export const INPUT_KINDS: readonly InputKind[] = ["left", "right", "jump", "roll"];
export const isInputKind = (k: unknown): k is InputKind => INPUT_KINDS.includes(k as InputKind);

export interface RunnerInput {
  tick: number;
  kind: InputKind;
}

export interface RunnerState {
  tick: number;
  /** Lane the runner is heading to (0 = leftmost). */
  lane: number;
  /** Lateral position in LANE UNITS (lane index space, fractional mid-change). */
  x: number;
  /** Metres run since tick 0 — a pure function of the tick (see rules). */
  distance: number;
  alive: boolean;
}

/** Runners start in the middle: lane 1 or 2 by seat, spread so a full lobby
 *  doesn't stack four people in one lane on tick 0. */
export function startLane(seat: number): number {
  const order = [1, 2, 0, 3];
  return order[seat % order.length];
}

export function createState(seat: number): RunnerState {
  const lane = startLane(seat);
  return { tick: 0, lane, x: lane, distance: 0, alive: true };
}

/** Lateral speed in lane units per tick — a full lane in LANE_CHANGE_TICKS. */
const X_STEP = 1 / LANE_CHANGE_TICKS;

/** Apply one input to the state AT its tick. Invalid or impossible inputs are
 *  ignored deterministically (every replayer ignores them the same way), so a
 *  hacked client that sends "left" at lane 0 changes nothing anywhere. */
export function applyInput(s: RunnerState, kind: InputKind): void {
  if (!s.alive) return;
  switch (kind) {
    case "left":
      if (s.lane > 0) s.lane -= 1;
      return;
    case "right":
      if (s.lane < LANES - 1) s.lane += 1;
      return;
    case "jump":
    case "roll":
      // M2: airborne / sliding states + obstacle interaction.
      return;
  }
}

/** Advance exactly one tick. */
export function step(s: RunnerState): void {
  s.tick += 1;
  // Slide towards the target lane at a fixed rate; snap when within a step.
  const dx = s.lane - s.x;
  if (dx > X_STEP) s.x += X_STEP;
  else if (dx < -X_STEP) s.x -= X_STEP;
  else s.x = s.lane;
  s.distance = s.alive ? distanceAt(s.tick / TICK_RATE) : s.distance;
  if (s.tick >= DURATION_TICKS) {
    // The clock ran out: state freezes here (the match is over).
  }
}

/** Run a fresh state through an input log up to (and including) `toTick`.
 *  Used for late/out-of-order inputs and for joining mid-match: cheap enough
 *  to redo whole — a full two-minute match is 7,200 trivial steps. */
export function replay(seat: number, inputs: readonly RunnerInput[], toTick: number): RunnerState {
  const s = createState(seat);
  const sorted = [...inputs].sort((a, b) => a.tick - b.tick);
  let i = 0;
  while (s.tick < toTick) {
    // Inputs stamped for the NEXT tick take effect before that tick's step.
    const next = s.tick + 1;
    while (i < sorted.length && sorted[i].tick <= next) {
      applyInput(s, sorted[i].kind);
      i++;
    }
    step(s);
  }
  return s;
}

/** Score for the results screen — M1: distance only (equal for everyone
 *  alive; M2 adds coins and near-misses). Kept here so the SERVER computes it
 *  from the same code the client shows live. */
export function scoreOf(s: RunnerState): number {
  return Math.floor(s.distance);
}
