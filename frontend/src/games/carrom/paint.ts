// Drawing the board.
//
// Two layers, and the split matters more here than it did in Ludo. The frame,
// the felt, the four pockets, the base lines and the arrows never change, so
// they are painted ONCE onto their own canvas and left alone. The live canvas
// above carries nineteen discs, a striker and an aim line — and during a shot
// it is repainted sixty times a second, which is exactly why nothing static may
// be underneath it.
//
// The other half of the same idea is in the runtime: for most of a carrom match
// nothing is moving at all — somebody is deciding — so a frame in which nothing
// has changed does no canvas work whatsoever.
//
// EVERYTHING IS DRAWN IN THE LOCAL PLAYER'S FRAME. You are always at the bottom
// of your own screen: it is how the game is played sitting at a table and it is
// what makes aiming make sense. The rotation is `toLocal` from the shared board
// — a swap and a sign, applied once per disc — and the static layer needs none
// of it at all, because a carrom board is the same board from all four sides.
//
// Everything here works in CSS pixels; the device-pixel ratio is handled once,
// by the transform the runtime sets on the context.
import {
  BASE_DOT_R,
  BASE_HALF,
  BASE_Y,
  CENTRE_R,
  COIN_COUNT,
  COIN_R,
  HALF,
  KIND_STRIKER,
  POCKETS,
  POCKET_R,
  STRIKER_INDEX,
  STRIKER_R,
  radiusOf,
  toLocal,
  type CarromState,
} from "../../shared/games/carrom/index";
import { AIM, DISC, INK } from "./theme";

/** The wooden surround, as a fraction of half the playing square. Wide enough
 *  to swallow a pocket whole: a pocket is drawn centred on the corner, so
 *  anything narrower leaves two black lobes sticking out into the room. */
export const FRAME = 0.115;

export interface Layout {
  w: number;
  h: number;
  /** Centre of the playing surface, in CSS pixels. */
  cx: number;
  cy: number;
  /** Pixels per board unit — half the playing surface. */
  r: number;
  /** Width of the rail either side of the board, for the DOM chrome. */
  rail: number;
  /** Height reserved along the bottom for the control strip. */
  ctrl: number;
}

/** Fit the square board between two rails, above the controls.
 *
 *  Every TOFO game is played in locked landscape (the platform's entry gate
 *  sees to it), so there is always room either side of a square — which is what
 *  the player cards use.
 *
 *  THE STRIP AT THE BOTTOM IS NOT OPTIONAL, and it costs the board about a
 *  seventh of its size. That trade was made after the first version tried to do
 *  everything with one gesture on the felt: aim, weight and the striker's
 *  placement all rode on a single drag, which meant the aim could not be
 *  adjusted without recharging the shot, the striker could not be moved without
 *  abandoning the aim, and there was no way to change your mind at all. A
 *  smaller board you can aim beats a larger one you cannot. */
export function layoutFor(w: number, h: number): Layout {
  const pad = Math.max(6, Math.min(16, h * 0.03));
  const ctrl = Math.round(Math.max(44, Math.min(62, h * 0.135)));
  const minRail = Math.min(96, Math.max(44, w * 0.115));
  // The frame around the felt is drawn OUTSIDE the playing square, so the
  // square itself has to leave room for it — and enough room that the corner
  // pockets are cut INTO the wood rather than hanging off the outside of it.
  const frame = FRAME;
  const room = h - pad * 2 - ctrl;
  const span = Math.max(120, Math.min(room, w - pad * 2 - minRail * 2));
  const r = span / 2 / (1 + frame);
  const cx = Math.round(w / 2);
  const cy = Math.round(pad + room / 2);
  return { w, h, cx, cy, r, rail: Math.max(0, cx - span / 2), ctrl };
}

/** Board units → CSS pixels. Local +y is INTO the board, which is up the
 *  screen, so the sign flips exactly once and it flips here. */
export const px = (l: Layout, x: number, y: number): { x: number; y: number } => ({
  x: l.cx + x * l.r,
  y: l.cy - y * l.r,
});

/** A state position, rotated into the local player's frame and scaled. */
export function discPx(l: Layout, s: CarromState, side: number, i: number): { x: number; y: number } {
  const p = toLocal(side, s.x[i], s.y[i]);
  return px(l, p.x, p.y);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rad: number): void {
  const r = Math.min(rad, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** ---------------------------------------------------------------------------
 *  The static layer.
 * ------------------------------------------------------------------------- */

export function paintBoard(g: CanvasRenderingContext2D, l: Layout): void {
  g.clearRect(0, 0, l.w, l.h);
  const R = l.r;
  const half = HALF * R;
  const frame = R * FRAME;

  // ---- the frame -------------------------------------------------------
  const fx = l.cx - half - frame;
  const fy = l.cy - half - frame;
  const fs = (half + frame) * 2;
  const wood = g.createLinearGradient(fx, fy, fx + fs, fy + fs);
  wood.addColorStop(0, "#3a161f");
  wood.addColorStop(0.5, INK.frame);
  wood.addColorStop(1, "#1d0a10");
  g.fillStyle = wood;
  roundRect(g, fx, fy, fs, fs, frame * 0.9);
  g.fill();
  // A hairline of the platform's own red, which is what makes this board
  // belong to this app rather than to a photograph of a board.
  g.strokeStyle = "rgba(229, 24, 46, 0.45)";
  g.lineWidth = Math.max(1, R * 0.006);
  roundRect(g, fx + 1, fy + 1, fs - 2, fs - 2, frame * 0.9);
  g.stroke();

  // ---- the felt --------------------------------------------------------
  const felt = g.createRadialGradient(l.cx, l.cy, R * 0.1, l.cx, l.cy, R * 1.45);
  felt.addColorStop(0, INK.felt);
  felt.addColorStop(1, INK.feltDeep);
  g.fillStyle = felt;
  g.fillRect(l.cx - half, l.cy - half, half * 2, half * 2);
  g.strokeStyle = "rgba(0, 0, 0, 0.55)";
  g.lineWidth = Math.max(1, R * 0.008);
  g.strokeRect(l.cx - half, l.cy - half, half * 2, half * 2);

  // ---- markings, one side at a time ------------------------------------
  //
  // A carrom board looks the same from all four sides, so the base lines and
  // the arrows are drawn by rotating the context rather than by writing the
  // same geometry out four times. The player's own side is drawn last and in
  // red, so the edge they are shooting from is never in doubt.
  for (let side = 0; side < 4; side++) {
    g.save();
    g.translate(l.cx, l.cy);
    g.rotate((side * Math.PI) / 2);
    paintSideMarks(g, R, side === 0);
    g.restore();
  }

  // ---- the centre circle ------------------------------------------------
  g.strokeStyle = INK.line;
  g.lineWidth = Math.max(1, R * 0.007);
  g.beginPath();
  g.arc(l.cx, l.cy, CENTRE_R * R, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = INK.markSoft;
  g.lineWidth = Math.max(1, R * 0.009);
  g.beginPath();
  g.arc(l.cx, l.cy, CENTRE_R * R * 0.66, 0, Math.PI * 2);
  g.stroke();

  // ---- the pockets ------------------------------------------------------
  for (const p of POCKETS) {
    const c = px(l, p.x, p.y);
    const pr = POCKET_R * R;
    const hole = g.createRadialGradient(c.x, c.y, pr * 0.1, c.x, c.y, pr);
    hole.addColorStop(0, "#000000");
    hole.addColorStop(0.75, INK.pocket);
    hole.addColorStop(1, "#120a0d");
    g.fillStyle = hole;
    g.beginPath();
    g.arc(c.x, c.y, pr, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = INK.pocketLip;
    g.lineWidth = Math.max(1, R * 0.008);
    g.beginPath();
    g.arc(c.x, c.y, pr, 0, Math.PI * 2);
    g.stroke();
  }
}

/** One edge's markings, drawn with the edge at the bottom.
 *
 *  THE RED CIRCLES ARE RINGS, not discs. Filled, at the size the rules give
 *  them, they are very slightly larger than a carrom man and exactly the colour
 *  of the queen — so a board with four base lines on it appeared to have eight
 *  extra queens sitting on it, which is precisely as confusing as it sounds.
 *  On a real board they are outlines, and outlines is what they have to be. */
function paintSideMarks(g: CanvasRenderingContext2D, R: number, mine: boolean): void {
  const y = BASE_Y * R; // screen y is positive downwards after the rotate
  const gap = R * 0.032;
  const x0 = -BASE_HALF * R;
  const x1 = BASE_HALF * R;
  g.lineCap = "round";

  if (mine) {
    // A soft wash under the player's own base line: the strip their thumb
    // slides the striker along, so it has to look like a control.
    const wash = g.createLinearGradient(0, y - gap * 2.5, 0, y + gap * 3.5);
    wash.addColorStop(0, "rgba(229, 24, 46, 0)");
    wash.addColorStop(0.5, INK.homeGlow);
    wash.addColorStop(1, "rgba(229, 24, 46, 0)");
    g.fillStyle = wash;
    g.fillRect(x0 - gap * 2, y - gap * 2.5, x1 - x0 + gap * 4, gap * 6);
  }

  // The arrows first, so the lines sit over them.
  g.strokeStyle = mine ? INK.markSoft : INK.lineSoft;
  g.lineWidth = Math.max(1, R * 0.005);
  for (const x of [x0, x1]) {
    const towards = x < 0 ? 1 : -1;
    g.beginPath();
    g.moveTo(x + towards * R * 0.075, y - R * 0.028);
    g.lineTo(x + towards * R * 0.2, y - R * 0.125);
    g.stroke();
  }

  g.strokeStyle = mine ? INK.home : INK.lineSoft;
  g.lineWidth = Math.max(1, R * (mine ? 0.009 : 0.006));
  for (const dy of [-gap / 2, gap / 2]) {
    g.beginPath();
    g.moveTo(x0, y + dy);
    g.lineTo(x1, y + dy);
    g.stroke();
  }
  // The circles that close the ends of the line.
  g.strokeStyle = mine ? INK.home : INK.mark;
  g.lineWidth = Math.max(1, R * 0.008);
  for (const x of [x0, x1]) {
    g.beginPath();
    g.arc(x, y, BASE_DOT_R * R, 0, Math.PI * 2);
    g.stroke();
  }
  g.lineCap = "butt";
}

/** ---------------------------------------------------------------------------
 *  The live layer.
 * ------------------------------------------------------------------------- */

export interface DiscStyle {
  /** Draw a ring around it: the local player's own colour. */
  own: boolean;
  /** How hard it is glowing, 0–1. */
  glow: number;
}

export function paintDisc(
  g: CanvasRenderingContext2D,
  l: Layout,
  x: number,
  y: number,
  radius: number,
  kind: number,
  style: DiscStyle
): void {
  const paint = DISC[kind] ?? DISC[0];
  const rr = radius * l.r;

  if (style.glow > 0) {
    g.fillStyle = kind === KIND_STRIKER ? "rgba(229, 24, 46, 0.28)" : "rgba(255, 255, 255, 0.2)";
    g.beginPath();
    g.arc(x, y, rr * (1.35 + 0.2 * style.glow), 0, Math.PI * 2);
    g.fill();
  }

  // A soft shadow so the discs sit ON the felt rather than in it.
  g.fillStyle = "rgba(0, 0, 0, 0.45)";
  g.beginPath();
  g.arc(x + rr * 0.1, y + rr * 0.14, rr, 0, Math.PI * 2);
  g.fill();

  const face = g.createRadialGradient(x - rr * 0.35, y - rr * 0.4, rr * 0.1, x, y, rr);
  face.addColorStop(0, paint.light);
  face.addColorStop(0.65, paint.main);
  face.addColorStop(1, paint.rim);
  g.fillStyle = face;
  g.beginPath();
  g.arc(x, y, rr, 0, Math.PI * 2);
  g.fill();

  // The turned edge and the engraved ring every carrom man has.
  g.strokeStyle = paint.rim;
  g.lineWidth = Math.max(1, rr * 0.14);
  g.beginPath();
  g.arc(x, y, rr * 0.93, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = paint.inlay;
  g.lineWidth = Math.max(1, rr * 0.07);
  g.beginPath();
  g.arc(x, y, rr * 0.55, 0, Math.PI * 2);
  g.stroke();

  if (style.own) {
    g.strokeStyle = "rgba(229, 24, 46, 0.55)";
    g.lineWidth = Math.max(1, rr * 0.11);
    g.beginPath();
    g.arc(x, y, rr * 1.16, 0, Math.PI * 2);
    g.stroke();
  }
}

/** Every disc on the board, in the local player's frame. */
export function paintDiscs(
  g: CanvasRenderingContext2D,
  l: Layout,
  s: CarromState,
  side: number,
  myKind: number,
  highlight: number
): void {
  for (let i = 0; i < COIN_COUNT; i++) {
    if (!s.alive[i]) continue;
    const p = discPx(l, s, side, i);
    paintDisc(g, l, p.x, p.y, COIN_R, s.kind[i], {
      own: s.kind[i] === myKind,
      glow: 0,
    });
  }
  if (s.alive[STRIKER_INDEX]) {
    const p = discPx(l, s, side, STRIKER_INDEX);
    paintDisc(g, l, p.x, p.y, STRIKER_R, KIND_STRIKER, { own: false, glow: highlight });
  }
}

/** ---------------------------------------------------------------------------
 *  The aim.
 * ------------------------------------------------------------------------- */

export interface AimDraw {
  /** Where the striker is sitting, in LOCAL board units. */
  from: { x: number; y: number };
  /** Unit aim direction, local. */
  dir: { x: number; y: number };
  /** 0–1. */
  power: number;
  /** How far the striker travels before it touches something, in board units,
   *  and whether that something is a disc. */
  hit: { x: number; y: number; disc: boolean } | null;
  /** The player is mid-drag: draw it hot. */
  live: boolean;
  /** Somebody ELSE's aim. Drawn quieter, so a glance never confuses what you
   *  are about to do with what is being done to you. */
  theirs?: boolean;
}

/** The line the striker will travel, the point it first touches something, and
 *  a ring showing how hard it is about to be hit.
 *
 *  The line comes from the SHARED ray test, so the preview and the shot are
 *  computed by the same code — a preview that disagrees with what happens is
 *  worse than no preview at all. */
export function paintAim(g: CanvasRenderingContext2D, l: Layout, a: AimDraw): void {
  const from = px(l, a.from.x, a.from.y);
  const to = a.hit ? px(l, a.hit.x, a.hit.y) : px(l, a.from.x + a.dir.x * 2, a.from.y + a.dir.y * 2);
  g.save();
  if (a.theirs) g.globalAlpha = 0.72;
  g.strokeStyle = a.theirs ? AIM.lineThem : a.live ? AIM.lineHot : AIM.line;
  g.lineWidth = Math.max(1.5, l.r * (a.theirs ? 0.009 : 0.012));
  g.setLineDash([l.r * 0.035, l.r * 0.03]);
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.stroke();
  g.setLineDash([]);

  if (a.hit) {
    // Where the striker's face lands: a ring the size of the striker, so the
    // player is looking at the actual contact rather than at a dot.
    g.strokeStyle = a.hit.disc ? AIM.hit : AIM.ghost;
    g.lineWidth = Math.max(1, l.r * 0.008);
    g.beginPath();
    g.arc(to.x, to.y, STRIKER_R * l.r, 0, Math.PI * 2);
    g.stroke();
  }

  // The power ring around the striker: a track, and an arc of it filled.
  const pr = STRIKER_R * l.r * 1.7;
  g.lineCap = "round";
  g.strokeStyle = AIM.powerTrack;
  g.lineWidth = Math.max(2, l.r * 0.016);
  g.beginPath();
  g.arc(from.x, from.y, pr, Math.PI * 0.75, Math.PI * 2.25);
  g.stroke();
  if (a.power > 0) {
    g.strokeStyle = a.theirs ? AIM.powerThem : AIM.power;
    g.beginPath();
    g.arc(from.x, from.y, pr, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * a.power);
    g.stroke();
  }
  g.lineCap = "butt";
  g.restore();
}

/** The striker waiting on the base line while somebody lines a shot up. */
export function paintGhostStriker(g: CanvasRenderingContext2D, l: Layout, t: number, glow: number): void {
  const p = px(l, BASE_HALF * t, -BASE_Y);
  paintDisc(g, l, p.x, p.y, STRIKER_R, KIND_STRIKER, { own: false, glow });
}

/** The striker anywhere at all, in local units — which for somebody ELSE'S
 *  base line is not a point this file could work out on its own. */
export function paintStrikerAt(g: CanvasRenderingContext2D, l: Layout, x: number, y: number, glow: number): void {
  const p = px(l, x, y);
  paintDisc(g, l, p.x, p.y, STRIKER_R, KIND_STRIKER, { own: false, glow });
}

/** The striker at the moment of release: at full glow, wherever the recoil has
 *  put it, with a short trail back to the place on the base line it will end up.
 *  All in local units. */
export function paintCharged(
  g: CanvasRenderingContext2D,
  l: Layout,
  x: number,
  y: number,
  homeX: number,
  homeY: number
): void {
  const p = px(l, x, y);
  const home = px(l, homeX, homeY);
  if (Math.abs(p.x - home.x) > 1 || Math.abs(p.y - home.y) > 1) {
    g.strokeStyle = "rgba(229, 24, 46, 0.45)";
    g.lineWidth = Math.max(2, l.r * 0.02);
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(home.x, home.y);
    g.stroke();
    g.lineCap = "butt";
  }
  paintDisc(g, l, p.x, p.y, STRIKER_R, KIND_STRIKER, { own: false, glow: 1 });
}

/** How big a rectangle the live layer has to clear: the whole felt, plus the
 *  aim ring, which reaches beyond the base line. */
export function liveBounds(l: Layout): { x: number; y: number; w: number; h: number } {
  const m = l.r * (HALF + 0.16);
  return { x: l.cx - m, y: l.cy - m, w: m * 2, h: m * 2 };
}

/** Where a pointer is on the board, in LOCAL board units. */
export const toBoard = (l: Layout, cssX: number, cssY: number): { x: number; y: number } => ({
  x: (cssX - l.cx) / l.r,
  y: (l.cy - cssY) / l.r,
});

/** Is this point close enough to the striker to be a grab at it?
 *
 *  Deliberately a circle round the disc rather than the whole base-line band it
 *  used to be. A band that wide swallowed every attempt to aim at a coin lying
 *  near the shooter's own frame — the drag was read as "move the striker" and
 *  the aim never happened. A grab radius costs nothing and takes nothing. */
export function onStriker(x: number, y: number, t: number): boolean {
  const dx = x - BASE_HALF * t;
  const dy = y + BASE_Y;
  const reach = STRIKER_R * 1.9;
  return dx * dx + dy * dy < reach * reach;
}

/** Radius the discs occupy, for the runtime's hit tests. */
export const discRadius = (i: number): number => radiusOf(i);
