// The crystal aura — "Celestial Omen", worn by Seraph.
//
// The second legendary effect. Zenith's is warm amber embers off the forearm
// guards and belt (legendaryAura.ts); this one is violet crystal.
//
// WHAT IS AND IS NOT IN HERE
//
// The garment's own glow — the blue prism at the chest, the matching one at
// the small of the back, the wrist crystals, the crystal work on the pauldrons
// and boots, and the shimmer along the coat tails — is NOT this file. It is an
// emissive mask baked into the character's own material, so the DRESS glows
// rather than a light being parked in front of it. An earlier cut hung glowing
// spheres at those points and it read exactly as what it was: balls stuck on
// the coat. The mask is derived from the albedo, so every part glows in the
// colour it already is, and it costs no draw call at all — the lobby's
// GlowLayer blooms it for free.
//
// So what remains here is only what the mesh cannot do itself:
//
//   * the halo above the crown, which is not on the body at all
//   * crystal shards shed from the wrist guards and boot spurs, which have to
//     exist in world space so they hang in the air as the limb moves on
//   * the pulse running down the coat's gold veins, which is a per-pixel
//     function of position on the body and so lives in the shader (veinFlow.ts)
//
// Cost:
//
//   * ONE particle system for all four sources. startPositionFunction picks
//     between them per particle, so four emission points stay one update loop
//     and one draw call.
//   * The two halo rings are one mesh plus one instance — hardware instancing
//     batches them into a single draw call, and per-instance scaling still
//     lets the inner ring read smaller.
//
// That puts Seraph at +2 draw calls and ~80 live particles. The vein pulse
// adds no draw call at all — it is a few instructions inside the character's
// own material.
//
// Emission points are read from the bone transform nodes each frame rather
// than parented to them: a bone here carries the skeleton root's 0.01 scale
// (see normalizeSize in characterRig.ts), so anything parented to one would be
// authored at 1/100 size. Reading world positions side-steps that, and leaving
// the shards in world space is what makes them trail behind a moving hand
// instead of riding along with it.

import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { CharacterRig } from "./characterRig";
import { attachVeinFlow } from "./veinFlow";

/** The violet the shards burn at. Kept off the red side of violet: an even
 *  mix of red and blue blows out to hot magenta under additive blending plus
 *  the lobby's GlowLayer, which reads as bubblegum rather than crystal. */
const AMETHYST = new Color3(0.46, 0.3, 1.0);
/** The halo. Pale violet-white, NOT gold: the outfit already carries gold on
 *  every surface, and a gold ring both disappears into it and collides with
 *  Zenith's amber effect, which this one has to read as distinct from. */
const HALO_VIOLET = new Color3(0.76, 0.7, 1.0);
/** Pale crystal-white the shards turn as they rise. */
const LILAC = new Color4(0.88, 0.82, 1.0, 0.62);

const CAPACITY = 96;

/** One shared shard sprite per scene — a faceted crystal, not a round dot.
 *
 *  Owned by the SCENE, not by any one aura: it outlives every character
 *  wearing the effect and is released with the scene. Anything tearing an aura
 *  down must leave it alone (see dispose).
 *
 *  The internal-texture check is a safety net for exactly that mistake: if the
 *  cached sprite was disposed out from under us, rebuild rather than hand back
 *  a dead handle that silently freezes every new aura too. */
const sprites = new WeakMap<Scene, DynamicTexture>();
function shard(scene: Scene): DynamicTexture {
  const existing = sprites.get(scene);
  if (existing && existing.getInternalTexture()) return existing;
  const size = 64;
  const tex = new DynamicTexture("omenShard", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const c = size / 2;

  // Soft bloom behind the shard, so a dense cluster still reads as light.
  const halo = ctx.createRadialGradient(c, c, 0, c, c, c);
  halo.addColorStop(0, "rgba(255,255,255,0.42)");
  halo.addColorStop(0.42, "rgba(226,206,255,0.12)");
  halo.addColorStop(1, "rgba(190,160,255,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  // The crystal: a tall four-point diamond, brightest across its waist so the
  // tips fade out instead of ending in a hard edge.
  const body = ctx.createLinearGradient(c, 3, c, size - 3);
  body.addColorStop(0, "rgba(255,255,255,0)");
  body.addColorStop(0.34, "rgba(255,255,255,0.95)");
  body.addColorStop(0.5, "rgba(255,255,255,1)");
  body.addColorStop(0.66, "rgba(255,255,255,0.95)");
  body.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(c, 3);
  ctx.lineTo(c + 9, c);
  ctx.lineTo(c, size - 3);
  ctx.lineTo(c - 9, c);
  ctx.closePath();
  ctx.fill();

  tex.update(false);
  tex.hasAlpha = true;
  sprites.set(scene, tex);
  return tex;
}

/** Where shards are shed: the wrist guards — the same place Zenith sheds
 *  embers from, because it is where both outfits put a crystal — and the
 *  crystal spurs on the boots. */
const SOURCES: { a: string; b: string; t: number; out: number }[] = [
  { a: "LeftForeArm", b: "LeftHand", t: 0.74, out: 0.05 },
  { a: "RightForeArm", b: "RightHand", t: 0.74, out: 0.05 },
  { a: "LeftLeg", b: "LeftFoot", t: 0.92, out: 0.035 },
  { a: "RightLeg", b: "RightFoot", t: 0.92, out: 0.035 },
];

/** Bones used to build a body frame, so "up" and the direction the character
 *  faces survive it turning around. */
const FRAME = ["Hips", "Spine", "LeftUpLeg", "RightUpLeg"] as const;

/** Halo height above the Head joint — just clear of the crown horns. */
const HALO_UP = 0.2;
const HALO_DIAMETER = 0.34;
const HALO_THICKNESS = 0.004;
/** Tilt and precession rate per ring. Two rings tipped opposite ways and
 *  turning at different rates is what makes the halo read as motion: a ring
 *  spun about its OWN axis is rotationally symmetric and looks static.
 *
 *  Keep the tilts SMALL and close together. Opening them up crosses the rings
 *  into an X and the halo stops reading as a halo and starts reading as a
 *  planetary ring. */
const RINGS = [
  { tilt: 0.15, rate: 0.45, scale: 1.0 },
  { tilt: -0.21, rate: -0.32, scale: 0.84 },
];

export class CrystalAura {
  private scene: Scene;
  private sources: { a: TransformNode; b: TransformNode; t: number; out: number }[];
  private frame: TransformNode[];
  private head: TransformNode;
  /** One world-space point per source, in SOURCES order. */
  private points: Vector3[];
  private detachVeins: () => void = () => {};
  private system: ParticleSystem;
  private halo: { mesh: Mesh; instance: InstancedMesh };
  private observer: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null = null;
  private disposed = false;
  /** Frames since attach; the pre-warm waits for the skeleton to be posed. */
  private posed = 0;
  private phase = 0;

  /** Scratch, so the per-frame work allocates nothing. */
  private up = new Vector3(0, 1, 0);
  private right = new Vector3(1, 0, 0);
  private forward = new Vector3(0, 0, 1);
  private tmp = new Vector3();
  private tmp2 = new Vector3();
  private tmp3 = new Vector3();

  /** Returns null when the rig has no bones to hang the effect on, which is
   *  never fatal — the character simply renders without an aura. */
  static attach(rig: CharacterRig, scene: Scene): CrystalAura | null {
    const sources: { a: TransformNode; b: TransformNode; t: number; out: number }[] = [];
    for (const s of SOURCES) {
      const a = rig.node(s.a);
      const b = rig.node(s.b);
      if (a && b) sources.push({ a, b, t: s.t, out: s.out });
    }
    const frame = FRAME.map((n) => rig.node(n));
    const head = rig.node("Head");
    if (sources.length < SOURCES.length || frame.some((n) => !n) || !head) return null;
    return new CrystalAura(rig, scene, sources, frame as TransformNode[], head);
  }

  private constructor(
    rig: CharacterRig,
    scene: Scene,
    sources: { a: TransformNode; b: TransformNode; t: number; out: number }[],
    frame: TransformNode[],
    head: TransformNode
  ) {
    this.scene = scene;
    this.sources = sources;
    this.frame = frame;
    this.head = head;
    this.points = sources.map(() => new Vector3());
    this.sample();

    // The garment's own veins. Lives on the material, not in this class, but
    // it is part of the same look and dies with it.
    this.detachVeins = attachVeinFlow(rig, scene);

    const tag = rig.root.name;

    // ---- the halo: two rings, tipped opposite ways -------------------------
    const haloMat = new StandardMaterial(`omenHalo_${tag}`, scene);
    haloMat.emissiveColor = HALO_VIOLET;
    haloMat.diffuseColor = Color3.Black();
    haloMat.specularColor = Color3.Black();
    haloMat.disableLighting = true;
    haloMat.alphaMode = Constants.ALPHA_ADD;
    haloMat.alpha = 0.42;
    haloMat.backFaceCulling = false;

    const ring = MeshBuilder.CreateTorus(
      `omenHalo_${tag}`,
      { diameter: HALO_DIAMETER, thickness: HALO_THICKNESS, tessellation: 32 },
      scene
    );
    ring.material = haloMat;
    ring.isPickable = false;
    ring.alwaysSelectAsActiveMesh = true; // it moves every frame; skip the cull test
    const ringB = ring.createInstance(`omenHalo_${tag}_b`);
    ringB.isPickable = false;
    ringB.alwaysSelectAsActiveMesh = true;
    ringB.scaling.setAll(RINGS[1].scale);
    this.halo = { mesh: ring, instance: ringB };
    this.placeHalo();

    // ---- the shards --------------------------------------------------------
    const ps = new ParticleSystem(`omen_${tag}`, CAPACITY, scene);
    ps.particleTexture = shard(scene);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.emitter = this.points[0];
    ps.isLocal = false; // shards stay where they were shed

    // Round-robin the sources so each sheds an equal share of the budget.
    let next = 0;
    ps.startPositionFunction = (_world, out) => {
      const p = this.points[next++ % this.points.length];
      out.set(
        p.x + (Math.random() - 0.5) * 0.05,
        p.y + (Math.random() - 0.5) * 0.05,
        p.z + (Math.random() - 0.5) * 0.05
      );
    };
    // Rising, with enough lateral spread to look like a field of crystal
    // rather than a jet.
    ps.startDirectionFunction = (_world, out) => {
      out.set((Math.random() - 0.5) * 0.55, Math.random() * 0.75 + 0.2, (Math.random() - 0.5) * 0.55);
    };

    // Violet at the source, crystal-white as it rises, gone by the end.
    ps.addColorGradient(0, new Color4(AMETHYST.r, AMETHYST.g, AMETHYST.b, 0));
    ps.addColorGradient(0.14, new Color4(AMETHYST.r, AMETHYST.g, AMETHYST.b, 0.95));
    ps.addColorGradient(0.55, LILAC);
    ps.addColorGradient(1, new Color4(0.92, 0.88, 1, 0));

    // Shards read bigger than embers — they are meant to be faceted objects,
    // not sparks.
    ps.addSizeGradient(0, 0.016);
    ps.addSizeGradient(0.35, 0.058);
    ps.addSizeGradient(1, 0.028);

    // Drag rising over the life is what reads as "settling".
    ps.addDragGradient(0, 0.12);
    ps.addDragGradient(1, 0.68);

    // Tumbling is what sells them as solid crystal rather than sprites.
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    ps.minAngularSpeed = -1.3;
    ps.maxAngularSpeed = 1.3;

    ps.minLifeTime = 1.3;
    ps.maxLifeTime = 2.4;
    ps.emitRate = 34;
    ps.minEmitPower = 0.09;
    ps.maxEmitPower = 0.24;
    ps.gravity = new Vector3(0, 0.22, 0);
    ps.updateSpeed = 0.012;
    // Start at steady state, so a character arriving in the lobby is already
    // wearing the effect instead of filling in over the first two seconds.
    ps.preWarmCycles = 80;
    ps.preWarmStepOffset = 1;
    this.system = ps;
    // NOT started here. A rig that has only just been built still has its
    // bones in the bind pose — a T-pose, arms straight out — so pre-warming
    // now fires the whole burst where the hands AREN'T, leaving two clouds
    // hanging in the air beside the character until they age out. Wait for the
    // animation to have posed the skeleton first (see follow).

    this.observer = scene.onBeforeRenderObservable.add(() => this.follow());
  }

  /** Rebuild the body frame and both wrist points for this frame.
   *
   *  The frame is derived from the rig rather than from the root node's
   *  rotation: the lobby rotates its anchor and the preview rotates the rig,
   *  so reading a facing off either one is wrong in the other. Hips->Spine
   *  gives up, the two thigh joints give right, and their cross product gives
   *  the direction the character faces. */
  private sample() {
    const [hipsN, spineN, leftLegN, rightLegN] = this.frame;
    const hips = hipsN.getAbsolutePosition();

    this.up.copyFrom(spineN.getAbsolutePosition()).subtractInPlace(hips);
    if (this.up.lengthSquared() > 1e-12) this.up.normalize();
    else this.up.set(0, 1, 0);

    this.right.copyFrom(rightLegN.getAbsolutePosition()).subtractInPlace(leftLegN.getAbsolutePosition());
    if (this.right.lengthSquared() > 1e-12) this.right.normalize();
    else this.right.set(1, 0, 0);

    Vector3.CrossToRef(this.right, this.up, this.forward);
    if (this.forward.lengthSquared() > 1e-12) this.forward.normalize();
    else this.forward.set(0, 0, 1);

    for (let i = 0; i < this.sources.length; i++) {
      const { a, b, t, out } = this.sources[i];
      const pa = a.getAbsolutePosition();
      const pb = b.getAbsolutePosition();
      const p = this.points[i].set(
        pa.x + (pb.x - pa.x) * t,
        pa.y + (pb.y - pa.y) * t,
        pa.z + (pb.z - pa.z) * t
      );
      // Stand the source off the limb's surface. The offset has to be
      // PERPENDICULAR to the limb, not simply away from the body: with the arm
      // raised or reaching out, "away from the body" points straight down the
      // arm, which slides the source along the bone and leaves it buried
      // inside the sleeve where the mesh draws over it.
      this.tmp.copyFrom(pb).subtractInPlace(pa); // limb axis
      this.tmp2.copyFrom(p).subtractInPlace(hips); // roughly outward
      if (this.tmp.lengthSquared() > 1e-12) {
        this.tmp.normalize();
        this.tmp2.subtractInPlace(this.tmp3.copyFrom(this.tmp).scaleInPlace(Vector3.Dot(this.tmp2, this.tmp)));
      }
      if (this.tmp2.lengthSquared() < 1e-8) this.tmp2.copyFrom(this.forward); // limb in line with the body
      else this.tmp2.normalize();
      p.addInPlace(this.tmp2.scaleInPlace(out));
    }
  }

  /** Sit both rings above the crown and give them their current precession.
   *
   *  Each ring's orientation is built by spinning the body frame about `up` by
   *  the ring's phase, then tipping the result about the spun "right" axis.
   *  Doing it with vectors rather than a quaternion product keeps the order
   *  unambiguous — a torus is symmetric about its own axis, so only the tilt
   *  DIRECTION precessing is visible, and getting the order backwards silently
   *  produces a ring that never appears to move. */
  private placeHalo() {
    const head = this.head.getAbsolutePosition();
    const cx = head.x + this.up.x * HALO_UP;
    const cy = head.y + this.up.y * HALO_UP;
    const cz = head.z + this.up.z * HALO_UP;

    const targets: (Mesh | InstancedMesh)[] = [this.halo.mesh, this.halo.instance];
    for (let i = 0; i < targets.length; i++) {
      const { tilt, rate } = RINGS[i];
      const ph = this.phase * rate;
      const cp = Math.cos(ph);
      const sp = Math.sin(ph);
      // right/forward spun about up
      const rx = this.right.x * cp + this.forward.x * sp;
      const ry = this.right.y * cp + this.forward.y * sp;
      const rz = this.right.z * cp + this.forward.z * sp;
      const fx = this.forward.x * cp - this.right.x * sp;
      const fy = this.forward.y * cp - this.right.y * sp;
      const fz = this.forward.z * cp - this.right.z * sp;
      // then tipped about that spun right axis
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      this.tmp.set(rx, ry, rz);
      this.tmp2.set(this.up.x * ct - fx * st, this.up.y * ct - fy * st, this.up.z * ct - fz * st);
      this.tmp3.set(fx * ct + this.up.x * st, fy * ct + this.up.y * st, fz * ct + this.up.z * st);

      const node = targets[i];
      node.position.set(cx, cy, cz);
      node.rotation = Vector3.RotationFromAxis(this.tmp, this.tmp2, this.tmp3);
    }
  }

  private follow() {
    if (this.disposed) return;
    this.phase += this.scene.getEngine().getDeltaTime() / 1000;
    this.sample();
    this.placeHalo();
    (this.system.emitter as Vector3).copyFrom(this.points[0]);

    // Two frames in, the clip has posed the skeleton and the sources are where
    // they belong; only then is it safe to fire the pre-warm burst.
    if (this.posed < 2 && ++this.posed === 2) this.system.start();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) this.scene.onBeforeRenderObservable.remove(this.observer);
    this.detachVeins();
    // dispose(false) — do NOT let it take the particle texture with it. That
    // sprite is shared by every aura in the scene: with two of these in a
    // lobby, one leaving would destroy the sprite and freeze the other's
    // effect (isReady() false forever), with no recovery short of a reload.
    this.system.dispose(false);
    this.halo.instance.dispose();
    this.halo.mesh.material?.dispose();
    this.halo.mesh.dispose();
  }
}
