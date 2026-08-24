// The solver: twenty discs on a square, and nothing else.
//
// THE ONE RULE THIS FILE OBEYS. Only +, -, *, / and Math.sqrt appear in it.
// IEEE-754 requires all five to be correctly rounded, which means every one of
// them returns the same bits on every machine that has ever run JavaScript — so
// two players watching the same flick watch the same coin. Math.sin, Math.cos,
// Math.atan2, Math.pow and Math.hypot are all specified loosely enough that two
// engines may differ in the last place, and one of them in this loop would, over
// a few hundred collisions, put a coin in a pocket on one phone and against the
// wall on another. There is no way back from that: a board game on a platform
// that relays inputs rather than state has nothing to re-sync against.
//
// Everything else here is ordinary. Discs slide with a constant deceleration
// (which is what sliding friction actually is — the viscous damping physics
// engines default to would make a hard flick crawl to a stop over ten seconds),
// bounce off the four walls, and collide with each other as frictionless
// circles with restitution. Pockets are tested along the swept segment, not at
// the end point, so nothing can cross a pocket mouth between two steps and come
// out the other side.
//
// ORDER IS PART OF THE ANSWER. Bodies are visited by index, pairs in (i, j)
// order with i < j, walls before pairs, and a pocketed disc is removed the
// instant it falls. None of that is arbitrary and none of it may be reordered
// for tidiness: floating-point addition is not associative, so a different
// order is a different board.
import { HALF, POCKETS, POCKET_R, STRIKER_INDEX, radiusOf } from "./board.js";
import { SUBSTEPS, TICK_RATE } from "./rules.js";

/** Board units per second per second, taken off a moving disc's speed. Tuned
 *  so the hardest flick runs about three and a half board-widths before it
 *  stops, which is what a hard flick does on a real board. */
export const FRICTION = 1.35;

/** Below this speed a disc is simply stopped. The tail of a constant-
 *  deceleration slide is a coin creeping for another tenth of a second and
 *  nobody watching; cutting it is worth a beat per shot across sixty shots. */
export const STOP_SPEED = 0.055;

/** Restitution. Carrom men are hard and lose very little to each other; the
 *  wooden frame absorbs a good deal more. */
export const REST_DISC = 0.88;
export const REST_WALL = 0.66;

/** The striker is about two and a half times a coin. Stored as its inverse
 *  because that is what every line below actually wants. */
export const INV_MASS_COIN = 1;
export const INV_MASS_STRIKER = 1 / 2.6;

/** Speed a flick puts on the striker, from a power of 0…1.
 *
 *  The floor is not zero: the nearest coin is 0.59 units from the base line and
 *  a disc travelling at v covers v²/(2·FRICTION), so anything under about 1.26
 *  cannot reach the rose at all. A power slider whose bottom third does nothing
 *  is a broken slider, so the bottom of the range is a shot that just reaches. */
export const MIN_SPEED = 1.15;
export const MAX_SPEED = 4.3;

/** Seconds per physics step, and the speed one step takes off a disc. */
const DT = 1 / (TICK_RATE * SUBSTEPS);
const DECEL = FRICTION * DT;
const POCKET_R2 = POCKET_R * POCKET_R;

/** The mutable disc arrays. Parallel arrays rather than objects: a replay walks
 *  them tens of thousands of times and this shape has no per-body indirection,
 *  no allocation and an obvious serialisation. */
export interface Bodies {
  x: number[];
  y: number[];
  vx: number[];
  vy: number[];
  /** 1 while the disc is on the board. A pocketed coin and a striker between
   *  shots are both 0. */
  alive: number[];
}

/** What one tick of flight produced, accumulated across a whole shot by the
 *  simulation that owns it. */
export interface ShotLog {
  /** Bodies pocketed, in the order they fell. */
  pocketed: number[];
  /** The striker touched at least one disc. A shot that touches nothing is a
   *  foul in every ruleset there is, which is why this is tracked here rather
   *  than guessed at afterwards. */
  contact: boolean;
}

export const invMassOf = (i: number): number => (i === STRIKER_INDEX ? INV_MASS_STRIKER : INV_MASS_COIN);

/** Is anything still moving? Exact, because friction sets velocities to a hard
 *  zero rather than letting them decay towards it — which is what makes "the
 *  shot has finished" a fact rather than a threshold every device rounds its
 *  own way. */
export function anyMoving(b: Bodies): boolean {
  for (let i = 0; i < b.alive.length; i++) {
    if (b.alive[i] && (b.vx[i] !== 0 || b.vy[i] !== 0)) return true;
  }
  return false;
}

/** Did this disc, moving from (px, py) to (nx, ny), fall in? Distance from a
 *  segment to a point, which is the same test whether the disc crossed the
 *  mouth in one step or crept over the lip in fifty. */
function pocketedOnSegment(px: number, py: number, nx: number, ny: number): boolean {
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

function sink(b: Bodies, i: number, log: ShotLog): void {
  b.alive[i] = 0;
  b.vx[i] = 0;
  b.vy[i] = 0;
  log.pocketed.push(i);
}

/** One physics step. Called SUBSTEPS times per tick. */
function substep(b: Bodies, log: ShotLog): void {
  const n = b.alive.length;

  // ---- slide, slow down, and fall in -------------------------------------
  for (let i = 0; i < n; i++) {
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
    if (pocketedOnSegment(px, py, nx, ny)) sink(b, i, log);
  }

  // ---- the four walls ----------------------------------------------------
  //
  // The velocity is only reversed when it still points AT the wall. Without
  // that guard a disc resting hard against the frame flips its velocity every
  // step and buzzes there forever.
  for (let i = 0; i < n; i++) {
    if (!b.alive[i]) continue;
    const r = radiusOf(i);
    const lo = -HALF + r;
    const hi = HALF - r;
    if (b.x[i] < lo) {
      b.x[i] = lo;
      if (b.vx[i] < 0) b.vx[i] = -b.vx[i] * REST_WALL;
    } else if (b.x[i] > hi) {
      b.x[i] = hi;
      if (b.vx[i] > 0) b.vx[i] = -b.vx[i] * REST_WALL;
    }
    if (b.y[i] < lo) {
      b.y[i] = lo;
      if (b.vy[i] < 0) b.vy[i] = -b.vy[i] * REST_WALL;
    } else if (b.y[i] > hi) {
      b.y[i] = hi;
      if (b.vy[i] > 0) b.vy[i] = -b.vy[i] * REST_WALL;
    }
  }

  // ---- disc against disc -------------------------------------------------
  //
  // A pair in which NEITHER disc is moving is skipped outright. That is not a
  // micro-optimisation: for most of a shot two or three discs are moving among
  // fifteen at rest, so the skip turns a hundred and ninety pair tests into a
  // couple of dozen, and it is the difference between an end-of-match replay
  // costing tens of milliseconds and costing hundreds.
  for (let i = 0; i < n; i++) {
    if (!b.alive[i]) continue;
    const ri = radiusOf(i);
    const imi = invMassOf(i);
    const movingI = b.vx[i] !== 0 || b.vy[i] !== 0;
    for (let j = i + 1; j < n; j++) {
      if (!b.alive[j]) continue;
      if (!movingI && b.vx[j] === 0 && b.vy[j] === 0) continue;
      const rr = ri + radiusOf(j);
      const dx = b.x[j] - b.x[i];
      const dy = b.y[j] - b.y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      // Touching at all counts as a hit, whether or not an impulse follows.
      if (j === STRIKER_INDEX || i === STRIKER_INDEX) log.contact = true;
      let d: number;
      let nx: number;
      let ny: number;
      if (d2 === 0) {
        // Exactly coincident — only reachable when the striker had to be set
        // down on an occupied base line. Pick a direction rather than divide
        // by zero, and pick the same one everywhere.
        d = 0;
        nx = 1;
        ny = 0;
      } else {
        d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
      }
      const imj = invMassOf(j);
      const inv = imi + imj;
      // Push them apart in proportion to how easily each is pushed.
      const overlap = rr - d;
      const si = (overlap * imi) / inv;
      const sj = (overlap * imj) / inv;
      b.x[i] -= nx * si;
      b.y[i] -= ny * si;
      b.x[j] += nx * sj;
      b.y[j] += ny * sj;
      const rvn = (b.vx[j] - b.vx[i]) * nx + (b.vy[j] - b.vy[i]) * ny;
      if (rvn >= 0) continue; // already separating
      const imp = (-(1 + REST_DISC) * rvn) / inv;
      b.vx[i] -= imp * imi * nx;
      b.vy[i] -= imp * imi * ny;
      b.vx[j] += imp * imj * nx;
      b.vy[j] += imp * imj * ny;
    }
  }

  // ---- a disc that came to rest over a pocket ----------------------------
  //
  // The swept test above only runs for a disc that MOVED this step, so a coin
  // nudged over the lip by a separation and stopping there would sit half in
  // the hole forever. On a real board it drops, and it drops here.
  for (let i = 0; i < n; i++) {
    if (!b.alive[i]) continue;
    if (b.vx[i] !== 0 || b.vy[i] !== 0) continue;
    if (pocketedOnSegment(b.x[i], b.y[i], b.x[i], b.y[i])) sink(b, i, log);
  }
}

/** Tidy up the discs that stopped touching each other.
 *
 *  The pair loop above skips two discs that are both at rest, which is the
 *  optimisation the whole replay budget rests on — and it leaves one artefact.
 *  Separating A from B can push B into C; if the A-B pair was visited after
 *  B-C, nobody looks at B-C again, and if everything stops on that step the two
 *  are left a fraction of a millimetre inside each other for good. Measured
 *  across two hundred and forty shots it happened to 62 pairs in 41,040 and the
 *  worst was one part in eighty of a coin's radius — invisible, but it is the
 *  kind of thing that is invisible until the day two coins are drawn merged.
 *
 *  So the moment the board comes to rest, the chain is relaxed: position only,
 *  no impulses, a handful of passes, stopping as soon as a pass finds nothing.
 *  It runs ONCE per shot, so it costs nothing worth measuring. */
function relax(b: Bodies): void {
  const n = b.alive.length;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      if (!b.alive[i]) continue;
      const ri = radiusOf(i);
      const imi = invMassOf(i);
      for (let j = i + 1; j < n; j++) {
        if (!b.alive[j]) continue;
        const rr = ri + radiusOf(j);
        const dx = b.x[j] - b.x[i];
        const dy = b.y[j] - b.y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = d2 === 0 ? 0 : Math.sqrt(d2);
        const nx = d === 0 ? 1 : dx / d;
        const ny = d === 0 ? 0 : dy / d;
        const imj = invMassOf(j);
        const inv = imi + imj;
        const overlap = rr - d;
        b.x[i] -= (nx * overlap * imi) / inv;
        b.y[i] -= (ny * overlap * imi) / inv;
        b.x[j] += (nx * overlap * imj) / inv;
        b.y[j] += (ny * overlap * imj) / inv;
        moved = true;
      }
    }
    if (!moved) return;
    // Nothing may be pushed off the board by the tidying.
    for (let i = 0; i < n; i++) {
      if (!b.alive[i]) continue;
      const r = radiusOf(i);
      const lo = -HALF + r;
      const hi = HALF - r;
      if (b.x[i] < lo) b.x[i] = lo;
      else if (b.x[i] > hi) b.x[i] = hi;
      if (b.y[i] < lo) b.y[i] = lo;
      else if (b.y[i] > hi) b.y[i] = hi;
    }
  }
}

/** One tick of flight. Does nothing at all when the board is at rest, which is
 *  most of a turn-based game's ticks. */
export function stepBodies(b: Bodies, log: ShotLog): void {
  for (let k = 0; k < SUBSTEPS; k++) substep(b, log);
  if (!anyMoving(b)) relax(b);
}

/** ---------------------------------------------------------------------------
 *  Aim helpers — shared because the client draws the same line the simulation
 *  is about to travel, and a preview that disagrees with the shot is worse than
 *  no preview.
 * ------------------------------------------------------------------------- */

/** The first thing a striker fired from (x, y) along the unit vector (ux, uy)
 *  would touch: a disc index, or -1 for a wall. `dist` is how far it travels
 *  before contact; `hx`/`hy` is where its CENTRE would be at that moment.
 *
 *  A straight ray, so it ignores friction — the point is to show what is in the
 *  way, not to predict where the shot ends. */
export function firstHit(
  b: Bodies,
  x: number,
  y: number,
  ux: number,
  uy: number
): { index: number; dist: number; hx: number; hy: number } {
  const rs = radiusOf(STRIKER_INDEX);
  // The wall first, so the line always ends somewhere and every disc test is
  // measured against a real ceiling rather than Infinity.
  const lo = -HALF + rs;
  const hi = HALF - rs;
  let limit = 4; // longer than any diagonal; only used if the ray is degenerate
  if (ux > 0) limit = Math.min(limit, (hi - x) / ux);
  else if (ux < 0) limit = Math.min(limit, (lo - x) / ux);
  if (uy > 0) limit = Math.min(limit, (hi - y) / uy);
  else if (uy < 0) limit = Math.min(limit, (lo - y) / uy);
  if (limit < 0) limit = 0;

  let best = -1;
  let bestT = limit;
  for (let i = 0; i < b.alive.length; i++) {
    if (!b.alive[i] || i === STRIKER_INDEX) continue;
    const rr = rs + radiusOf(i);
    const ox = b.x[i] - x;
    const oy = b.y[i] - y;
    const along = ox * ux + oy * uy;
    if (along <= 0) continue; // behind us
    const perp2 = ox * ox + oy * oy - along * along;
    const rr2 = rr * rr;
    if (perp2 >= rr2) continue;
    const t = along - Math.sqrt(rr2 - perp2);
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    best = i;
  }
  return { index: best, dist: bestT, hx: x + ux * bestT, hy: y + uy * bestT };
}
