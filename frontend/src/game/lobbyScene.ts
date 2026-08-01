// The Free Fire-style lobby scene.
// Performance notes baked in:
//  - tree-shaken imports (only what we use ships in the bundle)
//  - static meshes get frozen world matrices, materials get frozen after setup
//  - pointer-move picking disabled (big win on mobile)
//  - one fullscreen GUI texture for all name plates, linked to static meshes
//    (pedestals) so idle-animation frames never force a GUI repaint
import { Scene } from "@babylonjs/core/scene";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import "@babylonjs/core/Layers/effectLayerSceneComponent";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
// Side-effect import: registers the REAL Scene.prototype.pick. Without it,
// tree-shaken builds get a stub that always returns an empty PickingInfo,
// so character taps silently hit nothing.
import "@babylonjs/core/Culling/ray";
import type { Node } from "@babylonjs/core/node";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { getLobbyIdleClip, hasAssets } from "./assets";
import type { CharacterRig } from "./characterRig";
import type { LobbyMember } from "../types";

// Fixed pedestal positions for up to 4 lobby members, local player centered.
const SLOTS: [number, number][] = [
  [0, 0],
  [-2.4, -0.6],
  [2.4, -0.6],
  [-4.6, -1.4],
];

// Shared 2D context for name-plate text measurement — a few µs per member
// change, never per frame. (A DOM-style scrolling reveal is out here on
// purpose: animating a GUI TextBlock would repaint the fullscreen GUI texture
// every frame, exactly what this scene is built to avoid.)
let measureCtx: CanvasRenderingContext2D | null = null;

/** Largest font size (14 down to 9) at which the plate text fits the 160px
 *  banner. Usernames cap at 15 chars, so 9px covers even all-wide-glyph
 *  names; anything still wider just clips inside the plate — the plate
 *  itself never grows or shifts. */
function fitPlateFontSize(text: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 14;
  for (let size = 14; size > 9; size--) {
    measureCtx.font = `${size}px "Archivo Black", system-ui, sans-serif`;
    if (measureCtx.measureText(text).width <= 142) return size;
  }
  return 9;
}

/** Name line of the base plate: leader gets the star and the gold. Reused
 *  in place when leadership moves so the plate never gets rebuilt. */
function applyNameStyle(label: TextBlock, member: LobbyMember) {
  const text = `${member.name}${member.isLeader ? " ★" : ""}`;
  label.text = text;
  label.fontSize = fitPlateFontSize(text);
  label.color = member.isLeader ? "#ffd45e" : "#f2f5ff";
}

function colorFromUid(uid: string): Color3 {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  const hue = (hash % 360) / 360;
  return Color3.FromHSV(hue * 360, 0.65, 0.9);
}

interface CharacterInstance {
  /** Fixed slot node — parent of everything, including the pedestal disc. */
  anchor: TransformNode;
  /** Animated (bobbing) child holding the PLACEHOLDER body meshes. Real models
   *  hang off the anchor instead and bob through their own idle clip. */
  root: TransformNode;
  /** Name line of the base plate — updated in place when leadership moves. */
  label: TextBlock;
  /** Free Fire-style chat bubble over the head; hidden until a team message. */
  bubble: Rectangle;
  bubbleText: TextBlock;
  bubbleTimer: number;
  isLeader: boolean;
  disposables: { dispose: () => void }[];
  /** Catalog id currently shown, so an equip elsewhere swaps just this model. */
  characterId: string;
  /** The loaded model, once it arrives. Null while loading, and for good if
   *  the CDN is unreachable — the placeholder simply stays. */
  rig: CharacterRig | null;
  /** Rises on every character change; a load that finishes after a newer one
   *  started sees a stale token and throws its result away. */
  loadToken: number;
}

export class LobbyScene {
  readonly scene: Scene;
  private gui: AdvancedDynamicTexture;
  private characters = new Map<string, CharacterInstance>();
  private localUid: string;
  private time = 0;

  constructor(engine: Engine, localUid: string, onMemberTap?: (uid: string) => void) {
    this.localUid = localUid;
    this.scene = new Scene(engine);
    const scene = this.scene;

    scene.clearColor = new Color4(0.02, 0.03, 0.07, 1);
    scene.skipPointerMovePicking = true; // no hover picking needed in the lobby

    // Tap a character → report which member was tapped (one raycast per tap,
    // never per frame; camera drags don't count as taps). The picked mesh's
    // ancestor chain carries the member uid in its metadata.
    if (onMemberTap) {
      scene.onPointerObservable.add((pointerInfo) => {
        if (pointerInfo.type !== PointerEventTypes.POINTERTAP) return;
        let node: Node | null = pointerInfo.pickInfo?.pickedMesh ?? null;
        while (node) {
          const uid = (node.metadata as { memberUid?: string } | null)?.memberUid;
          if (uid) {
            onMemberTap(uid);
            return;
          }
          node = node.parent;
        }
      });
    }

    // Camera: gentle framing like a lobby showcase; user can rotate a little.
    const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.25, 9, new Vector3(0, 1.2, 0), scene);
    camera.attachControl(engine.getRenderingCanvas(), true);
    camera.lowerRadiusLimit = 6;
    camera.upperRadiusLimit = 13;
    camera.lowerBetaLimit = 1.0;
    camera.upperBetaLimit = 1.45;
    camera.wheelPrecision = 40;
    camera.pinchPrecision = 120;
    camera.panningSensibility = 0; // no panning — keeps the scene framed

    // Lighting: one hemispheric + one directional. Cheap and looks clean.
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.55;
    hemi.groundColor = new Color3(0.05, 0.08, 0.2);
    const dir = new DirectionalLight("dir", new Vector3(-0.4, -1, 0.6), scene);
    dir.position = new Vector3(6, 12, -8);
    dir.intensity = 0.9;

    // Subtle glow for the neon accents (low cost with small kernel).
    const glow = new GlowLayer("glow", scene, { mainTextureRatio: 0.25 });
    glow.intensity = 0.6;

    this.buildEnvironment();

    this.gui = AdvancedDynamicTexture.CreateFullscreenUI("ui", true, scene);
    this.gui.renderScale = 1;

    // Idle "breathing" for PLACEHOLDER bodies only — one observer for all.
    // A loaded character animates through its own idle clip; bobbing it too
    // would fight that clip and read as a jitter, so rigged slots are skipped.
    scene.onBeforeRenderObservable.add(() => {
      this.time += engine.getDeltaTime() / 1000;
      let i = 0;
      for (const character of this.characters.values()) {
        if (!character.rig) character.root.position.y = Math.sin(this.time * 1.6 + i * 1.3) * 0.04;
        i++;
      }
    });
  }

  private buildEnvironment() {
    const scene = this.scene;

    // Floor
    const ground = MeshBuilder.CreateDisc("ground", { radius: 14, tessellation: 48 }, scene);
    ground.isPickable = false; // only characters need tap-picking
    ground.rotation.x = Math.PI / 2;
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.05, 0.07, 0.13);
    groundMat.specularColor = new Color3(0.02, 0.02, 0.04);
    ground.material = groundMat;

    // Neon ring accent around the stage
    const ring = MeshBuilder.CreateTorus("ring", { diameter: 12, thickness: 0.06, tessellation: 64 }, scene);
    ring.isPickable = false;
    ring.position.y = 0.02;
    const ringMat = new StandardMaterial("ringMat", scene);
    ringMat.emissiveColor = new Color3(0.1, 0.6, 1.0);
    ringMat.disableLighting = true;
    ring.material = ringMat;

    // Back wall panels for depth
    const panelMat = new StandardMaterial("panelMat", scene);
    panelMat.diffuseColor = new Color3(0.04, 0.05, 0.1);
    panelMat.emissiveColor = new Color3(0.01, 0.02, 0.05);
    const basePanel = MeshBuilder.CreateBox("panel0", { width: 2.2, height: 6, depth: 0.3 }, scene);
    basePanel.isPickable = false;
    basePanel.material = panelMat;
    basePanel.position.set(0, 3, 8);
    for (let i = 1; i < 7; i++) {
      // Instances share geometry+material: 7 panels ≈ cost of 1 draw call
      const inst = basePanel.createInstance(`panel${i}`);
      inst.isPickable = false;
      const angle = (i - 3) * 0.28;
      inst.position.set(Math.sin(angle) * 11, 3, Math.cos(angle) * 8 + 1);
      inst.rotation.y = -angle;
      inst.freezeWorldMatrix();
    }

    // Everything above is static — freeze it all.
    ground.freezeWorldMatrix();
    ring.freezeWorldMatrix();
    basePanel.freezeWorldMatrix();
    scene.freezeMaterials();
  }

  /** Rebuild the characters to match the lobby member list. */
  setMembers(members: LobbyMember[]) {
    // Local player always takes the center slot.
    const ordered = [...members].sort((a, b) =>
      a.uid === this.localUid ? -1 : b.uid === this.localUid ? 1 : a.uid.localeCompare(b.uid)
    );

    // Remove characters that left. Disposing the anchor takes the whole
    // hierarchy with it — body, name plate link AND the pedestal disc, which
    // used to linger as a bare white plate when only the root was disposed.
    const keep = new Set(ordered.map((m) => m.uid));
    for (const [uid, character] of this.characters) {
      if (!keep.has(uid)) {
        clearTimeout(character.bubbleTimer);
        character.loadToken++; // strand any load still in flight for this slot
        character.rig?.dispose();
        character.anchor.dispose();
        character.disposables.forEach((d) => d.dispose());
        this.characters.delete(uid);
      }
    }

    ordered.forEach((member, index) => {
      const [x, z] = SLOTS[index] ?? [0, 0];
      const existing = this.characters.get(member.uid);
      if (existing) {
        existing.anchor.position.set(x, 0, z);
        if (existing.isLeader !== member.isLeader) {
          // Leadership moved (transfer / old leader left) — restar the plate.
          existing.isLeader = member.isLeader;
          applyNameStyle(existing.label, member);
        }
        // Someone equipped a different character — swap just that model, keep
        // the pedestal, plate and any bubble exactly as they are.
        if (existing.characterId !== member.character) {
          existing.characterId = member.character;
          void this.attachModel(existing, member.character);
        }
        return;
      }
      this.characters.set(member.uid, this.createCharacter(member, x, z));
    });
  }

  /** Load a character model into a slot and retire its placeholder. Failure is
   *  survivable by design: the placeholder body stays and the lobby keeps
   *  working exactly as it did before models existed. */
  private async attachModel(character: CharacterInstance, characterId: string): Promise<void> {
    if (!hasAssets()) return;
    const mine = ++character.loadToken;
    const idle = getLobbyIdleClip();

    // Dynamic: Babylon's skinning + animation machinery is ~550 kB and the
    // lobby has already painted placeholders by now. Downloading it here means
    // the first frame never waited for it.
    const { CharacterRig } = await import("./characterRig");
    const rig = await CharacterRig.create(characterId, this.scene, `rig_${character.anchor.name}`);
    // Slot was removed, or a newer character was picked, while this loaded.
    if (mine !== character.loadToken) {
      rig?.dispose();
      return;
    }
    if (!rig) return; // keep the placeholder

    character.rig?.dispose();
    character.rig = rig;
    // Parented to the anchor, not the bobbing root: the model's own idle clip
    // provides the motion, and the plate/bubble links stay rock steady.
    // No scaling here: the rig measures the model and sizes itself to
    // CHARACTER_HEIGHT with its feet on the pedestal.
    rig.root.parent = character.anchor;

    // Placeholder primitives are no longer needed. Their meshes hang off the
    // bobbing root, so emptying it also parks the bob at zero.
    for (const child of character.root.getChildren()) child.dispose();
    character.root.position.y = 0;

    if (idle) await rig.play(idle, { loop: true });
  }

  /** Free Fire-style team chat callout: a truncated preview of the message in
   *  a bubble over the sender's head, so teammates notice who is talking even
   *  with the chat panel closed. Repeat messages replace the text and restart
   *  the clock. Costs nothing while idle — the bubble is a hidden GUI control
   *  linked to a static mesh, repainted only on show/hide/text change. */
  showChatBubble(uid: string, text: string) {
    const character = this.characters.get(uid);
    if (!character) return;
    // Truncate by code point, not UTF-16 unit, so an emoji at the cut never
    // ends the preview on a broken half-character ("�").
    const chars = [...text];
    character.bubbleText.text = chars.length > 64 ? `${chars.slice(0, 63).join("")}…` : text;
    character.bubble.isVisible = true;
    clearTimeout(character.bubbleTimer);
    character.bubbleTimer = window.setTimeout(() => {
      character.bubble.isVisible = false;
    }, 4500);
  }

  /** Placeholder stylized character (primitives). Swap for a GLB model later —
   *  keep the same slot/anchor structure and nothing else changes. */
  private createCharacter(member: LobbyMember, x: number, z: number): CharacterInstance {
    const scene = this.scene;
    const disposables: { dispose: () => void }[] = [];

    // anchor = fixed slot position; root = animated (bobbing) child
    const anchor = new TransformNode(`anchor_${member.uid}`, scene);
    anchor.metadata = { memberUid: member.uid }; // tap-picking looks this up
    anchor.position.set(x, 0, z);
    const root = new TransformNode(`char_${member.uid}`, scene);
    root.parent = anchor;

    const accent = colorFromUid(member.uid);

    const bodyMat = new StandardMaterial(`bodyMat_${member.uid}`, scene);
    bodyMat.diffuseColor = accent.scale(0.5);
    bodyMat.specularColor = new Color3(0.1, 0.1, 0.1);
    disposables.push(bodyMat);

    const accentMat = new StandardMaterial(`accentMat_${member.uid}`, scene);
    accentMat.emissiveColor = accent;
    accentMat.disableLighting = true;
    disposables.push(accentMat);

    const skinMat = new StandardMaterial(`skinMat_${member.uid}`, scene);
    skinMat.diffuseColor = new Color3(0.85, 0.7, 0.6);
    disposables.push(skinMat);

    const body = MeshBuilder.CreateCapsule(`body_${member.uid}`, { height: 1.5, radius: 0.34 }, scene);
    body.position.y = 1.05;
    body.material = bodyMat;
    body.parent = root;

    const head = MeshBuilder.CreateSphere(`head_${member.uid}`, { diameter: 0.5, segments: 12 }, scene);
    head.position.y = 2.05;
    head.material = skinMat;
    head.parent = root;

    const visor = MeshBuilder.CreateBox(`visor_${member.uid}`, { width: 0.42, height: 0.12, depth: 0.1 }, scene);
    visor.position.set(0, 2.08, -0.22);
    visor.material = accentMat;
    visor.parent = root;

    const makeLimb = (name: string, lx: number): Mesh => {
      const limb = MeshBuilder.CreateCapsule(name, { height: 1.0, radius: 0.11 }, scene);
      limb.position.set(lx, 1.15, 0);
      limb.material = bodyMat;
      limb.parent = root;
      return limb;
    };
    makeLimb(`armL_${member.uid}`, -0.48);
    makeLimb(`armR_${member.uid}`, 0.48);

    const legMat = bodyMat;
    for (const [name, lx] of [
      [`legL_${member.uid}`, -0.18],
      [`legR_${member.uid}`, 0.18],
    ] as [string, number][]) {
      const leg = MeshBuilder.CreateCapsule(name, { height: 0.9, radius: 0.13 }, scene);
      leg.position.set(lx, 0.45, 0);
      leg.material = legMat;
      leg.parent = root;
    }

    // Glowing pedestal under each player
    const pedestal = MeshBuilder.CreateCylinder(`ped_${member.uid}`, { diameter: 1.6, height: 0.08 }, scene);
    pedestal.position.y = 0.04;
    pedestal.material = accentMat;
    pedestal.parent = anchor;

    // Name plate at the character's base (Free Fire/PUBG style: a banner on
    // the podium, not floating over the head). Linked to the STATIC pedestal
    // rather than the bobbing body — a link target that never moves means the
    // fullscreen GUI texture stops repainting every animation frame.
    const plate = new Rectangle(`plate_${member.uid}`);
    plate.width = "160px";
    plate.height = "30px";
    plate.cornerRadius = 6;
    plate.thickness = 1.5;
    plate.color = accent.toHexString(); // border ties the plate to the pedestal glow
    plate.background = "rgba(8, 12, 26, 0.85)";
    this.gui.addControl(plate);
    plate.linkWithMesh(pedestal);
    plate.linkOffsetY = 30; // px below the pedestal → sits on the floor in front

    const label = new TextBlock(`label_${member.uid}`);
    label.fontFamily = '"Archivo Black", system-ui, sans-serif';
    applyNameStyle(label, member); // sets text, color AND the fitted fontSize
    plate.addControl(label);
    disposables.push(plate);

    // Chat bubble over the head. Linked to a tiny STATIC invisible mesh at
    // head height (parented to the anchor, not the bobbing root) so the
    // projection tracks zoom correctly without forcing a GUI repaint every
    // animation frame — same trick as the base plate.
    const bubbleAnchor = MeshBuilder.CreateBox(`bubbleAnchor_${member.uid}`, { size: 0.01 }, scene);
    bubbleAnchor.isVisible = false;
    bubbleAnchor.isPickable = false;
    bubbleAnchor.position.y = 2.6;
    bubbleAnchor.parent = anchor;

    const bubble = new Rectangle(`bubble_${member.uid}`);
    bubble.width = "150px";
    bubble.adaptHeightToChildren = true;
    bubble.cornerRadius = 8;
    bubble.thickness = 1.5;
    bubble.color = accent.toHexString();
    bubble.background = "rgba(8, 12, 26, 0.9)";
    bubble.isVisible = false;
    bubble.isHitTestVisible = false; // never steal character taps
    this.gui.addControl(bubble);
    bubble.linkWithMesh(bubbleAnchor);
    bubble.linkOffsetY = -22;

    const bubbleText = new TextBlock(`bubbleText_${member.uid}`);
    bubbleText.textWrapping = true; // word-wrap (TextWrapping is a const enum — unusable under isolatedModules)
    bubbleText.resizeToFit = true; // grows the bubble's height with the text
    bubbleText.color = "#f2f5ff";
    bubbleText.fontSize = 12;
    bubbleText.fontFamily = "system-ui, sans-serif";
    bubbleText.paddingTop = "6px";
    bubbleText.paddingBottom = "6px";
    bubbleText.paddingLeft = "8px";
    bubbleText.paddingRight = "8px";
    bubble.addControl(bubbleText);
    disposables.push(bubble);

    // Characters face the camera side
    anchor.rotation.y = Math.PI;

    const instance: CharacterInstance = {
      anchor,
      root,
      label,
      bubble,
      bubbleText,
      bubbleTimer: 0,
      isLeader: member.isLeader,
      disposables,
      characterId: member.character,
      rig: null,
      loadToken: 0,
    };
    // The primitives above are already on screen; the real model replaces them
    // whenever it finishes downloading. Nobody waits on a network round trip to
    // see their squad. Tap-picking keeps working throughout — it walks up to
    // the anchor, which both the placeholder and the model hang off.
    void this.attachModel(instance, member.character);
    return instance;
  }

  dispose() {
    for (const character of this.characters.values()) {
      clearTimeout(character.bubbleTimer);
      character.loadToken++;
      character.rig?.dispose();
    }
    this.characters.clear();
    this.scene.dispose();
  }
}
