// The map in the corner, and the big one behind it.
//
// An island a hundred and fifty metres across is bigger than it looks from
// inside, and the two questions everybody asks in one — where am I, and where
// has my friend got to — cannot be answered by looking around. So: a dial in
// the corner that turns with you, and a tap to open the whole island.
//
// COST, because this runs beside twenty characters and it would be very easy
// for a map to be the most expensive thing on screen:
//
//   * The island is drawn ONCE, into an offscreen canvas, at load. It never
//     changes — it is a constant in shared/games/social/map.ts.
//   * A frame is then ONE rotated drawImage of that canvas plus a handful of
//     small arcs. No paths are rebuilt, no gradients recreated, nothing
//     allocated.
//   * And it repaints twelve times a second, not sixty. A dot on a map moves
//     two pixels a second at walking pace; nobody has ever seen the other
//     forty-eight frames.
//
// BOTH ARE NORTH-UP, and the arrow turns instead of the map. The island has
// four avenues and a ring path, so it has a shape worth learning — and a map
// that spins takes that away: "the bandstand is north-west" stops meaning
// anything the moment north moves. A fixed map plus a turning arrow carries
// exactly the same information and none of the disorientation, and it is what
// lets the dial and the full map be the same picture at two scales.
import {
  AVENUE_OUT,
  BEACH_IN,
  LANDMARKS,
  PLAZA_R,
  RING_R,
  WALK_R,
  islandProps,
  mapArrow,
  placeOf,
  type PropKind,
} from "../../shared/games/social/index";

/** Pixels per metre in the offscreen island. Generous enough that the big map
 *  is sharp and the dial is downscaled, which is the cheap direction. */
const SRC_PPM = 3;
const SRC_R = Math.round((WALK_R + 8) * SRC_PPM);
const SRC_SIZE = SRC_R * 2;

/** How much island the corner dial shows, as a radius in metres. */
const DIAL_METRES = 52;
/** …and how often it repaints. */
const EVERY_MS = 80;

const SEA = "#1d6285";
const SAND = "#d9c79a";
const GRASS = "#4f8f4a";
const PAVING = "#cfc7b4";

/** What each prop is worth on a map. Anything not here is not drawn — a map
 *  of every bush is a green smear, and the point of the thing is the paths and
 *  the landmarks. */
const DOT: Partial<Record<PropKind, { r: number; c: string }>> = {
  tree: { r: 1.7, c: "#2f6b3a" },
  pine: { r: 1.5, c: "#27563a" },
  palm: { r: 1.5, c: "#3d7f4a" },
  rock: { r: 1.0, c: "#8a8a90" },
  bench: { r: 0.8, c: "#8a6a3a" },
  picnic: { r: 1.2, c: "#8a6a3a" },
  kiosk: { r: 2.2, c: "#c25a3c" },
  fountain: { r: 3.4, c: "#5f9fc4" },
  gazebo: { r: 3.2, c: "#c8a05a" },
  statue: { r: 1.6, c: "#b9b9c4" },
  arch: { r: 1.6, c: "#a08b62" },
};

let island: HTMLCanvasElement | null = null;

/** The island, drawn once. Everything after this is a blit. */
function source(): HTMLCanvasElement {
  if (island) return island;
  const c = document.createElement("canvas");
  c.width = SRC_SIZE;
  c.height = SRC_SIZE;
  const g = c.getContext("2d")!;
  const px = (m: number) => SRC_R + m * SRC_PPM;
  const len = (m: number) => m * SRC_PPM;

  g.fillStyle = SEA;
  g.fillRect(0, 0, SRC_SIZE, SRC_SIZE);
  const disc = (r: number, fill: string) => {
    g.beginPath();
    g.arc(SRC_R, SRC_R, len(r), 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };
  disc(WALK_R + 3, SAND);
  disc(BEACH_IN, GRASS);

  // The paths, which are what a map is actually read for.
  g.strokeStyle = PAVING;
  g.lineCap = "round";
  g.lineWidth = len(4.6);
  g.beginPath();
  g.arc(SRC_R, SRC_R, len(RING_R), 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = len(5.2);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    g.beginPath();
    g.moveTo(px(dx * (PLAZA_R - 1)), px(dz * (PLAZA_R - 1)));
    g.lineTo(px(dx * AVENUE_OUT), px(dz * AVENUE_OUT));
    g.stroke();
  }
  disc(PLAZA_R + 0.8, PAVING);

  for (const p of islandProps()) {
    const d = DOT[p.k];
    if (!d) continue;
    g.beginPath();
    g.arc(px(p.x), px(p.z), len(d.r * p.s), 0, Math.PI * 2);
    g.fillStyle = d.c;
    g.fill();
  }
  island = c;
  return c;
}

export interface MapPerson {
  uid: string;
  name: string;
  x: number;
  z: number;
  /** Which way they are facing — drawn as a spur off their dot, so you can
   *  see at a glance which way somebody is heading rather than only where
   *  they were when you last looked. */
  ry: number;
  friend: boolean;
  /** Their number in YOUR group, 1-based, or 0 for everybody else. A squad is
   *  read by number on a map; names are too long and there are twenty of
   *  them. */
  squad: number;
  /** Inside your twenty metres — the ones who can hear you. */
  near: boolean;
}

/** One colour per seat in the group, in the order the server numbers them. A
 *  squad reads by COLOUR at a glance and by number when you look — which is
 *  why every game that draws teammates on a map does both, and why these are
 *  not all the same yellow as the marker. */
const SQUAD_COLOURS = ["#3fa9ff", "#4ade80", "#ff9f3f", "#c58cff"];

/** A spot somebody in your group has marked. */
export interface MapPin {
  x: number;
  z: number;
  /** Whose it is — theirs is drawn the same, it is the group's marker. */
  mine: boolean;
}

/** Everything both views draw on top of the island. */
function marks(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  ppm: number,
  rot: number,
  me: { x: number; z: number; ry: number },
  people: MapPerson[],
  labels: boolean,
  arrow: number,
  pin: MapPin | null
): void {
  const to = (x: number, z: number): [number, number] => {
    const dx = (x - me.x) * ppm;
    const dz = (z - me.z) * ppm;
    const s = Math.sin(rot);
    const c = Math.cos(rot);
    return [cx + dx * c - dz * s, cy + dx * s + dz * c];
  };

  if (labels) {
    g.font = '700 12px system-ui, sans-serif';
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    // Stroked first, then filled: a white name on a green field is unreadable
    // without something behind it, and a halo costs nothing.
    g.lineJoin = "round";
    g.lineWidth = 3;
    g.strokeStyle = "rgba(6,10,6,0.85)";
    for (const l of LANDMARKS) {
      if (!l.onMap) continue;
      const [lx, ly] = to(l.x, l.z);
      g.strokeText(l.name, lx, ly - 8);
    }
    g.fillStyle = "#ffffff";
    for (const l of LANDMARKS) {
      if (!l.onMap) continue;
      const [lx, ly] = to(l.x, l.z);
      g.fillText(l.name, lx, ly - 8);
      // A small mark ON the spot, so the name has something to point at.
      g.beginPath();
      g.arc(lx, ly, 2.5, 0, Math.PI * 2);
      g.fillStyle = "rgba(255,255,255,0.9)";
      g.fill();
      g.fillStyle = "#ffffff";
    }
  }

  // THE ROUTE, under everything: a straight line from you to the marker, so
  // "which way is it" is answered by looking rather than by working it out.
  if (pin) {
    const [px, py] = to(pin.x, pin.z);
    const [mx, my] = to(me.x, me.z);
    g.save();
    g.beginPath();
    g.moveTo(mx, my);
    g.lineTo(px, py);
    // Cased: a thin yellow dash crossing a paved avenue and a landmark name is
    // invisible exactly where somebody is looking for it. Dark line first,
    // dashes on top.
    g.lineWidth = 4.5;
    g.strokeStyle = "rgba(8, 10, 14, 0.55)";
    g.stroke();
    g.setLineDash([6, 5]);
    g.lineWidth = 2.5;
    g.strokeStyle = "#ffd23f";
    g.stroke();
    g.restore();
    // The marker itself: a teardrop is fussy at this size, a ringed dot is not.
    g.beginPath();
    g.arc(px, py, 6, 0, Math.PI * 2);
    g.fillStyle = "rgba(255, 210, 63, 0.35)";
    g.fill();
    g.beginPath();
    g.arc(px, py, 3.5, 0, Math.PI * 2);
    g.fillStyle = "#ffd23f";
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(0,0,0,0.6)";
    g.stroke();
    // HOW FAR, on the big map. "Two hundred metres away" is half of what a
    // marker is for, and it is one number nobody has to pace out.
    if (labels) {
      const away = `${Math.round(Math.hypot(pin.x - me.x, pin.z - me.z))} m`;
      g.font = '700 11px system-ui, sans-serif';
      g.textAlign = "center";
      g.lineJoin = "round";
      g.lineWidth = 3;
      g.strokeStyle = "rgba(6,10,6,0.85)";
      g.strokeText(away, px, py - 10);
      g.fillStyle = "#ffd23f";
      g.fillText(away, px, py - 10);
    }
  }

  for (const p of people) {
    const [x, y] = to(p.x, p.z);
    const r = p.squad > 0 ? 7 : p.friend ? 5 : 3;
    const colour =
      p.squad > 0
        ? SQUAD_COLOURS[(p.squad - 1) % SQUAD_COLOURS.length]
        : p.friend
          ? "#4ade80"
          : p.near
            ? "#ff8d99"
            : "rgba(255,255,255,0.72)";
    // WHICH WAY THEY ARE GOING, as a spur off the dot. Drawn first so the dot
    // sits on top of its root and the spur reads as coming out from under it.
    if (p.squad > 0 || p.friend) {
      const a = rot + p.ry;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.sin(a) * (r + 7), y + Math.cos(a) * (r + 7));
      g.lineWidth = 2.5;
      g.lineCap = "round";
      g.strokeStyle = colour;
      g.stroke();
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = colour;
    g.fill();
    if (p.squad > 0 || p.friend) {
      g.lineWidth = 1.5;
      g.strokeStyle = "rgba(0,0,0,0.6)";
      g.stroke();
    }
    // A squad member is a NUMBER, which is how a squad is read on a map — a
    // name is too long and there may be twenty of them on screen.
    if (p.squad > 0) {
      g.font = '700 9px system-ui, sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#08121a";
      g.fillText(String(p.squad), x, y + 0.5);
      g.textBaseline = "alphabetic";
    }
    if (labels && p.friend && p.squad === 0) {
      g.font = '700 11px system-ui, sans-serif';
      g.textAlign = "center";
      g.fillStyle = "#4ade80";
      g.fillText(p.name, x, y - 9);
    }
  }

  // You, last, so nothing is drawn over you. An arrow rather than a dot,
  // because which way you are pointing is half of what a map is for.
  g.save();
  g.translate(cx, cy);
  g.rotate(arrow);
  g.beginPath();
  g.moveTo(0, -7);
  g.lineTo(5, 6);
  g.lineTo(0, 3);
  g.lineTo(-5, 6);
  g.closePath();
  g.fillStyle = "#e5182e";
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = "#fff";
  g.stroke();
  g.restore();
}

export class MiniMap {
  private g: CanvasRenderingContext2D;
  private nextAt = 0;
  private size = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext("2d")!;
    source(); // built once, on the way in, not on the first frame
  }

  /** One repaint, if one is due. Everything is in world units; the rotation is
   *  the player's own facing, so "up" is where they are looking. */
  draw(now: number, me: { x: number; z: number; ry: number }, people: MapPerson[], pin: MapPin | null): void {
    if (now < this.nextAt) return;
    this.nextAt = now + EVERY_MS;
    const box = this.canvas.clientWidth;
    if (box <= 0) return;
    if (this.size !== box) {
      // Backing store at device resolution, laid out in CSS pixels.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(box * dpr);
      this.canvas.height = Math.round(box * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.size = box;
    }
    const g = this.g;
    const r = box / 2;
    const ppm = r / DIAL_METRES;
    g.save();
    g.clearRect(0, 0, box, box);
    g.beginPath();
    g.arc(r, r, r, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = SEA;
    g.fillRect(0, 0, box, box);

    // ONE blit of the island, HELD STILL.
    //
    // Turning the map under a fixed arrow is the other tradition, and it reads
    // worse here: the island has four avenues and a ring, and a player who has
    // learnt that the bandstand is north-west loses that the moment the map
    // starts spinning. Holding it still keeps the island a place with a shape,
    // and the arrow says which way you are facing — which is the same
    // information and none of the disorientation.
    g.save();
    g.translate(r, r);
    g.scale(ppm / SRC_PPM, ppm / SRC_PPM);
    g.translate(-me.x * SRC_PPM, -me.z * SRC_PPM);
    g.drawImage(source(), -SRC_R, -SRC_R);
    g.restore();

    // Same formula as the big map, because they are now the same map at two
    // scales. See mapArrow.
    marks(g, r, r, ppm, 0, me, people, false, mapArrow(me.ry), pin);
    g.restore();

    // North is simply up now, and says so on the rim.
    g.font = '700 10px system-ui, sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.fillText("N", r, 9);
  }
}

/** The whole island, opened from the dial. Drawn once per open — a full map is
 *  read, not watched, and repainting it sixty times a second to move a dot two
 *  pixels would be the most expensive thing on the screen. */
export function drawFullMap(
  canvas: HTMLCanvasElement,
  me: { x: number; z: number; ry: number },
  people: MapPerson[],
  pin: MapPin | null
): void {
  const g = canvas.getContext("2d")!;
  const box = canvas.clientWidth;
  if (box <= 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(box * dpr);
  canvas.height = Math.round(box * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = box / 2;
  const ppm = r / (WALK_R + 6);
  g.clearRect(0, 0, box, box);
  // North UP on the big map. A dial you glance at should agree with what is in
  // front of you; a map you stop and read should agree with the island, or
  // "meet me on the north beach" means nothing.
  g.save();
  g.translate(r, r);
  g.scale(ppm / SRC_PPM, ppm / SRC_PPM);
  g.drawImage(source(), -SRC_R, -SRC_R);
  g.restore();
  // North up, island centred: `to()` inside marks subtracts the player's own
  // position, so the origin it is given has to add it back.
  //
  marks(g, r + me.x * ppm, r + me.z * ppm, ppm, 0, me, people, true, mapArrow(me.ry), pin);
}

/** A tap on the full map, turned back into a spot on the island. The inverse
 *  of what drawFullMap does, and it has to stay that way — a pin that lands
 *  somewhere other than where the thumb went is worse than no pin. */
export function fullMapToWorld(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; z: number } {
  const box = canvas.getBoundingClientRect();
  const r = box.width / 2;
  const ppm = r / (WALK_R + 6);
  return { x: (clientX - box.left - r) / ppm, z: (clientY - box.top - r) / ppm };
}

/** Where somebody is, in words. */
export const whereIs = (x: number, z: number): string => placeOf(x, z);
