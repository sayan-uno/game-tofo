// The Ludo board, as geometry — the one description of it that the rules, the
// server's replay and the painter all read.
//
// It is a 15×15 grid. Four 6×6 yards sit in the corners; a three-wide cross
// joins them. The outer two lanes of each cross arm form a closed ring of 52
// squares; the middle lane of each arm is that colour's home run and belongs to
// nobody else.
//
//        col →  0 1 2 3 4 5 6 7 8 9 …            corner 0 ── corner 1
//   row 0      ┌───────────┬─┬─┬───────────┐        (top-left)  (top-right)
//     ↓        │  yard 0   │ │ │  yard 1   │
//        6     ├───────────┼─┼─┼───────────┤     turn order runs clockwise,
//        7     │ ring …  home run … ring   │     0 → 1 → 2 → 3
//        8     ├───────────┼─┼─┼───────────┤
//              │  yard 3   │ │ │  yard 2   │        corner 3 ── corner 2
//       14     └───────────┴─┴─┴───────────┘
//
// A token's position is ONE number, which is what keeps the simulation small
// enough to replay from scratch on every late input:
//
//    -1        still in the yard
//    0 … 50    the 51 ring squares it walks, counted from ITS OWN start square
//    51 … 55   its five home-run squares
//    56        home
//
// Counting the ring from each colour's own start is the trick that makes the
// four players symmetric: the rules never mention a colour, only a number, and
// only `ringIndexOf` translates back to the shared ring where captures happen.
//
// The ring is WALKED rather than written out as fifty-two literal pairs: a walk
// is checkable by eye against the diagram above, a table of coordinates is not.
// It runs clockwise from corner 0's start square, and its shape is the same
// five-six-two step repeated once per arm — which is also why the four start
// squares land exactly thirteen apart.
//
// One thing about that walk surprises everyone who checks it: at each of the
// four INNER corners the ring steps DIAGONALLY, past a corner of the centre
// block — (5,6) to (6,5), and its three rotations. That is not a mistake in the
// walk, it is what fifty-two means. The cross has room for fifty-six squares
// around it if the corners are turned squarely; the classic board turns them
// across the corner of the home triangle instead, and a real token really does
// cut that corner. The self-check asserts exactly four such steps, so a walk
// that drifted would be caught rather than excused.

/** Squares on the shared ring. */
export const RING_LENGTH = 52;
/** Ring squares a token walks before turning into its home run. One short of
 *  the full lap: you turn off just before you would re-enter your own start. */
export const RING_STEPS = 51;
/** Squares in a home run, plus the home triangle at the end of it. */
export const HOME_RUN = 5;
/** The position that IS home. A token must land on it exactly. */
export const POS_HOME = RING_STEPS + HOME_RUN; // 56
/** A token still in its yard. */
export const POS_YARD = -1;
export const TOKENS_PER_PLAYER = 4;
/** The grid is this many cells on a side. */
export const GRID = 15;

export interface Cell {
  col: number;
  row: number;
}

/** One leg of the walk round the ring: where it starts, which way it goes, and
 *  how many squares long it is. */
const WALK: readonly (readonly [col: number, row: number, dc: number, dr: number, n: number])[] = [
  [1, 6, 1, 0, 5], // out along the top of the left arm
  [6, 5, 0, -1, 6], // up the left side of the top arm
  [7, 0, 1, 0, 2], // across the top of the board
  [8, 1, 0, 1, 5], // down the right side of the top arm
  [9, 6, 1, 0, 6], // out along the top of the right arm
  [14, 7, 0, 1, 2], // down the right edge of the board
  [13, 8, -1, 0, 5], // back along the bottom of the right arm
  [8, 9, 0, 1, 6], // down the right side of the bottom arm
  [7, 14, -1, 0, 2], // across the bottom of the board
  [6, 13, 0, -1, 5], // up the left side of the bottom arm
  [5, 8, -1, 0, 6], // back along the bottom of the left arm
  [0, 7, 0, -1, 2], // up the left edge of the board
];

function walkRing(): Cell[] {
  const out: Cell[] = [];
  for (const [col, row, dc, dr, n] of WALK) {
    for (let i = 0; i < n; i++) out.push({ col: col + dc * i, row: row + dr * i });
  }
  return out;
}

/** The 52 ring squares, clockwise, index 0 being corner 0's start square. */
export const RING: readonly Cell[] = walkRing();

/** Ring index of each corner's start square. Thirteen apart, by construction. */
export const START_INDEX: readonly number[] = [0, 13, 26, 39];

/** Squares no capture may happen on: the four start squares, and the four
 *  starred squares eight along from each of them — the traditional resting
 *  places, and the reason a token is not simply prey for its whole lap. */
export const SAFE_RING: readonly number[] = [0, 8, 13, 21, 26, 34, 39, 47];
const SAFE = new Set(SAFE_RING);
export const isSafeRing = (index: number): boolean => SAFE.has(index);

/** The 3×3 block in the middle. It is drawn as four triangles meeting at its
 *  centre — one per colour — and a token that gets home rests in its own. */
export const CENTRE: Cell = { col: 7, row: 7 };
export const CENTRE_SIZE = 3;

/** Where a finished token sits: inside its OWN triangle rather than stacked
 *  with everybody else's on the middle square. Pulled back from the centre by
 *  a little under half a cell, which is the middle of each triangle. */
const HOME_OFFSET = 0.62;
export const HOME_CELL: readonly Cell[] = [
  { col: CENTRE.col - HOME_OFFSET, row: CENTRE.row },
  { col: CENTRE.col, row: CENTRE.row - HOME_OFFSET },
  { col: CENTRE.col + HOME_OFFSET, row: CENTRE.row },
  { col: CENTRE.col, row: CENTRE.row + HOME_OFFSET },
];

/** Where each corner's yard begins (its top-left grid cell). */
const YARD_ORIGIN: readonly Cell[] = [
  { col: 0, row: 0 },
  { col: 9, row: 0 },
  { col: 9, row: 9 },
  { col: 0, row: 9 },
];

/** The four parking places inside a yard, as offsets from its origin. Half
 *  values because a token sits at the CENTRE of a cell, and these sit between
 *  cells — a yard is drawn as one rounded panel, not six squares. */
const YARD_SPOTS: readonly Cell[] = [
  { col: 1.5, row: 1.5 },
  { col: 3.5, row: 1.5 },
  { col: 1.5, row: 3.5 },
  { col: 3.5, row: 3.5 },
];

/** Which way a corner's home run runs, from its entry square inwards. */
const INWARD: readonly Cell[] = [
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: -1, row: 0 },
  { col: 0, row: -1 },
];

function buildHomeRuns(): Cell[][] {
  return START_INDEX.map((start, corner) => {
    // The square a token turns off the ring from, and then five inwards.
    const entry = RING[(start + RING_STEPS - 1) % RING_LENGTH];
    const dir = INWARD[corner];
    const run: Cell[] = [];
    for (let i = 1; i <= HOME_RUN; i++) run.push({ col: entry.col + dir.col * i, row: entry.row + dir.row * i });
    return run;
  });
}

/** homeRunOf[corner][0…4] — the five squares between the ring and the centre. */
export const HOME_RUN_CELLS: readonly (readonly Cell[])[] = buildHomeRuns();

/** The yard panel of a corner: its origin and its 6×6 extent, for the painter. */
export const yardRect = (corner: number): { col: number; row: number; size: number } => ({
  col: YARD_ORIGIN[corner].col,
  row: YARD_ORIGIN[corner].row,
  size: 6,
});

/** Where a token parks while it waits in the yard. */
export function yardCell(corner: number, token: number): Cell {
  const o = YARD_ORIGIN[corner];
  const s = YARD_SPOTS[token % TOKENS_PER_PLAYER];
  return { col: o.col + s.col, row: o.row + s.row };
}

/** The shared ring square a position sits on, or -1 when it is not on the ring
 *  (in the yard, in a home run, or home). Captures are decided on this number
 *  and nothing else, which is why it is the only place a corner's private
 *  count is turned back into a public square. */
export function ringIndexOf(corner: number, pos: number): number {
  if (pos < 0 || pos >= RING_STEPS) return -1;
  return (START_INDEX[corner] + pos) % RING_LENGTH;
}

/** The grid cell a token is drawn on. Pure geometry — the painter's only
 *  question — so it also answers for the yard and for home. */
export function cellOf(corner: number, pos: number, token: number): Cell {
  if (pos === POS_YARD) return yardCell(corner, token);
  if (pos >= POS_HOME) return HOME_CELL[corner];
  const ring = ringIndexOf(corner, pos);
  if (ring >= 0) return RING[ring];
  return HOME_RUN_CELLS[corner][pos - RING_STEPS];
}

/** Is this position safe from capture? The home run and the yard always are;
 *  on the ring it depends on the square. */
export function isSafePos(corner: number, pos: number): boolean {
  const ring = ringIndexOf(corner, pos);
  return ring < 0 ? true : isSafeRing(ring);
}

/** Which corner of the board a seat plays from.
 *
 *  Two players sit ACROSS the diagonal, which is how the two-handed game is
 *  always laid out and keeps the two home runs from sharing an arm. Three and
 *  four take the corners in order. */
export function cornerOf(seat: number, players: number): number {
  if (players <= 2) return seat === 0 ? 0 : 2;
  return seat % 4;
}
