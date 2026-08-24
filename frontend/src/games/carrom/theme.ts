// The carrom board's palette.
//
// A real carrom board is pale polished ply, and this one is not — for the
// reason Ludo's board is not white either. The game is played inside a platform
// whose whole language is crimson on near-black, and a sheet of blond wood in
// the middle of it reads as a different application rather than a different
// game. What makes a board legible AS carrom is its geometry: the square, the
// four corner pockets, the double base lines with their red circles, the centre
// circle and the arrows reaching out to the pockets. Every one of those is
// here, full strength, on a dark table.
//
// The one thing the darkness costs is the black coins, so they are not black:
// they are a cool slate against a warm board, which separates them from the
// surface by hue as well as by lightness. Held next to the ivory coins the pair
// still reads instantly as "mine and theirs", which is the only job the two
// colours have.

export const INK = {
  /** Behind everything. */
  backdrop: "#0b0507",
  /** The frame the board sits in. */
  frame: "#2b1119",
  frameEdge: "#e5182e",
  frameInner: "#180a0e",
  /** The playing surface. */
  felt: "#2a1f24",
  feltDeep: "#1a1216",
  /** Painted lines on the surface. */
  line: "rgba(240, 226, 205, 0.34)",
  lineSoft: "rgba(240, 226, 205, 0.16)",
  /** The red circles at the ends of a base line, and the arrows. */
  mark: "rgba(229, 24, 46, 0.72)",
  markSoft: "rgba(229, 24, 46, 0.3)",
  /** The pocket itself. */
  pocket: "#040203",
  pocketRim: "rgba(0, 0, 0, 0.75)",
  pocketLip: "rgba(255, 255, 255, 0.14)",
  text: "#e8ecf8",
  dim: "rgba(232, 236, 248, 0.5)",
  /** The player's own base line, so they always know which edge is theirs. */
  home: "rgba(229, 24, 46, 0.85)",
  homeGlow: "rgba(229, 24, 46, 0.16)",
} as const;

export interface DiscPaint {
  /** The face of the disc. */
  main: string;
  /** A lift for the top-left highlight. */
  light: string;
  /** The turned rim. */
  rim: string;
  /** The engraved ring inside the rim. */
  inlay: string;
  name: string;
}

/** Index by KIND_* from the shared board: light, dark, queen, striker. */
export const DISC: readonly DiscPaint[] = [
  { main: "#efe4cd", light: "#fffaf0", rim: "#a8916a", inlay: "rgba(120, 96, 58, 0.55)", name: "White" },
  { main: "#2c3247", light: "#586380", rim: "#7b86a5", inlay: "rgba(170, 185, 220, 0.42)", name: "Black" },
  { main: "#e5182e", light: "#ff8492", rim: "#8d0b1a", inlay: "rgba(255, 220, 225, 0.45)", name: "Queen" },
  { main: "#f4f7ff", light: "#ffffff", rim: "#e5182e", inlay: "rgba(229, 24, 46, 0.55)", name: "Striker" },
];

/** The two sides, for the cards and the banner. Team 0 plays the light coins. */
export const TEAM = [
  { main: "#efe4cd", light: "#fffaf0", deep: "#3a3126", name: "White", swatch: "⚪" },
  { main: "#7f8dae", light: "#aab6d2", deep: "#1b2030", name: "Black", swatch: "⚫" },
] as const;

/** The aim line, the power ring and the landing marker. */
export const AIM = {
  line: "rgba(255, 255, 255, 0.55)",
  lineHot: "#e5182e",
  /** Somebody else lining up. Amber rather than white or red: it has to read as
   *  "not yours" at a glance, on a board where white is your own aim and red is
   *  the moment of release. */
  lineThem: "rgba(245, 177, 32, 0.75)",
  powerThem: "#f5b120",
  ghost: "rgba(255, 255, 255, 0.3)",
  power: "#e5182e",
  powerTrack: "rgba(255, 255, 255, 0.18)",
  hit: "rgba(255, 255, 255, 0.8)",
} as const;
