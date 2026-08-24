// The carrom board: its measurements, its pockets, its base lines, and where
// the nineteen coins start.
//
// EVERYTHING IS IN BOARD UNITS, and the board is two units across: the playing
// surface runs from -1 to +1 on both axes, with the origin at the centre spot.
// One unit is therefore half a real board — 14.5 inches on the 29-inch square
// the international rules specify — and every measurement below is the real one
// divided by that, so the proportions a carrom player knows are the proportions
// on screen. The painter scales units to pixels and never has an opinion about
// any of this.
//
// WORLD AND LOCAL. World coordinates are fixed to the board. Local coordinates
// belong to a player: in their frame they are always at the bottom, +y is into
// the board, +x is to their right. That is how a carrom app has to work — you
// aim from where you are sitting — and it is why the four transforms below are
// the only rotation in the game. They are sign flips and swaps, which is to say
// they are exact, which is why the shot a player composes in their own frame
// produces the identical world velocity on every other device.
import { COINS_PER_TEAM } from "./rules.js";

/** Half the playing surface. The square is [-HALF, +HALF] on both axes. */
export const HALF = 1;

/** Disc radii. Real carrom: coins 1.19" across, striker 1.65", on a 29" board. */
export const COIN_R = 0.041;
export const STRIKER_R = 0.057;

/** Pocket radius, centred exactly on each corner of the playing square.
 *
 *  Wider than the paper rules (this is 2.7 real inches across against the
 *  regulation 1.75–2) and deliberately so, for two separate reasons.
 *
 *  One is the thumb: the game is played on a phone rather than on a table, and
 *  a pocket that punishes a quarter of a degree of aim error is a pocket nobody
 *  ever hits. The mouth this leaves in each wall — the stretch of wall a coin
 *  can be pocketed through — is about 1.2 real inches either side of a corner.
 *
 *  The other is the corner itself, and it is the one that set the number. A
 *  disc's centre can never reach the corner: the walls stop it a radius short of
 *  each, which for the striker is 0.081 units away on the diagonal, and further
 *  still when it arrives at any other angle. Anything smaller than that and a
 *  striker fired dead at a corner rattles out of a pocket it plainly went into
 *  — and scratching, which is half the tension in carrom, stops happening at
 *  all. Measured before and after: striker fouls went from a third of one a
 *  board to something a player actually has to think about. */
export const POCKET_R = 0.092;

/** Pocket centres, clockwise from the bottom-left. Sitting ON the corner rather
 *  than inside it is what lets a coin hugging a wall still drop: the pocket
 *  circle overlaps both walls, so the wall never shields it. */
export const POCKETS: readonly { x: number; y: number }[] = [
  { x: -HALF, y: -HALF },
  { x: -HALF, y: HALF },
  { x: HALF, y: HALF },
  { x: HALF, y: -HALF },
];

/** The base line, in the shooting player's LOCAL frame: the striker's centre
 *  sits at y = -BASE_Y and may slide anywhere in x between ±BASE_HALF.
 *
 *  BASE_Y puts it 3.55 real inches from the frame (the rules say 3.5) and
 *  BASE_HALF makes the line 16.8 inches long (the rules say about 16.5). */
export const BASE_Y = 0.755;
export const BASE_HALF = 0.58;

/** The red circle painted at each end of the base line. Decoration for the
 *  painter, and the thing that tells a player where the line stops. */
export const BASE_DOT_R = 0.052;

/** The centre circle the coins are set inside. Purely a marking. */
export const CENTRE_R = 0.224;

/** What a body is. Coins never change kind; the striker is body STRIKER_INDEX
 *  and is only on the board while a shot is in flight. */
export const KIND_LIGHT = 0;
export const KIND_DARK = 1;
export const KIND_QUEEN = 2;
export const KIND_STRIKER = 3;

export const COIN_COUNT = COINS_PER_TEAM * 2 + 1; // 19
export const STRIKER_INDEX = COIN_COUNT; // 19
export const BODY_COUNT = COIN_COUNT + 1; // 20
/** The queen is laid down first, so it is body 0 and the centre spot is its. */
export const QUEEN_INDEX = 0;

/** Which team a body belongs to, or -1 for the queen and the striker. */
export function coinTeam(kind: number): number {
  return kind === KIND_LIGHT ? 0 : kind === KIND_DARK ? 1 : -1;
}

/** ---------------------------------------------------------------------------
 *  THE ROSE — where nineteen coins start.
 *
 *  Real coins are laid in a hexagonal packing: the queen on the centre spot,
 *  six coins touching it, and twelve more touching those. That packing has an
 *  exact description in integers, which is the only reason the layout can be
 *  computed rather than typed:
 *
 *      position(i, j) = ( COIN_R * (2i + j),  COIN_R * sqrt(3) * j )
 *
 *  Every coin in the rose is a whole (i, j) away from the centre, so every
 *  coordinate is a small integer times COIN_R or COIN_R·√3 — and √3 comes from
 *  Math.sqrt, which is correctly rounded and therefore the same number
 *  everywhere. A layout built from sines would not be.
 *
 *  Cells are listed centre-out and then anticlockwise from due east, so index
 *  order is also "nearest the middle first" — which is exactly the order a
 *  returned coin wants to be offered (see `freeSlot`).
 * ------------------------------------------------------------------------- */
const SQRT3 = Math.sqrt(3);

/** (i, j) hex cells: the centre, the ring of six, then the ring of twelve. */
const CELLS: readonly (readonly [number, number])[] = [
  [0, 0],
  // ring 1, anticlockwise from east: 0°, 60°, 120°, 180°, 240°, 300°
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
  // ring 2, anticlockwise from east in 30° steps
  [2, 0],
  [1, 1],
  [0, 2],
  [-1, 2],
  [-2, 2],
  [-2, 1],
  [-2, 0],
  [-1, -1],
  [0, -2],
  [1, -2],
  [2, -2],
  [2, -1],
];

export interface Spot {
  x: number;
  y: number;
}

/** The nineteen starting positions, in body-index order. */
export const LAYOUT: readonly Spot[] = CELLS.map(([i, j]) => ({
  x: COIN_R * (2 * i + j),
  y: COIN_R * SQRT3 * j,
}));

/** What each body is.
 *
 *  THE ARRANGEMENT HAS TO BE FAIR, and "alternating" is not enough to make it
 *  so. What fairness means on a board with two colours is that turning the
 *  whole thing half a turn gives you the same board with the colours swapped:
 *  then the player sitting opposite is looking at exactly the arrangement you
 *  are, in their own colour, and neither of you started better placed.
 *
 *  A ring of six alternating satisfies that on its own — half a turn is three
 *  places round, and three places along an alternating ring is the other
 *  colour. A ring of TWELVE alternating does not: half a turn is six places,
 *  and six places along an alternating ring is the colour you started with. So
 *  the outer ring alternates through the first half and alternates the other
 *  way through the second, which puts one seam of two like colours on each
 *  side of the board and makes the half-turn swap the colours as it must. It
 *  is still nine and nine, and it is close to the arms of the traditional
 *  arrangement.
 *
 *  Measured before and after: eighteen thousand bot boards went from a lopsided
 *  result to an even one. It really was worth two lines. */
export const KIND: readonly number[] = LAYOUT.map((_, k) => {
  if (k === 0) return KIND_QUEEN;
  const ring2 = k > 6;
  const inRing = ring2 ? k - 7 : k - 1;
  const even = inRing % 2 === 0;
  const dark = ring2 && inRing >= 6 ? !even : even;
  return dark ? KIND_DARK : KIND_LIGHT;
});

/** Radius of body `i`. */
export const radiusOf = (i: number): number => (i === STRIKER_INDEX ? STRIKER_R : COIN_R);

/** ---------------------------------------------------------------------------
 *  Local ⇄ world.
 *
 *  A player on side `s` is rotated s × 90° clockwise from the bottom. Written
 *  out rather than derived from a rotation matrix so that every one of them is
 *  a swap and a sign — no multiplication, no rounding, no drift.
 * ------------------------------------------------------------------------- */
export function toWorld(side: number, x: number, y: number): Spot {
  switch (side & 3) {
    case 1:
      return { x: -y, y: x };
    case 2:
      return { x: -x, y: -y };
    case 3:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}

export function toLocal(side: number, x: number, y: number): Spot {
  switch (side & 3) {
    case 1:
      return { x: y, y: -x };
    case 2:
      return { x: -x, y: -y };
    case 3:
      return { x: -y, y: x };
    default:
      return { x, y };
  }
}

/** Where the striker sits for a placement `t` in [-1, 1] along the base line,
 *  in the shooter's local frame. */
export const baseSpot = (t: number): Spot => ({ x: BASE_HALF * t, y: -BASE_Y });

/** ---------------------------------------------------------------------------
 *  Placement legality.
 *
 *  The striker may not be set down on top of a coin. On a real board that is
 *  self-evident; here it has to be decided identically by the client offering
 *  the placement, the server writing the shot and every table replaying it —
 *  so it lives here and all three call the same function.
 * ------------------------------------------------------------------------- */

/** Is the striker clear of every live coin at this local placement? `xs`/`ys`
 *  are the world positions of the coins, `alive` their flags. */
export function slotFree(
  side: number,
  t: number,
  xs: readonly number[],
  ys: readonly number[],
  alive: readonly number[]
): boolean {
  const local = baseSpot(t);
  const w = toWorld(side, local.x, local.y);
  const gap = COIN_R + STRIKER_R;
  const min = gap * gap;
  for (let i = 0; i < COIN_COUNT; i++) {
    if (!alive[i]) continue;
    const dx = xs[i] - w.x;
    const dy = ys[i] - w.y;
    if (dx * dx + dy * dy < min) return false;
  }
  return true;
}

/** How finely the base line is searched when a requested placement is blocked.
 *  1/1000 of the line is the encoding's own resolution; stepping four of those
 *  at a time keeps the scan to a few hundred tests and cannot miss a gap, since
 *  the narrowest usable gap is far wider than four thousandths of the line. */
const SLOT_STEP = 4 / 1000;

/** The nearest placement to `t` the striker actually fits in, searched outward
 *  in both directions so the answer is the same everywhere.
 *
 *  Falls back to the requested placement if the whole line is blocked, which
 *  needs six coins parked along it and is left to the solver to push apart —
 *  a shot that cannot be taken at all would be very much worse. */
export function nearestFreeSlot(
  side: number,
  t: number,
  xs: readonly number[],
  ys: readonly number[],
  alive: readonly number[]
): number {
  const want = t < -1 ? -1 : t > 1 ? 1 : t;
  if (slotFree(side, want, xs, ys, alive)) return want;
  for (let d = SLOT_STEP; d <= 2; d += SLOT_STEP) {
    const a = want - d;
    if (a >= -1 && slotFree(side, a, xs, ys, alive)) return a;
    const b = want + d;
    if (b <= 1 && slotFree(side, b, xs, ys, alive)) return b;
  }
  return want;
}

/** Where a returned disc may be put down, nearest the centre first.
 *
 *  The paper rule is "on the centre spot, and as near to it as there is room
 *  for if that is taken", so the candidates are the same hexagonal lattice the
 *  rose is laid on, four rings deep, sorted by how far out they are. Sixty-one
 *  of them against nineteen coins means a board on which every one is blocked
 *  cannot be arranged — which matters, because the alternative to finding a
 *  free spot is stacking two coins on top of each other, and a stack is a board
 *  no rule in this game knows how to describe.
 *
 *  Sorted at module load and never again. The sort is on a computed distance,
 *  which is fine: the input order is fixed, JavaScript's sort is stable, and
 *  every device therefore builds the identical list. */
const RETURN_SPOTS: readonly Spot[] = (() => {
  const out: { spot: Spot; d: number }[] = [];
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      // Hex ring distance in axial coordinates.
      if ((Math.abs(i) + Math.abs(i + j) + Math.abs(j)) / 2 > 4) continue;
      const x = COIN_R * (2 * i + j);
      const y = COIN_R * SQRT3 * j;
      out.push({ spot: { x, y }, d: x * x + y * y });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map((o) => o.spot);
})();

/** The nearest spot to the centre with nothing live standing on it — where a
 *  coin goes when it is put back after a foul, or when an uncovered queen
 *  returns.
 *
 *  "Standing on it" allows exact contact: two coins touching is a legal board,
 *  and a strict test would reject the spot beside a coin that is EXACTLY a
 *  diameter away — which is every spot in an untouched rose, since that is how
 *  the rose is laid. The epsilon is there for that, not for tolerance's sake. */
export function freeSlot(xs: readonly number[], ys: readonly number[], alive: readonly number[]): Spot {
  const touching = COIN_R * 2;
  const min = touching * touching * (1 - 1e-9);
  for (const spot of RETURN_SPOTS) {
    let clear = true;
    for (let i = 0; i < COIN_COUNT; i++) {
      if (!alive[i]) continue;
      const dx = xs[i] - spot.x;
      const dy = ys[i] - spot.y;
      if (dx * dx + dy * dy < min) {
        clear = false;
        break;
      }
    }
    if (clear) return spot;
  }
  return LAYOUT[0];
}
