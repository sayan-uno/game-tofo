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
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { getEmote } from "./assets";
import { CharacterRig } from "./characterRig";

export class PreviewScene {
  readonly scene: Scene;
  private camera: ArcRotateCamera;
  private rig: CharacterRig | null = null;
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
    this.scene.skipPointerMovePicking = true;
    this.scene.autoClear = true;

    this.camera = new ArcRotateCamera("previewCam", -Math.PI / 2, 1.28, 4.6, new Vector3(0, 0.95, 0), this.scene);
    this.camera.attachControl(engine.getRenderingCanvas(), true);
    this.camera.lowerRadiusLimit = 2.6;
    this.camera.upperRadiusLimit = 7;
    this.camera.lowerBetaLimit = 0.75;
    this.camera.upperBetaLimit = 1.62;
    this.camera.wheelPrecision = 60;
    this.camera.pinchPrecision = 140;
    this.camera.panningSensibility = 0; // framing stays put; rotate only

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
    this.rig?.dispose();
    this.rig = rig;
    if (!rig) return false;

    rig.root.rotation.y = Math.PI; // face the camera, same as the lobby
    await rig.play(this.idleClip, { loop: true });
    return true;
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
        void rig.play(this.idleClip, { loop: true });
      });
    }
    return true;
  }

  /** Gentle auto-spin so a showcased character reads as 3D without the player
   *  having to drag. Any manual rotation simply moves alpha from here. */
  spin(deltaMs: number) {
    this.camera.alpha += deltaMs * 0.00016;
  }

  dispose() {
    this.unsubscribeEnd?.();
    this.rig?.dispose();
    this.scene.dispose();
  }
}
