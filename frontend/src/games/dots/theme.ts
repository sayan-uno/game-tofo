// The grid's palette.
//
// Four players, four colours, and unlike carrom they are not two sides — every
// box belongs to exactly one person, so the colours have to be told apart at a
// glance in a filled square the size of a fingernail. Ludo's four are reused on
// purpose: a player who has played the other board game here already knows that
// crimson is seat one, and the platform's own red being first is what makes
// this board belong to this app rather than to a piece of squared paper.
//
// The BOXES are the loud thing and the LINES are the quiet one. A filled box is
// the score; a drawn line is only how it got there, so lines are drawn in a
// muted version of their owner's colour and boxes in the full one. A board with
// eighty-four full-strength lines on it is unreadable.

export interface Seat {
  /** The strong colour: a filled box, the player's card. */
  main: string;
  /** A lift of it, for the initial inside a box and for a highlight. */
  light: string;
  /** The muted version a drawn line gets. */
  line: string;
  /** The same hue at low alpha, for a hovering finger. */
  ghost: string;
  name: string;
}

/** Seat order is the turn order, which is also the card order. */
export const SEATS: readonly Seat[] = [
  { main: "#e5182e", light: "#ff8492", line: "rgba(229, 24, 46, 0.75)", ghost: "rgba(229, 24, 46, 0.34)", name: "Red" },
  { main: "#19c37d", light: "#6ff0bd", line: "rgba(25, 195, 125, 0.75)", ghost: "rgba(25, 195, 125, 0.34)", name: "Green" },
  { main: "#f5b120", light: "#ffd97a", line: "rgba(245, 177, 32, 0.78)", ghost: "rgba(245, 177, 32, 0.36)", name: "Amber" },
  { main: "#3f8dff", light: "#8fc0ff", line: "rgba(63, 141, 255, 0.75)", ghost: "rgba(63, 141, 255, 0.34)", name: "Blue" },
];

/** Everything on the board that belongs to nobody. */
export const INK = {
  /** Behind everything. */
  backdrop: "#0b0507",
  /** The paper the grid is ruled on. */
  paper: "#171018",
  paperEdge: "rgba(229, 24, 46, 0.22)",
  /** A dot nobody has joined yet. */
  dot: "rgba(236, 240, 252, 0.68)",
  dotEdge: "rgba(0, 0, 0, 0.5)",
  /** A line still free, drawn only under the finger. */
  hint: "rgba(232, 236, 248, 0.16)",
  text: "#e8ecf8",
  dim: "rgba(232, 236, 248, 0.5)",
} as const;

/** The line the local player has chosen but not yet drawn. White, not their own
 *  colour: it is not on the board yet, and a ghost in seat colour is a line
 *  people read as already played. */
export const PICK = {
  line: "#ffffff",
  glow: "rgba(255, 255, 255, 0.28)",
  /** A box this line would close — the only forecast the board makes. */
  fill: "rgba(255, 255, 255, 0.14)",
} as const;
