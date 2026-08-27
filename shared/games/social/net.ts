// What travels while people are walking around.
//
// Movement here is NOT an input in the platform's sense: it is not logged, not
// replayed and not authoritative. A social island has no result, so there is
// nothing for a deterministic simulation to protect, and the input log a match
// keeps would be four hundred thousand entries by the time the island closed.
//
// So positions ride their own channel, and the shape below is what is on it:
// integers, quantised, batched by the server into ONE message per tick for the
// whole island rather than relayed player to player. Twenty people at ten
// reports a second is 200 messages in and 200 out; relaying each one to each
// other client would be 3,800.

/** What a character is doing. Ordered so a bigger number is faster. */
export type Anim = 0 | 1 | 2;
export const ANIM_IDLE: Anim = 0;
export const ANIM_WALK: Anim = 1;
export const ANIM_RUN: Anim = 2;

/** Metres per unit on the wire — 1/32 m, about three centimetres, which is
 *  finer than anybody can see at walking pace and keeps every coordinate a
 *  small integer. */
const POS_Q = 32;
/** Facings per turn. 1024 is a third of a degree. */
const ROT_Q = 1024;
const TAU = Math.PI * 2;

export interface Pose {
  x: number;
  z: number;
  /** Radians, 0…2π. */
  ry: number;
  anim: Anim;
}

/** What a client sends about itself: five small integers, no name, no seat —
 *  the server knows who the socket belongs to and will not take its word for
 *  anything else.
 *
 *  The fifth is `dt`: milliseconds since this client's PREVIOUS report, which
 *  is to say how much walking this one contains. It is the difference between
 *  a remote player who moves smoothly and one who stutters, and the reason is
 *  worth writing down because it is not obvious:
 *
 *  A bot's position is computed at the instant the snapshot is built, so the
 *  snapshot's timestamp describes it exactly and two consecutive samples lie
 *  exactly on a smooth curve. A PERSON's position is whatever they last
 *  reported — true at some earlier moment, and an earlier moment that varies
 *  by up to a full report interval depending on when their packet happened to
 *  land relative to the snapshot tick. Stamp that with the snapshot's own
 *  clock and every entry is a lie whose SIZE changes every tick: the client
 *  then interpolates two samples labelled a hundred milliseconds apart that
 *  actually contain anywhere between nothing and two hundred milliseconds of
 *  walking, so the character alternately stalls and sprints.
 *
 *  That is the whole of "bots are smooth and people are not". Carrying the
 *  spacing the sender measured lets the receiver space them the same way. */
export type PoseReport = [x: number, z: number, ry: number, anim: number, dt?: number];

/** What the server sends about everybody: the same four, prefixed by the seat
 *  the roster gave them and suffixed by how OLD the pose is — see PoseReport.
 *  Seats rather than uids because a uid is ten bytes and a seat is one, twenty
 *  times a snapshot, fifteen times a second. */
export type PoseWire = [seat: number, x: number, z: number, ry: number, anim: number, age: number];

export interface Snapshot {
  /** Server clock when this was taken, so a client can place it on its own
   *  timeline rather than assuming it arrived the instant it was sent. */
  t: number;
  p: PoseWire[];
}

/** The longest a pose may be claimed to be. Past this the sender has gone
 *  quiet and there is nothing to be smooth about. */
export const MAX_POSE_AGE_MS = 1000;

/** …and how far the other way a sender's timeline may run.
 *
 *  Not zero, which is the obvious answer and is wrong. A pose is always true
 *  BEFORE it arrives, so it looks as though the timeline should never be
 *  allowed past the present — but latency does not only get worse. When it
 *  IMPROVES, a burst of reports lands together carrying half a second of real
 *  walking, and pinning their timeline to "now" compresses that half second
 *  into the tick that received it. On the far end the character sprints.
 *  Letting the timeline run a little ahead instead leaves the compression to
 *  the receiver's own smoothing window, which is what that window is for.
 *  Measured: it took the worst case from 4,000% of walking speed to under
 *  eighty. */
export const MAX_POSE_AHEAD_MS = 250;

export function packReport(p: Pose, dt = 0): PoseReport {
  return [
    Math.round(p.x * POS_Q),
    Math.round(p.z * POS_Q),
    Math.round(wrapAngle(p.ry) * (ROT_Q / TAU)),
    p.anim,
    Math.max(0, Math.min(2000, Math.round(dt))),
  ];
}

/** Read a report, refusing anything that is not four sane integers. Returns
 *  null rather than throwing: this is on the hot path and a malformed packet
 *  is a thing to drop, not an exception to unwind. */
export interface ReadReport extends Pose {
  /** Milliseconds of walking this report contains — see PoseReport. Zero when
   *  the sender did not say, which is what an older client looks like. */
  dt: number;
}

export function readReport(raw: unknown): ReadReport | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [x, z, r, a, d] = raw as unknown[];
  if (typeof x !== "number" || typeof z !== "number" || typeof r !== "number" || typeof a !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r) || !Number.isFinite(a)) return null;
  const anim = a === 1 ? 1 : a === 2 ? 2 : 0;
  const dt = typeof d === "number" && Number.isFinite(d) ? Math.max(0, Math.min(2000, d)) : 0;
  return { x: x / POS_Q, z: z / POS_Q, ry: wrapAngle(r / (ROT_Q / TAU)), anim, dt };
}

export function packWire(seat: number, p: Pose, age: number): PoseWire {
  const [x, z, r, a] = packReport(p);
  return [seat, x, z, r, a, Math.max(0, Math.min(MAX_POSE_AGE_MS, Math.round(age)))];
}

export function readWire(w: PoseWire): { seat: number; pose: Pose; age: number } | null {
  if (!Array.isArray(w) || w.length < 5) return null;
  const pose = readReport([w[1], w[2], w[3], w[4]]);
  if (!pose || typeof w[0] !== "number") return null;
  const age = typeof w[5] === "number" && Number.isFinite(w[5]) ? Math.max(0, Math.min(MAX_POSE_AGE_MS, w[5])) : 0;
  return { seat: w[0], pose, age };
}

export function wrapAngle(a: number): number {
  const t = a % TAU;
  return t < 0 ? t + TAU : t;
}

/** Shortest signed turn from `a` to `b`, in radians. Used to interpolate a
 *  facing without spinning the long way round when it crosses zero. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// ---------------------------------------------------------------------------
// The replay track
//
// A drop-in world has no inputs, which is the whole reason its live channel
// exists — so on the face of it there is nothing to archive and nothing for
// the console's replay studio to play. That would be a real loss: watching a
// match back is how a report gets answered, and "what was this player doing on
// that island" is exactly the same question.
//
// So the island writes a TRACK: where everybody was, a couple of times a
// second, encoded as ordinary {tick, kind} inputs. That is not a dodge around
// the platform's format — it is the format. The studio already builds its tape
// from inputs, seeds a runtime with the ones before the playhead and hands
// over the rest as time reaches them; a track shaped like inputs plays in it
// with no change to the studio at all, tape marks and per-player readouts
// included.
//
// It is coarser than the live channel on purpose. Ten a second is what a
// player's eye needs; two a second, and only when something changed, is what a
// moderator needs, and it is a fifth of the bytes.
// ---------------------------------------------------------------------------

/** Wire units per metre in the TRACK. Coarser than the live channel: an eighth
 *  of a metre is finer than anybody can be judged on and keeps every number in
 *  the string short. */
const TRACK_Q = 8;
const TRACK_ROT = 64;

/** How often a track samples somebody who is moving, and how often it says
 *  "still here" about somebody who is not. */
export const TRACK_MIN_MS = 500;
export const TRACK_IDLE_MS = 3000;
/** Movement below this is not worth a sample. */
export const TRACK_MOVE_M = 0.3;

/** The kind string for one pose in a track. */
export function packTrack(p: Pose): string {
  return `p${Math.round(p.x * TRACK_Q)},${Math.round(p.z * TRACK_Q)},${Math.round(
    (wrapAngle(p.ry) * TRACK_ROT) / TAU
  )},${p.anim}`;
}

/** …and its opposite. Null for anything that is not a pose, which is how the
 *  studio's other kinds (a departure, say) fall through to their own handler. */
export function readTrack(kind: string): Pose | null {
  if (typeof kind !== "string" || kind.charCodeAt(0) !== 112 /* p */) return null;
  const parts = kind.slice(1).split(",");
  if (parts.length !== 4) return null;
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  const r = Number(parts[2]);
  const a = Number(parts[3]);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r) || !Number.isFinite(a)) return null;
  return {
    x: x / TRACK_Q,
    z: z / TRACK_Q,
    ry: wrapAngle((r * TAU) / TRACK_ROT),
    anim: a === 1 ? 1 : a === 2 ? 2 : 0,
  };
}

/** Somebody walked out. Its own kind rather than a flag on a pose, because a
 *  departure has a MOMENT and the studio plays moments. */
export const TRACK_LEFT = "x";
