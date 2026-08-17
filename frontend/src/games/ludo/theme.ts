// The Ludo board's palette.
//
// A traditional Ludo board is white. This one is not, and that is a decision
// rather than an oversight: it is played inside a platform whose whole language
// is crimson on near-black, and dropping a sheet of white paper into the middle
// of that would read as a different application rather than a different game.
// What makes a board legible AS Ludo is its shape — the cross, the four corner
// yards, the four triangles meeting in the middle, the stars on the safe
// squares — and every one of those is here, in full-strength colour, on a dark
// table. Corner 0's red is the platform's own red, which is what makes the
// board belong to this app rather than to some other one.

export interface Palette {
  /** The strong colour: yards, home runs, tokens. */
  main: string;
  /** A lift of it, for rims and highlights. */
  light: string;
  /** A sink of it, for the panel behind the tokens. */
  deep: string;
  /** The same hue at low alpha, for tinting a square without drowning it. */
  wash: string;
  name: string;
}

/** Corner order is clockwise from the top-left, which is also the turn order. */
export const PALETTE: readonly Palette[] = [
  { main: "#e5182e", light: "#ff6172", deep: "#3d0810", wash: "rgba(229,24,46,0.22)", name: "Red" },
  { main: "#19c37d", light: "#5fe8b0", deep: "#04331f", wash: "rgba(25,195,125,0.22)", name: "Green" },
  { main: "#f5b120", light: "#ffd36b", deep: "#3d2a02", wash: "rgba(245,177,32,0.22)", name: "Amber" },
  { main: "#2f8dff", light: "#7ab8ff", deep: "#062245", wash: "rgba(47,141,255,0.22)", name: "Blue" },
];

/** Board and chrome colours that belong to no player. */
export const INK = {
  /** Behind everything. */
  backdrop: "#0b0507",
  /** The board panel. */
  board: "#160f13",
  /** A square nobody owns. */
  cell: "#241b21",
  cellEdge: "rgba(255,255,255,0.11)",
  text: "#e8ecf8",
  dim: "rgba(232,236,248,0.5)",
  die: "#f6f3f0",
  diePip: "#170f13",
  /** The ring a legal token wears while it is waiting to be chosen. */
  choose: "#ffffff",
} as const;
