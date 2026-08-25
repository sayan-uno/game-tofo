// The pool table's palette.
//
// A real table is green baize under warm light, and this one very nearly is —
// which is a different decision from carrom's, where the blond ply was thrown
// away for reading as a different application. The difference is that a pool
// table's colour is not incidental: green cloth with a dark wood rail is the
// single most recognisable object in any game room, and the fifteen balls only
// mean anything against it. So the cloth stays green and the platform's crimson
// does the rest — the rail, the cue, the moment of release, the seat that is
// yours. What is dropped is the LIGHTNESS: this is a dim room with a lamp over
// the table, not a showroom, which puts the cloth two stops under a real one
// and lets a white cue ball be the brightest thing on the screen.
//
// THE BALLS ARE THE PRINTED ONES. Yellow one, blue two, red three, and so on to
// the maroon seven, then the same seven again with a white band across them.
// Nobody has to be taught that and no legend is needed — but colour alone is
// not enough on a phone at arm's length, so a stripe is drawn as a stripe and
// every ball carries its number.

import { speedFor } from "../../shared/games/pool/index";

/** How hard a shot is, said the way a person would.
 *
 *  The bands are the speed the cue ball actually leaves at and not the slider
 *  position, because the slider is not linear and "half power" is a third of
 *  the pace. Lives here rather than in the studio hooks that first needed it,
 *  because the TABLE says it too now — the banner names the weight of a shot
 *  while it is being lined up, which is the one thing about somebody else's
 *  turn that used to be invisible.
 *
 *  Two readings of one number, and both of them wanted: the ring and the
 *  backswing are for the eye mid-shot, and this is for anyone who would rather
 *  be told. */
export function weightWord(power: number): string {
  const v = speedFor(power / 1000);
  if (v < 1.1) return "a touch";
  if (v < 1.9) return "softly";
  if (v < 2.9) return "steadily";
  if (v < 4.2) return "firmly";
  return "at full pace";
}

export const INK = {
  /** Behind everything. */
  backdrop: "#0b0507",
  /** The rail the cloth sits in, and its lit edge. */
  rail: "#2b1119",
  railEdge: "#e5182e",
  railInner: "#180a0e",
  /** The cloth. */
  cloth: "#12402f",
  clothDeep: "#0b2a1f",
  /** The lamp's pool of light on the cloth, drawn as a soft radial lift. */
  clothLit: "rgba(120, 220, 175, 0.09)",
  /** Painted lines: the head string and the two spots. */
  line: "rgba(240, 240, 226, 0.22)",
  lineSoft: "rgba(240, 240, 226, 0.1)",
  spot: "rgba(240, 240, 226, 0.34)",
  /** The pocket itself, and the leather it is cut into. */
  pocket: "#040203",
  pocketRim: "rgba(0, 0, 0, 0.8)",
  pocketLip: "rgba(255, 255, 255, 0.13)",
  /** The little diamond sights along the rail — decoration, and the thing that
   *  makes a rectangle read as a pool table rather than as a green box. */
  diamond: "rgba(240, 226, 205, 0.4)",
  text: "#e8ecf8",
  dim: "rgba(232, 236, 248, 0.5)",
  /** The band of cloth a ball in hand may be put down on. */
  kitchen: "rgba(229, 24, 46, 0.1)",
  kitchenEdge: "rgba(229, 24, 46, 0.5)",
} as const;

export interface BallPaint {
  /** The body of the ball. */
  main: string;
  /** The lit top-left. */
  light: string;
  /** The shaded underside. */
  deep: string;
  /** Ink for the number in its white disc. */
  ink: string;
  /** Striped balls are a white ball with a band across them. */
  striped: boolean;
}

/** Indexed by the number printed on the ball: 0 is the cue, 1–7 solids, 8 the
 *  black, 9–15 the stripes in the same seven colours. */
const HUE: readonly { main: string; light: string; deep: string }[] = [
  { main: "#f6f3e8", light: "#ffffff", deep: "#b9b3a2" }, // 0 cue
  { main: "#f2c33c", light: "#ffe697", deep: "#9c7a12" }, // 1 yellow
  { main: "#2f6ad9", light: "#7fa8f5", deep: "#1a3d80" }, // 2 blue
  { main: "#d8352c", light: "#ff8a80", deep: "#851a14" }, // 3 red
  { main: "#7a4bc4", light: "#b795ee", deep: "#452672" }, // 4 purple
  { main: "#e07a1f", light: "#ffb56a", deep: "#8a4508" }, // 5 orange
  { main: "#2f9f5e", light: "#79dba2", deep: "#175c34" }, // 6 green
  { main: "#8c3226", light: "#c9705f", deep: "#4d1710" }, // 7 maroon
  { main: "#191b20", light: "#4c525f", deep: "#000000" }, // 8 black
];

export function ballPaint(ball: number): BallPaint {
  const striped = ball > 8 && ball <= 15;
  const hue = HUE[striped ? ball - 8 : ball] ?? HUE[0];
  return { main: hue.main, light: hue.light, deep: hue.deep, ink: "#14161b", striped };
}

/** The two sides, for the cards and the banner. Team 0 takes whichever group it
 *  potted first, so these are named only once the table is decided; until then
 *  both sides are shown as open. */
export const GROUP = [
  { name: "Solids", swatch: "●", tint: "#f2c33c" },
  { name: "Stripes", swatch: "◐", tint: "#7fa8f5" },
] as const;

/** The cue, the aim line, the ghost ball and the power ring. */
export const AIM = {
  /** The line from the cue ball to where it is pointed. */
  line: "rgba(255, 255, 255, 0.6)",
  lineHot: "#e5182e",
  /** Where the cue ball will strike, drawn as a ring. */
  ghost: "rgba(255, 255, 255, 0.42)",
  /** Where the object ball will set off, if the cue ball hits one. */
  throw: "rgba(245, 177, 32, 0.7)",
  /** Somebody else lining up. Amber, so it reads as "not yours" on a table
   *  where white is your own aim and crimson is the moment of release. */
  lineThem: "rgba(245, 177, 32, 0.75)",
  powerThem: "#f5b120",
  power: "#e5182e",
  powerTrack: "rgba(255, 255, 255, 0.18)",
  /** The ring thrown off the cue ball at the moment the cue reaches it. */
  impact: "rgba(255, 255, 255, 0.92)",
  /** The cue stick itself. */
  cue: "#c99a5b",
  cueTip: "#3f6fa8",
  cueWrap: "#2a1a12",
} as const;
