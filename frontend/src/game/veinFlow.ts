// The gold veins running through Seraph's coat, lit by a pulse that starts at
// the collar, travels down the garment, fades out at the hem and begins again.
//
// WHY A MATERIAL PLUGIN
//
// The veins are painted into the character's emissive mask, so they already
// glow — but a travelling pulse is a function of WHERE ON THE BODY a pixel is,
// which no amount of texture work can express. That is a per-pixel question
// with a per-frame answer, so it belongs in the shader. Babylon's
// MaterialPluginBase injects into the stock PBR program rather than replacing
// it, so the character keeps its normal lighting, shadows and image
// processing; this only adds to `finalEmissive` just before it is composited.
//
// TWO THINGS WORTH KNOWING
//
// 1. Gold and crystal are told apart by the MASK TEXEL, not by a second
//    texture. The mask carries each part of the garment in its own colour, so
//    "warm" is a vein and "cool" is crystal, readable per pixel for free. The
//    prisms are separated from the violet crystals the same way — they are the
//    only cool pixels that are also green-over-red.
//
// 2. The pulse is positioned in the mesh's OWN object space, from the raw
//    vertex `position` attribute. Object space on purpose: the pulse should
//    run down the DRESS, hitting the same place on the garment whatever the
//    character is doing. Reading world position instead would sweep a
//    horizontal plane through the world, sliding across the body as the
//    character moved.
//
//    The range it is normalised against must come from that same attribute —
//    NOT from the bounding box. These models are meshopt-compressed with
//    KHR_mesh_quantization, so the attribute is quantised to [-1,1] while the
//    box reports dequantised metres, and the conversion (which can also mirror
//    Y) lives in the world matrix. Normalising by the box squashes the gradient
//    into a fraction of its range and clamps the rest flat: the pulse changes
//    brightness but never travels.
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Scene } from "@babylonjs/core/scene";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Nullable } from "@babylonjs/core/types";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { CharacterRig } from "./characterRig";

/** Seconds the pulse takes to travel from above the collar to below the hem.
 *  Slow on purpose — it should read as a charge moving through the garment,
 *  not a flicker. */
const SWEEP = 5.2;
/** Dark seconds between pulses. Without a gap it reads as a repeating stripe
 *  rather than a charge running down the garment. */
const GAP = 1.8;
/** Half-height of the pulse, in fractions of the character's height. Narrow
 *  enough to have an edge — widen it much past this and it stops reading as a
 *  charge running down the coat and starts reading as the whole thing pulsing. */
const HALF_WIDTH = 0.14;
/** How hard the pulse lifts the veins.
 *
 *  The veins are baked into the mask BRIGHT — an 8-bit texture painted dim has
 *  no signal left to amplify, which is exactly why an earlier cut's pulse was
 *  invisible: at a 0.18 bake the shader had 0.05 of colour difference to work
 *  with. They are baked strong and damped back down by GOLD_REST instead, so
 *  the precision is there and the resting brightness is still a free choice. */
const GOLD_BOOST = 90.0;
/** How much of the veins' baked brightness is removed when the pulse is not
 *  over them. At 0 the veins glow gold constantly; at 1 they are invisible
 *  between pulses. */
const GOLD_REST = 0.72;
/** Constant extra on the chest and back prisms — they are meant to read as the
 *  brightest thing on the character. */
const PRISM_BOOST = 5.0;
/** Parked well outside [0,1] so the band contributes nothing between pulses. */
const OFF = -5;

class VeinFlowPlugin extends MaterialPluginBase {
  center = OFF;
  yMin = 0;
  yMax = 1;
  /** Instance fields, not constants, so the strength can be swept at runtime
   *  while looking at the result instead of guessed at between rebuilds. */
  goldBoost = GOLD_BOOST;
  goldRest = GOLD_REST;
  prismBoost = PRISM_BOOST;


  constructor(material: Material) {
    super(material, "VeinFlow", 200, { VEINFLOW: false });
    this._enable(true);
  }

  getClassName() {
    return "VeinFlowPlugin";
  }

  prepareDefines(defines: Record<string, unknown>) {
    defines.VEINFLOW = true;
  }

  // Declared through `ubo` ONLY. The vertex/fragment declaration strings are
  // appended on top of the generated UBO block rather than instead of it, so
  // naming them here as well produces a duplicate-declaration compile error.
  getUniforms() {
    return {
      ubo: [
        { name: "veinParams", size: 4, type: "vec4" },
        { name: "veinRange", size: 4, type: "vec4" },
      ],
    };
  }

  bindForSubMesh(uniformBuffer: UniformBuffer) {
    uniformBuffer.updateFloat4("veinParams", this.center, HALF_WIDTH, this.goldBoost, this.prismBoost);
    uniformBuffer.updateFloat4("veinRange", this.yMin, this.yMax, this.goldRest, 0.0);
  }

  getCustomCode(shaderType: string): Nullable<{ [point: string]: string }> {
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `varying float vVeinY;`,
        // `position` is the raw attribute, so this is object space whatever the
        // quantisation — which matches the bounding box handed in below.
        CUSTOM_VERTEX_MAIN_BEGIN: `vVeinY = position.y;`,
      };
    }
    if (shaderType === "fragment") {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `varying float vVeinY;`,
        // Runs after pbrBlockFinalUnlitComponents (which declares
        // `emissiveColorTex` and `finalEmissive`) and before the composition
        // that adds finalEmissive into the frame.
        CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
        #ifdef EMISSIVE
            #ifdef GAMMAEMISSIVE
                vec3 veinTex = toLinearSpace(emissiveColorTex.rgb);
            #else
                vec3 veinTex = emissiveColorTex.rgb;
            #endif
            // Warm pixels are gold vein; cool pixels are crystal.
            float veinGold = clamp((veinTex.r - veinTex.b) * 6.0, 0.0, 1.0);
            // The prisms are the cool pixels that are ALSO green-over-red —
            // cyan. The shoulder and boot crystals are violet and fail that.
            float veinCool = clamp((veinTex.b - veinTex.r) * 3.0, 0.0, 1.0);
            float veinCyan = clamp((veinTex.g - veinTex.r) * 4.0, 0.0, 1.0);

            // The range is signed: x is the bottom of the character and y the
            // top, which is y < x whenever the mesh carries a mirrored Y.
            float veinDen = veinRange.y - veinRange.x;
            float veinH = clamp((vVeinY - veinRange.x) / (abs(veinDen) < 0.00001 ? 1.0 : veinDen), 0.0, 1.0);
            float veinBand = 1.0 - smoothstep(0.0, veinParams.y, abs(veinH - veinParams.x));
            veinBand *= veinBand;   // tighten the core so the pulse has an edge

            // Damp the veins back down where the pulse is not, then burn them
            // where it is. Subtracting only the gold share leaves the crystal
            // and the prisms untouched.
            finalEmissive -= veinTex * veinGold * veinRange.z;
            finalEmissive += veinTex * veinGold * veinBand * veinParams.z;
            finalEmissive = max(finalEmissive, vec3(0.0));
            // Tinted toward blue rather than added flat: the prisms read as
            // white-hot at this strength otherwise, and the ask was bluer.
            finalEmissive += veinTex * vec3(0.45, 0.78, 1.25) * veinCool * veinCyan * veinParams.w;
        #endif
        `,
      };
    }
    return null;
  }
}

/** One clock per scene drives every vein-flow material in it, so four Seraphs
 *  in a lobby pulse together off a single observer instead of four. */
interface Clock {
  elapsed: number;
  refs: number;
  plugins: Set<VeinFlowPlugin>;
  observer: ReturnType<Scene["onBeforeRenderObservable"]["add"]>;
}
const clocks = new WeakMap<Scene, Clock>();

function clockFor(scene: Scene): Clock {
  let clock = clocks.get(scene);
  if (clock) return clock;
  const made: Clock = {
    elapsed: 0,
    refs: 0,
    plugins: new Set(),
    observer: null,
  } as unknown as Clock;
  made.observer = scene.onBeforeRenderObservable.add(() => {
    made.elapsed = (made.elapsed + scene.getEngine().getDeltaTime() / 1000) % (SWEEP + GAP);
    // Starts above the collar and ends below the hem, so the pulse enters and
    // leaves rather than popping into existence on the chest.
    const center = made.elapsed < SWEEP ? 1.18 - (made.elapsed / SWEEP) * 1.36 : OFF;
    for (const p of made.plugins) p.center = center;
  });
  clocks.set(scene, made);
  return made;
}

/** Light the veins on a character's own material. Returns a detach function;
 *  calling it is safe even when other characters still share the material. */
export function attachVeinFlow(rig: CharacterRig, scene: Scene): () => void {
  const mesh = rig.root.getChildMeshes().find((m) => m.getTotalVertices() > 0 && m.material);
  const material = mesh?.material;
  if (!mesh || !material) return () => {};

  // Materials are SHARED between instances of the same character (the rig
  // instantiates with cloneMaterials false), so decorate each one once.
  const existing = material.pluginManager?.getPlugin("VeinFlow") as VeinFlowPlugin | undefined | null;
  const plugin = existing ?? new VeinFlowPlugin(material);

  // Normalise against the RAW position attribute, not the bounding box.
  //
  // These models are meshopt-compressed with KHR_mesh_quantization, so the
  // attribute the vertex shader reads is quantised to [-1,1] while the
  // bounding box reports dequantised metres — Babylon folds the conversion
  // into the world matrix. Normalising by the box compresses the gradient into
  // a fraction of its range and clamps the rest flat, which shows up as a pulse
  // that changes brightness but never travels. getVerticesData returns the same
  // buffer the shader samples, so it is the only safe source for this.
  const raw = mesh.getVerticesData("position");
  let lo = Infinity;
  let hi = -Infinity;
  let loAt = 0;
  let hiAt = 0;
  if (raw) {
    for (let i = 1; i < raw.length; i += 3) {
      if (raw[i] < lo) { lo = raw[i]; loAt = i - 1; }
      if (raw[i] > hi) { hi = raw[i]; hiAt = i - 1; }
    }
  }
  if (!raw || !Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return () => {};

  // Which end of that range is the character's HEAD? The dequantisation Babylon
  // folds into the world matrix can mirror Y, so the largest attribute value is
  // not reliably the top. Rather than reason about the hierarchy, transform the
  // two extreme vertices and look: whichever lands higher in the world is the
  // top. Passing the range signed then makes the pulse run collar-to-hem either
  // way.
  mesh.computeWorldMatrix(true);
  const world = mesh.getWorldMatrix();
  const atLo = Vector3.TransformCoordinates(new Vector3(raw[loAt], raw[loAt + 1], raw[loAt + 2]), world);
  const atHi = Vector3.TransformCoordinates(new Vector3(raw[hiAt], raw[hiAt + 1], raw[hiAt + 2]), world);
  const hiIsTop = atHi.y >= atLo.y;
  plugin.yMin = hiIsTop ? lo : hi; // the character's feet
  plugin.yMax = hiIsTop ? hi : lo; // the character's head

  const clock = clockFor(scene);
  clock.plugins.add(plugin);
  clock.refs++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--clock.refs > 0) return;
    // Last one out: stop the clock and park the pulse off the body, so a
    // frozen band can't be left lit across the garment.
    clock.plugins.forEach((p) => (p.center = OFF));
    clock.plugins.clear();
    scene.onBeforeRenderObservable.remove(clock.observer);
    clocks.delete(scene);
  };
}
