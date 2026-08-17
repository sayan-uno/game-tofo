// Drawing the board.
//
// Two layers, for one reason: a Ludo board is almost entirely still. The
// squares, the yards, the stars and the four triangles never move, so they are
// painted ONCE onto an off-screen canvas and blitted as a single image each
// frame; only the tokens, the dice and the highlights are drawn live. On a
// phone that is the difference between a few hundred path operations per frame
// and one.
//
// The other half of the same idea lives in the runtime: a turn-based game is
// idle most of the time, so a frame in which nothing has changed does no canvas
// work at all. Between them, a player waiting to be knocked out costs about as
// much battery as a still image.
//
// Everything here works in CSS pixels; the device-pixel ratio is handled once,
// by the transform the runtime sets on the context.
import {
  CENTRE,
  CENTRE_SIZE,
  GRID,
  HOME_RUN_CELLS,
  POS_HOME,
  POS_YARD,
  RING,
  START_INDEX,
  TOKENS_PER_PLAYER,
  cellOf,
  isSafeRing,
  ringIndexOf,
  yardRect,
  type Cell,
} from "../../shared/games/ludo/index";
import { INK, PALETTE } from "./theme";

export interface Layout {
  w: number;
  h: number;
  /** Board panel, in CSS pixels. */
  bx: number;
  by: number;
  size: number;
  /** One grid square. */
  cell: number;
  /** The dice, in the rail beside the board. */
  dx: number;
  dy: number;
  dsize: number;
}

/** Fit a square board between two rails, one of which holds the dice.
 *
 *  Every TOFO game is played in locked landscape (the platform's entry gate
 *  sees to it), so there is always room either side of a square — which is
 *  what the four player cards and the dice use. */
export function layoutFor(w: number, h: number): Layout {
  const pad = Math.max(8, Math.min(20, h * 0.04));
  // Leave enough beside the board for a dice and a name — but not so much that
  // a narrow window (a desktop browser in a tall shape, before anyone rotates
  // anything) is left with a postage stamp to play on.
  const minRail = Math.min(84, Math.max(48, w * 0.11));
  const size = Math.max(120, Math.min(h - pad * 2, w - pad * 2 - minRail * 2));
  const bx = Math.round((w - size) / 2);
  const by = Math.round((h - size) / 2);
  const rail = bx;
  const dsize = Math.max(40, Math.min(rail * 0.42, size * 0.17, 94));
  return {
    w,
    h,
    bx,
    by,
    size,
    cell: size / GRID,
    dx: Math.round(bx + size + (rail - dsize) / 2),
    dy: Math.round(by + size / 2 - dsize / 2),
    dsize,
  };
}

/** Centre of a grid cell, in CSS pixels. Cell coordinates may be fractional —
 *  a yard slot sits between squares — so this is a plain affine map. */
export const px = (l: Layout, c: Cell): { x: number; y: number } => ({
  x: l.bx + (c.col + 0.5) * l.cell,
  y: l.by + (c.row + 0.5) * l.cell,
});

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + h, rad);
  g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
}

/** One board square, drawn on its grid position. */
function square(g: CanvasRenderingContext2D, l: Layout, c: Cell, fill: string, edge: string = INK.cellEdge): void {
  const s = l.cell;
  const x = l.bx + c.col * s;
  const y = l.by + c.row * s;
  const inset = Math.max(0.5, s * 0.045);
  roundRect(g, x + inset, y + inset, s - inset * 2, s - inset * 2, s * 0.18);
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = edge;
  g.lineWidth = Math.max(0.6, s * 0.035);
  g.stroke();
}

/** The five-pointed star that marks a square nobody may be knocked off. */
function star(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string): void {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.44;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** The arrow on a start square, pointing the way that colour travels. */
function arrow(g: CanvasRenderingContext2D, l: Layout, corner: number, fill: string): void {
  const from = px(l, RING[START_INDEX[corner]]);
  const to = px(l, RING[(START_INDEX[corner] + 1) % RING.length]);
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  const r = l.cell * 0.26;
  g.save();
  g.translate(from.x, from.y);
  g.rotate(a);
  g.beginPath();
  g.moveTo(r, 0);
  g.lineTo(-r * 0.7, r * 0.72);
  g.lineTo(-r * 0.28, 0);
  g.lineTo(-r * 0.7, -r * 0.72);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.restore();
}

/** Everything that never moves. Redrawn only when the window changes size. */
export function paintBoard(g: CanvasRenderingContext2D, l: Layout, corners: readonly number[]): void {
  const s = l.cell;
  g.clearRect(0, 0, l.w, l.h);

  // The table the board sits on.
  g.fillStyle = INK.backdrop;
  g.fillRect(0, 0, l.w, l.h);

  // The board panel, with a hairline rim so it lifts off the table.
  roundRect(g, l.bx, l.by, l.size, l.size, s * 0.5);
  g.fillStyle = INK.board;
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = 1.5;
  g.stroke();

  // The four yards. Only the corners in play are coloured — a two-handed game
  // leaves the other two as empty panels rather than pretending at players.
  for (let corner = 0; corner < 4; corner++) {
    const p = PALETTE[corner];
    const inUse = corners.includes(corner);
    const y = yardRect(corner);
    const x0 = l.bx + y.col * s;
    const y0 = l.by + y.row * s;
    const side = y.size * s;
    const m = s * 0.34;
    roundRect(g, x0 + m, y0 + m, side - m * 2, side - m * 2, s * 0.8);
    g.fillStyle = inUse ? p.main : "#1b1418";
    g.fill();
    // The pale well the tokens stand in.
    const m2 = s * 1.05;
    roundRect(g, x0 + m2, y0 + m2, side - m2 * 2, side - m2 * 2, s * 0.55);
    g.fillStyle = inUse ? p.deep : "#141013";
    g.fill();
    if (!inUse) continue;
    // The four resting circles.
    for (let t = 0; t < TOKENS_PER_PLAYER; t++) {
      const c = px(l, cellOf(corner, POS_YARD, t));
      g.beginPath();
      g.arc(c.x, c.y, s * 0.36, 0, Math.PI * 2);
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.lineWidth = Math.max(1, s * 0.05);
      g.stroke();
    }
  }

  // The ring. A plain square unless it belongs to somebody: a start square is
  // its owner's colour, a safe square wears a star.
  const ownerOfStart = new Map<number, number>();
  for (let corner = 0; corner < 4; corner++) {
    if (corners.includes(corner)) ownerOfStart.set(START_INDEX[corner], corner);
  }
  for (let i = 0; i < RING.length; i++) {
    const owner = ownerOfStart.get(i);
    const c = RING[i];
    if (owner !== undefined) {
      square(g, l, c, PALETTE[owner].main, "rgba(255,255,255,0.28)");
      arrow(g, l, owner, "rgba(255,255,255,0.75)");
      continue;
    }
    square(g, l, c, INK.cell);
    if (isSafeRing(i)) {
      const p = px(l, c);
      star(g, p.x, p.y, s * 0.3, "rgba(255,255,255,0.30)");
    }
  }

  // The four home runs, each in its owner's colour and getting brighter as it
  // approaches the middle, so the last square before home reads as the prize.
  for (let corner = 0; corner < 4; corner++) {
    if (!corners.includes(corner)) continue;
    const p = PALETTE[corner];
    HOME_RUN_CELLS[corner].forEach((c, i) => {
      square(g, l, c, i === 4 ? p.light : p.main, "rgba(255,255,255,0.22)");
    });
  }

  // The centre: four triangles meeting in the middle, one per corner, pointing
  // back down each home run. This is the shape that says "Ludo" more than any
  // other, so it is drawn even for the corners nobody is playing.
  const half = (CENTRE_SIZE * s) / 2;
  const mx = l.bx + (CENTRE.col + 0.5) * s;
  const my = l.by + (CENTRE.row + 0.5) * s;
  const corners4: [number, number][] = [
    [mx - half, my - half],
    [mx + half, my - half],
    [mx + half, my + half],
    [mx - half, my + half],
  ];
  // Triangle i faces corner i's home run: left, top, right, bottom.
  const faces: [number, number][] = [
    [3, 0],
    [0, 1],
    [1, 2],
    [2, 3],
  ];
  for (let corner = 0; corner < 4; corner++) {
    const [a, b] = faces[corner];
    g.beginPath();
    g.moveTo(mx, my);
    g.lineTo(corners4[a][0], corners4[a][1]);
    g.lineTo(corners4[b][0], corners4[b][1]);
    g.closePath();
    g.fillStyle = corners.includes(corner) ? PALETTE[corner].main : "#1b1418";
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.lineWidth = 1;
    g.stroke();
  }
}

/** ---------------------------------------------------------------------------
 *  The live layer.
 * ------------------------------------------------------------------------- */

export interface TokenDraw {
  corner: number;
  /** Where it is, in CSS pixels. */
  x: number;
  y: number;
  /** 1 normally; larger while it is in the air or being pointed at. */
  scale: number;
  /** A white ring: this is one you may choose. */
  choosable: boolean;
  /** How many of this colour's tokens are stacked here, when more than one. */
  stack: number;
  /** Drawn above everything else — the one that is moving. */
  lifted: boolean;
}

export function paintToken(g: CanvasRenderingContext2D, l: Layout, t: TokenDraw, pulse: number): void {
  const p = PALETTE[t.corner];
  const r = l.cell * 0.34 * t.scale;
  // A shadow that grows with the lift, which is what sells the hop.
  g.beginPath();
  g.ellipse(t.x, t.y + r * 0.75, r * 0.85, r * 0.35, 0, 0, Math.PI * 2);
  g.fillStyle = `rgba(0,0,0,${t.lifted ? 0.5 : 0.35})`;
  g.fill();

  g.beginPath();
  g.arc(t.x, t.y - (t.lifted ? r * 0.28 : 0), r, 0, Math.PI * 2);
  g.fillStyle = p.main;
  g.fill();
  g.lineWidth = Math.max(1.2, r * 0.2);
  g.strokeStyle = p.light;
  g.stroke();

  // The bead of light that makes a flat circle look like a piece.
  g.beginPath();
  g.arc(t.x - r * 0.28, t.y - (t.lifted ? r * 0.28 : 0) - r * 0.3, r * 0.3, 0, Math.PI * 2);
  g.fillStyle = "rgba(255,255,255,0.5)";
  g.fill();

  if (t.choosable) {
    g.beginPath();
    g.arc(t.x, t.y, r * (1.32 + 0.13 * pulse), 0, Math.PI * 2);
    g.strokeStyle = INK.choose;
    g.lineWidth = Math.max(1.5, r * 0.16);
    g.globalAlpha = 0.55 + 0.45 * pulse;
    g.stroke();
    g.globalAlpha = 1;
  }
  if (t.stack > 1) {
    const br = r * 0.46;
    g.beginPath();
    g.arc(t.x + r * 0.72, t.y - r * 0.72, br, 0, Math.PI * 2);
    g.fillStyle = "#0b0507";
    g.fill();
    g.strokeStyle = p.light;
    g.lineWidth = 1.2;
    g.stroke();
    g.fillStyle = INK.text;
    g.font = `600 ${Math.round(br * 1.35)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(t.stack), t.x + r * 0.72, t.y - r * 0.7);
  }
}

/** The squares a chosen token could land on, marked so a player can see the
 *  consequence of a tap before making it. */
export function paintTarget(g: CanvasRenderingContext2D, l: Layout, c: Cell, capture: boolean, pulse: number): void {
  const p = px(l, c);
  const r = l.cell * 0.42;
  g.beginPath();
  g.arc(p.x, p.y, r * (0.86 + 0.08 * pulse), 0, Math.PI * 2);
  g.strokeStyle = capture ? "#ff5566" : "rgba(255,255,255,0.8)";
  g.lineWidth = Math.max(1.5, l.cell * 0.07);
  g.setLineDash([l.cell * 0.18, l.cell * 0.14]);
  g.stroke();
  g.setLineDash([]);
}

const PIPS: readonly (readonly [number, number][])[] = [
  [[0, 0]],
  [
    [-1, -1],
    [1, 1],
  ],
  [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
];

/** The dice. `face` 0 draws a blank one (nobody has rolled yet); `spin` is how
 *  far through a tumble it is, 0…1, and tips and turns it on the way. */
export function paintDie(
  g: CanvasRenderingContext2D,
  l: Layout,
  face: number,
  spin: number,
  glow: number,
  colour: string
): void {
  const s = l.dsize;
  const cx = l.dx + s / 2;
  const cy = l.dy + s / 2;
  g.save();
  g.translate(cx, cy);
  if (spin > 0) {
    g.rotate(spin * Math.PI * 4);
    const k = 1 + 0.12 * Math.sin(spin * Math.PI * 6);
    g.scale(k, k);
  }
  if (glow > 0) {
    g.shadowColor = colour;
    g.shadowBlur = s * 0.4 * glow;
  }
  roundRect(g, -s / 2, -s / 2, s, s, s * 0.22);
  g.fillStyle = INK.die;
  g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = colour;
  g.lineWidth = Math.max(2, s * 0.055);
  g.stroke();
  if (face >= 1 && face <= 6) {
    const step = s * 0.26;
    const r = s * 0.082;
    g.fillStyle = INK.diePip;
    for (const [ox, oy] of PIPS[face - 1]) {
      g.beginPath();
      g.arc(ox * step, oy * step, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

/** Squares a move crosses. Coming out of the yard is one leg however you count
 *  it: the token appears on its start square rather than walking six. */
export const hopLegs = (from: number, to: number): number => (from === POS_YARD ? 1 : Math.max(1, to - from));

/** The path a token walks, square by square, from one position to another.
 *  Used to interpolate a hop; it is geometry, so it lives with the painter. */
export function walkCells(corner: number, from: number, to: number, token: number): Cell[] {
  if (from === POS_YARD) return [cellOf(corner, POS_YARD, token), cellOf(corner, 0, token)];
  const out: Cell[] = [];
  for (let p = from; p <= Math.min(to, POS_HOME); p++) out.push(cellOf(corner, p, token));
  return out;
}

/** The square a token that has just been knocked out was standing on — which
 *  is, by definition, the square the token that knocked it out landed on. */
export function capturedFrom(corner: number, landedOn: number): Cell | null {
  const ring = ringIndexOf(corner, landedOn);
  return ring < 0 ? null : RING[ring];
}
