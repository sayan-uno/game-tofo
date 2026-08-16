// Loading the pack's 3D models and turning them into things the street can
// stamp out thousands of times.
//
// Every model arrives as a GLB with its own materials and its own idea of
// which way is forward. What the scene needs is ONE mesh it can instance, in
// the right orientation, standing on the ground — so this does three things:
//
//   * merges the loaded meshes into a single source (one draw call per model
//     however many copies are placed, and instances need a single mesh);
//   * applies a per-model orientation, because a generated model's "forward"
//     is wherever the generator put it and only looking at it tells you which;
//   * bakes that transform into the vertices, so an instance is nothing but a
//     position and a rotation about Y.
//
// The bytes come through the same on-device store as characters, so a model is
// downloaded once per device and read locally ever after.
import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { loadContainer } from "../../game/characterRig";

export interface ModelOptions {
  /** Rotation about each axis applied BEFORE baking, in radians. */
  rotation?: { x?: number; y?: number; z?: number };
  /** Multiply the model's size (it is already scaled to metres at build time). */
  scale?: number;
  /** Target size in metres per axis, applied AFTER rotation. Any axis left out
   *  keeps its own scale. Use it to make a generated carriage exactly as long
   *  as the simulation says a carriage is. */
  fit?: { x?: number; y?: number; z?: number };
  /** Lift or drop it off the ground, in metres. */
  lift?: number;
  /** Multiply the model's base colour. Generated models are lit for daylight
   *  and arrive far too bright for a night street; this is where they are
   *  brought down to the hour the scene is set in. */
  tint?: { r: number; g: number; b: number };
  /** Fraction of the model's own texture added back as emissive — how much of
   *  it lights itself. Small values make lit windows read without the whole
   *  building glowing. */
  selfLit?: number;
}

/** Load a pack model and return a hidden source mesh ready for instancing, or
 *  null if it could not be loaded — a missing prop must never stop a match. */
export async function loadModel(
  url: string,
  scene: Scene,
  name: string,
  opts: ModelOptions = {}
): Promise<Mesh | null> {
  try {
    const container = await loadContainer(url, scene);
    const entries = container.instantiateModelsToScene((n) => `${name}_${n}`, false, { doNotInstantiate: true });
    const meshes = entries.rootNodes
      .flatMap((node) => [node, ...node.getDescendants(false)])
      .filter((n): n is Mesh => n instanceof Mesh && n.getTotalVertices() > 0);
    if (meshes.length === 0) {
      entries.dispose();
      return null;
    }
    // ALWAYS merge, even for a single mesh. A merge bakes each source's WORLD
    // matrix into the vertices, and that world matrix is where the model's
    // scale lives — glTF keeps it on the parent node, not in the vertex data.
    // Taking the single-mesh shortcut dropped that parent scale, and every
    // model arrived exactly ten times too small.
    for (const m of meshes) m.computeWorldMatrix(true);
    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
    if (!merged) {
      entries.dispose();
      return null;
    }
    merged.name = name;
    merged.rotation = new Vector3(opts.rotation?.x ?? 0, opts.rotation?.y ?? 0, opts.rotation?.z ?? 0);
    if (opts.scale) merged.scaling.setAll(opts.scale);
    if (opts.fit) {
      // Measure AFTER the rotation, because which axis is "length" depends on
      // how the model was turned.
      merged.bakeCurrentTransformIntoVertices();
      merged.refreshBoundingInfo();
      const s = modelSize(merged);
      merged.scaling.set(
        opts.fit.x ? opts.fit.x / (s.x || 1) : 1,
        opts.fit.y ? opts.fit.y / (s.y || 1) : 1,
        opts.fit.z ? opts.fit.z / (s.z || 1) : 1
      );
    }
    merged.position.y = opts.lift ?? 0;
    // Bake it: from here the mesh IS oriented and sized, so an instance only
    // ever carries a position (and a turn about Y for variety).
    merged.bakeCurrentTransformIntoVertices();
    applyLook(merged, opts);
    merged.isPickable = false;
    merged.isVisible = false;
    merged.alwaysSelectAsActiveMesh = false;
    for (const m of merged.getChildMeshes()) m.isVisible = false;
    return merged;
  } catch (err) {
    console.warn(`[trackline] model "${name}" failed to load`, err);
    return null;
  }
}

/** Bring a generated model into the scene's light. Works for both material
 *  families Babylon may hand back from a GLB (PBR normally, Standard if the
 *  file is simple), without the caller having to know which. */
function applyLook(mesh: Mesh, opts: ModelOptions): void {
  const mats = mesh.material && "subMaterials" in mesh.material
    ? ((mesh.material as unknown as { subMaterials: unknown[] }).subMaterials as unknown[])
    : [mesh.material];
  for (const raw of mats) {
    const mat = raw as {
      albedoColor?: { set(r: number, g: number, b: number): void };
      diffuseColor?: { set(r: number, g: number, b: number): void };
      albedoTexture?: unknown;
      diffuseTexture?: unknown;
      emissiveTexture?: unknown;
      emissiveColor?: { set(r: number, g: number, b: number): void };
      environmentIntensity?: number;
      metallic?: number | null;
      roughness?: number | null;
    } | null;
    if (!mat) continue;
    if (opts.tint) {
      mat.albedoColor?.set(opts.tint.r, opts.tint.g, opts.tint.b);
      mat.diffuseColor?.set(opts.tint.r, opts.tint.g, opts.tint.b);
    }
    if (opts.selfLit) {
      mat.emissiveTexture = mat.albedoTexture ?? mat.diffuseTexture ?? mat.emissiveTexture;
      mat.emissiveColor?.set(opts.selfLit, opts.selfLit * 0.86, opts.selfLit * 0.7);
    }
    // Generated PBR is usually fully rough and non-metal; a wet night street
    // wants a little sheen on stone and a lot on steel.
    if (typeof mat.metallic === "number" || mat.metallic === null) {
      mat.metallic = 0.08;
      mat.roughness = 0.72;
      mat.environmentIntensity = 0.35;
    }
  }
}

/** Size of a source mesh in metres, for laying things out against each other. */
export function modelSize(mesh: AbstractMesh): { x: number; y: number; z: number } {
  const info = mesh.getBoundingInfo().boundingBox;
  const min = info.minimum;
  const max = info.maximum;
  return { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
}

/** The models a Trackline pack ships. Any of them may be null: a pack without
 *  a model falls back to simple geometry rather than failing a match. */
export interface TracklineModels {
  building: Mesh | null;
  building2: Mesh | null;
  building3: Mesh | null;
  lamp: Mesh | null;
  tree: Mesh | null;
  bench: Mesh | null;
  kiosk: Mesh | null;
  car: Mesh | null;
  barrier: Mesh | null;
  carriage: Mesh | null;
}

/** Load them all in parallel. Sizes and orientations are set HERE, in one
 *  place, because they are properties of the generated models rather than of
 *  the game — a regenerated model with a different pose is a change to this
 *  table and nothing else. */
export async function loadTracklineModels(
  assets: { has(p: string): boolean; url(p: string): string },
  scene: Scene,
  carriageLength: number,
  roofHeight: number
): Promise<TracklineModels> {
  const one = async (name: string, opts: ModelOptions): Promise<Mesh | null> => {
    const path = `models/${name}.glb`;
    if (!assets.has(path)) return null;
    return loadModel(assets.url(path), scene, name, opts);
  };
  // Stone lit by street lamps, not by the sun; a touch of self-light so the
  // shopfronts and windows still read at night.
  const stone = { tint: { r: 0.5, g: 0.39, b: 0.28 }, selfLit: 0.14 };
  const [building, building2, building3, lamp, tree, bench, kiosk, car, barrier, carriage] = await Promise.all([
    one("building", stone),
    one("building2", stone),
    one("building3", { tint: { r: 0.46, g: 0.36, b: 0.28 }, selfLit: 0.12 }),
    one("lamp", { tint: { r: 0.4, g: 0.4, b: 0.42 } }),
    one("tree", { tint: { r: 0.3, g: 0.29, b: 0.26 } }),
    one("bench", { tint: { r: 0.35, g: 0.38, b: 0.34 } }),
    one("kiosk", { tint: { r: 0.38, g: 0.4, b: 0.36 }, selfLit: 0.08 }),
    one("car", { tint: { r: 0.42, g: 0.42, b: 0.45 } }),
    // The road barrier is the thing you jump: sized to the lane, not to the
    // model's own idea of a barrier.
    one("barrier3d", { fit: { x: 1.9, y: 0.62 }, tint: { r: 0.85, g: 0.8, b: 0.8 }, selfLit: 0.12 }),
    // Turned to run ALONG the track, then cut to exactly the length the
    // simulation says a carriage is — otherwise what you see overlaps rows the
    // sim thinks are clear.
    one("carriage", {
      rotation: { y: Math.PI / 2 },
      fit: { x: 2.2, y: roofHeight, z: carriageLength },
      tint: { r: 0.6, g: 0.62, b: 0.66 },
      selfLit: 0.14, // lit windows
    }),
  ]);
  return { building, building2, building3, lamp, tree, bench, kiosk, car, barrier, carriage };
}
