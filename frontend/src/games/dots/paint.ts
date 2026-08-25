// Drawing the grid.
//
// Two layers, and the split is the same one every 2D game here makes. The paper
// and the forty-nine dots never change, so they are painted ONCE onto their own
// canvas. The live canvas above carries the drawn lines, the filled boxes, the
// line the local player has chosen and whatever the other three are hovering
// over.
//
// The live layer redraws everything it owns rather than keeping track of what
// changed. That is a hundred and twenty path operations at the very end of a
// match and fewer for all of it, which is cheaper than the bookkeeping would be
// — and a game that is idle most of the time skips the frame entirely anyway
// (see the runtime's signature).
//
// UNLIKE THE OTHER BOARD GAMES, THE VIEW IS NOT ROTATED. A carrom player sits
// at an edge, so their edge has to be the near one; a dots player sits nowhere,
// and turning the grid for each of them would mean four people describing the
// same square with four different names — which is exactly what the chat is
// for. Everybody sees row 1 at the top.
//
// Everything here works in CSS pixels; the device-pixel ratio is handled once,
// by the transform the runtime sets on the context.
import {
  BOX_COUNT,
  DOTS,
  GRID,
  LINE_COUNT,
  boxCol,
  boxRow,
  lineEnds,
  type DotsState,
} from "../../shared/games/dots/index";
import { INK, PICK, SEATS } from "./theme";

export interface Layout {
  w: number;
  h: number;
  /** Top-left of the grid — the first DOT, not the paper. */
  gx: number;
  gy: number;
  /** One box, in pixels. */
  cell: number;
  /** Width of the rail either side, for the DOM chrome. */
  rail: number;
  /** Height reserved along the bottom for the control strip. */
  ctrl: number;
}

/** The wooden margin round the ruled area, as a fraction of a cell. */
const PAD = 0.55;

/** Fit the square grid between two rails, above the controls. */
export function layoutFor(w: number, h: number): Layout {
  const pad = Math.max(6, Math.min(16, h * 0.03));
  // Slimmer than carrom's strip: there is one button on it, not three controls.
  const ctrl = Math.round(Math.max(38, Math.min(52, h * 0.115)));
  const minRail = Math.min(96, Math.max(44, w * 0.115));
  const room = h - pad * 2 - ctrl;
  const span = Math.max(120, Math.min(room, w - pad * 2 - minRail * 2));
  // The span covers the dots AND the margin either side of them.
  const cell = span / (GRID + PAD * 2);
  const size = cell * GRID;
  const gx = Math.round((w - size) / 2);
  const gy = Math.round(pad + (room - size) / 2);
  return { w, h, gx, gy, cell, rail: Math.max(0, (w - span) / 2), ctrl };
}

/** Where a dot is. Columns run left to right, rows top to bottom, both from 0. */
export const dotPx = (l: Layout, col: number, row: number): { x: number; y: number } => ({
  x: l.gx + col * l.cell,
  y: l.gy + row * l.cell,
});

/** The two ends of a line, in pixels. */
export function lineSeg(l: Layout, line: number): { ax: number; ay: number; bx: number; by: number } {
  const e = lineEnds(line);
  const a = dotPx(l, e.col, e.row);
  return e.across
    ? { ax: a.x, ay: a.y, bx: a.x + l.cell, by: a.y }
    : { ax: a.x, ay: a.y, bx: a.x, by: a.y + l.cell };
}

/** The square a box occupies, inset a little so two neighbours never touch. */
export function boxRect(l: Layout, box: number): { x: number; y: number; s: number } {
  const inset = l.cell * 0.13;
  const p = dotPx(l, boxCol(box), boxRow(box));
  return { x: p.x + inset, y: p.y + inset, s: l.cell - inset * 2 };
}

/** The free line nearest a point, or -1 when the point is nowhere near one.
 *
 *  DISTANCE TO THE LINE, not a hit box on it. A line on a phone is two pixels
 *  wide and a finger is forty, so asking a player to touch one would make the
 *  game unplayable; asking which line they are CLOSEST to is the same question
 *  with an answer they can always give. The cap stops a stray touch out on the
 *  margin selecting the nearest edge of the board from an inch away. */
export function nearestFree(l: Layout, s: DotsState, px: number, py: number): number {
  let best = -1;
  let bestD = l.cell * 0.75;
  for (let line = 0; line < LINE_COUNT; line++) {
    if (s.line[line] >= 0) continue;
    const g = lineSeg(l, line);
    const dx = g.bx - g.ax;
    const dy = g.by - g.ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - g.ax) * dx + (py - g.ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = g.ax + dx * t - px;
    const cy = g.ay + dy * t - py;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (d < bestD) {
      bestD = d;
      best = line;
    }
  }
  return best;
}

/** ---------------------------------------------------------------------------
 *  The static layer: the paper and the dots.
 * ------------------------------------------------------------------------- */

export function paintGrid(g: CanvasRenderingContext2D, l: Layout): void {
  g.clearRect(0, 0, l.w, l.h);
  const pad = l.cell * PAD;
  const x = l.gx - pad;
  const y = l.gy - pad;
  const size = l.cell * GRID + pad * 2;

  const paper = g.createRadialGradient(x + size / 2, y + size / 2, l.cell, x + size / 2, y + size / 2, size * 0.8);
  paper.addColorStop(0, "#1e1520");
  paper.addColorStop(1, INK.paper);
  g.fillStyle = paper;
  const r = l.cell * 0.35;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + size, y, x + size, y + size, r);
  g.arcTo(x + size, y + size, x, y + size, r);
  g.arcTo(x, y + size, x, y, r);
  g.arcTo(x, y, x + size, y, r);
  g.closePath();
  g.fill();
  g.strokeStyle = INK.paperEdge;
  g.lineWidth = 1;
  g.stroke();

  // The dots themselves, and nothing else: an unplayed line drawn faintly all
  // over the grid turns eighty-four choices into a wall of texture. A free line
  // is shown one at a time, under the finger.
  const dr = Math.max(1.8, l.cell * 0.085);
  for (let row = 0; row < DOTS; row++) {
    for (let col = 0; col < DOTS; col++) {
      const p = dotPx(l, col, row);
      g.fillStyle = INK.dotEdge;
      g.beginPath();
      g.arc(p.x, p.y + 1, dr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK.dot;
      g.beginPath();
      g.arc(p.x, p.y, dr, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** ---------------------------------------------------------------------------
 *  The live layer.
 * ------------------------------------------------------------------------- */

export interface LiveDraw {
  /** How far through the drawing animation the last move is, 0…1. */
  drawing: number;
  /** How far through the fill each claimed box of the last move is, 0…1. */
  claiming: number[];
  /** The line the local player has chosen, or -1. */
  pick: number;
  /** Boxes that line would close. */
  picked: readonly number[];
  /** What each other seat is hovering over: seat → line. */
  hovers: ReadonlyMap<number, number>;
  /** 0…1, for the pulse on the chosen line. */
  pulse: number;
}

export function paintLive(g: CanvasRenderingContext2D, l: Layout, s: DotsState, d: LiveDraw): void {
  const pad = l.cell * PAD;
  g.clearRect(l.gx - pad, l.gy - pad, l.cell * GRID + pad * 2, l.cell * GRID + pad * 2);

  const last = s.phase === "draw" ? s.last : null;

  // ---- claimed boxes ---------------------------------------------------
  for (let box = 0; box < BOX_COUNT; box++) {
    const owner = s.box[box];
    if (owner < 0) continue;
    const filling = last ? last.boxes.indexOf(box) : -1;
    const u = filling >= 0 ? (d.claiming[filling] ?? 1) : 1;
    if (u <= 0) continue;
    paintBox(g, l, box, owner, u);
  }

  // ---- the boxes the chosen line would close ---------------------------
  for (const box of d.picked) {
    const rect = boxRect(l, box);
    g.fillStyle = PICK.fill;
    roundRect(g, rect.x, rect.y, rect.s, rect.s, l.cell * 0.12);
    g.fill();
  }

  // ---- drawn lines -----------------------------------------------------
  g.lineCap = "round";
  const lw = Math.max(2, l.cell * 0.11);
  for (let line = 0; line < LINE_COUNT; line++) {
    const owner = s.line[line];
    if (owner < 0) continue;
    const seg = lineSeg(l, line);
    // The last line grows out of the dot it started at, so a move is seen
    // rather than merely noticed.
    const u = last && last.line === line ? d.drawing : 1;
    if (u <= 0) continue;
    g.strokeStyle = SEATS[owner % SEATS.length].line;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(seg.ax, seg.ay);
    g.lineTo(seg.ax + (seg.bx - seg.ax) * u, seg.ay + (seg.by - seg.ay) * u);
    g.stroke();
  }

  // ---- what the others are thinking about ------------------------------
  for (const [seat, line] of d.hovers) {
    if (line < 0 || line >= LINE_COUNT || s.line[line] >= 0) continue;
    const seg = lineSeg(l, line);
    g.strokeStyle = SEATS[seat % SEATS.length].ghost;
    g.lineWidth = lw * 0.8;
    g.setLineDash([l.cell * 0.16, l.cell * 0.12]);
    g.beginPath();
    g.moveTo(seg.ax, seg.ay);
    g.lineTo(seg.bx, seg.by);
    g.stroke();
    g.setLineDash([]);
  }

  // ---- the line the local player has chosen -----------------------------
  if (d.pick >= 0 && d.pick < LINE_COUNT && s.line[d.pick] < 0) {
    const seg = lineSeg(l, d.pick);
    g.strokeStyle = PICK.glow;
    g.lineWidth = lw * (2.2 + 0.5 * d.pulse);
    g.beginPath();
    g.moveTo(seg.ax, seg.ay);
    g.lineTo(seg.bx, seg.by);
    g.stroke();
    g.strokeStyle = PICK.line;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(seg.ax, seg.ay);
    g.lineTo(seg.bx, seg.by);
    g.stroke();
  }
  g.lineCap = "butt";
}

/** One filled box, with its owner's initial in it.
 *
 *  The initial is not decoration. Four colours is one more than most people can
 *  hold at a glance, and colour-blindness makes red and green a coin toss — a
 *  letter answers "whose is that" without anybody having to remember. */
function paintBox(g: CanvasRenderingContext2D, l: Layout, box: number, owner: number, u: number): void {
  const seat = SEATS[owner % SEATS.length];
  const rect = boxRect(l, box);
  const grow = 0.55 + 0.45 * u;
  const s = rect.s * grow;
  const x = rect.x + (rect.s - s) / 2;
  const y = rect.y + (rect.s - s) / 2;
  g.globalAlpha = u;
  g.fillStyle = seat.main;
  roundRect(g, x, y, s, s, l.cell * 0.12);
  g.fill();
  // A darker core so a filled box reads as a tile rather than as a flat swatch.
  g.fillStyle = "rgba(0, 0, 0, 0.22)";
  roundRect(g, x + s * 0.14, y + s * 0.14, s * 0.72, s * 0.72, l.cell * 0.08);
  g.fill();
  g.fillStyle = seat.light;
  g.font = `700 ${Math.round(s * 0.5)}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(owner + 1), x + s / 2, y + s / 2 + s * 0.02);
  g.globalAlpha = 1;
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
