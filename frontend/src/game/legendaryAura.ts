// The legendary aura: warm amber light at the forearm guards and the belt,
// shedding icy motes that drift up and fade out.
//
// Attached only to characters the catalog marks `rarity: "legendary"`, and
// dynamically imported, so a session that never sees one downloads none of it.
//
// Cost, which is the whole design constraint here:
//
//   * ONE particle system per character, not three. The three emission points
//     come from startPositionFunction picking between them per particle, so it
//     stays a single update loop and a single draw call however many sources
//     the effect appears to have.
//   * The three light cores are one mesh plus two instances — one more draw
//     call for all three, and the lobby's existing GlowLayer blooms them at no
//     extra cost.
//   * The sprite is a 64px canvas gradient built once per scene and shared by
//     every character wearing the aura.
//
// That puts a legendary character at +2 draw calls and ~60 live particles.
//
// Emission points are read from the bone transform nodes each frame rather than
// parented to them: a bone here carries the skeleton root's 0.01 scale (see
// normalizeSize in characterRig.ts), so anything parented to one would be
// authored at 1/100 size. Reading world positions side-steps that entirely, and
// leaving the particles in world space is also what makes them trail behind a
// moving hand instead of riding along with it.

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
import type { CharacterRig } from "./characterRig";

/** Warm amber the light is born as. */
const EMBER = new Color3(1.0, 0.62, 0.22);
/** Pale ice the motes turn as they drift off. */
const FROST = new Color4(0.74, 0.9, 1.0, 0.55);

const CAPACITY = 80;

/** One shared sprite per scene — a soft round dot.
 *
 *  Owned by the SCENE, not by any one aura: it outlives every character wearing
 *  the effect and is released when the scene is disposed. Anything that tears an
 *  aura down must leave it alone (see dispose below).
 *
 *  The internal-texture check is a safety net for exactly that mistake: if the
 *  cached sprite has been disposed out from under us, rebuild rather than hand
 *  back a dead handle that silently freezes every new aura too. */
const sprites = new WeakMap<Scene, DynamicTexture>();
function dot(scene: Scene): DynamicTexture {
  const existing = sprites.get(scene);
  if (existing && existing.getInternalTexture()) return existing;
  const size = 64;
  const tex = new DynamicTexture("auraDot", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update(false);
  tex.hasAlpha = true;
  sprites.set(scene, tex);
  return tex;
}

/** The forearm guards, as a blend down the forearm toward the wrist. */
const ARMS: { a: string; b: string; t: number }[] = [
  { a: "LeftForeArm", b: "LeftHand", t: 0.72 },
  { a: "RightForeArm", b: "RightHand", t: 0.72 },
];
/** Bones used to build a body frame, so the belt source can be pushed out to
 *  the front of the torso instead of sitting inside it. */
const FRAME = ["Hips", "Spine", "LeftUpLeg", "RightUpLeg"] as const;

/** How far each source stands off the skin. A source left on the bone axis is
 *  buried inside the limb and the mesh simply draws over it. */
const ARM_OUT = 0.055;
const BELT_UP = 0.1;
const BELT_OUT = 0.12;

export class LegendaryAura {
  private scene: Scene;
  private arms: { a: TransformNode; b: TransformNode; t: number }[];
  private frame: TransformNode[];
  /** [left guard, right guard, belt] in world space. */
  private points: Vector3[];
  private system: ParticleSystem;
  private cores: { mesh: Mesh; instances: { position: Vector3; dispose(): void }[] };
  private observer: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null = null;
  private disposed = false;
  /** Frames since attach; the pre-warm waits for the skeleton to be posed. */
  private posed = 0;

  /** Returns null when the rig has no bones to hang the effect on, which is
   *  never fatal — the character simply renders without an aura. */
  static attach(rig: CharacterRig, scene: Scene): LegendaryAura | null {
    const arms: { a: TransformNode; b: TransformNode; t: number }[] = [];
    for (const s of ARMS) {
      const a = rig.node(s.a);
      const b = rig.node(s.b);
      if (a && b) arms.push({ a, b, t: s.t });
    }
    const frame = FRAME.map((n) => rig.node(n));
    if (arms.length < 2 || frame.some((n) => !n)) return null;
    return new LegendaryAura(rig, scene, arms, frame as TransformNode[]);
  }

  private constructor(
    rig: CharacterRig,
    scene: Scene,
    arms: { a: TransformNode; b: TransformNode; t: number }[],
    frame: TransformNode[]
  ) {
    this.scene = scene;
    this.arms = arms;
    this.frame = frame;
    this.points = [new Vector3(), new Vector3(), new Vector3()];
    this.sample();

    // ---- the light cores: one mesh, the rest instances -----------------------
    const mat = new StandardMaterial(`auraCore_${rig.root.name}`, scene);
    mat.emissiveColor = EMBER;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.alpha = 0.9;
    mat.backFaceCulling = false;

    const core = MeshBuilder.CreateSphere(`auraCore_${rig.root.name}`, { diameter: 0.05, segments: 6 }, scene);
    core.material = mat;
    core.isPickable = false;
    core.alwaysSelectAsActiveMesh = true; // it moves every frame; skip the cull test
    core.position.copyFrom(this.points[0]);
    const instances = this.points.slice(1).map((p, i) => {
      const inst = core.createInstance(`auraCore_${rig.root.name}_${i}`);
      inst.isPickable = false;
      inst.alwaysSelectAsActiveMesh = true;
      inst.position.copyFrom(p);
      return inst;
    });
    this.cores = { mesh: core, instances };

    // ---- the motes ----------------------------------------------------------
    const ps = new ParticleSystem(`aura_${rig.root.name}`, CAPACITY, scene);
    ps.particleTexture = dot(scene);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.emitter = this.points[2];
    ps.isLocal = false; // motes stay where they were shed, so a moving hand trails them

    // Round-robin the three sources so each gets an even share of the budget.
    let next = 0;
    ps.startPositionFunction = (_world, out) => {
      const p = this.points[next++ % this.points.length];
      out.set(
        p.x + (Math.random() - 0.5) * 0.05,
        p.y + (Math.random() - 0.5) * 0.05,
        p.z + (Math.random() - 0.5) * 0.05
      );
    };
    // Drift outward and up, with enough spread to look like air rather than a jet.
    ps.startDirectionFunction = (_world, out) => {
      out.set((Math.random() - 0.5) * 0.6, Math.random() * 0.8 + 0.25, (Math.random() - 0.5) * 0.6);
    };

    // Amber at the source, ice as it travels, gone by the end.
    ps.addColorGradient(0, new Color4(EMBER.r, EMBER.g, EMBER.b, 0));
    ps.addColorGradient(0.12, new Color4(EMBER.r, EMBER.g, EMBER.b, 0.95));
    ps.addColorGradient(0.5, FROST);
    ps.addColorGradient(1, new Color4(0.85, 0.95, 1, 0));

    ps.addSizeGradient(0, 0.014);
    ps.addSizeGradient(0.35, 0.05);
    ps.addSizeGradient(1, 0.022);

    // Drag rising over the life is what reads as "settling into the wind".
    ps.addDragGradient(0, 0.15);
    ps.addDragGradient(1, 0.7);

    ps.minLifeTime = 1.1;
    ps.maxLifeTime = 2.2;
    ps.emitRate = 26;
    ps.minEmitPower = 0.1;
    ps.maxEmitPower = 0.26;
    ps.gravity = new Vector3(0, 0.28, 0);
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    ps.updateSpeed = 0.012;
    // Start at steady state, so a character arriving in the lobby is already
    // wearing the effect instead of filling in over the first two seconds.
    // Costs one burst of ~80 update steps, once, at attach.
    ps.preWarmCycles = 80;
    ps.preWarmStepOffset = 1;
    this.system = ps;
    // NOT started here. A rig that has only just been built still has its bones
    // in the bind pose — a T-pose, arms straight out — so pre-warming now fires
    // the whole burst at where the hands AREN'T, leaving two clouds hanging in
    // the air beside the character until they age out. Wait for the animation
    // to have posed the skeleton first.

    this.observer = scene.onBeforeRenderObservable.add(() => this.follow());
  }

  /** Current world position of each source, standing off the skin so the mesh
   *  does not simply draw over them.
   *
   *  The body frame is derived from the rig rather than from the root node's
   *  rotation: the lobby rotates its anchor and the preview rotates the rig, so
   *  reading a facing off either one is wrong in the other. Hips->Spine gives
   *  up, the two thigh joints give right, and their cross product gives the
   *  direction the belt buckle faces. */
  private sample() {
    const [hipsN, spineN, leftLegN, rightLegN] = this.frame;
    const hips = hipsN.getAbsolutePosition();
    const spine = spineN.getAbsolutePosition();

    const up = spine.subtract(hips);
    if (up.lengthSquared() > 1e-12) up.normalize(); else up.set(0, 1, 0);
    const right = rightLegN.getAbsolutePosition().subtract(leftLegN.getAbsolutePosition());
    if (right.lengthSquared() > 1e-12) right.normalize(); else right.set(1, 0, 0);
    const forward = Vector3.Cross(right, up);
    if (forward.lengthSquared() > 1e-12) forward.normalize(); else forward.set(0, 0, 1);

    for (let i = 0; i < this.arms.length; i++) {
      const { a, b, t } = this.arms[i];
      const pa = a.getAbsolutePosition();
      const pb = b.getAbsolutePosition();
      const p = this.points[i].set(
        pa.x + (pb.x - pa.x) * t,
        pa.y + (pb.y - pa.y) * t,
        pa.z + (pb.z - pa.z) * t
      );
      // Stand the source off the arm's surface. The offset has to be
      // PERPENDICULAR to the forearm, not simply away from the body: with the
      // arm raised or reaching out, "away from the body" points straight down
      // the arm, which slides the source along the bone and leaves it buried
      // inside the sleeve where the mesh draws over it.
      const axis = pb.subtract(pa);
      const out = p.subtract(hips);
      if (axis.lengthSquared() > 1e-12) {
        axis.normalize();
        out.subtractInPlace(axis.scale(Vector3.Dot(out, axis)));
      }
      if (out.lengthSquared() < 1e-8) out.copyFrom(forward); // arm dead in line with the body
      out.normalize();
      p.addInPlace(out.scale(ARM_OUT));
    }

    this.points[2].set(
      hips.x + up.x * BELT_UP + forward.x * BELT_OUT,
      hips.y + up.y * BELT_UP + forward.y * BELT_OUT,
      hips.z + up.z * BELT_UP + forward.z * BELT_OUT
    );
  }

  private follow() {
    if (this.disposed) return;
    this.sample();
    this.cores.mesh.position.copyFrom(this.points[0]);
    for (let i = 0; i < this.cores.instances.length; i++) {
      this.cores.instances[i].position.copyFrom(this.points[i + 1]);
    }
    (this.system.emitter as Vector3).copyFrom(this.points[2]);

    // Two frames in, the clip has posed the skeleton and the sources are where
    // they belong; only then is it safe to fire the pre-warm burst.
    if (this.posed < 2 && ++this.posed === 2) this.system.start();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) this.scene.onBeforeRenderObservable.remove(this.observer);
    // dispose(false) — do NOT let it take the particle texture with it.
    // ParticleSystem.dispose() disposes its texture by default, and that sprite
    // is shared by every aura in the scene: with two legendary characters in a
    // lobby, one leaving destroyed the sprite and froze the other's effect
    // (isReady() false forever), with no recovery short of a reload.
    this.system.dispose(false);
    for (const inst of this.cores.instances) inst.dispose();
    this.cores.mesh.material?.dispose();
    this.cores.mesh.dispose();
  }
}
