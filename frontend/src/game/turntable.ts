// How a character turns under a finger.
//
// One file so the lobby and the collection preview can never drift apart: a
// character that took a certain drag to turn round on the podium has to take
// the same drag on the locker stand, or the two screens feel like two games.
//
// Deliberately FREE of any Babylon import — this is the physics of a drag, not
// a scene graph. Owners read `angle` and apply it to whatever node they turn,
// which is what lets the lobby put it on a per-member spinner node and the
// preview put it straight on the model.

/** A full screen-width drag turns a character one and a half times round. */
const SPIN_PER_DRAG = Math.PI * 3;
/** Cap on the release glide, so a violent flick can't leave a character
 *  spinning like a top. */
const SPIN_MAX = 13;
/** e-folds per second of the glide — about 0.8 s from a hard flick to a stop. */
const GLIDE_DECAY = 6.5;
/** Below this the glide is over. Without a floor the exponential decay never
 *  reaches zero and the scene keeps writing a rotation nobody can see. */
const GLIDE_FLOOR = 0.05;
const TWO_PI = Math.PI * 2;

export class Turntable {
  /** Radians turned so far, wrapped. Owners apply this to a node. */
  angle = 0;
  private velocity = 0;
  /** Rotation applied since the last frame, used to measure release speed. */
  private pending = 0;
  private held = false;

  /** True while a glide is still running. Nothing to poll otherwise. */
  get moving(): boolean {
    return this.velocity !== 0;
  }

  /** Take hold. Grabbing a gliding character stops it dead — which is what a
   *  hand on a spinning turntable does. */
  grab() {
    this.held = true;
    this.velocity = 0;
    this.pending = 0;
  }

  /** Turn by a pointer that moved `dx` CSS pixels across a `width`-pixel
   *  surface, so the same swipe turns the same amount on a phone and on a
   *  desktop monitor.
   *
   *  The sign is NEGATIVE on purpose, and it is the whole of what makes this
   *  feel like a turntable rather than a lever. The face a finger lands on is
   *  the one nearest the camera; both scenes stand their characters at
   *  rotation.y = π, so that near face is at world -Z, and Babylon's
   *  left-handed +Y rotation carries a point at -Z towards -X — screen LEFT.
   *  Dragging right therefore has to DECREASE the angle for the surface under
   *  the finger to follow it. Getting this backwards is not subtle in the hand:
   *  the character turns away from the drag. */
  turn(dx: number, width: number) {
    const by = -(dx / Math.max(width, 1)) * SPIN_PER_DRAG;
    this.angle = (this.angle + by) % TWO_PI;
    this.pending += by;
  }

  /** Let go: whatever speed was measured becomes the glide. */
  release() {
    this.held = false;
    this.velocity = Math.max(-SPIN_MAX, Math.min(SPIN_MAX, this.velocity));
  }

  /** Face front again, for a fresh subject on the stand. */
  reset() {
    this.angle = 0;
    this.velocity = 0;
    this.pending = 0;
  }

  /** Advance one frame. Returns true when `angle` moved and the owner has to
   *  write it somewhere — false is the common case and costs nothing. */
  step(dt: number): boolean {
    if (this.held) {
      // Measure the release speed while the finger is still down, smoothed so
      // one stuttering frame can't turn a slow drag into a flick.
      this.velocity = this.velocity * 0.65 + (this.pending / Math.max(dt, 0.004)) * 0.35;
      this.pending = 0;
      return false; // the move handler already applied the angle
    }
    if (this.velocity === 0) return false;
    this.angle = (this.angle + this.velocity * dt) % TWO_PI;
    this.velocity *= Math.exp(-dt * GLIDE_DECAY);
    if (Math.abs(this.velocity) < GLIDE_FLOOR) this.velocity = 0;
    return true;
  }
}
