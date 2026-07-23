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
import type { LobbyMember } from "../types";

// Fixed pedestal positions for up to 4 lobby members, local player centered.
const SLOTS: [number, number][] = [
  [0, 0],
  [-2.4, -0.6],
  [2.4, -0.6],
  [-4.6, -1.4],
];

/** Name line of the base plate: leader gets the star and the gold. Reused
 *  in place when leadership moves so the plate never gets rebuilt. */
function applyNameStyle(label: TextBlock, member: LobbyMember) {
  label.text = `${member.name}${member.isLeader ? " ★" : ""}`;
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
  /** Animated (bobbing) child holding the body meshes. */
  root: TransformNode;
  /** Name line of the base plate — updated in place when leadership moves. */
  label: TextBlock;
  isLeader: boolean;
  disposables: { dispose: () => void }[];
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

    // Idle "breathing" animation for characters — one observer for all.
    scene.onBeforeRenderObservable.add(() => {
      this.time += engine.getDeltaTime() / 1000;
      let i = 0;
      for (const character of this.characters.values()) {
        character.root.position.y = Math.sin(this.time * 1.6 + i * 1.3) * 0.04;
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
        return;
      }
      this.characters.set(member.uid, this.createCharacter(member, x, z));
    });
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
    applyNameStyle(label, member);
    label.fontSize = 14;
    label.fontFamily = '"Archivo Black", system-ui, sans-serif';
    plate.addControl(label);
    disposables.push(plate);

    // Characters face the camera side
    anchor.rotation.y = Math.PI;

    return { anchor, root, label, isLeader: member.isLeader, disposables };
  }

  dispose() {
    this.scene.dispose();
  }
}
