// The grid: where the dots are, which lines join them, and which boxes each
// line can close.
//
// EVERYTHING IS AN INDEX. A line is a number from 0 to 83 and a box is a number
// from 0 to 35, and every relationship between them is a lookup table built
// once at module load by walking the grid. Nothing in the simulation ever does
// arithmetic on a coordinate, which is what makes the whole game a handful of
// array reads — and what makes it impossible for the server and a client to
// disagree about which line a player meant.
//
// Lines are numbered ACROSS first and then DOWN, because that ordering is what
// the wire carries: a move is `d37`, and a number that means something
// different on two builds would be the one bug this shape exists to prevent.
import { GRID } from "./rules.js";

/** Dots along one side. Six boxes means seven dots. */
export const DOTS = GRID + 1;

/** Horizontal lines: one above every box row, plus one below the last. */
export const H_COUNT = (GRID + 1) * GRID;
/** Vertical lines: one to the left of every box column, plus one to the right. */
export const V_COUNT = GRID * (GRID + 1);
export const LINE_COUNT = H_COUNT + V_COUNT;
export const BOX_COUNT = GRID * GRID;

/** Is this line one of the ACROSS ones? The first H_COUNT of them are. */
export const isAcross = (line: number): boolean => line < H_COUNT;

/** The line above box row `r`, in box column `c`. Also the line BELOW row r-1. */
export const acrossLine = (r: number, c: number): number => r * GRID + c;
/** The line to the left of box (r, c). Also the line to the right of (r, c-1). */
export const downLine = (r: number, c: number): number => H_COUNT + r * (GRID + 1) + c;

/** Where a line sits, in dot coordinates: it runs from (col, row) to the next
 *  dot across or down. Used by the painter and by nothing else. */
export function lineEnds(line: number): { col: number; row: number; across: boolean } {
  if (isAcross(line)) return { col: line % GRID, row: Math.floor(line / GRID), across: true };
  const n = line - H_COUNT;
  return { col: n % (GRID + 1), row: Math.floor(n / (GRID + 1)), across: false };
}

/** The four lines that close box `b`, in the order top, bottom, left, right. */
export const BOX_LINES: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      out.push([acrossLine(r, c), acrossLine(r + 1, c), downLine(r, c), downLine(r, c + 1)]);
    }
  }
  return out;
})();

/** The boxes a line can close: two of them inside the grid, one on the border.
 *
 *  Built by INVERTING BOX_LINES rather than by deriving it a second way. Two
 *  independent derivations of the same relationship is two chances to get it
 *  wrong, and the self-check would then be comparing one mistake against
 *  another. */
export const LINE_BOXES: readonly (readonly number[])[] = (() => {
  const out: number[][] = Array.from({ length: LINE_COUNT }, () => []);
  BOX_LINES.forEach((lines, box) => {
    for (const line of lines) out[line].push(box);
  });
  return out;
})();

/** Box (r, c) from its index, for the painter. */
export const boxRow = (box: number): number => Math.floor(box / GRID);
export const boxCol = (box: number): number => box % GRID;

/** How a line is named to a person: the dot it starts at, and which way it
 *  goes. Rows are numbered from the top and columns from the left, both from
 *  one, because that is how somebody reading a replay would count them. */
export function lineName(line: number): string {
  const e = lineEnds(line);
  return `${e.across ? "across" : "down"} at r${e.row + 1}c${e.col + 1}`;
}
