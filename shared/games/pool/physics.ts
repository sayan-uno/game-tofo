// The solver: sixteen balls on a rectangle with six holes in it.
//
// THE ONE RULE THIS FILE OBEYS, and it is carrom's rule for carrom's reason:
// only +, -, *, / and Math.sqrt appear in it. IEEE-754 requires all five to be
// correctly rounded, so every one returns the same bits on every machine that
// has ever run JavaScript — which is what lets two people watch the same break
// and see the same table afterwards. Math.sin, Math.cos, Math.atan2, Math.pow
// and Math.hypot are all specified loosely enough that two engines may differ
// in the last place, and one of them in this loop would, over the forty
// collisions of a break, put the black in a pocket on one phone and safe on the
// cushion on another. There is no way back from that.
//
// EVERY BALL IS THE SAME BALL. Pool's one mercy over carrom: equal radii and
// equal masses, so a collision is the textbook case and the impulse is half the
// closing speed each way. No inverse masses, no weighted separation.
//
// ORDER IS PART OF THE ANSWER. Balls are visited by index, pairs in (i, j)
// order with i < j, cushions before pairs, and a potted ball is removed the
// instant it drops. None of that is arbitrary and none of it may be reordered
// for tidiness: floating-point addition is not associative, so a different
// order is a different table.
import { BALL_R, HALF_X, HALF_Y, POCKETS, POCKET_R } from "./table.js";
import { BALLS, SUBSTEPS, TICK_RATE } from "./rules.js";

/** Table units per second per second, taken off a rolling ball.
 *
 *  THE NUMBER THAT DECIDES WHETHER THE BREAK IS ALIVE, and it was wrong once by
 *  a factor of four.
 *
 *  Work it in real units. A unit here is half a hundred-inch table, so 1.27 m;
 *  a pool ball rolling on cloth loses about 0.25 m/s², which is 0.2 in these
 *  units. That looks like nothing until you follow it through the break: the
 *  cue arrives with the energy of one ball at speed v, fifteen balls leave with
 *  a fifteenth of it each, and a ball at speed u runs u²/2a before it dies. Cut
 *  a in half and every one of those fifteen balls runs twice as far.
 *
 *  The first version used 1.2 — the number that made a shot settle promptly —
 *  and it strangled the game: each ball off the break had half a table-length
 *  in it, the pack never opened, and measured over four hundred racks the break
 *  potted a ball exactly never. On a real table a break pots something rather
 *  more than half the time, and it does that because those balls have SIX table
 *  lengths in them and spend them ricocheting past the pockets.
 *
 *  0.32 is a third of the way back from real cloth towards a game that settles
 *  in a few seconds rather than half a minute: measured, two breaks in three
 *  pot, and the hardest one is done rolling in four and a half seconds. The
 *  rest of the losses are where a real table keeps them — in the cushions.
 * ------------------------------------------------------------------------- */
export const FRICTION = 0.32;

/** Below this speed a ball is simply stopped. The tail of a constant
 *  deceleration is a ball creeping for another tenth of a second with nobody
 *  watching, and cutting it is worth a beat on every one of thirty shots. */
export const STOP_SPEED = 0.035;

/** Restitution. Two phenolic balls lose very little to each other; a cushion is
 *  lively but not perfect, and every bounce is where the pace of a break goes. */
export const REST_BALL = 0.94;
export const REST_CUSHION = 0.75;

/** ---------------------------------------------------------------------------
 *  Speed a shot puts on the cue ball, from a power of 0…1.
 *
 *  NOT LINEAR. Almost every shot in a rack is played below half power — a safety,
 *  a stun, rolling up behind a ball — and a linear slider spends most of its
 *  travel on shots nobody plays. Cubing the low end would go too far, so the
 *  curve is p·√p: at a tenth of the slider the cue leaves at about a fiftieth of
 *  its top speed, which is a touch, and the top half still has all the pace.
 *
 *  And √ is the one curve available, because `**` and Math.pow are not.
 * ------------------------------------------------------------------------- */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 5.4;

export const speedFor = (power: number): number => {
  const p = power < 0 ? 0 : power > 1 ? 1 : power;
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * p * Math.sqrt(p);
};

/** Seconds per physics step, and the speed one step takes off a ball. */
const DT = 1 / (TICK_RATE * SUBSTEPS);
const DECEL = FRICTION * DT;
const POCKET_R2 = POCKET_R * POCKET_R;
const BALL_D = BALL_R * 2;
const BALL_D2 = BALL_D * BALL_D;

/** The mutable ball arrays. Parallel arrays rather than objects: a replay walks
 *  them tens of thousands of times and this shape has no per-ball indirection,
 *  no allocation and an obvious serialisation. */
export interface Balls {
  x: number[];
  y: number[];
  vx: number[];
  vy: number[];
  /** 1 while the ball is on the table. A potted ball is 0; so is the cue ball
   *  between a scratch and being placed again. */
  alive: number[];
}

/** What one shot produced, accumulated across its whole flight by the
 *  simulation that owns it. Every one of these is a RULE — 8-ball is decided
 *  almost entirely by what the cue ball touched first and whether anything
 *  reached a cushion afterwards. */
export interface ShotLog {
  /** Balls potted, in the order they dropped. */
  potted: number[];
  /** The first ball the cue ball touched, or -1 if it touched nothing. */
  firstHit: number;
  /** A ball reached a cushion AFTER the cue ball made contact. Without this,
   *  nudging a ball a millimetre and leaving everything where it was would be a
   *  legal shot, and the whole game would be two people refusing to move. */
  railAfterHit: boolean;
}

/** Is anything still rolling? Exact, because friction sets velocities to a hard
 *  zero rather than letting them decay towards it — which is what makes "the
 *  shot has finished" a fact rather than a threshold every device rounds its
 *  own way. */
export function anyMoving(b: Balls): boolean {
  for (let i = 0; i < BALLS; i++) {
    if (b.alive[i] && (b.vx[i] !== 0 || b.vy[i] !== 0)) return true;
  }
  return false;
}

/** Did this ball, moving from (px, py) to (nx, ny), drop? Distance from a
 *  segment to a point, which is the same test whether it flew across the mouth
 *  in one step or crept over the lip in fifty. */
function pottedOnSegment(px: number, py: number, nx: number, ny: number): boolean {
  const ax = nx - px;
  const ay = ny - py;
  const len2 = ax * ax + ay * ay;
  for (let p = 0; p < POCKETS.length; p++) {
    const pk = POCKETS[p];
    const bx = pk.x - px;
    const by = pk.y - py;
    let t = 0;
    if (len2 > 0) {
      t = (bx * ax + by * ay) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = px + ax * t - pk.x;
    const cy = py + ay * t - pk.y;
    if (cx * cx + cy * cy < POCKET_R2) return true;
  }
  return false;
}

function drop(b: Balls, i: number, log: ShotLog): void {
  b.alive[i] = 0;
  b.vx[i] = 0;
  b.vy[i] = 0;
  log.potted.push(i);
}

/** One physics step. Called SUBSTEPS times per tick. */
function substep(b: Balls, log: ShotLog): void {
  // ---- roll, slow down, and drop -----------------------------------------
  for (let i = 0; i < BALLS; i++) {
    if (!b.alive[i]) continue;
    const vx = b.vx[i];
    const vy = b.vy[i];
    if (vx === 0 && vy === 0) continue;
    const px = b.x[i];
    const py = b.y[i];
    const nx = px + vx * DT;
    const ny = py + vy * DT;
    b.x[i] = nx;
    b.y[i] = ny;
    const sp = Math.sqrt(vx * vx + vy * vy);
    if (sp <= STOP_SPEED) {
      b.vx[i] = 0;
      b.vy[i] = 0;
    } else {
      const k = (sp - DECEL) / sp;
      if (k <= 0) {
        b.vx[i] = 0;
        b.vy[i] = 0;
      } else {
        b.vx[i] = vx * k;
        b.vy[i] = vy * k;
      }
    }
    if (pottedOnSegment(px, py, nx, ny)) drop(b, i, log);
  }

  // ---- the cushions -------------------------------------------------------
  //
  // The velocity is only reversed when it still points AT the rail. Without
  // that guard a ball resting hard against a cushion flips its velocity every
  // step and buzzes there forever.
  const loX = -HALF_X + BALL_R;
  const hiX = HALF_X - BALL_R;
  const loY = -HALF_Y + BALL_R;
  const hiY = HALF_Y - BALL_R;
  for (let i = 0; i < BALLS; i++) {
    if (!b.alive[i]) continue;
    let hit = false;
    if (b.x[i] < loX) {
      b.x[i] = loX;
      if (b.vx[i] < 0) {
        b.vx[i] = -b.vx[i] * REST_CUSHION;
        hit = true;
      }
    } else if (b.x[i] > hiX) {
      b.x[i] = hiX;
      if (b.vx[i] > 0) {
        b.vx[i] = -b.vx[i] * REST_CUSHION;
        hit = true;
      }
    }
    if (b.y[i] < loY) {
      b.y[i] = loY;
      if (b.vy[i] < 0) {
        b.vy[i] = -b.vy[i] * REST_CUSHION;
        hit = true;
      }
    } else if (b.y[i] > hiY) {
      b.y[i] = hiY;
      if (b.vy[i] > 0) {
        b.vy[i] = -b.vy[i] * REST_CUSHION;
        hit = true;
      }
    }
    if (hit && log.firstHit >= 0) log.railAfterHit = true;
  }

  // ---- ball against ball --------------------------------------------------
  //
  // A pair in which NEITHER ball is moving is skipped outright. For most of a
  // shot two or three balls are rolling among a dozen at rest, so the skip
  // turns a hundred and twenty pair tests into a couple of dozen — and it is
  // the difference between an end-of-match replay costing tens of milliseconds
  // and costing hundreds.
  for (let i = 0; i < BALLS; i++) {
    if (!b.alive[i]) continue;
    const movingI = b.vx[i] !== 0 || b.vy[i] !== 0;
    for (let j = i + 1; j < BALLS; j++) {
      if (!b.alive[j]) continue;
      if (!movingI && b.vx[j] === 0 && b.vy[j] === 0) continue;
      const dx = b.x[j] - b.x[i];
      const dy = b.y[j] - b.y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 >= BALL_D2) continue;
      // WHAT THE CUE BALL TOUCHED FIRST decides almost every rule in 8-ball, so
      // it is recorded the moment two balls are in contact — before any test of
      // whether an impulse follows.
      if (log.firstHit < 0 && (i === 0 || j === 0)) log.firstHit = i === 0 ? j : i;
      let d: number;
      let nx: number;
      let ny: number;
      if (d2 === 0) {
        // Exactly coincident — only reachable when a ball in hand had to be put
        // down on an occupied spot. Pick a direction rather than divide by zero,
        // and pick the same one everywhere.
        d = 0;
        nx = 1;
        ny = 0;
      } else {
        d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
      }
      // Equal masses, so they are pushed apart by half the overlap each.
      const half = (BALL_D - d) / 2;
      b.x[i] -= nx * half;
      b.y[i] -= ny * half;
      b.x[j] += nx * half;
      b.y[j] += ny * half;
      const rvn = (b.vx[j] - b.vx[i]) * nx + (b.vy[j] - b.vy[i]) * ny;
      if (rvn >= 0) continue; // already separating
      // Equal masses again: the impulse is (1 + e)/2 of the closing speed, one
      // way for each of them.
      const imp = (-(1 + REST_BALL) * rvn) / 2;
      b.vx[i] -= imp * nx;
      b.vy[i] -= imp * ny;
      b.vx[j] += imp * nx;
      b.vy[j] += imp * ny;
    }
  }

  // ---- a ball that came to rest over a hole -------------------------------
  //
  // The swept test above only runs for a ball that MOVED this step, so one
  // nudged over the lip by a separation and stopping there would hang half in
  // the pocket forever. On a real table it drops, and it drops here.
  for (let i = 0; i < BALLS; i++) {
    if (!b.alive[i]) continue;
    if (b.vx[i] !== 0 || b.vy[i] !== 0) continue;
    if (pottedOnSegment(b.x[i], b.y[i], b.x[i], b.y[i])) drop(b, i, log);
  }
}

/** Tidy up the balls that stopped touching each other.
 *
 *  The pair loop skips two balls that are both at rest, which is the
 *  optimisation the whole replay budget rests on — and it leaves one artefact.
 *  Separating A from B can push B into C; if the A-B pair was visited after
 *  B-C, nobody looks at B-C again, and if everything stops on that step the two
 *  are left a fraction inside each other for good. Carrom paid for this once;
 *  the fix travels with the pattern.
 *
 *  Position only, no impulses, and it runs ONCE per shot — so the pass count is
 *  set by what actually converges rather than by what looks tidy. Four left a
 *  worst case of a twentieth of a millimetre still overlapping after a break
 *  (a chain of touching balls needs one pass per link); twelve clears every
 *  arrangement two hundred measured racks could produce, and costs nothing
 *  because the loop exits the moment a pass moves nothing. */
function relax(b: Balls): void {
  const loX = -HALF_X + BALL_R;
  const hiX = HALF_X - BALL_R;
  const loY = -HALF_Y + BALL_R;
  const hiY = HALF_Y - BALL_R;
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < BALLS; i++) {
      if (!b.alive[i]) continue;
      for (let j = i + 1; j < BALLS; j++) {
        if (!b.alive[j]) continue;
        const dx = b.x[j] - b.x[i];
        const dy = b.y[j] - b.y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= BALL_D2) continue;
        const d = d2 === 0 ? 0 : Math.sqrt(d2);
        const nx = d === 0 ? 1 : dx / d;
        const ny = d === 0 ? 0 : dy / d;
        const half = (BALL_D - d) / 2;
        b.x[i] -= nx * half;
        b.y[i] -= ny * half;
        b.x[j] += nx * half;
        b.y[j] += ny * half;
        moved = true;
      }
    }
    if (!moved) return;
    for (let i = 0; i < BALLS; i++) {
      if (!b.alive[i]) continue;
      if (b.x[i] < loX) b.x[i] = loX;
      else if (b.x[i] > hiX) b.x[i] = hiX;
      if (b.y[i] < loY) b.y[i] = loY;
      else if (b.y[i] > hiY) b.y[i] = hiY;
    }
  }
}

/** One tick of a shot. Does nothing at all when the table is at rest, which is
 *  most of a turn-based game's ticks. */
export function stepBalls(b: Balls, log: ShotLog): void {
  for (let k = 0; k < SUBSTEPS; k++) substep(b, log);
  if (!anyMoving(b)) relax(b);
}

/** ---------------------------------------------------------------------------
 *  Aim helpers — shared, because the client draws the line the cue ball is
 *  about to travel and a preview that disagrees with the shot is worse than no
 *  preview at all.
 * ------------------------------------------------------------------------- */

/** The first ball a cue ball fired from (x, y) along the unit vector (ux, uy)
 *  would touch: an index, or -1 for a cushion. `dist` is how far it travels
 *  before contact and `hx`/`hy` is where its CENTRE would be at that moment —
 *  the ghost ball, which is the thing a pool player actually aims at.
 *
 *  A straight ray, so it ignores friction: the point is to show what is in the
 *  way, not to predict where the shot ends. */
export function firstHit(
  b: Balls,
  x: number,
  y: number,
  ux: number,
  uy: number,
  ignore: number
): { index: number; dist: number; hx: number; hy: number } {
  // The cushions first, so the line always ends somewhere and every ball test
  // is measured against a real ceiling rather than Infinity.
  const loX = -HALF_X + BALL_R;
  const hiX = HALF_X - BALL_R;
  const loY = -HALF_Y + BALL_R;
  const hiY = HALF_Y - BALL_R;
  let limit = 4; // longer than any diagonal; only used if the ray is degenerate
  if (ux > 0) limit = Math.min(limit, (hiX - x) / ux);
  else if (ux < 0) limit = Math.min(limit, (loX - x) / ux);
  if (uy > 0) limit = Math.min(limit, (hiY - y) / uy);
  else if (uy < 0) limit = Math.min(limit, (loY - y) / uy);
  if (limit < 0) limit = 0;

  let best = -1;
  let bestT = limit;
  for (let i = 0; i < BALLS; i++) {
    if (!b.alive[i] || i === ignore) continue;
    const ox = b.x[i] - x;
    const oy = b.y[i] - y;
    const along = ox * ux + oy * uy;
    if (along <= 0) continue; // behind us
    const perp2 = ox * ox + oy * oy - along * along;
    if (perp2 >= BALL_D2) continue;
    const t = along - Math.sqrt(BALL_D2 - perp2);
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    best = i;
  }
  return { index: best, dist: bestT, hx: x + ux * bestT, hy: y + uy * bestT };
}
