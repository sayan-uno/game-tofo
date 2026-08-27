// What a push on the stick MEANS, and where the camera goes while it is held.
//
// This is a few lines of arithmetic and it is the difference between turning
// that feels like every other third-person game on a phone and turning that
// feels wrong in a way players describe as "I can't explain it". It lives in
// shared/ rather than in the runtime for one reason: it is the sort of loop
// that has a stable state nobody notices when they write it, and the only way
// to know which stable state it has is to run it — which is what
// tools/checks/social-sim.ts does with these exact functions.
//
// THE TRAP, written down because it cost a round: read the stick in camera
// space every frame AND settle the camera in behind the player, and the two
// chase each other. The stick says "left of the camera", the player turns
// left, the camera swings left to get behind them, and the unmoved thumb now
// means left of THAT. A thumb held perfectly still walks in a circle, about
// one turn every two seconds. Each half is right on its own; together they
// spin.
import { angleDelta } from "./net.js";

/** How fast the camera settles behind a moving player, in radians a second.
 *  Slower than the character's own turn rate on purpose: the character snaps
 *  round and the camera catches up, which reads as the player leading. */
export const CAM_FOLLOW_RATE = 2.4;
/** How long after a deliberate look the camera is left alone — and the window
 *  in which the stick steers in camera space rather than world space. */
export const CAM_FOLLOW_HOLD_MS = 900;
/** How far the stick has to actually move before it counts as a new direction
 *  rather than as a thumb resting on it. About seven degrees: below the wobble
 *  of a thumb held still, above nothing. */
export const STICK_TURN = 0.12;

/** A stick being held: the angle it points at, and the WORLD direction that
 *  was taken to mean. Null between pushes. */
export interface Held {
  dir: number;
  want: number;
}

/** Where the player is trying to go.
 *
 *  Camera space at the moment the stick moves, world-locked while it is held —
 *  so pushing left turns you left ONCE and you keep going that way with the
 *  camera coming round behind you, instead of curving for ever. While a thumb
 *  is actually dragging the view, it is camera space throughout, because that
 *  is the other way a player steers and it must keep working.
 *
 *  @param push  the stick's own angle, `atan2(x, z)`, camera-relative
 *  @param yaw   where the camera is pointing
 *  @param steering  the player is aiming the view themselves right now
 *  @param held  what the last frame made of the same stick, or null
 */
export function stickWant(push: number, yaw: number, steering: boolean, held: Held | null): Held {
  if (steering || !held) return { dir: push, want: yaw + push };
  const rolled = angleDelta(held.dir, push);
  return { dir: push, want: Math.abs(rolled) > STICK_TURN ? held.want + rolled : held.want };
}

/** The camera easing in behind a moving player. Exponential rather than a
 *  fixed speed with a dead zone: a big error corrects briskly, a small one is
 *  left alone, which is what a dead zone is trying to approximate anyway. */
export function followYaw(yaw: number, heading: number, dt: number): number {
  return yaw + angleDelta(yaw, heading) * Math.min(1, dt * CAM_FOLLOW_RATE);
}
