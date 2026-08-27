// Turning a stream of samples back into a walk.
//
// Positions arrive a dozen or so times a second, unevenly, and have to be
// drawn sixty times a second, evenly. That conversion is the entire difference
// between a world that feels alive and one where everybody skates — and it is
// the one piece of this game that has to be identical in three places: the
// client drawing a live island, the console replaying a recorded one, and the
// self-check that proves the result is smooth. So it lives here rather than
// inside the renderer, and it knows nothing about Babylon.
//
// THE PROPERTY IT EXISTS TO HOLD: if a sender walks at a steady speed, a
// receiver draws them at a steady speed — however unevenly the samples were
// produced, sent, or delivered. Everything below is in service of that, and
// `check:social` measures it rather than taking anyone's word for it.
import { ANIM_IDLE, angleDelta, type Anim, type Pose } from "./net.js";
import { EXTRAPOLATE_MS, INTERP_DELAY_MS } from "./rules.js";

interface Sample {
  t: number;
  x: number;
  z: number;
  ry: number;
  anim: Anim;
}

/** Six samples is under half a kilobyte and covers about a third of a second
 *  of jitter at the rates this game runs at. Three — what this shipped with —
 *  is barely two intervals, so one late packet emptied the window. */
const KEEP = 6;

/** How long an error takes to be walked off, and the largest one worth walking
 *  off at all.
 *
 *  A connection that stalls for half a second and then delivers everything at
 *  once leaves the drawn character somewhere the sender is no longer standing,
 *  and the true position has to be got back to. Jumping there is a teleport;
 *  gliding there over a fifth of a second is a character breaking step, which
 *  is what a person watching reads as "they lagged for a moment" rather than
 *  as a broken game. Past FIX_MAX_M it is not a correction any more — it is
 *  somebody arriving, or being pushed out of a wall — and gliding across the
 *  island would be far worse than appearing. */
const FIX_MS = 200;
const FIX_MAX_M = 6;

export class PoseTrack {
  private buffer: Sample[] = [];
  /** The error being walked off, in metres, and when it was taken on. */
  private errX = 0;
  private errZ = 0;
  private errAt = -1e9;
  /** The previous frame's SOLVED position — where the samples said they were,
   *  before any correction was added. A jump is detected against this and not
   *  against what was drawn, or the residual of one correction would be read
   *  as the start of the next and it would never converge. */
  private solvedX = 0;
  private solvedZ = 0;
  /** …and the previous frame's DRAWN position, which is what a correction has
   *  to be continuous with. */
  private drewX = 0;
  private drewZ = 0;
  private drew = false;
  private lastSolvedAt = -1e9;
  /** True once anything has arrived. Somebody who has not turned up yet must
   *  not be drawn standing on their spawn. */
  arrived = false;
  readonly pose: Pose = { x: 0, z: 0, ry: 0, anim: ANIM_IDLE };

  /** One sample, at the moment it was TRUE — not the moment it arrived, and
   *  not the moment the message carrying it was built. Getting that wrong is
   *  what makes a remote player stutter; see PoseReport in net.ts. */
  push(t: number, x: number, z: number, ry: number, anim: Anim): void {
    const b = this.buffer;
    if (b.length && t <= b[b.length - 1].t) return; // out of order, already stale
    b.push({ t, x, z, ry, anim });
    while (b.length > KEEP) b.shift();
    this.arrived = true;
  }

  get samples(): number {
    return this.buffer.length;
  }

  /** Where they are at `renderAt`, drawn `delay` behind so there are normally
   *  two samples to sit between. Returns a SHARED object — this runs once per
   *  character per frame and must not allocate.
   *
   *  Three cases, and each of them was a visible fault before it was handled:
   *
   *  BEFORE the oldest — they have just appeared — hold at it.
   *  BETWEEN two — the ordinary case — interpolate.
   *  PAST the newest — a packet is late, or they stopped and the keep-alive
   *  has not come round — carry on at the speed they were going, for up to
   *  EXTRAPOLATE_MS, then hold. Freezing instead turns one late packet into a
   *  visible stop-and-jump. */
  sample(renderAt: number, delay: number = INTERP_DELAY_MS): Pose {
    const b = this.buffer;
    const p = this.pose;
    if (b.length === 0) return p;
    this.solve(renderAt, delay);
    // Walk off whatever error the last correction took on. Linear rather than
    // exponential so it actually finishes: an exponential tail never quite
    // arrives, and "never quite arrives" on a position is a character standing
    // a few centimetres from where they are.
    if (this.errX !== 0 || this.errZ !== 0) {
      const k = Math.max(0, 1 - (renderAt - this.errAt) / FIX_MS);
      if (k <= 0) {
        this.errX = 0;
        this.errZ = 0;
      } else {
        p.x += this.errX * k;
        p.z += this.errZ * k;
      }
    }
    this.drewX = p.x;
    this.drewZ = p.z;
    this.drew = true;
    return p;
  }

  /** Take on an error rather than jumping, when the newly solved position is
   *  further from the previous solved one than a running player could have
   *  got. The error taken on is measured against what was DRAWN, so the drawn
   *  path stays continuous while the solved path is what decides there was a
   *  jump at all. */
  private note(renderAt: number, dt: number): void {
    const p = this.pose;
    if (!this.drew) {
      this.solvedX = p.x;
      this.solvedZ = p.z;
      return;
    }
    const jx = p.x - this.solvedX;
    const jz = p.z - this.solvedZ;
    const jump2 = jx * jx + jz * jz;
    this.solvedX = p.x;
    this.solvedZ = p.z;
    // 8 m/s is comfortably above a run, so anything under this is ordinary
    // motion and not an error at all.
    const could = 0.008 * Math.max(16, dt);
    if (jump2 <= could * could || jump2 > FIX_MAX_M * FIX_MAX_M) {
      if (jump2 > FIX_MAX_M * FIX_MAX_M) {
        // Too far to glide: somebody arriving, or being put back on the right
        // side of a wall. Appear there rather than skate across the park.
        this.errX = 0;
        this.errZ = 0;
      }
      return;
    }
    this.errX = this.drewX - p.x;
    this.errZ = this.drewZ - p.z;
    this.errAt = renderAt;
  }

  private solve(renderAt: number, delay: number): void {
    const b = this.buffer;
    const p = this.pose;
    const before = this.lastSolvedAt;
    this.lastSolvedAt = renderAt;
    const target = renderAt - delay;
    const first = b[0];
    const last = b[b.length - 1];
    if (b.length === 1 || target <= first.t) {
      p.x = first.x;
      p.z = first.z;
      p.ry = first.ry;
      p.anim = first.anim;
      this.note(renderAt, renderAt - before);
      return;
    }
    if (target >= last.t) {
      const prev = b[b.length - 2];
      const span = last.t - prev.t;
      // Standing still is not something to extrapolate — it would drift them
      // off the spot they are standing on.
      const ahead = span > 0 && last.anim !== ANIM_IDLE ? Math.min(EXTRAPOLATE_MS, target - last.t) : 0;
      const k = ahead / span;
      p.x = last.x + (last.x - prev.x) * k;
      p.z = last.z + (last.z - prev.z) * k;
      p.ry = last.ry;
      p.anim = last.anim;
      this.note(renderAt, renderAt - before);
      return;
    }
    let a = first;
    let c = last;
    for (let i = 1; i < b.length; i++) {
      if (b[i].t >= target) {
        a = b[i - 1];
        c = b[i];
        break;
      }
    }
    const span = c.t - a.t;
    if (span <= 0) {
      p.x = c.x;
      p.z = c.z;
      p.ry = c.ry;
      p.anim = c.anim;
      this.note(renderAt, renderAt - before);
      return;
    }
    const k = (target - a.t) / span;
    p.x = a.x + (c.x - a.x) * k;
    p.z = a.z + (c.z - a.z) * k;
    p.ry = a.ry + angleDelta(a.ry, c.ry) * k;
    // The pose the SEGMENT is being walked in, not a halfway vote: a step that
    // starts a walk is a walking step from its first frame.
    p.anim = c.anim === ANIM_IDLE ? a.anim : c.anim;
    this.note(renderAt, renderAt - before);
  }

  reset(): void {
    this.buffer.length = 0;
    this.arrived = false;
    this.errX = 0;
    this.errZ = 0;
    this.drew = false;
    this.lastSolvedAt = -1e9;
  }
}
