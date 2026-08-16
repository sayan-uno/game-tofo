// One runner on the track: their character (the same CharacterRig the lobby
// draws, running the "run" clip) plus a name tag that always faces the
// camera. Positioned from sim state each frame; knows nothing about the sim.
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CharacterRig } from "../../game/characterRig";
import { getEmote } from "../../game/assets";
import { attachAura, type Aura } from "../../game/aura";

/** Clips this game drives, all already in the shared catalog and cached by the
 *  lobby, so a match adds no download. There is no jump clip yet (M4 asset
 *  work): the arc itself reads as the jump, and the run cycle keeps playing. */
const RUN_CLIP = "run";
const ROLL_CLIP = "roll";
const CRASH_CLIP = "fall";

export class RunnerView {
  readonly root: TransformNode;
  private rig: CharacterRig | null = null;
  /** Only on characters the catalog marks legendary — null for everyone else,
   *  which is the common case and costs nothing. */
  private aura: Aura | null = null;
  private tag: Mesh | null = null;
  private tagTex: DynamicTexture | null = null;
  private disposed = false;
  /** What is playing, so a clip starts once on transition rather than being
   *  restarted every frame (which reads as a twitching character). */
  private clip: string | null = null;
  private crashed = false;

  constructor(
    private scene: Scene,
    readonly uid: string,
    private name: string,
    private isLocal: boolean
  ) {
    this.root = new TransformNode(`runner_${uid}`, scene);
  }

  /** Load the character and start it running. Never throws — a runner whose
   *  model can't load is simply an empty spot with a name tag. */
  async load(characterId: string): Promise<void> {
    const rig = await CharacterRig.create(characterId, this.scene, `rig_${this.uid}`);
    if (this.disposed) {
      rig?.dispose();
      return;
    }
    if (rig) {
      this.rig = rig;
      rig.root.parent = this.root;
      // Characters are authored facing +Z... the lobby turns them by PI to
      // face its camera; here the camera is BEHIND, so they run away from it.
      if (getEmote(RUN_CLIP)) {
        await rig.play(RUN_CLIP, { loop: true });
        this.clip = RUN_CLIP;
      }
      // A legendary skin keeps its effect on the track — a cosmetic you own is
      // worth least in the one place people are watching. It is the same
      // module the lobby uses, so this costs no extra download: +2 draw calls
      // and ~60-80 particles per legendary runner, at most four of them.
      //
      // Its bloom is NOT here: the aura reads brighter in the lobby because
      // that scene has a GlowLayer, and a full-screen glow pass in a match is
      // exactly the cost this game's budget rules out until a real phone says
      // otherwise. The emissive cores and the shards still draw.
      //
      // AFTER the clip, never before: the effect reads bone positions, and a
      // skeleton that has not been posed by a clip yet sits at 1/100 scale.
      const aura = await attachAura(characterId, rig, this.scene);
      if (this.disposed) aura?.dispose();
      else this.aura = aura;
    }
    this.buildTag();
  }

  private buildTag(): void {
    const w = 256;
    const h = 64;
    const tex = new DynamicTexture(`tag_${this.uid}`, { width: w, height: h }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(8,5,8,0.78)";
    roundRect(ctx, 4, 8, w - 8, h - 16, 12);
    ctx.fill();
    ctx.strokeStyle = this.isLocal ? "#e5182e" : "rgba(255,255,255,0.35)";
    ctx.lineWidth = 3;
    roundRect(ctx, 4, 8, w - 8, h - 16, 12);
    ctx.stroke();
    ctx.fillStyle = "#f2f5ff";
    ctx.font = 'bold 26px "Archivo Black", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.name, w / 2, h / 2 + 1, w - 30);
    tex.update(false);
    tex.hasAlpha = true;
    // Canvas Y grows DOWNWARD, a plane's V grows upward, so a canvas drawn
    // top-down lands upside down on a plane (verified with a corner marker:
    // the top-left of the canvas rendered at the bottom-left of the tag, and
    // every "M" came out as a "W"). Flipping V here costs nothing and keeps
    // the drawing code reading in normal canvas coordinates.
    tex.vScale = -1;
    tex.vOffset = 1;
    this.tagTex = tex;

    const mat = new StandardMaterial(`tagMat_${this.uid}`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    // NOT billboarded, deliberately. The chase camera always looks down +Z
    // with no roll and only a few degrees of sway, so a plane standing in the
    // XY plane already faces it — while billboarding turned the plane far
    // enough to show its back face, which drew every name mirrored. Skipping
    // it also drops a per-frame billboard matrix rebuild per runner.
    const plane = MeshBuilder.CreatePlane(`tag_${this.uid}`, { width: 1.1, height: 0.275 }, this.scene);
    plane.material = mat;
    plane.position.y = 2.15;
    plane.isPickable = false;
    plane.parent = this.root;
    this.tag = plane;
  }

  /** Grey out a runner who left the match — their effect goes with them. */
  setLeft(): void {
    if (this.tag) this.tag.visibility = 0.35;
    this.rig?.stop();
    this.aura?.dispose();
    this.aura = null;
    if (this.rig) this.rig.root.setEnabled(false);
  }

  /** Drive the character from one tick of simulation state. Position is set
   *  every frame; the clip only when the runner changes what it is doing. */
  setState(x: number, y: number, z: number, opts: { rolling: boolean; alive: boolean }): void {
    this.root.position.set(x, y, z);
    if (!opts.alive) {
      if (!this.crashed) {
        this.crashed = true;
        // Face-plant, once, then stay down: the run is over, and the body is
        // what the others see as they go past.
        this.play(CRASH_CLIP, false);
        // Drop the name tag with them. A tag is a fixed-size plane, so on the
        // body you spectate past it fills half the screen — and a runner who
        // is out is already reported on the scoreboard.
        if (this.tag) this.tag.setEnabled(false);
      }
      return;
    }
    if (opts.rolling) this.play(ROLL_CLIP, false);
    else this.play(RUN_CLIP, true);
  }

  private play(clipId: string, loop: boolean): void {
    if (this.clip === clipId || !this.rig || !getEmote(clipId)) return;
    this.clip = clipId;
    void this.rig.play(clipId, { loop });
  }

  dispose(): void {
    this.disposed = true;
    this.aura?.dispose();
    this.rig?.dispose();
    this.tagTex?.dispose();
    this.tag?.material?.dispose();
    this.tag?.dispose();
    this.root.dispose();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
