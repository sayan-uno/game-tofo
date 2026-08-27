// A weapon held in a character's hand.
//
// Its own module, loaded dynamically, for the same reason the auras are: a
// player carrying nothing never downloads a byte of this, and the lobby's
// first frame never waits on it.
//
// WHICH SPACE THE HAND IS IN — the one thing to get right in here
//
// A POSED skeleton and the drawn mesh share a space; a skeleton at REST does
// not, and the difference is a factor of 100.
//
// At rest these models put a 0.01 scale on the skeleton's root node, so the
// joint nodes measure 1.7 while the mesh draws at 170 (this is what
// CharacterRig.normalizeSize measures, and why it divides by that scale). But
// every shipped clip carries translation, rotation AND scale channels on all
// 24 joints, and a glTF channel REPLACES a node's local transform rather than
// composing with it — so the moment any clip plays, the 0.01 is gone and the
// joints stand in exactly the space the mesh is drawn in. That is why the
// auras can read bone world positions straight off and land on the wrist.
//
// So: read the joint as-is, apply no correction — and refuse to draw while the
// skeleton is still at rest, because there the same read is 100x off and would
// hang a hundred-metre sword over the lobby. Hence poseSanity() below.
//
// Everything about how the weapon sits IN that hand — pivot at the grip, blade
// along +Y, sized in metres — is baked into the GLB by buildProp.mjs, so this
// file holds one grip transform shared by every WEAPON rather than a table of
// per-weapon offsets. Per CHARACTER is a different matter: where the fist sits
// inside the hand joint varies by up to 7 cm between characters, so that one
// number comes from the catalog (see GRIP_OFFSET).
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { CHARACTER_HEIGHT, getCharacter, getWeapon } from "./assets";
import { loadContainer, type CharacterRig } from "./characterRig";

/** The hand that holds it. Both starter rigs and every Meshy export share the
 *  24-joint canonical skeleton, so this name is guaranteed present. */
const HAND_JOINT = "RightHand";

/** Where the handle lies in the fist, in the HAND joint's own frame.
 *
 *  THESE NUMBERS ARE PAIRED WITH THE CHARACTER MODELS. The characters carry a
 *  fist baked into the right hand by gripHand.mjs — a closed hand with a
 *  tunnel through it — plus 45 degrees of baked pronation that aims that
 *  tunnel. Put a character built WITHOUT that treatment on the other end of
 *  these constants and the sword goes back to floating past an open palm,
 *  which is the bug they exist to fix. The pairing is why the catalog's
 *  characters all had to move to /v2/ at once.
 *
 *  SOLVED, not guessed: read off the posed idle skeleton so the handle runs
 *  down the tunnel and the fist closes on the grip rather than the pommel.
 *
 *  This ROTATION really is shared by every character, because realign.mjs
 *  conforms the hand joint's AXES to the canonical rig — measured across ten
 *  characters they agree within a degree. The POSITION is not, and used to
 *  claim it was; see GRIP_OFFSET below for what that cost.
 *
 *  Why the blade ends up angled rather than standing up: a fist closes around
 *  an axis running ACROSS the palm, which is roughly perpendicular to the
 *  forearm. With the arm hanging at the character's side, that pins a truly
 *  gripped blade to within ~30 degrees of horizontal — no rotation here can
 *  raise it, and the vertical blade this replaced was only vertical because
 *  the hand was not really holding it. The pronation baked into the hand is
 *  what turns that angle away from across the chest and out past the hip.
 *
 *  SOLVED BACKWARDS, and that is the trick. Rather than picking a handle angle
 *  and seeing where the blade ended up, this was derived from the answer: put
 *  the arm where it should be (out at the side, wrist at its resting bend, palm
 *  turned in the way a hand actually holds a hilt), then ask what grip sends
 *  the blade along the reference art's line from there. One matrix inverse.
 *
 *  Solving it the other way round is what cost so many attempts. The grip
 *  fixes the angle between the blade and the palm, so choosing it first LOCKS
 *  those two together: every pose that aimed the blade correctly then rolled
 *  the palm to face outward, and every pose with the palm right threw the
 *  blade 50 degrees off. Neither is a stance problem, and no amount of arm
 *  tuning escapes it — the constraint is in this constant.
 *
 *  Which way the palm ends up facing is not free, and it is the stance that
 *  picks it: the grip rides the hand, so twisting the forearm turns the palm
 *  and drags the handle's angle with it. This constant is solved FROM the
 *  stance's twist, not chosen alongside it — change RightForeArm in the clip
 *  and this has to be re-derived or the blade leaves the reference line. */
const GRIP_ROTATION = new Quaternion(0.17658, -0.04534, -0.24455, 0.95234);
/** FALLBACK grip point, for a character whose catalog entry carries none.
 *
 *  This was a single constant shared by every character, and that was wrong.
 *  It is `male`'s value: it fits seraph, it is 2-3 cm out on female and
 *  zenith, and it was 6-7 cm out on every character generated later — which,
 *  on a hand about 10 cm across, is a weapon held BESIDE the fist with the
 *  fingers splayed past it, which is what shipped until someone looked. Meshy
 *  does not put the wrist joint in the same place relative to the hand twice,
 *  so where the fist is has to be measured per character (fistOffset.mjs) and
 *  carried in the catalog as `grip`.
 *
 *  The ROTATION below is still shared, and legitimately: realign.mjs conforms
 *  every character's hand joint AXES to the canonical rig, so only the
 *  position drifts. Measured across ten characters, the axes agree to within a
 *  degree — except one at 6-9 degrees, which is invisible.
 *
 *  Kept as the default so a character added without the measurement keeps its
 *  weapon rather than dropping it.
 *
 *  The centre of the fist's tunnel, in metres, in the hand joint's frame:
 *  across the palm, down toward the knuckles, and out to the palm side.
 *
 *  MEASURED off the shipped mesh, not derived. Every hand vertex is rigidly
 *  weighted to this joint, so the centroid of the curled finger mass is a
 *  constant that can be read straight out of the GLB — and that is the only
 *  trustworthy way to find it. The version this replaces was computed by
 *  rotating a pre-bake measurement through the hand's baked twist, and the
 *  rotation went the wrong way round: glTF is right-handed and Babylon is not,
 *  so the twist's sense flips across that boundary. The X came out positive
 *  instead of negative and the handle sat 6cm off the side of the fist,
 *  hovering past the knuckles instead of through them. */
const GRIP_OFFSET = new Vector3(-0.0314, 0.0973, 0.0347);

export interface HeldWeapon {
  dispose(): void;
}

/** Put a weapon in a character's hand, or return null when there is nothing to
 *  hold — no such weapon, no CDN, a failed download. Never fatal: an
 *  empty-handed character is a perfectly good character. */
export async function attachWeapon(
  weaponId: string,
  rig: CharacterRig,
  scene: Scene,
  /** Whose hand it is. Optional so a caller that does not know falls back to
   *  the default grip rather than failing — but pass it: without it the
   *  weapon lands in the wrong place on most characters. */
  characterId?: string
): Promise<HeldWeapon | null> {
  const weapon = getWeapon(weaponId);
  const hand = rig.node(HAND_JOINT);
  if (!weapon?.url || !hand) return null;

  let container;
  try {
    container = await loadContainer(weapon.url, scene);
  } catch (err) {
    console.warn(`[assets] weapon "${weaponId}" failed to load`, err);
    return null;
  }

  // Mount in the SAME frame the joint lives in — the glTF loader's own root
  // node, one level under rig.root — not under rig.root itself.
  //
  // That node carries a reflection, because glTF is right-handed and Babylon
  // is not. Measure the hand across that boundary and the matrix you decompose
  // contains it, which decompose() cannot express as a rotation: it hides it
  // in the scale and hands back a rotation that is flipped. The sword hangs
  // point-down and every attempt to fix it by rotating the grip fails, because
  // the error is a mirror and not an angle. Staying inside the frame keeps the
  // reflection on both sides, where it cancels — and it is the same frame the
  // character's own mesh is drawn in.
  //
  // WHICH AXIS that reflection is in is not what the node's scaling says, and
  // the difference matters to anything that bakes a rotation into a model's
  // vertices instead of setting it here (buildGun.mjs --tune). The loader
  // writes scaling (1, 1, -1) AND a 180-degree turn about Y; composed, those
  // are diag(-1, 1, 1) — a mirror in X. Conjugating a rotation by the scaling
  // alone flips the wrong two components, which bakes a weapon in pointing
  // backwards while every number involved looks right.
  let frame = hand;
  while (frame.parent && frame.parent !== rig.root) frame = frame.parent as TransformNode;

  const tag = `${weaponId}_${rig.root.name}`;
  // Tracks the hand; rebuilt every frame from the joint.
  const mount = new TransformNode(`weaponMount_${tag}`, scene);
  mount.parent = frame;
  mount.rotationQuaternion = Quaternion.Identity();
  // rig.root is scaled so the CHARACTER lands at CHARACTER_HEIGHT, which also
  // shrinks anything parented under it. Undoing that scale here is what lets
  // the weapon be authored in plain metres and stay 1 m long on a tall
  // character and a short one alike.
  const rootScale = rig.root.scaling.x || 1;
  mount.scaling.setAll(1 / rootScale);

  const prop = new TransformNode(`weaponProp_${tag}`, scene);
  prop.parent = mount;
  // This character's own fist, or the default when the catalog has none.
  const me = characterId ? getCharacter(characterId) : undefined;
  const grip = me?.grip;
  if (grip) prop.position.set(grip[0], grip[1], grip[2]);
  else prop.position.copyFrom(GRIP_OFFSET);

  // ...but ONE shared rotation, for every character. Hands do come out of
  // Meshy turned right over about their own finger axis — five of six in one
  // batch did — and it is tempting to correct that here, per character, by
  // turning the weapon by the same amount. That does put the handle back in
  // the palm, and it swings the BARREL through 180 degrees on the way, so the
  // character stands there aiming behind itself. The hand is what is wrong,
  // so the hand is what gets fixed: pronate.mjs turns it back in the bind
  // pose, before upload. Nothing about a character's hand belongs here.
  prop.rotationQuaternion = GRIP_ROTATION.clone();

  const entries = container.instantiateModelsToScene((n) => `${n}_${tag}`, false, { doNotInstantiate: false });
  for (const node of entries.rootNodes) node.parent = prop;
  // A prop file should carry no clips, but if one ever does, don't let it
  // drive anything behind our back.
  for (const group of entries.animationGroups) group.stop();

  // Scratch — the per-frame update allocates nothing.
  const inverseRoot = new Matrix();
  const local = new Matrix();
  const scale = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  // A hand on a posed skeleton is roughly a torso's worth away from the
  // character's own origin, in the same units the character is drawn in — call
  // it a tenth of its height at the very least, arms crossed and crouching. An
  // unposed skeleton reads a hundredth of that. Anything below the line is the
  // rest pose, so hold the weapon back rather than draw it in the wrong place.
  const posedFloor = (CHARACTER_HEIGHT / (rootScale || 1)) * 0.1;

  const follow = () => {
    frame.getWorldMatrix().invertToRef(inverseRoot);
    hand.getWorldMatrix().multiplyToRef(inverseRoot, local);
    if (!local.decompose(scale, rotation, position)) return;
    const posed = position.length() > posedFloor;
    if (prop.isEnabled() !== posed) prop.setEnabled(posed);
    if (!posed) return;
    mount.position.copyFrom(position);
    mount.rotationQuaternion!.copyFrom(rotation);
  };
  follow();
  const observer = scene.onBeforeRenderObservable.add(follow);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.onBeforeRenderObservable.remove(observer);
      entries.dispose();
      prop.dispose();
      mount.dispose();
    },
  };
}
