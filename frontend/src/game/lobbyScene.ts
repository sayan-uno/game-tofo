// The TOFO lobby: painted backdrop art, one fixed camera, characters you spin.
//
// The scene is deliberately composed like a POSTER rather than a room you fly
// around in. The backdrop is a single full-screen image drawn behind
// everything, the camera never moves, and the only thing a drag can touch is
// the character it started on. That buys three things at once: the framing can
// never be broken by the player, the painted art and the 3D characters always
// share one perspective, and the whole environment costs a single textured
// quad instead of a room full of geometry.
//
// Performance notes baked in:
//  - tree-shaken imports (only what we use ships in the bundle)
//  - one full-screen quad for the entire environment; no walls, no ground mesh
//  - a fixed camera means no per-frame camera matrix churn and, more usefully,
//    GUI plates linked to static meshes never re-project, so the fullscreen GUI
//    texture is painted on member changes only — never per frame
//  - picking is one ray against ONE invisible box per member (4 max) rather
//    than against skinned character meshes, so a tap costs microseconds
//  - pointer-move picking disabled entirely
import { plateText } from "./plate";
import { Scene } from "@babylonjs/core/scene";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Layer } from "@babylonjs/core/Layers/layer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import "@babylonjs/core/Layers/effectLayerSceneComponent";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
// Side-effect import: registers the REAL Scene.prototype.pick. Without it,
// tree-shaken builds get a stub that always returns an empty PickingInfo,
// so character taps silently hit nothing.
import "@babylonjs/core/Culling/ray";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { IPointerEvent } from "@babylonjs/core/Events/deviceInputEvents";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { Control } from "@babylonjs/gui/2D/controls/control";
import { onTalkingChange } from "../voice/livekit";
import { CHARACTER_HEIGHT, getPerformableEmotes, getStanceClip, hasAssets } from "./assets";
import type { CharacterRig } from "./characterRig";
import { attachAura, type Aura } from "./aura";
import type { HeldWeapon } from "./weapon";
import { Turntable } from "./turntable";
import type { LobbyMember } from "../types";

/** Painted stage art, served from our own origin (179 kB WebP). */
const BACKDROP_URL = "/lobby-bg.webp";
/** Aspect the art was authored at — the cover-fit maths needs it. */
const BACKDROP_ASPECT = 1536 / 1024;
/** Zoom applied on top of cover-fit, so the slow drift below always has art to
 *  drift INTO and can never expose an edge. */
const BACKDROP_OVERSCAN = 1.035;

/** Camera. Level (no downward pitch) on purpose: the backdrop is a photograph
 *  of a level camera — its horizon sits on the frame's centre line — and a
 *  tilted 3D camera would put the characters on a floor that visibly disagrees
 *  with the painted one. Everything else about the framing is derived, not
 *  guessed: see frameCamera(). */
const CAM_HEIGHT = 0.96;
const CAM_FOV = 0.78;
/** Where the characters' feet should land, as a fraction of screen height.
 *  With CAM_HEIGHT this is the whole composition in two numbers: they decide
 *  how far back the camera stands, and therefore how big the squad reads. A
 *  character ends up filling `CHARACTER_HEIGHT x (2 x FEET_AT - 1) / (2 x
 *  CAM_HEIGHT)` of the screen whenever height is the binding constraint —
 *  about 63%, which is the size a lobby hero reads at.
 *
 *  The two move TOGETHER: lowering both keeps that fraction identical while
 *  lifting the whole line-up up the screen, which is how the name plates stay
 *  clear of the chat button and the party card in the bottom corners without
 *  the squad having to shrink. */
const FEET_AT = 0.835;

const ACCENT = "#e5182e"; // brand crimson
const ACCENT_LEADER = "#ffd45e";
/** Ready. Green rather than the platform crimson: crimson is "act now" and
 *  belongs to START, and a lobby where four plates shout at once says
 *  nothing. */
const ACCENT_READY = "#7ddca0";
const PAD_TINT = new Color3(0.92, 0.1, 0.19);
const PAD_TINT_LEADER = new Color3(1.0, 0.74, 0.26);

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

/** Name line of the base plate: leader gets the star and the gold, and anybody
 *  who has said they are ready gets a tick. Reused in place when leadership
 *  moves or somebody readies up, so the plate is never rebuilt.
 *
 *  The tick goes in the NAME, not in a badge of its own: the question it
 *  answers is "who are we waiting for", and the answer is only readable if it
 *  is attached to the person. */
function applyNameStyle(plate: Rectangle, label: TextBlock, member: LobbyMember, ready = false) {
  const text = plateText(member.name, member.isLeader, ready);
  label.text = text;
  label.fontSize = fitPlateFontSize(text);
  const ticked = ready && !member.isLeader;
  label.color = member.isLeader ? ACCENT_LEADER : ticked ? ACCENT_READY : "#f2f5ff";
  plate.color = member.isLeader ? ACCENT_LEADER : ticked ? ACCENT_READY : ACCENT;
}

/** Where each member stands, for a squad of `count`.
 *
 *  Returned centre-out — index 0 is the middle-most spot — because the caller
 *  hands out slots in that order and the local player is always first. The
 *  squad therefore opens outwards around you as people join rather than
 *  shuffling you sideways into a queue.
 *
 *  The z stagger is what stops four characters reading as a flat cut-out row:
 *  the outer ones stand slightly further back, so the group curves away from
 *  the camera the way a lobby line-up does. */
function layoutFor(count: number): [number, number][] {
  const n = Math.min(Math.max(count, 1), 4);
  // Tight enough that four still read big, wide enough that the floor pads
  // (0.6 radius) keep clear air between them.
  const spacing = n >= 4 ? 1.4 : n === 3 ? 1.6 : 1.85;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push((i - (n - 1) / 2) * spacing);
  return xs
    .map((x, i) => ({ x, i }))
    .sort((a, b) => Math.abs(a.x) - Math.abs(b.x) || a.x - b.x)
    .map(({ x }): [number, number] => [x, 0.12 * Math.abs(x) - 0.05]);
}

/** The light pool + contact shadow under a character, drawn once and shared by
 *  every slot.
 *
 *  White where the slot's accent colour should come through, BLACK in the
 *  middle: the material tints by multiplying, and anything times black stays
 *  black, so the contact shadow reads as a shadow whether the character is
 *  standing on a crimson pad or a leader's gold one. One texture, two
 *  materials, no per-member allocation. */
function createPadTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("padTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext();
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, "rgba(0,0,0,0.66)"); // feet: contact shadow
  grad.addColorStop(0.34, "rgba(0,0,0,0.42)");
  grad.addColorStop(0.54, "rgba(70,70,70,0.2)");
  grad.addColorStop(0.74, "rgba(255,255,255,0.4)"); // light pool
  grad.addColorStop(0.84, "rgba(255,255,255,0.72)"); // rim
  grad.addColorStop(0.91, "rgba(255,255,255,0.26)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  tex.update(false);
  tex.hasAlpha = true;
  return tex;
}

/** Only the invisible per-member hit boxes are pickable, and they are boxes, so
 *  a tap costs a handful of ray/AABB tests — never a triangle sweep over a
 *  skinned character. Replaces Babylon's default predicate, which also demands
 *  isVisible and so would skip the hit boxes entirely. */
const isHitBox = (mesh: AbstractMesh): boolean =>
  mesh.isPickable && mesh.isEnabled() && (mesh.metadata as { hit?: boolean } | null)?.hit === true;

const uidOfPick = (mesh: AbstractMesh | null | undefined): string | null =>
  (mesh?.metadata as { memberUid?: string } | null)?.memberUid ?? null;

interface CharacterInstance {
  /** Fixed slot node — parent of everything, including the pedestal pad. */
  anchor: TransformNode;
  /** Turntable between the anchor and the character: a drag writes here, so
   *  the pad, the plate link and the chat bubble anchor never move with it. */
  spinner: TransformNode;
  /** Animated (bobbing) child. Holds the primitive fallback body when one is
   *  needed; real models hang off the spinner and bob via their own idle clip. */
  root: TransformNode;
  /** Glowing floor pad. The plate hangs off it and it is what seats the
   *  character on the painted floor. */
  pad: Mesh;
  /** Invisible box the pointer actually hits — see isHitBox. */
  hit: Mesh;
  /** The plate frame, restyled in place when leadership moves. */
  plate: Rectangle;
  /** Name line of the base plate — updated in place when leadership moves. */
  label: TextBlock;
  /** Microphone beside the name, shown ONLY while this member is actually
   *  speaking. "Their mic is on" is not worth drawing: everyone's mic is on.
   *  Toggled from LiveKit's active-speaker events, which fire a few times a
   *  second at most — not per frame — so the GUI texture is not repainting
   *  constantly (see the linkWithMesh notes above for why that matters). */
  mic: TextBlock;
  /** Free Fire-style chat bubble over the head; hidden until a team message. */
  bubble: Rectangle;
  bubbleText: TextBlock;
  bubbleTimer: number;
  /** Game-pack download bar under the plate: track + fill, built on first
   *  use and shown only while a game is picked. -1 = failed. */
  loadBar: { track: Rectangle; fill: Rectangle; pct: number } | null;
  isLeader: boolean;
  /** The undecorated name, kept because the plate's text is not it: that
   *  carries the leader star and the ready tick, and rebuilding the line from
   *  a decorated one would compound them. */
  name: string;
  /** Said they want to play what is picked. Held here so restyling the plate
   *  for any other reason — leadership moving — does not drop the tick. */
  ready: boolean;
  disposables: { dispose: () => void }[];
  uid: string;
  /** Slot this member is walking to — the anchor eases towards it, so a join
   *  or a leave opens the line-up instead of teleporting everyone. */
  slotX: number;
  slotZ: number;
  /** Drag-to-turn state. The feel lives in turntable.ts, shared with the
   *  collection preview. */
  turn: Turntable;
  /** Catalog id currently shown, so an equip elsewhere swaps just this model. */
  characterId: string;
  /** Weapon catalog id currently shown, null for empty-handed. */
  weaponId: string | null;
  /** The loaded model, once it arrives. Null while loading, and for good if
   *  the CDN is unreachable — in which case the fallback body is built. */
  rig: CharacterRig | null;
  /** Only present on characters the catalog marks legendary. */
  aura: Aura | null;
  /** What's in their hand, once it arrives. */
  weapon: HeldWeapon | null;
  /** Clip currently looping on this slot. Tracked so picking a weapon up
   *  switches stance exactly once — calling play() again with the same clip
   *  restarts it, which reads as the character flinching. */
  clipId: string | null;
  /** Unsubscribe for the "emote finished, go back to standing" hook, and the
   *  token that stops a finished emote from re-posing a character that has
   *  since been swapped or has started a newer emote. */
  emoteEnd: (() => void) | null;
  emoteToken: number;
  /** Rises on every character change; a load that finishes after a newer one
   *  started sees a stale token and throws its result away. */
  loadToken: number;
  /** The same guard for weapons, counted separately: swapping a sword must not
   *  invalidate a character load that is still in flight beside it. */
  weaponToken: number;
}

export class LobbyScene {
  readonly scene: Scene;
  private camera: TargetCamera;
  private backdrop: Layer;
  private glow: GlowLayer;
  private gui: AdvancedDynamicTexture;
  private padTexture!: DynamicTexture;
  private padMat!: StandardMaterial;
  private padMatLeader!: StandardMaterial;
  private characters = new Map<string, CharacterInstance>();
  /** Stops listening to LiveKit's active-speaker events when the stage goes. */
  private untalk: (() => void) | null = null;
  private localUid: string;
  private time = 0;
  /** How far the widest member stands from the middle — the camera pulls back
   *  to fit it. */
  private spread = 0;
  /** performance.now() of the last frame this scene drew. See isBeingWatched.
   *
   *  Starts as "now" rather than zero: a scene is built because somebody is
   *  about to look at it, and the first frame has not happened yet. Zero would
   *  mean the first moment of a lobby's life counts as unwatched — which the
   *  admin studio would hit every time, since it delivers the events for a
   *  moment and only then draws it. */
  private lastRenderAt = performance.now();
  /** How much room the backdrop's overscan leaves for the drift, in NDC. */
  private driftRoom = 0;
  /** Drawing surface the current framing was computed for — see refit(). */
  private viewWidth = 0;
  private viewHeight = 0;
  /** The character being turned, and the pointer turning it. */
  private drag: { uid: string; pointerId: number; lastX: number } | null = null;
  private onCaptureLost: (() => void) | null = null;

  constructor(engine: Engine, localUid: string, onMemberTap?: (uid: string) => void) {
    this.localUid = localUid;
    this.scene = new Scene(engine);
    // When this scene was last actually DRAWN.
    //
    // Measured rather than inferred. Whether the lobby is on screen has four
    // different answers — the tab is hidden, a full-screen page has covered
    // it, the collection has borrowed the canvas for its own preview, or the
    // admin console is driving it a frame at a time — and a guard built by
    // listing those gets one wrong the first time a fifth is added. A scene
    // that is being watched renders; one that is not, does not. That is the
    // whole condition, and this is it directly.
    this.scene.onAfterRenderObservable.add(() => {
      this.lastRenderAt = performance.now();
    });
    const scene = this.scene;

    scene.clearColor = new Color4(0.02, 0.01, 0.02, 1);
    scene.skipPointerMovePicking = true; // no hover picking needed in the lobby

    // Light the microphone on whoever is speaking. Event-driven, not polled:
    // LiveKit tells every client the same thing at the same time, so the whole
    // squad sees the same person light up, and nothing runs per frame.
    this.untalk = onTalkingChange((uids) => {
      for (const [uid, character] of this.characters) {
        const talking = uids.has(uid);
        if (character.mic.isVisible !== talking) character.mic.isVisible = talking;
      }
    });
    // Both pointer picks the input manager runs for us are narrowed to the hit
    // boxes, so POINTERDOWN (start a turn) and POINTERTAP (open a card) both
    // land on the member without a second raycast of our own.
    scene.pointerDownPredicate = isHitBox;
    scene.pointerUpPredicate = isHitBox;

    // Camera: fixed. No attachControl anywhere — the lobby is a composed shot,
    // and letting it orbit is what made the old one feel like a level editor.
    this.camera = new TargetCamera("cam", new Vector3(0, CAM_HEIGHT, -5), scene);
    this.camera.fov = CAM_FOV;
    this.camera.minZ = 0.6;
    this.camera.maxZ = 60;
    this.camera.setTarget(new Vector3(0, CAM_HEIGHT, 0));

    // The environment, in one draw call.
    this.backdrop = new Layer("backdrop", BACKDROP_URL, scene, true);
    if (this.backdrop.texture) {
      this.backdrop.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.backdrop.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.backdrop.texture.anisotropicFilteringLevel = 1; // no mips on a layer
    }

    // Lighting matched to the backdrop AND to the collection preview, so a
    // character never looks like two different characters in the two places:
    // a soft cool fill, a warm key from the front left, and a crimson rim from
    // behind that lifts them off the painted arena.
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.6;
    hemi.groundColor = new Color3(0.16, 0.05, 0.07);
    const key = new DirectionalLight("key", new Vector3(-0.45, -1, 0.55), scene);
    key.position = new Vector3(5, 9, -6);
    key.intensity = 1.05;
    const rim = new DirectionalLight("rim", new Vector3(0.55, -0.25, -0.85), scene);
    rim.diffuse = new Color3(1, 0.28, 0.36);
    rim.intensity = 0.75;

    // Subtle glow for the neon accents (low cost with small kernel).
    this.glow = new GlowLayer("glow", scene, { mainTextureRatio: 0.25 });
    this.glow.intensity = 0.6;

    this.buildStage();

    this.gui = AdvancedDynamicTexture.CreateFullscreenUI("ui", true, scene);
    this.gui.renderScale = 1;

    this.installPointer(engine, onMemberTap);

    scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(engine.getDeltaTime(), 100) / 1000;
      this.time += dt;
      this.refit(engine);
      this.driftBackdrop();
      this.stepCharacters(dt);
    });
  }

  /** Everything static in the scene: the shared floor-pad art and the two
   *  materials that tint it. The backdrop already IS the environment, so
   *  there is no ground, no walls and no props to build. */
  private buildStage() {
    const scene = this.scene;
    this.padTexture = createPadTexture(scene);

    const makePadMat = (name: string, tint: Color3) => {
      const mat = new StandardMaterial(name, scene);
      mat.diffuseTexture = this.padTexture;
      mat.useAlphaFromDiffuseTexture = true;
      mat.diffuseColor = new Color3(0, 0, 0); // colour comes from emissive only
      mat.specularColor = new Color3(0, 0, 0);
      mat.emissiveColor = tint;
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      return mat;
    };
    this.padMat = makePadMat("padMat", PAD_TINT);
    this.padMatLeader = makePadMat("padMatLeader", PAD_TINT_LEADER);

    scene.freezeMaterials();
  }

  /** Re-fit the shot whenever the drawing surface changes size.
   *
   *  Two integer compares per frame, and in exchange the framing can never get
   *  stuck: a resize event that arrives before the browser has laid the canvas
   *  out, an orientation lock, entering fullscreen from the entry gate, the
   *  mobile keyboard resizing the visual viewport — all of them land here the
   *  frame after the engine's own size actually changes, which is exactly when
   *  the composition has to be recomputed and never otherwise. */
  private refit(engine: Engine) {
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    if (width === this.viewWidth && height === this.viewHeight) return;
    this.viewWidth = width;
    this.viewHeight = height;
    this.fitBackdrop();
    this.frameCamera();
  }

  /** Cover-fit the backdrop, the way `background-size: cover` would.
   *
   *  A Layer stretches its texture across the whole canvas, which distorts the
   *  art on any screen that isn't the aspect it was painted at — and phones in
   *  landscape are nowhere near it. Layer.scale grows the QUAD (the shader
   *  shifts gl_Position and derives the UV from it), so scaling the squeezed
   *  axis past the screen restores the art's own aspect and crops the overflow
   *  instead of stretching it. Runs on resize only. */
  private fitBackdrop() {
    const engine = this.scene.getEngine();
    const aspect = engine.getRenderWidth() / Math.max(engine.getRenderHeight(), 1);
    let x = BACKDROP_OVERSCAN;
    let y = BACKDROP_OVERSCAN;
    if (aspect > BACKDROP_ASPECT) y *= aspect / BACKDROP_ASPECT;
    else x *= BACKDROP_ASPECT / aspect;
    this.backdrop.scale.set(x, y);
    this.driftRoom = Math.min(x, y) - 1;
  }

  /** A drift slow enough to read as depth rather than movement — a full cycle
   *  takes about two minutes and never travels further than the overscan the
   *  fit above reserved for it. Two float writes per frame. */
  private driftBackdrop() {
    const room = this.driftRoom;
    if (room <= 0) return;
    this.backdrop.offset.set(
      Math.sin(this.time * 0.055) * room * 0.55,
      Math.sin(this.time * 0.037 + 1.1) * room * 0.35
    );
  }

  /** Stand the camera where the whole squad fits with their feet at FEET_AT.
   *
   *  Derived rather than hand-tuned, because with a fixed camera the framing
   *  has to survive every screen the game runs on: a phone in landscape is
   *  more than twice as wide as it is tall, a desktop window can be nearly
   *  square, and the player has no zoom to rescue a bad guess. The distance
   *  that satisfies the vertical composition and the one that keeps the
   *  outermost character on screen are both computed; the larger wins. */
  private frameCamera() {
    const engine = this.scene.getEngine();
    const aspect = engine.getRenderWidth() / Math.max(engine.getRenderHeight(), 1);
    const tanV = Math.tan(CAM_FOV / 2);
    // Feet at FEET_AT of the screen: a point on the floor at distance d sits
    // (CAM_HEIGHT / d) / tanV below the centre line, in half-heights.
    const forHeight = CAM_HEIGHT / ((2 * FEET_AT - 1) * tanV);
    // Outermost character, plus its floor pad and a little air, inside 92% of
    // the half-width — the rest is breathing room and HUD.
    const forWidth = (this.spread + 0.76) / (0.92 * tanV * aspect);
    const distance = Math.min(Math.max(Math.max(forHeight, forWidth), 3.2), 16);
    this.camera.position.set(0, CAM_HEIGHT, -distance);
    this.camera.setTarget(new Vector3(0, CAM_HEIGHT, 0));
  }

  /** Turning a character, and everything else that has to move between frames.
   *  One loop over at most four members. */
  private stepCharacters(dt: number) {
    let i = 0;
    for (const character of this.characters.values()) {
      // Walk to the slot the current squad size gives them.
      const dx = character.slotX - character.anchor.position.x;
      const dz = character.slotZ - character.anchor.position.z;
      if (dx * dx + dz * dz > 1e-6) {
        const step = 1 - Math.exp(-dt * 9);
        character.anchor.position.x += dx * step;
        character.anchor.position.z += dz * step;
      }

      if (character.turn.step(dt)) character.spinner.rotation.y = character.turn.angle;

      // Idle "breathing" for FALLBACK bodies only. A loaded character animates
      // through its own idle clip; bobbing it too would fight that clip and
      // read as a jitter, so rigged slots are skipped.
      if (!character.rig) character.root.position.y = Math.sin(this.time * 1.6 + i * 1.3) * 0.04;
      i++;
    }
  }

  /** Drag a character to turn it; tap one to open their card.
   *
   *  Babylon only reports a TAP when the pointer stayed inside its drag
   *  threshold, so the two gestures can share one pointer without a mode
   *  switch: a turn never opens a card, and a card never eats a turn. */
  private installPointer(engine: Engine, onMemberTap?: (uid: string) => void) {
    const canvas = engine.getRenderingCanvas();

    this.scene.onPointerObservable.add((info) => {
      const event = info.event as IPointerEvent;
      switch (info.type) {
        case PointerEventTypes.POINTERDOWN: {
          const uid = uidOfPick(info.pickInfo?.pickedMesh);
          const character = uid ? this.characters.get(uid) : null;
          if (!character) return;
          character.turn.grab();
          this.drag = { uid: character.uid, pointerId: event.pointerId, lastX: event.clientX };
          // Capture, so a finger that slides off the canvas still delivers its
          // move and up events here instead of stranding the drag.
          try {
            canvas?.setPointerCapture(event.pointerId);
          } catch {
            /* pointer already gone — the drag simply ends at the next up */
          }
          if (canvas) canvas.style.cursor = "grabbing";
          return;
        }
        case PointerEventTypes.POINTERMOVE: {
          const drag = this.drag;
          if (!drag || event.pointerId !== drag.pointerId) return;
          const character = this.characters.get(drag.uid);
          if (!character) {
            this.endDrag();
            return;
          }
          const moved = event.clientX - drag.lastX;
          if (moved === 0) return;
          drag.lastX = event.clientX;
          character.turn.turn(moved, canvas?.clientWidth || 1);
          character.spinner.rotation.y = character.turn.angle;
          return;
        }
        case PointerEventTypes.POINTERUP: {
          if (this.drag && event.pointerId === this.drag.pointerId) {
            this.characters.get(this.drag.uid)?.turn.release();
            this.endDrag();
          }
          return;
        }
        case PointerEventTypes.POINTERTAP: {
          if (!onMemberTap) return;
          const uid = uidOfPick(info.pickInfo?.pickedMesh);
          if (uid) onMemberTap(uid);
          return;
        }
      }
    });

    // A cancelled gesture (system swipe, alt-tab mid-drag) never sends an up.
    // Losing the capture is the one signal that always arrives.
    if (canvas) {
      this.onCaptureLost = () => this.endDrag();
      canvas.addEventListener("lostpointercapture", this.onCaptureLost);
    }
  }

  private endDrag() {
    const drag = this.drag;
    this.drag = null;
    const canvas = this.scene.getEngine().getRenderingCanvas();
    if (!canvas) return;
    canvas.style.cursor = "";
    if (drag && canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
  }

  /** Rebuild the characters to match the lobby member list. */
  setMembers(members: LobbyMember[]) {
    // Local player always takes the centre slot.
    const ordered = [...members].sort((a, b) =>
      a.uid === this.localUid ? -1 : b.uid === this.localUid ? 1 : a.uid.localeCompare(b.uid)
    );

    // Remove characters that left. Disposing the anchor takes the whole
    // hierarchy with it — body, name plate link AND the floor pad, which
    // used to linger as a bare white plate when only the root was disposed.
    const keep = new Set(ordered.map((m) => m.uid));
    for (const [uid, character] of this.characters) {
      if (!keep.has(uid)) {
        if (this.drag?.uid === uid) this.endDrag();
        character.emoteToken++;
        character.emoteEnd?.();
        clearTimeout(character.bubbleTimer);
        character.loadToken++; // strand any load still in flight for this slot
        character.weaponToken++;
        character.weapon?.dispose();
        character.aura?.dispose();
        character.rig?.dispose();
        // The glow layer holds excluded meshes by id and never drops them by
        // itself, and it walks that list per glowing mesh per frame — so a
        // session with a lot of coming and going would pay a little more every
        // time somebody left.
        this.glow.removeExcludedMesh(character.pad);
        character.loadBar?.track.dispose();
        character.anchor.dispose();
        character.disposables.forEach((d) => d.dispose());
        this.characters.delete(uid);
      }
    }

    const slots = layoutFor(ordered.length);
    this.spread = Math.max(...slots.map(([x]) => Math.abs(x)));

    ordered.forEach((member, index) => {
      const [x, z] = slots[index] ?? [0, 0];
      const existing = this.characters.get(member.uid);
      if (existing) {
        existing.slotX = x;
        existing.slotZ = z;
        if (existing.isLeader !== member.isLeader || existing.name !== member.name) {
          // Leadership moved (transfer / old leader left), or they claimed a
          // name — restyle the plate and the pad rather than rebuilding either.
          existing.isLeader = member.isLeader;
          existing.name = member.name;
          applyNameStyle(existing.plate, existing.label, member, existing.ready);
          existing.pad.material = member.isLeader ? this.padMatLeader : this.padMat;
        }
        // Someone equipped a different character — swap just that model, keep
        // the pad, plate and any bubble exactly as they are. The weapon
        // rides along: attachModel re-hangs it on the new rig, since the old
        // one it was following is about to be disposed.
        if (existing.characterId !== member.character) {
          existing.characterId = member.character;
          existing.weaponId = member.weapon;
          void this.attachModel(existing, member.character);
        } else if (existing.weaponId !== member.weapon) {
          existing.weaponId = member.weapon;
          void this.attachWeapon(existing);
        }
        return;
      }
      this.characters.set(member.uid, this.createCharacter(member, x, z));
    });

    // A wider squad needs a wider shot.
    this.frameCamera();
  }

  /** Load a character model into a slot.
   *
   *  Nothing stands on the pad until the real model arrives. An earlier
   *  version drew primitive stand-ins immediately and swapped them out, but a
   *  capsule-robot turning into a character every time you open the lobby reads
   *  as a glitch — a briefly empty pad reads as loading. The stand-in is
   *  now only built when the model genuinely cannot be shown, so the lobby is
   *  never empty for a reason the player can't recover from. */
  private async attachModel(character: CharacterInstance, characterId: string): Promise<void> {
    const mine = ++character.loadToken;
    if (!hasAssets()) {
      this.buildFallbackBody(character);
      return;
    }
    // Start straight in the stance the weapon calls for, rather than idling
    // first and switching a frame later — that switch is visible.
    const idle = getStanceClip(character.weaponId);

    // Dynamic: Babylon's skinning + animation machinery is ~550 kB, and the
    // pads and plates are already painted by now, so none of that weight
    // sits on the lobby's first frame.
    const { CharacterRig } = await import("./characterRig");
    const rig = await CharacterRig.create(characterId, this.scene, `rig_${character.anchor.name}`);
    // Slot was removed, or a newer character was picked, while this loaded.
    if (mine !== character.loadToken) {
      rig?.dispose();
      return;
    }
    if (!rig) {
      this.buildFallbackBody(character);
      return;
    }

    character.weaponToken++; // the rig it was following is going away
    character.emoteToken++;
    character.emoteEnd?.();
    character.emoteEnd = null;
    character.weapon?.dispose();
    character.weapon = null;
    character.clipId = null; // new rig, nothing playing on it yet
    character.aura?.dispose();
    character.aura = null;
    character.rig?.dispose();
    character.rig = rig;
    this.clearBody(character);
    // Parented to the spinner, not the bobbing root: the model's own idle clip
    // provides the motion, and the pad/plate/bubble links stay rock steady
    // while a drag turns the character.
    // No scaling here: the rig measures the model and sizes itself to
    // CHARACTER_HEIGHT with its feet on the floor.
    rig.root.parent = character.spinner;

    if (idle) {
      await rig.play(idle, { loop: true });
      character.clipId = idle;
    }

    // Separate chunk per effect: nobody who never stands next to a legendary
    // pays for one, and seeing Seraph does not download Zenith's.
    const aura = await attachAura(characterId, rig, this.scene);
    if (mine === character.loadToken) character.aura = aura;
    else aura?.dispose(); // a newer load won the race

    // After the idle clip, never before: a weapon reads the hand joint, and
    // until a clip has posed the skeleton that joint is in the rest pose, a
    // hundred times smaller than the character it belongs to (see weapon.ts).
    if (mine === character.loadToken) await this.attachWeapon(character);
  }

  /** Put the slot's current weapon in its hand, or take it away. Empty-handed
   *  is the common case and costs nothing — the module isn't even downloaded. */
  private async attachWeapon(character: CharacterInstance): Promise<void> {
    const mine = ++character.weaponToken;
    character.weapon?.dispose();
    character.weapon = null;
    const rig = character.rig;
    if (!rig) return;

    // Picking a weapon up changes how they stand, not just what they hold.
    const stance = getStanceClip(character.weaponId);
    if (stance && stance !== character.clipId) {
      character.clipId = stance;
      await rig.play(stance, { loop: true });
      if (mine !== character.weaponToken) return;
    }

    if (!character.weaponId) return;
    const { attachWeapon } = await import("./weapon");
    const held = await attachWeapon(character.weaponId, rig, this.scene, character.characterId);
    if (mine !== character.weaponToken) {
      held?.dispose(); // a newer weapon (or a character swap) won the race
      return;
    }
    character.weapon = held;
  }

  /** Empty the bobbing root (any stand-in body) and park the bob at zero. */
  private clearBody(character: CharacterInstance) {
    for (const child of character.root.getChildren()) child.dispose();
    character.root.position.y = 0;
    character.root.scaling.setAll(1); // the stand-in's normalising scale, undone
  }

  /** Stylised stand-in built from primitives, shown ONLY when the real model
   *  can't be loaded — no CDN configured, or the download failed. It hangs off
   *  the bobbing root, so the idle bob in the render loop animates it.
   *
   *  Deliberately anonymous and on-brand: a dark figure with a crimson edge,
   *  standing exactly CHARACTER_HEIGHT tall like everybody else. It should read
   *  as "this player's model hasn't arrived", which is what it means — an
   *  oversized primitive in a random colour reads as a broken game instead. */
  private buildFallbackBody(character: CharacterInstance) {
    if (character.rig || character.root.getChildren().length > 0) return; // already has a body
    const scene = this.scene;
    const uid = character.uid;
    const root = character.root;
    // Authored from the floor up, then normalised to the height every real
    // character is measured to — so a stand-in never towers over the squad it
    // is standing in.
    const headSize = 0.42;
    const headY = 1.98;
    root.scaling.setAll(CHARACTER_HEIGHT / (headY + headSize / 2));

    const bodyMat = new StandardMaterial(`bodyMat_${uid}`, scene);
    bodyMat.diffuseColor = new Color3(0.08, 0.08, 0.1);
    bodyMat.emissiveColor = new Color3(0.1, 0.013, 0.028);
    bodyMat.specularColor = new Color3(0.1, 0.1, 0.1);
    character.disposables.push(bodyMat);

    const skinMat = new StandardMaterial(`skinMat_${uid}`, scene);
    skinMat.diffuseColor = new Color3(0.16, 0.16, 0.19);
    skinMat.emissiveColor = new Color3(0.08, 0.01, 0.022);
    character.disposables.push(skinMat);

    const body = MeshBuilder.CreateCapsule(`body_${uid}`, { height: 1.5, radius: 0.22 }, scene);
    body.position.y = 1.05;
    body.material = bodyMat;
    body.isPickable = false;
    body.parent = root;

    const head = MeshBuilder.CreateSphere(`head_${uid}`, { diameter: headSize, segments: 12 }, scene);
    head.position.y = headY;
    head.material = skinMat;
    head.isPickable = false;
    head.parent = root;

    const makeLimb = (name: string, lx: number, ly: number, height: number, radius: number): Mesh => {
      const limb = MeshBuilder.CreateCapsule(name, { height, radius }, scene);
      limb.position.set(lx, ly, 0);
      limb.material = bodyMat;
      limb.isPickable = false;
      limb.parent = root;
      return limb;
    };
    makeLimb(`armL_${uid}`, -0.32, 1.15, 1.0, 0.075);
    makeLimb(`armR_${uid}`, 0.32, 1.15, 1.0, 0.075);
    makeLimb(`legL_${uid}`, -0.13, 0.45, 0.9, 0.1);
    makeLimb(`legR_${uid}`, 0.13, 0.45, 0.9, 0.1);
  }

  /** Download progress for the picked game, under this member's name plate.
   *
   *  `pct` 0–100 fills a slim bar (crimson while loading, green at 100), -1
   *  paints it as failed, null hides it. Costs a GUI repaint only when the
   *  value changes — and callers already throttle to a few updates a second,
   *  only ever during the loading phase, never in gameplay. */
  /** Who has said they are ready. A tick beside the name, so the answer to
   *  "who are we waiting for" is readable at a glance instead of being
   *  something the leader has to work out from a hint line. */
  setReady(uid: string, ready: boolean) {
    const character = this.characters.get(uid);
    if (!character || character.ready === ready) return;
    character.ready = ready;
    applyNameStyle(
      character.plate,
      character.label,
      { uid, name: character.name, isLeader: character.isLeader } as LobbyMember,
      ready
    );
  }

  setLoading(uid: string, pct: number | null) {
    const character = this.characters.get(uid);
    if (!character) return;
    if (pct === null) {
      if (character.loadBar) character.loadBar.track.isVisible = false;
      return;
    }
    let bar = character.loadBar;
    if (!bar) {
      const track = new Rectangle(`load_${uid}`);
      track.width = "150px";
      track.height = "6px";
      track.cornerRadius = 3;
      track.thickness = 1;
      track.color = "rgba(255,255,255,0.18)";
      track.background = "rgba(8, 5, 8, 0.85)";
      track.isHitTestVisible = false;
      this.gui.addControl(track);
      track.linkWithMesh(character.pad);
      // Just under the plate (plate: 30px tall around offset 10).
      track.linkOffsetY = 32;
      const fill = new Rectangle(`loadFill_${uid}`);
      fill.horizontalAlignment = Rectangle.HORIZONTAL_ALIGNMENT_LEFT;
      fill.height = "100%";
      fill.width = "0%";
      fill.thickness = 0;
      fill.cornerRadius = 3;
      fill.background = ACCENT;
      fill.isHitTestVisible = false;
      track.addControl(fill);
      bar = { track, fill, pct: -2 };
      character.loadBar = bar;
    }
    bar.track.isVisible = true;
    if (bar.pct === pct) return;
    bar.pct = pct;
    if (pct < 0) {
      bar.fill.width = "100%";
      bar.fill.background = "#7a1e2a";
      bar.track.color = "#ff6b7a";
    } else {
      bar.fill.width = `${Math.max(0, Math.min(100, pct))}%`;
      bar.fill.background = pct >= 100 ? "#46c98a" : ACCENT;
      bar.track.color = pct >= 100 ? "rgba(70,201,138,0.5)" : "rgba(255,255,255,0.18)";
    }
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

  /** Perform an emote on a member's character: play it once, exactly as
   *  authored, then settle back into whatever stance they were standing in.
   *
   *  The character is deliberately NOT held in place. Emotes travel — this one
   *  covers 0.79 m of the pad — and that movement is the point of owning one;
   *  a dance pinned to a spot reads as a bug, not a performance.
   *
   *  ONE path for everybody. The local player calls this the instant they tap
   *  so their own emote never waits for a round trip, and every squadmate
   *  calls it when the server forwards the same id — which is what stops
   *  "what I see" and "what they see" drifting into two behaviours.
   *
   *  Returns false when the character has no model yet: a player who emotes at
   *  a teammate whose skin is still downloading is not an error, there is just
   *  nothing to pose. */
  /** Is anybody actually looking at this lobby right now?
   *
   *  Two dropped frames of slack: a render loop runs at 60fps and even a
   *  struggling phone is nowhere near a fifth of a second between frames, so
   *  this says "yes" whenever the lobby is genuinely being drawn and "no"
   *  within a moment of it stopping. */
  isBeingWatched(): boolean {
    return performance.now() - this.lastRenderAt < 200;
  }

  /** Perform an emote on somebody's character.
   *
   *  FIRES ONCE, LIVE — and is dropped outright if this lobby is not being
   *  watched. An emote is a gesture, not a message: it means "this happened
   *  just now, in front of the people standing here", and one delivered late
   *  is not a lesser version of that, it is a different and confusing event.
   *
   *  Dropping it also fixes a real fault rather than merely being tidy. A
   *  Babylon animation only advances while its scene renders, and the lobby
   *  stops rendering the moment the tab is hidden or the collection borrows
   *  the canvas. A clip started then does not quietly skip — it FREEZES on
   *  its first frame and performs when the player comes back, so a wave from
   *  five seconds ago played out on return, out of time and with nothing on
   *  screen to explain it. */
  async playEmote(uid: string, clipId: string): Promise<boolean> {
    if (!this.isBeingWatched()) return false;
    const character = this.characters.get(uid);
    const rig = character?.rig;
    if (!character || !rig) return false;

    const mine = ++character.emoteToken;
    character.emoteEnd?.(); // a second emote replaces the first, never queues
    character.emoteEnd = null;

    const started = await rig.play(clipId, { loop: false });
    if (!started || mine !== character.emoteToken) return false;
    // That await can be a download — a squadmate's emote clip is not
    // necessarily on this device — and the player may have looked away while
    // it arrived. Starting it now would freeze it on its first frame and
    // perform it whenever they come back, which is the very thing dropping
    // stale emotes is meant to prevent. Put the stance back and let it go.
    if (!this.isBeingWatched()) {
      const stance = getStanceClip(character.weaponId);
      character.clipId = stance;
      if (stance) void rig.play(stance, { loop: true });
      return false;
    }
    character.clipId = clipId;

    character.emoteEnd = rig.onClipEnd(() => {
      character.emoteEnd?.();
      character.emoteEnd = null;
      if (mine !== character.emoteToken) return; // superseded while performing
      const stance = getStanceClip(character.weaponId);
      character.clipId = stance;
      if (stance) void rig.play(stance, { loop: true });
    });
    return true;
  }

  /** Warm the emote clips into cache. Called when the sheet OPENS, so by the
   *  time a player has read the menu and picked one the clip is usually
   *  already here and the emote starts on the tap instead of after a
   *  download. 72 kB for the whole set today. */
  async prefetchEmotes(): Promise<void> {
    if (!hasAssets()) return;
    const ids = getPerformableEmotes().map((emote) => emote.id);
    if (ids.length === 0) return;
    const { prefetchClips } = await import("./characterRig");
    await prefetchClips(ids, this.scene);
  }

  /** Build a slot: floor pad, hit box, name plate and chat bubble. The BODY is
   *  not built here — the real model is fetched straight away and only if that
   *  fails does a stand-in appear (see buildFallbackBody). */
  private createCharacter(member: LobbyMember, x: number, z: number): CharacterInstance {
    const scene = this.scene;
    const disposables: { dispose: () => void }[] = [];

    // anchor = slot position; spinner = turntable; root = bobbing stand-in host
    const anchor = new TransformNode(`anchor_${member.uid}`, scene);
    anchor.position.set(x, 0, z);
    anchor.rotation.y = Math.PI; // characters face the camera side
    const spinner = new TransformNode(`spin_${member.uid}`, scene);
    spinner.parent = anchor;
    const root = new TransformNode(`char_${member.uid}`, scene);
    root.parent = spinner;

    // Light pool + contact shadow: what actually seats the character on the
    // painted floor, in one transparent disc.
    const pad = MeshBuilder.CreateDisc(`pad_${member.uid}`, { radius: 0.6, tessellation: 40 }, scene);
    pad.rotation.x = Math.PI / 2;
    pad.position.y = 0.012;
    pad.isPickable = false;
    pad.material = member.isLeader ? this.padMatLeader : this.padMat;
    pad.parent = anchor;
    // Blooming a flat floor decal washes red haze up over the character's
    // legs — the collection preview learned the same lesson.
    this.glow.addExcludedMesh(pad);

    // What the pointer actually hits: one invisible box around the character.
    // Square in plan, so turning the character never moves its hit area, and
    // present from the first frame, so a slot can be grabbed and tapped while
    // its model is still downloading.
    const hit = MeshBuilder.CreateBox(`hit_${member.uid}`, { width: 1.05, depth: 1.05, height: 2.25 }, scene);
    hit.position.y = 1.1;
    hit.isVisible = false;
    hit.metadata = { memberUid: member.uid, hit: true };
    hit.parent = anchor;

    // Name plate at the character's base (Free Fire/PUBG style: a banner on
    // the podium, not floating over the head). Linked to the STATIC pad
    // rather than the character — a link target that never moves means the
    // fullscreen GUI texture stops repainting every animation frame.
    const plate = new Rectangle(`plate_${member.uid}`);
    plate.width = "160px";
    plate.height = "30px";
    plate.cornerRadius = 6;
    plate.thickness = 1.5;
    plate.background = "rgba(8, 5, 8, 0.82)";
    plate.isHitTestVisible = false; // never swallow a turn that starts on it
    this.gui.addControl(plate);
    plate.linkWithMesh(pad);
    // Just clear of the pad. Not further: at this framing the feet already sit
    // low, and every pixel the plate drops takes it towards the chat button and
    // the party card in the bottom corners.
    plate.linkOffsetY = 10;

    const label = new TextBlock(`label_${member.uid}`);
    label.fontFamily = '"Archivo Black", system-ui, sans-serif';
    label.isHitTestVisible = false;
    applyNameStyle(plate, label, member); // text, colours AND the fitted size
    plate.addControl(label);

    const mic = new TextBlock(`mic_${member.uid}`, "🎙");
    mic.fontSize = 13;
    mic.width = "18px";
    mic.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    mic.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    mic.left = "5px";
    mic.isHitTestVisible = false;
    mic.isVisible = false; // silent until they actually say something
    plate.addControl(mic);
    disposables.push(plate);

    // Chat bubble over the head. Linked to a tiny STATIC invisible mesh at
    // head height (parented to the anchor, not the spinner) so the
    // projection tracks correctly without forcing a GUI repaint every
    // animation frame — same trick as the base plate.
    const bubbleAnchor = MeshBuilder.CreateBox(`bubbleAnchor_${member.uid}`, { size: 0.01 }, scene);
    bubbleAnchor.isVisible = false;
    bubbleAnchor.isPickable = false;
    // Hugging a CHARACTER_HEIGHT head. It used to sit at 2.6, which was clear
    // of the old wide shot but rides off the top of the screen now that
    // characters are framed half again as large.
    bubbleAnchor.position.y = 1.95;
    bubbleAnchor.parent = anchor;

    const bubble = new Rectangle(`bubble_${member.uid}`);
    bubble.width = "150px";
    bubble.adaptHeightToChildren = true;
    bubble.cornerRadius = 8;
    bubble.thickness = 1.5;
    bubble.color = ACCENT;
    bubble.background = "rgba(8, 5, 8, 0.9)";
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
    bubbleText.isHitTestVisible = false;
    bubbleText.paddingTop = "6px";
    bubbleText.paddingBottom = "6px";
    bubbleText.paddingLeft = "8px";
    bubbleText.paddingRight = "8px";
    bubble.addControl(bubbleText);
    disposables.push(bubble);

    const instance: CharacterInstance = {
      uid: member.uid,
      anchor,
      spinner,
      root,
      pad,
      hit,
      aura: null,
      plate,
      label,
      mic,
      bubble,
      bubbleText,
      bubbleTimer: 0,
      loadBar: null,
      isLeader: member.isLeader,
      name: member.name,
      ready: false,
      disposables,
      slotX: x,
      slotZ: z,
      turn: new Turntable(),
      characterId: member.character,
      weaponId: member.weapon,
      rig: null,
      weapon: null,
      clipId: null,
      emoteEnd: null,
      emoteToken: 0,
      loadToken: 0,
      weaponToken: 0,
    };
    // The pad and plate are already on screen; the character itself drops
    // in when its model arrives. Tapping and turning work throughout — both go
    // through the hit box, which exists before the model does.
    void this.attachModel(instance, member.character);
    return instance;
  }

  dispose() {
    this.untalk?.();
    this.untalk = null;
    for (const character of this.characters.values()) {
      clearTimeout(character.bubbleTimer);
      character.emoteEnd?.();
      character.loadToken++;
      character.weaponToken++;
      character.weapon?.dispose();
      character.aura?.dispose();
      character.rig?.dispose();
    }
    this.characters.clear();
    const canvas = this.scene.getEngine().getRenderingCanvas();
    if (canvas && this.onCaptureLost) canvas.removeEventListener("lostpointercapture", this.onCaptureLost);
    this.scene.dispose();
  }
}
