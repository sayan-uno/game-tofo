// Drawing the table.
//
// Two layers, for carrom's reason. The rail, the cloth, the six pockets, the
// diamonds, the head string and the spots never change, so they are painted
// ONCE onto their own canvas and left there. The live canvas above carries
// sixteen balls, an aim line, a ghost ball and a cue — and while a shot is
// rolling it is repainted sixty times a second, which is exactly why nothing
// static may be underneath it.
//
// THE TABLE IS NOT ROTATED PER SEAT. Carrom rotates, because a carrom board has
// four sides and your own base line has to be the near one for an aim gesture
// to mean anything. Pool has no seats: everybody stands where the shot is, both
// players use the whole table, and the cue ball may be anywhere on it. Turning
// the table for one player would turn it away from the other and buy nothing —
// so the head rail is on the left for everybody, exactly as in every diagram of
// a pool table ever printed, and both sides are looking at the same picture.
//
// Everything here works in CSS pixels; the device-pixel ratio is handled once,
// by the transform the runtime sets on the context.
import {
  BALLS,
  BALL_R,
  CUE,
  HALF_X,
  HALF_Y,
  HEAD_STRING,
  FOOT_SPOT,
  POCKETS,
  POCKET_R,
  type PoolState,
} from "../../shared/games/pool/index";
import { AIM, INK, ballPaint } from "./theme";

/** The rail, as a fraction of half the table's WIDTH (the short way). Wide
 *  enough to swallow a pocket whole: a pocket is drawn centred on the cushion,
 *  so anything narrower leaves black lobes sticking out into the room. */
export const RAIL = 0.19;

export interface Layout {
  w: number;
  h: number;
  /** Centre of the cloth, in CSS pixels. */
  cx: number;
  cy: number;
  /** Pixels per table unit — half the table's LENGTH. */
  r: number;
  /** Space left either side of the table, for the DOM chrome. */
  side: number;
  /** Height reserved along the bottom for the control strip. */
  ctrl: number;
}

/** Fit a two-by-one table above the controls.
 *
 *  Every TOFO game is played in locked landscape, and a pool table is the one
 *  board here whose proportions actually want that — two units by one is very
 *  nearly a phone on its side, so the table can be big.
 *
 *  THE STRIP AT THE BOTTOM IS NOT OPTIONAL. Carrom paid for that lesson in
 *  full: aim, weight and placement on one drag means the aim cannot be adjusted
 *  without recharging the shot, and there is no moment in which to change your
 *  mind. A smaller table you can aim beats a larger one you cannot — and pool
 *  needs the aim finer than carrom ever did, because a quarter of a degree is
 *  the difference between a pot and a safety. */
export function layoutFor(w: number, h: number): Layout {
  const pad = Math.max(6, Math.min(14, h * 0.025));
  const ctrl = Math.round(Math.max(46, Math.min(66, h * 0.15)));
  // Room for the seat cards along the top. Pool's cards are a strip rather than
  // carrom's two columns, because the table is wide and there is nothing to
  // spare at the sides.
  const head = Math.round(Math.max(34, Math.min(52, h * 0.11)));
  const room = Math.max(60, h - pad * 2 - ctrl - head);
  // COUNT THE UNITS ONCE. `r` is pixels per table unit, and the cloth is TWO
  // units wide by ONE tall — not two by two — so the width divides by two and
  // the height by one. Getting that wrong is not a crash and not a stretch: the
  // proportions stay perfect and the whole table is simply drawn at half the
  // size it could be, with a band of empty black above and below it that reads
  // as deliberate.
  //
  // `outer` is the rail, as a multiple of r, on EACH side — RAIL is measured
  // against half the table's width and `paintTable` draws it at 1.25× that.
  const outer = RAIL * 0.5 * 1.25;
  const byWidth = (w - pad * 2) / (2 + outer * 2);
  const byHeight = room / (1 + outer * 2);
  const r = Math.max(60, Math.min(byWidth, byHeight));
  const cx = Math.round(w / 2);
  const cy = Math.round(pad + head + room / 2);
  const halfW = r * (1 + outer);
  return { w, h, cx, cy, r, side: Math.max(0, cx - halfW), ctrl };
}

/** Table units → CSS pixels. Table +y is DOWN the screen here, unlike carrom:
 *  the table is not rotated per seat, so there is no reason to flip it, and not
 *  flipping keeps the shared table's diagram and the screen the same way up. */
export const px = (l: Layout, x: number, y: number): { x: number; y: number } => ({
  x: l.cx + x * l.r,
  y: l.cy + y * l.r,
});

/** CSS pixels → table units. */
export const toTable = (l: Layout, cssX: number, cssY: number): { x: number; y: number } => ({
  x: (cssX - l.cx) / l.r,
  y: (cssY - l.cy) / l.r,
});

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

export function paintTable(g: CanvasRenderingContext2D, l: Layout): void {
  g.clearRect(0, 0, l.w, l.h);
  const R = l.r;
  const hx = HALF_X * R;
  const hy = HALF_Y * R;
  const rail = RAIL * R * 0.5;

  // ---- the rail ----------------------------------------------------------
  g.save();
  g.translate(l.cx, l.cy);
  const outer = rail * 1.25;
  g.fillStyle = INK.rail;
  roundRect(g, -hx - outer, -hy - outer, (hx + outer) * 2, (hy + outer) * 2, outer * 0.9);
  g.fill();
  // A single lit edge along the top of the rail — the lamp, not a border.
  g.strokeStyle = INK.railEdge;
  g.globalAlpha = 0.5;
  g.lineWidth = Math.max(1, R * 0.006);
  roundRect(g, -hx - outer, -hy - outer, (hx + outer) * 2, (hy + outer) * 2, outer * 0.9);
  g.stroke();
  g.globalAlpha = 1;
  g.fillStyle = INK.railInner;
  roundRect(g, -hx - rail, -hy - rail, (hx + rail) * 2, (hy + rail) * 2, rail * 0.7);
  g.fill();

  // ---- the cloth ---------------------------------------------------------
  const cloth = g.createLinearGradient(0, -hy, 0, hy);
  cloth.addColorStop(0, INK.cloth);
  cloth.addColorStop(1, INK.clothDeep);
  g.fillStyle = cloth;
  g.fillRect(-hx, -hy, hx * 2, hy * 2);
  // The lamp overhead.
  const lamp = g.createRadialGradient(0, -hy * 0.15, R * 0.05, 0, 0, hx * 1.05);
  lamp.addColorStop(0, INK.clothLit);
  lamp.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = lamp;
  g.fillRect(-hx, -hy, hx * 2, hy * 2);

  // ---- the markings ------------------------------------------------------
  g.strokeStyle = INK.line;
  g.lineWidth = Math.max(1, R * 0.004);
  g.beginPath();
  g.moveTo(HEAD_STRING * R, -hy);
  g.lineTo(HEAD_STRING * R, hy);
  g.stroke();
  g.fillStyle = INK.spot;
  for (const sx of [FOOT_SPOT, HEAD_STRING]) {
    g.beginPath();
    g.arc(sx * R, 0, Math.max(1.2, R * 0.008), 0, Math.PI * 2);
    g.fill();
  }

  // ---- the diamonds ------------------------------------------------------
  //
  // Three per half along the long rails and one either side of the middle of
  // the short ones, which is where they are on a real table. Decoration, and
  // the thing that makes a green rectangle read as a pool table.
  g.fillStyle = INK.diamond;
  const dot = Math.max(1.2, R * 0.0075);
  const mid = (hy + rail) / 2 + hy / 2;
  for (let k = -3; k <= 3; k++) {
    if (k === 0) continue;
    const x = (k / 4) * hx;
    for (const y of [-mid, mid]) {
      g.beginPath();
      g.moveTo(x, y - dot);
      g.lineTo(x + dot, y);
      g.lineTo(x, y + dot);
      g.lineTo(x - dot, y);
      g.closePath();
      g.fill();
    }
  }
  const midX = (hx + rail) / 2 + hx / 2;
  for (const x of [-midX, midX]) {
    for (const y of [-hy / 2, hy / 2]) {
      g.beginPath();
      g.moveTo(x, y - dot);
      g.lineTo(x + dot, y);
      g.lineTo(x, y + dot);
      g.lineTo(x - dot, y);
      g.closePath();
      g.fill();
    }
  }

  // ---- the pockets -------------------------------------------------------
  for (const p of POCKETS) {
    const cx = p.x * R;
    const cy = p.y * R;
    const pr = POCKET_R * R;
    g.fillStyle = INK.pocketRim;
    g.beginPath();
    g.arc(cx, cy, pr * 1.22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = INK.pocket;
    g.beginPath();
    g.arc(cx, cy, pr, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = INK.pocketLip;
    g.lineWidth = Math.max(1, R * 0.004);
    g.beginPath();
    g.arc(cx, cy, pr, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
}

/** ---------------------------------------------------------------------------
 *  The live layer.
 * ------------------------------------------------------------------------- */

/** The rectangle the live canvas has to clear — the cloth and a margin for a
 *  cue that overhangs it. */
export function liveBounds(l: Layout): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: 0, w: l.w, h: l.h };
}

export function paintBall(
  g: CanvasRenderingContext2D,
  l: Layout,
  ball: number,
  x: number,
  y: number,
  alpha = 1,
  scale = 1
): void {
  const p = px(l, x, y);
  const r = BALL_R * l.r * scale;
  const skin = ballPaint(ball);
  g.save();
  g.globalAlpha = alpha;
  // The shadow it casts on the cloth, offset the way the lamp says.
  g.fillStyle = "rgba(0,0,0,0.35)";
  g.beginPath();
  g.ellipse(p.x + r * 0.16, p.y + r * 0.24, r * 0.98, r * 0.78, 0, 0, Math.PI * 2);
  g.fill();

  const body = g.createRadialGradient(p.x - r * 0.34, p.y - r * 0.4, r * 0.1, p.x, p.y, r * 1.08);
  body.addColorStop(0, skin.light);
  body.addColorStop(0.52, skin.main);
  body.addColorStop(1, skin.deep);

  if (skin.striped) {
    // A striped ball is a WHITE ball with a band across its middle. Drawn that
    // way round rather than as a coloured ball with white caps, because it is
    // the white that has to survive being three millimetres wide on a phone.
    const white = g.createRadialGradient(p.x - r * 0.34, p.y - r * 0.4, r * 0.1, p.x, p.y, r * 1.08);
    white.addColorStop(0, "#ffffff");
    white.addColorStop(0.55, "#efece1");
    white.addColorStop(1, "#a8a396");
    g.fillStyle = white;
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fill();
    g.save();
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = body;
    g.fillRect(p.x - r, p.y - r * 0.56, r * 2, r * 1.12);
    g.restore();
  } else {
    g.fillStyle = body;
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fill();
  }

  // The number, in its white disc. The cue ball has neither.
  if (ball !== CUE) {
    g.fillStyle = "#f7f5ec";
    g.beginPath();
    g.arc(p.x, p.y, r * 0.46, 0, Math.PI * 2);
    g.fill();
    const size = r * 0.68;
    if (size >= 5) {
      g.fillStyle = skin.ink;
      g.font = `700 ${size.toFixed(1)}px "Archivo Black", system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(ball), p.x, p.y + size * 0.06);
    }
  }
  // The specular highlight, last and over everything.
  g.fillStyle = "rgba(255,255,255,0.5)";
  g.beginPath();
  g.ellipse(p.x - r * 0.36, p.y - r * 0.42, r * 0.26, r * 0.19, -0.6, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** Every ball still on the table. The cue ball is drawn last so that it is
 *  never hidden under one of the fifteen. */
export function paintBalls(g: CanvasRenderingContext2D, l: Layout, s: PoolState): void {
  for (let i = 1; i < BALLS; i++) {
    if (!s.alive[i]) continue;
    paintBall(g, l, i, s.x[i], s.y[i]);
  }
  if (s.alive[CUE]) paintBall(g, l, CUE, s.x[CUE], s.y[CUE]);
}

export interface AimDraw {
  from: { x: number; y: number };
  dir: { x: number; y: number };
  power: number;
  /** Where the cue ball first touches something, and what. */
  hit: { x: number; y: number; ball: number };
  /** Where the ball it touches will set off, as a unit vector. Only drawn when
   *  something is actually struck. */
  throwDir: { x: number; y: number } | null;
  /** Somebody else's aim rather than our own. */
  theirs?: boolean;
  /** A thumb is on the glass right now. */
  live?: boolean;
  /** Where the cue is in its swing: 1 addressed, above 1 drawn back, 0 at the
   *  ball. Left out while somebody is still choosing, which is the same
   *  picture as a player standing at the table with the cue held back. */
  draw?: number;
  /** Fades the lines but not the stick — the stroke's last few frames, where
   *  the aim has been decided and the swing is the only thing left to watch. */
  fade?: number;
}

/** ---------------------------------------------------------------------------
 *  The power ring — carrom's, deliberately.
 *
 *  The backswing already says how hard the shot will be, and says it in the
 *  language of the game itself. This says the same thing as a NUMBER you can
 *  read in one glance without waiting for the swing, which is what a person
 *  watching from the other side of the table actually needs — and a player who
 *  has met it once in carrom has already learned it here.
 * ------------------------------------------------------------------------- */
function paintPowerRing(
  g: CanvasRenderingContext2D,
  l: Layout,
  at: { x: number; y: number },
  power: number,
  theirs: boolean,
  alpha: number
): void {
  const r = BALL_R * l.r;
  const pr = r * 2.3;
  const p = power < 0 ? 0 : power > 1 ? 1 : power;
  g.save();
  g.globalAlpha = alpha;
  g.lineCap = "round";
  g.strokeStyle = AIM.powerTrack;
  g.lineWidth = Math.max(2, r * 0.3);
  g.beginPath();
  g.arc(at.x, at.y, pr, Math.PI * 0.75, Math.PI * 2.25);
  g.stroke();
  if (p > 0) {
    g.strokeStyle = theirs ? AIM.powerThem : AIM.power;
    g.beginPath();
    g.arc(at.x, at.y, pr, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * p);
    g.stroke();
  }
  g.restore();
}

/** The aim: a line to the contact point, a ghost ball on it, and the line the
 *  object ball will take.
 *
 *  THE GHOST BALL IS THE WHOLE GAME. Pool is aimed by picturing where the cue
 *  ball has to BE at the moment of contact — one diameter back from the object
 *  ball along the line to the pocket — and every player learns to see it. Not
 *  drawing it would make the game a guess on a phone, where a degree is two
 *  pixels of thumb. */
export function paintAim(g: CanvasRenderingContext2D, l: Layout, a: AimDraw): void {
  const from = px(l, a.from.x, a.from.y);
  const to = px(l, a.hit.x, a.hit.y);
  const r = BALL_R * l.r;
  const fade = a.fade === undefined ? 1 : a.fade;
  g.save();
  g.globalAlpha = fade;
  g.lineCap = "round";
  // The line from the cue ball to where it will arrive.
  g.strokeStyle = a.theirs ? AIM.lineThem : a.live ? AIM.lineHot : AIM.line;
  g.lineWidth = Math.max(1.2, r * 0.16);
  g.setLineDash([r * 0.5, r * 0.5]);
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.stroke();
  g.setLineDash([]);

  // The ghost: where the cue ball will be when it touches.
  g.strokeStyle = a.theirs ? AIM.lineThem : AIM.ghost;
  g.lineWidth = Math.max(1, r * 0.13);
  g.beginPath();
  g.arc(to.x, to.y, r, 0, Math.PI * 2);
  g.stroke();

  // And which way what it hits will go.
  if (a.throwDir && a.hit.ball > 0) {
    const len = l.r * 0.26;
    g.strokeStyle = AIM.throw;
    g.lineWidth = Math.max(1.2, r * 0.15);
    g.beginPath();
    g.moveTo(to.x + a.throwDir.x * r, to.y + a.throwDir.y * r);
    g.lineTo(to.x + a.throwDir.x * (r + len), to.y + a.throwDir.y * (r + len));
    g.stroke();
  }
  g.restore();

  // How hard, as a number rather than as a distance. Drawn under the stick so
  // the two never fight for the same pixels.
  paintPowerRing(g, l, from, a.power, a.theirs === true, fade);

  // The cue stick, behind the ball, pulled back by the weight of the shot.
  paintCue(g, l, a.from, a.dir, a.power, a.theirs === true, a.draw);
}

/** The stick. Drawn BEHIND the cue ball along the aim, pulled back in
 *  proportion to the power — which is the one part of the picture that tells a
 *  watcher how hard the shot is going to be without reading a bar.
 *
 *  `draw` is where the cue is in its swing, and it is the whole of the stroke:
 *  1 is addressed (the distance the weight alone puts it at), above 1 is drawn
 *  back further, 0 is the tip on the ball and below 0 is the follow-through.
 *  Every one of those positions is still scaled by the POWER, so a soft shot
 *  makes a small movement and a break makes a huge one — the distance and the
 *  motion say the same thing twice.
 *
 *  `alpha`, when given, overrides the usual mine/theirs weighting: the
 *  follow-through fades out and nothing else does. */
export function paintCue(
  g: CanvasRenderingContext2D,
  l: Layout,
  from: { x: number; y: number },
  dir: { x: number; y: number },
  power: number,
  theirs: boolean,
  draw = 1,
  alpha?: number
): void {
  const r = BALL_R * l.r;
  // At draw = 1 this is exactly the old resting position; at 0 the tip is on
  // the ball, which is the one place the two numbers have to agree.
  const gap = r * (1.05 + (0.45 + power * 5.5) * draw);
  const len = l.r * 0.62;
  const a = px(l, from.x, from.y);
  const bx = a.x - dir.x * gap;
  const by = a.y - dir.y * gap;
  const cx = bx - dir.x * len;
  const cy = by - dir.y * len;
  g.save();
  g.globalAlpha = alpha === undefined ? (theirs ? 0.55 : 0.95) : alpha;
  g.lineCap = "round";
  // The shaft, tapering by being drawn twice.
  g.strokeStyle = AIM.cue;
  g.lineWidth = Math.max(2, r * 0.38);
  g.beginPath();
  g.moveTo(bx, by);
  g.lineTo(cx, cy);
  g.stroke();
  g.strokeStyle = AIM.cueWrap;
  g.lineWidth = Math.max(2, r * 0.42);
  g.beginPath();
  g.moveTo(cx + dir.x * len * 0.12, cy + dir.y * len * 0.12);
  g.lineTo(cx, cy);
  g.stroke();
  // The tip.
  g.strokeStyle = AIM.cueTip;
  g.lineWidth = Math.max(2, r * 0.34);
  g.beginPath();
  g.moveTo(bx, by);
  g.lineTo(bx - dir.x * r * 0.34, by - dir.y * r * 0.34);
  g.stroke();
  g.restore();
}

/** ---------------------------------------------------------------------------
 *  The swing, as a shape.
 *
 *  `u` runs 0…1 across the stroke, and the SIMULATION is what times it — so all
 *  this decides is where in its travel the cue is at that point, and every table
 *  draws the identical shape over the identical ticks.
 *
 *  BACK FIRST, slowing as it rises; then through, gathering pace all the way to
 *  the ball. The asymmetry is the whole trick: a cue that went back and came in
 *  at one speed reads as a lever, and a cue that accelerates into the ball reads
 *  as a person hitting it.
 * ------------------------------------------------------------------------- */
const SWING_BACK = 0.58;
/** How much further back than the addressed position the backswing lifts. */
const SWING_LIFT = 0.5;

export function strokeDraw(u: number): number {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  if (t < SWING_BACK) {
    const v = t / SWING_BACK;
    return 1 + SWING_LIFT * (1 - (1 - v) * (1 - v));
  }
  const v = (t - SWING_BACK) / (1 - SWING_BACK);
  return (1 + SWING_LIFT) * (1 - v * v);
}

/** The crack: a ring thrown off the spot the cue ball left, for a quarter of a
 *  second after contact. Pure punctuation — and the size of it is the power
 *  again, which is what makes a hard shot LOOK hard on a phone too small to
 *  show the difference in the roll. */
export function paintImpact(
  g: CanvasRenderingContext2D,
  l: Layout,
  at: { x: number; y: number },
  power: number,
  u: number
): void {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  const r = BALL_R * l.r;
  const a = px(l, at.x, at.y);
  g.save();
  g.globalAlpha = (1 - t) * (0.3 + power * 0.55);
  g.strokeStyle = AIM.impact;
  g.lineWidth = Math.max(1.5, r * 0.4 * (1 - t));
  g.beginPath();
  g.arc(a.x, a.y, r * (1 + (1.1 + power * 2.4) * t), 0, Math.PI * 2);
  g.stroke();
  g.restore();
}

/** The band of cloth behind the head string, lit while a ball in hand may only
 *  be put down in it. */
export function paintKitchen(g: CanvasRenderingContext2D, l: Layout): void {
  const a = px(l, -HALF_X, -HALF_Y);
  const b = px(l, HEAD_STRING, HALF_Y);
  g.save();
  g.fillStyle = INK.kitchen;
  g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.strokeStyle = INK.kitchenEdge;
  g.lineWidth = Math.max(1, l.r * 0.005);
  g.beginPath();
  g.moveTo(b.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
  g.restore();
}

/** How big the grab circle round the cue ball is, in CSS pixels. A fingertip is
 *  eight millimetres across and a ball drawn on a phone is four, so the reach
 *  has to be a SCREEN measurement rather than a table one: at the size this
 *  table is drawn on a laptop, two and a half ball-radii is eleven pixels, and
 *  eleven pixels is not a thumb. */
const GRAB_PX = 22;

/** Is this point on the cue ball? */
export function onCue(l: Layout, s: PoolState, x: number, y: number): boolean {
  if (!s.alive[CUE]) return false;
  const dx = x - s.x[CUE];
  const dy = y - s.y[CUE];
  // Whichever is larger: a comfortable thumb, or a couple of ball-widths on a
  // table drawn very small.
  const reach = Math.max(BALL_R * 2.2, l.r > 0 ? GRAB_PX / l.r : BALL_R * 2.2);
  return dx * dx + dy * dy <= reach * reach;
}

/** A ghost of the cue ball where it is about to be put down. */
export function paintGhostCue(g: CanvasRenderingContext2D, l: Layout, x: number, y: number, glow: number): void {
  const p = px(l, x, y);
  const r = BALL_R * l.r;
  g.save();
  g.globalAlpha = 0.35 + 0.45 * glow;
  g.strokeStyle = "#ffffff";
  g.lineWidth = Math.max(1.2, r * 0.18);
  g.setLineDash([r * 0.55, r * 0.45]);
  g.beginPath();
  g.arc(p.x, p.y, r * 1.08, 0, Math.PI * 2);
  g.stroke();
  g.restore();
}
