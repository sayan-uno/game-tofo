// The table: its measurements, its six pockets, the head string, and where the
// fifteen balls are racked.
//
// EVERYTHING IS IN TABLE UNITS, and the playing surface is two units by one:
// x runs from -1 to +1 and y from -0.5 to +0.5, with the origin at the centre
// spot. One unit is therefore half the length of a real hundred-inch table, so
// every measurement below is the real one divided by fifty and the proportions
// a pool player knows are the proportions on screen.
//
// The head rail is at x = -1 and the foot rail at x = +1, which is why the
// break comes from the left and the rack sits on the right — the same way round
// as every diagram of a pool table ever printed.
import { BALLS, EIGHT } from "./rules.js";

/** Half the length and half the width of the playing surface. */
export const HALF_X = 1;
export const HALF_Y = 0.5;

/** A two-and-a-quarter-inch ball on a hundred-inch table. */
export const BALL_R = 0.0225;

/** Pocket radius. Twice the ball, which is what a four-and-a-half-inch corner
 *  mouth is next to a two-and-a-quarter-inch ball — and then a shade over,
 *  because the game is played with a thumb on a phone rather than with a cue,
 *  and a pocket that punishes a quarter of a degree is a pocket nobody hits. */
export const POCKET_R = 0.055;

/** The six pockets: four corners and one either side, in the middle of the long
 *  rails.
 *
 *  The corners sit ON the corner and the side pockets ON the cushion, so every
 *  pocket circle overlaps the rails it belongs to. That is what lets a ball
 *  running along a cushion still drop: the rail never shields the hole. */
export const POCKETS: readonly { x: number; y: number }[] = [
  { x: -HALF_X, y: -HALF_Y },
  { x: 0, y: -HALF_Y },
  { x: HALF_X, y: -HALF_Y },
  { x: HALF_X, y: HALF_Y },
  { x: 0, y: HALF_Y },
  { x: -HALF_X, y: HALF_Y },
];

/** The head string: the cue ball starts behind it, and so does a ball in hand
 *  given away by a foul on the break. A quarter of the table from the head
 *  rail, exactly as the real one is. */
export const HEAD_STRING = -HALF_X / 2;
/** The foot spot, where the apex ball of the rack stands. */
export const FOOT_SPOT = HALF_X / 2;
/** Where the cue ball is placed to break. */
export const BREAK_SPOT = { x: -HALF_X * 0.68, y: 0 };

/** ---------------------------------------------------------------------------
 *  THE RACK.
 *
 *  A triangle: one ball at the apex, then rows of two, three, four and five —
 *  fifteen in all. The rows step back by the height of an equilateral triangle
 *  of side 2r, which is r·√3, and within a row the balls are 2r apart. Both are
 *  exact: √3 comes from Math.sqrt, which is correctly rounded and therefore the
 *  same number everywhere, and everything else is a small integer times the
 *  ball's radius.
 *
 *  The ARRANGEMENT is the printed one. The black stands in the middle of the
 *  third row; the two back corners are one of each group; everything else
 *  alternates outwards from the apex. What that buys is a rack neither side can
 *  prefer — which matters here, because the break is worth something and who
 *  takes it is drawn from the seed.
 * ------------------------------------------------------------------------- */
const SQRT3 = Math.sqrt(3);

export interface Spot {
  x: number;
  y: number;
}

/** The fifteen rack positions, apex first and then row by row. */
export const RACK: readonly Spot[] = (() => {
  const out: Spot[] = [];
  // A HAIR of daylight — a thousandth of a radius — and no more.
  //
  // The first version left two per cent, which reads as "not overlapping" and
  // plays as a rack that eats the break: each ball has to be crossed before the
  // next one is touched, so the cascade arrives late and slow and the pack
  // barely opens. Measured, a full-power break potted something once in twenty.
  // A real rack is FROZEN, and this is as close to frozen as floating point
  // wants to be asked to be.
  const gap = BALL_R * 2.001;
  const step = BALL_R * SQRT3 * 1.001;
  for (let row = 0; row < 5; row++) {
    for (let seat = 0; seat <= row; seat++) {
      out.push({ x: FOOT_SPOT + row * step, y: (seat - row / 2) * gap });
    }
  }
  return out;
})();

/** Which ball stands on which rack position, by its printed number.
 *
 *  THE THREE THINGS A LEGAL RACK HAS TO GET RIGHT, and the third one was wrong
 *  in the first version of this line:
 *
 *    * a solid at the apex, on the foot spot;
 *    * the black in the middle of the third row — index 4;
 *    * ONE SOLID AND ONE STRIPE in the two back corners — indices 10 and 14.
 *
 *  The last is not decoration. The back corners are the two balls a break
 *  throws furthest and the likeliest thing on the table to drop off it, so a
 *  rack with both corners from the same group hands that group's side a real
 *  edge on a shot whose taker is drawn from the seed. It read `…6, 14, 7, 15`
 *  and both corners were stripes; the check caught it.
 *
 *  Everything else alternates, which is how a rack is set on any table where
 *  somebody is paying attention. */
export const RACK_ORDER: readonly number[] = [1, 9, 2, 10, EIGHT, 3, 11, 4, 12, 5, 13, 6, 14, 15, 7];

/** Is this point on the cloth, far enough from the cushions for a ball? */
export const onCloth = (x: number, y: number): boolean =>
  x >= -HALF_X + BALL_R && x <= HALF_X - BALL_R && y >= -HALF_Y + BALL_R && y <= HALF_Y - BALL_R;

/** Is a ball at this point clear of every other ball on the table? */
export function spotFree(
  x: number,
  y: number,
  xs: readonly number[],
  ys: readonly number[],
  alive: readonly number[],
  ignore: number
): boolean {
  if (!onCloth(x, y)) return false;
  const gap = BALL_R * 2;
  const min = gap * gap;
  for (let i = 0; i < BALLS; i++) {
    if (i === ignore || !alive[i]) continue;
    const dx = xs[i] - x;
    const dy = ys[i] - y;
    if (dx * dx + dy * dy < min) return false;
  }
  return true;
}

/** How finely the cloth is searched when a requested placement is blocked. A
 *  fortieth of the table's half-length is a ball's diameter and a bit, so the
 *  spiral cannot step over a gap a ball would fit in. */
const SEARCH_STEP = BALL_R * 1.6;

/** The nearest legal place to put the cue ball, searched outward from where it
 *  was asked for.
 *
 *  A RING AT A TIME, and the ring is walked in a fixed order, so the answer is
 *  the same on the server, on the client that asked, and in every replay of the
 *  match afterwards. `behind` is the head string rule: on the break, and after
 *  a foul on the break, a ball in hand may only be placed in the top quarter of
 *  the table. */
export function nearestSpot(
  x: number,
  y: number,
  xs: readonly number[],
  ys: readonly number[],
  alive: readonly number[],
  behind: boolean
): Spot {
  const legal = (px: number, py: number): boolean =>
    spotFree(px, py, xs, ys, alive, 0) && (!behind || px <= HEAD_STRING);
  const cx = Math.max(-HALF_X + BALL_R, Math.min(behind ? HEAD_STRING : HALF_X - BALL_R, x));
  const cy = Math.max(-HALF_Y + BALL_R, Math.min(HALF_Y - BALL_R, y));
  if (legal(cx, cy)) return { x: cx, y: cy };
  // Eight compass points per ring, outwards. Enough to find any gap a ball fits
  // in, and few enough that the whole search is a few hundred distance tests.
  const dirs: readonly (readonly [number, number])[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [0.7071, 0.7071],
    [-0.7071, 0.7071],
    [-0.7071, -0.7071],
    [0.7071, -0.7071],
  ];
  for (let ring = 1; ring <= 40; ring++) {
    const d = ring * SEARCH_STEP;
    for (const [ux, uy] of dirs) {
      const px = cx + ux * d;
      const py = cy + uy * d;
      if (legal(px, py)) return { x: px, y: py };
    }
  }
  // Nothing anywhere, which needs a table with no room left on it. Better a
  // ball on the break spot than a shot that cannot be taken at all.
  return { x: BREAK_SPOT.x, y: BREAK_SPOT.y };
}

/** How a ball is named to a person, for the replay studio and the HUD. */
export function ballName(ball: number): string {
  if (ball === 0) return "the cue ball";
  if (ball === EIGHT) return "the black";
  return `the ${ball}`;
}
