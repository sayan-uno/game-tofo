// The 3D showcase behind the collection page.
//
// It is a SECOND Scene on the SAME Engine and the SAME canvas — never a second
// Engine. Two WebGL contexts on a phone means double the driver memory and, on
// plenty of Android devices, the browser silently killing the older one. The
// lobby's render loop is swapped out for this scene's while the page is open,
// so exactly one scene is ever drawing.
//
// The character is drawn into a viewport covering only the left part of the
// canvas; the collection's item grid is opaque DOM sitting over the rest.
import { Scene } from "@babylonjs/core/scene";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { getEmote, getStanceClip } from "./assets";
import { CharacterRig } from "./characterRig";
import { attachAura, type Aura } from "./aura";
import { Turntable } from "./turntable";
import type { HeldWeapon } from "./weapon";

/** Where the model faces before anything is turned — the same "front to the
 *  camera" the lobby starts every character at. */
const FACING = Math.PI;

export class PreviewScene {
  readonly scene: Scene;
  private camera: TargetCamera;
  private rig: CharacterRig | null = null;
  /** Drag-to-turn, exactly as it feels in the lobby (see turntable.ts). */
  private turn = new Turntable();
  private aura: Aura | null = null;
  private weapon: HeldWeapon | null = null;
  /** Held across character swaps: picking a different character on the
   *  Characters tab should not put down the sword you were just looking at. */
  private weaponId: string | null = null;
  private weaponToken = 0;
  private characterId: string | null = null;
  /** Guards against a slow load landing after the player picked something
   *  else — without it, tapping two characters quickly can leave the loser
   *  on screen. */
  private token = 0;
  private idleClip: string;
  private unsubscribeEnd: (() => void) | null = null;

  constructor(engine: Engine, idleClip: string) {
    this.idleClip = idleClip;
    this.scene = new Scene(engine);
    this.scene.clearColor = new Color4(0.043, 0.02, 0.027, 1);
    this.scene.autoClear = true;
    // There is nothing in here to pick: the whole stage box turns the one model
    // standing in it. Skipping all three saves a ray per pointer event.
    this.scene.skipPointerMovePicking = true;
    this.scene.skipPointerDownPicking = true;
    this.scene.skipPointerUpPicking = true;

    // Fixed, like the lobby. The player turns the CHARACTER, not the camera —
    // an orbiting camera and a turning model look the same for one drag and
    // then diverge, and having the locker work one way and the podium the other
    // is the confusing half of that. Position is the old orbit framing
    // (alpha -π/2, beta 1.28, radius 4.6 about the chest) solved once.
    this.camera = new TargetCamera("previewCam", new Vector3(0, 2.269, -4.407), this.scene);
    this.camera.setTarget(new Vector3(0, 0.95, 0));

    const hemi = new HemisphericLight("previewHemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.85;
    hemi.groundColor = new Color3(0.16, 0.05, 0.07);
    const key = new DirectionalLight("previewKey", new Vector3(-0.45, -1, 0.55), this.scene);
    key.position = new Vector3(5, 9, -6);
    key.intensity = 1.15;
    const rim = new DirectionalLight("previewRim", new Vector3(0.6, -0.25, -0.8), this.scene);
    rim.diffuse = new Color3(1, 0.28, 0.36); // brand red edge light
    rim.intensity = 0.7;

    // A single emissive disc under the character. Cheap, and it stops the model
    // floating in a void without paying for a ground plane and shadows.
    const pad = MeshBuilder.CreateDisc("previewPad", { radius: 0.82, tessellation: 48 }, this.scene);
    pad.rotation.x = Math.PI / 2;
    pad.position.y = 0.002;
    pad.isPickable = false;
    const padMat = new StandardMaterial("previewPadMat", this.scene);
    padMat.emissiveColor = new Color3(0.34, 0.03, 0.07);
    padMat.disableLighting = true;
    pad.material = padMat;
    pad.freezeWorldMatrix();

    const ring = MeshBuilder.CreateTorus("previewRing", { diameter: 1.9, thickness: 0.012, tessellation: 64 }, this.scene);
    ring.position.y = 0.004;
    ring.isPickable = false;
    const ringMat = new StandardMaterial("previewRingMat", this.scene);
    ringMat.emissiveColor = new Color3(0.9, 0.09, 0.18);
    ringMat.disableLighting = true;
    ring.material = ringMat;
    ring.freezeWorldMatrix();

    // The lobby has one of these, so without it a character's emissive work —
    // Seraph's chest prism, the crystal along the coat — renders flat here and
    // glowing in the lobby, which reads as the collection being the broken one.
    // Quarter-res, and only ever running while the collection page is open.
    //
    // The pad and ring are excluded on purpose: they are flat emissive
    // decoration authored to sit BEHIND the character, and blooming them
    // washes a bright red haze up over its legs.
    const glow = new GlowLayer("previewGlow", this.scene, { mainTextureRatio: 0.25 });
    glow.intensity = 0.9;
    glow.addExcludedMesh(pad);
    glow.addExcludedMesh(ring);

    this.scene.onBeforeRenderObservable.add(() => {
      if (this.turn.step(Math.min(engine.getDeltaTime(), 100) / 1000)) this.applyTurn();
    });
  }

  /** Take hold of the model.
   *
   *  Turning is driven by the PAGE, from pointer events on its own stage
   *  element, not by this scene watching the canvas. The collection page is a
   *  full-screen overlay above the canvas, so canvas-level input never reaches
   *  it — and the element the player sees as the stage is exactly the surface
   *  that should turn the model, which makes this the honest wiring rather
   *  than a workaround. */
  grabTurn() {
    this.turn.grab();
  }

  /** Turn by a pointer that moved `dx` px, measured against `width` — pass the
   *  CANVAS width, not the stage's, so a swipe turns a character by the same
   *  amount here as it does in the lobby. */
  turnBy(dx: number, width: number) {
    this.turn.turn(dx, width);
    this.applyTurn();
  }

  /** Let go; whatever speed the drag had becomes the glide. */
  releaseTurn() {
    this.turn.release();
  }

  private applyTurn() {
    if (this.rig) this.rig.root.rotation.y = FACING + this.turn.angle;
  }

  /** Aim the camera at exactly the screen box the page left transparent for it.
   *  Measured from the real element rather than assumed, so the character stays
   *  centred in its column across every screen size and orientation without the
   *  layout and the 3D having to agree on numbers separately. */
  setViewportFromRect(box: DOMRect, canvas: HTMLCanvasElement) {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    this.camera.viewport = new Viewport(
      box.left / w,
      1 - box.bottom / h, // Babylon measures viewport Y from the bottom
      box.width / w,
      box.height / h
    );
  }

  /** Swap the shown character. Returns false when the model couldn't load, so
   *  the page can show a message instead of an empty stage. */
  async setCharacter(id: string): Promise<boolean> {
    if (this.characterId === id && this.rig) return true;
    const mine = ++this.token;
    this.characterId = id;

    const rig = await CharacterRig.create(id, this.scene, `preview_${id}`);
    if (mine !== this.token) {
      rig?.dispose(); // a newer pick won the race
      return false;
    }
    this.weaponToken++;
    this.weapon?.dispose();
    this.weapon = null;
    this.aura?.dispose();
    this.aura = null;
    this.rig?.dispose();
    this.rig = rig;
    if (!rig) return false;

    // A new subject on the stand faces front, however the last one was left.
    this.turn.reset();
    rig.root.rotation.y = FACING; // face the camera, same as the lobby
    await rig.play(this.stance(), { loop: true });

    const aura = await attachAura(id, rig, this.scene);
    if (mine === this.token) this.aura = aura;
    else aura?.dispose(); // a newer pick won the race
    // Only after a clip has posed the skeleton — see weapon.ts.
    if (mine === this.token) await this.hold(this.weaponId);
    return true;
  }

  /** The clip the character stands in: the held weapon's stance, or the idle
   *  when empty-handed. */
  private stance(): string {
    return getStanceClip(this.weaponId) ?? this.idleClip;
  }

  /** Show a weapon in the character's hand, or null for empty-handed. Picking
   *  one up changes the stance too — that is most of what makes it read as
   *  "armed" rather than "carrying a prop". */
  async setWeapon(id: string | null): Promise<void> {
    const before = this.stance();
    this.weaponId = id;
    const after = this.stance();
    await this.hold(id);
    // Only when it actually changes: replaying the same clip restarts it.
    if (after !== before && this.rig) await this.rig.play(after, { loop: true });
  }

  private async hold(id: string | null): Promise<void> {
    const mine = ++this.weaponToken;
    this.weapon?.dispose();
    this.weapon = null;
    const rig = this.rig;
    if (!id || !rig) return;
    const { attachWeapon } = await import("./weapon");
    const held = await attachWeapon(id, rig, this.scene);
    if (mine !== this.weaponToken) {
      held?.dispose();
      return;
    }
    this.weapon = held;
  }

  /** Play a clip once, then fall back to idle. Clips that travel are played on
   *  a re-centred root so the character can't walk out of frame. */
  async playClip(clipId: string): Promise<boolean> {
    const rig = this.rig;
    if (!rig) return false;
    const emote = getEmote(clipId);
    const ok = await rig.play(clipId);
    if (!ok) return false;

    this.unsubscribeEnd?.();
    this.unsubscribeEnd = null;
    if (!emote?.loop) {
      this.unsubscribeEnd = rig.onClipEnd(() => {
        this.unsubscribeEnd?.();
        this.unsubscribeEnd = null;
        void rig.play(this.stance(), { loop: true }); // back to the armed stance, not a bare idle
      });
    }
    return true;
  }

  dispose() {
    this.weapon?.dispose();
    this.aura?.dispose();
    this.unsubscribeEnd?.();
    this.rig?.dispose();
    this.scene.dispose();
  }
}
