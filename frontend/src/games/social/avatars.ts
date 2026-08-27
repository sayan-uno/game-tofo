// Twenty people, on a phone.
//
// That number is the entire problem this file solves. A character here is a
// skinned mesh with a skeleton and a retargeted animation clip — the lobby
// draws four of them and that is already the most expensive thing in it. Doing
// twenty naively means twenty model downloads on arrival and twenty skeletons
// evaluated every frame, and the island would be a slideshow before anybody
// said hello.
//
// So three budgets, all of them distance-first, and all of them hysteretic so
// nothing ever flickers on the boundary:
//
//   MODELS   at most MAX_RIGS characters have a real model at once, nearest
//            first. Everybody else is their name tag and their shadow, which
//            is honestly most of what you need from somebody forty metres away
//            — and is also exactly what a person who has just arrived looks
//            like for the second before their model lands.
//   MOTION   at most MAX_ANIMATED of those are actually animating. A walk
//            cycle you cannot see is a skeleton evaluated for nothing.
//   DRAWS    tags and shadows are billboards and instances; the shadows are one
//            draw call for the whole island.
//
// The other thing worth knowing: a remote person is drawn INTERPOLATED, a
// hundred and forty milliseconds behind real time, between the last two
// snapshots the server sent. Bots are not — their walk is a function of the
// clock, so they are drawn at exactly now, and the two look identical.
import type { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { CharacterRig } from "../../game/characterRig";
import { getEmote, getStanceClip } from "../../game/assets";
import { attachWeapon, type HeldWeapon } from "../../game/weapon";
import { attachAura, type Aura } from "../../game/aura";
import {
  ANIM_IDLE,
  ANIM_RUN,
  ANIM_WALK,
  INTERP_DELAY_MS,
  PoseTrack,
  angleDelta,
  heightAt,
  type Anim,
  type Pose,
} from "../../shared/games/social/index";

/** How many characters carry a real model at once. The ones past it are always
 *  the ones furthest away.
 *
 *  Sixteen rather than the twelve this shipped with. The models are shared —
 *  twenty players wear at most a handful of distinct characters, and the
 *  container cache means the second person in a given outfit costs an
 *  instantiation rather than a download — so the real price is drawn
 *  triangles, and the scenery got cheap enough (see the prop budget in
 *  island.ts) to afford four more people. */
const MAX_RIGS = 16;
/** …and how many of those are ANIMATING.
 *
 *  Deliberately the same number, which is a correction. It shipped at eight,
 *  on the theory that a walk cycle you cannot make out is not worth
 *  evaluating — and that was false economy twice over. The saving is small:
 *  the skinning happens in the vertex shader whether or not a clip is
 *  advancing, so stopping one saves a couple of dozen bone matrices and
 *  nothing else. The cost is enormous: a character whose position is still
 *  being interpolated but whose skeleton is frozen SLIDES, and eight of the
 *  twenty people on the island gliding about in a fixed pose is exactly what
 *  "the other players are lagging" looks like. */
const MAX_ANIMATED = MAX_RIGS;
/** How many legendary effects run at once, nearest first.
 *
 *  A legendary is +2 draw calls and sixty-odd live particles, and unlike a
 *  match this is a place people come to be LOOKED at — half the island can be
 *  wearing one. Six is what a mid-range phone carries alongside sixteen
 *  characters; past it the character is still there and still legendary, it
 *  simply is not shedding embers at somebody forty metres away who cannot see
 *  them anyway. */
const MAX_AURAS = 6;
/** …and the range beyond which one is not worth running at all. */
const AURA_RANGE = 34;
const AURA_DROP = 42;

/** Past this, a person is a tag on the horizon — no model is loaded at all. */
const RIG_RANGE = 55;
/** …and it is not dropped again until they are this far, so somebody pacing
 *  about at the edge does not blink in and out. */
const RIG_DROP = 68;
/** Beyond this, not even the tag — the island is 160 m across and a name you
 *  cannot read is clutter. */
const TAG_RANGE = 62;

const WALK_CLIP = "walk";
const RUN_CLIP = "run";

export interface AvatarInfo {
  uid: string;
  name: string;
  character: string;
  weapon: string | null;
  seat: number;
  isLocal: boolean;
}

export class Avatar {
  readonly root: TransformNode;
  /** What is pickable: an invisible capsule around the body, so tapping a
   *  person opens their card without every tree in the park being ray-tested. */
  readonly hit: Mesh;
  private rig: CharacterRig | null = null;
  private rigToken = 0;
  private weaponHeld: HeldWeapon | null = null;
  /** The legendary effect, for the characters the catalog marks legendary —
   *  null for everybody else, which is most people and costs nothing. */
  private aura: Aura | null = null;
  private auraToken = 0;
  /** True while this character SHOULD have one, so the budget can put it back
   *  when they walk closer again. */
  private wantsAura = false;
  private tag: Mesh | null = null;
  private tagTex: DynamicTexture | null = null;
  private bubble: Mesh | null = null;
  private bubbleTex: DynamicTexture | null = null;
  private bubbleTimer = 0;
  private shadow: InstancedMesh | null = null;
  private clip: string | null = null;
  private emoteToken = 0;
  private emoteTimer = 0;
  private disposed = false;
  private animating = false;
  /** Where the samples off the wire are turned back into a walk. Shared code,
   *  because the console replays islands with the same one and check:social
   *  measures the result. */
  private readonly track = new PoseTrack();
  /** Where they are being DRAWN, which is what the camera, the voice distance
   *  and the tap test all read. */
  readonly pose: Pose = { x: 0, z: 0, ry: 0, anim: ANIM_IDLE };
  /** Nobody is playing: this island is being WATCHED. Then even the focused
   *  player comes off the tape, because in a replay there is no local player —
   *  there is only a camera following somebody. */
  replay = false;
  private drawnRy = 0;

  constructor(
    private scene: Scene,
    readonly info: AvatarInfo,
    shadowSource: Mesh
  ) {
    this.root = new TransformNode(`av_${info.uid}`, scene);
    this.hit = MeshBuilder.CreateCapsule(`hit_${info.uid}`, { height: 1.75, radius: 0.42 }, scene);
    this.hit.position.y = 0.9;
    this.hit.parent = this.root;
    this.hit.isVisible = false;
    this.hit.isPickable = !info.isLocal; // there is no point tapping yourself
    this.hit.metadata = { uid: info.uid };
    this.shadow = shadowSource.createInstance(`sh_${info.uid}`);
    this.shadow.isPickable = false;
    // No plate over your OWN head. It is a fixed-size billboard two metres in
    // front of the camera, so on your own character it is the largest thing on
    // screen and it sits exactly where you are trying to look — and you are
    // the one person on the island whose name you already know.
    if (!info.isLocal) this.buildTag();
  }

  // -- where they are ------------------------------------------------------

  /** A snapshot from the server, at the moment the pose was TRUE. */
  push(t: number, x: number, z: number, ry: number, anim: Anim): void {
    this.track.push(t, x, z, ry, anim);
  }

  /** True once anything has arrived — see PoseTrack. */
  get arrived(): boolean {
    return this.track.arrived;
  }

  /** Put them where they should be for this instant. `renderAt` is the server
   *  clock the local frame is drawing, already offset.
   *
   *  EVERY seat but your own comes off the wire, including the ones the server
   *  population is standing in — see broadcastSnapshot on the server for why
   *  that is worth the bytes. There is deliberately no second code path here:
   *  one would be a place for the two kinds of neighbour to start looking
   *  different from each other. */
  place(renderAt: number, dt: number, delay: number = INTERP_DELAY_MS): void {
    if (!this.info.isLocal || this.replay) {
      const p = this.track.sample(renderAt, delay);
      this.pose.x = p.x;
      this.pose.z = p.z;
      this.pose.ry = p.ry;
      this.pose.anim = p.anim;
    }
    const y = heightAt(this.pose.x, this.pose.z);
    this.root.position.set(this.pose.x, y, this.pose.z);
    // Turn towards the facing rather than snapping to it: a snapshot arriving
    // ten times a second would otherwise make everybody's head twitch.
    if (this.info.isLocal) this.drawnRy = this.pose.ry;
    else this.drawnRy += angleDelta(this.drawnRy, this.pose.ry) * Math.min(1, dt * 12);
    this.root.rotation.y = this.drawnRy;
    if (this.shadow) {
      this.shadow.position.set(this.pose.x, y + 0.03, this.pose.z);
      this.shadow.setEnabled(true);
    }
  }

  // -- what they look like -------------------------------------------------

  hasRig(): boolean {
    return this.rig !== null || this.rigToken > 0;
  }

  /** Load this person's real model. Safe to call twice; the second is a no-op.
   *  Never throws — a character that cannot be loaded stays a name and a
   *  shadow, which is a person you can still walk up to and talk to. */
  async loadRig(): Promise<void> {
    if (this.rig || this.rigToken > 0 || this.disposed) return;
    const mine = ++this.rigToken;
    const rig = await CharacterRig.create(this.info.character, this.scene, `rig_${this.info.uid}`);
    if (this.disposed || mine !== this.rigToken) {
      rig?.dispose();
      return;
    }
    if (!rig) return;
    this.rig = rig;
    rig.root.parent = this.root;
    await this.applyClip(true);
    if (this.info.weapon) {
      const weapon = await attachWeapon(this.info.weapon, rig, this.scene);
      if (this.disposed || this.rig !== rig) weapon?.dispose();
      else this.weaponHeld = weapon;
    }
    if (this.wantsAura) await this.raiseAura();
  }

  /** Light up a legendary. Null for everybody else — `attachAura` decides from
   *  the catalog, so this never has to know which characters are which.
   *
   *  AFTER a clip has played, never before: the effect reads bone world
   *  positions, and a skeleton that has not been posed yet sits at a hundredth
   *  of its size, so the embers would come off a character the size of a
   *  thumbnail. Same rule the runner follows, for the same reason. */
  private async raiseAura(): Promise<void> {
    const rig = this.rig;
    if (!rig || this.aura || this.disposed) return;
    const mine = ++this.auraToken;
    const aura = await attachAura(this.info.character, rig, this.scene);
    if (this.disposed || mine !== this.auraToken || this.rig !== rig) {
      aura?.dispose();
      return;
    }
    this.aura = aura;
    if (aura) this.hasAura = true;
  }

  /** True once this character is known to HAVE a legendary effect — the island
   *  reads it to decide whether the glow pass is worth running at all. */
  hasAura = false;

  /** Whether this character's effect should be running. The budget calls it;
   *  a character who has no effect ignores it for nothing. */
  setAura(on: boolean): void {
    if (this.wantsAura === on) return;
    this.wantsAura = on;
    if (on) void this.raiseAura();
    else {
      this.auraToken++;
      this.aura?.dispose();
      this.aura = null;
    }
  }

  /** Give the model back. The tag and the shadow stay — somebody who walked
   *  out of range has not stopped being there. */
  dropRig(): void {
    if (!this.rig) return;
    this.auraToken++;
    this.aura?.dispose();
    this.aura = null;
    this.weaponHeld?.dispose();
    this.weaponHeld = null;
    this.rig.dispose();
    this.rig = null;
    this.rigToken = 0;
    this.clip = null;
    this.animating = false;
  }

  /** Whether this character's skeleton should be running at all. */
  setAnimating(on: boolean): void {
    if (this.animating === on || !this.rig) return;
    this.animating = on;
    if (on) void this.applyClip(true);
    else this.rig.stop();
  }

  /** Play the clip the current pose calls for, if it is not already playing. */
  private async applyClip(force = false): Promise<void> {
    const rig = this.rig;
    if (!rig || this.emoteToken > 0) return;
    const want =
      this.pose.anim === ANIM_RUN ? RUN_CLIP : this.pose.anim === ANIM_WALK ? WALK_CLIP : getStanceClip(this.info.weapon);
    if (!want || (!force && want === this.clip)) return;
    this.clip = want;
    await rig.play(want, { loop: true });
  }

  /** Called every frame for the characters that have models.
   *
   *  Deliberately NOT `void this.applyClip(false)`: applyClip is async, so
   *  calling it every frame for every character allocates a promise per
   *  character per frame — twelve hundred a second for nothing, since almost
   *  every call is "the right clip is already playing". The comparison is done
   *  here, synchronously, and the async path is entered only on a change. */
  syncClip(): void {
    const rig = this.rig;
    if (!rig || !this.animating || this.emoteTimer || this.emoteToken > 0) return;
    const want =
      this.pose.anim === ANIM_RUN ? RUN_CLIP : this.pose.anim === ANIM_WALK ? WALK_CLIP : getStanceClip(this.info.weapon);
    if (!want || want === this.clip) return;
    this.clip = want;
    void rig.play(want, { loop: true });
  }

  /** Perform an emote. Falls back to a bubble if the clip will not load, so a
   *  player who presses it always sees something happen. */
  async perform(emoteId: string): Promise<void> {
    const rig = this.rig;
    const clip = getEmote(emoteId);
    if (!rig || !clip?.url) {
      this.say(emoteId === "" ? "👋" : "✨");
      return;
    }
    const mine = ++this.emoteToken;
    window.clearTimeout(this.emoteTimer);
    this.clip = emoteId;
    const ok = await rig.play(emoteId, { loop: false });
    if (this.disposed || mine !== this.emoteToken) return;
    if (!ok) {
      this.emoteToken = 0;
      return;
    }
    // The clip's own length, plus a beat. `onClipEnd` alone is not enough — a
    // rig disposed mid-clip never fires it, and then the character would stand
    // frozen in the last pose of a dance for the rest of the session.
    this.emoteTimer = window.setTimeout(
      () => {
        if (this.disposed || mine !== this.emoteToken) return;
        this.emoteToken = 0;
        this.emoteTimer = 0;
        this.clip = null;
        void this.applyClip(true);
      },
      Math.min(20000, (clip.duration || 3) * 1000 + 200)
    );
  }

  // -- name and bubble -----------------------------------------------------

  private buildTag(): void {
    const w = 256;
    const h = 64;
    const tex = new DynamicTexture(`tag_${this.info.uid}`, { width: w, height: h }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(8,5,8,0.72)";
    roundRect(ctx, 4, 10, w - 8, h - 20, 12);
    ctx.fill();
    ctx.strokeStyle = this.info.isLocal ? "#e5182e" : "rgba(255,255,255,0.34)";
    ctx.lineWidth = 3;
    roundRect(ctx, 4, 10, w - 8, h - 20, 12);
    ctx.stroke();
    ctx.fillStyle = "#f2f5ff";
    ctx.font = 'bold 26px "Archivo Black", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.info.name, w / 2, h / 2 + 1, w - 30);
    tex.update(false);
    tex.hasAlpha = true;
    // Canvas Y grows downward and a plane's V grows upward, so a canvas drawn
    // top-down lands upside down on a plane.
    tex.vScale = -1;
    tex.vOffset = 1;
    this.tagTex = tex;

    const mat = new StandardMaterial(`tagMat_${this.info.uid}`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    const plane = MeshBuilder.CreatePlane(`tag_${this.info.uid}`, { width: 1.15, height: 0.29 }, this.scene);
    plane.material = mat;
    plane.position.y = 2.16;
    plane.isPickable = false;
    plane.parent = this.root;
    plane.billboardMode = Mesh.BILLBOARDMODE_Y;
    plane.applyFog = false;
    this.tag = plane;
  }

  /** Something over their head — a quick emoji, a phrase. */
  say(text: string, ms = 2800): void {
    if (this.disposed) return;
    if (!this.bubble) this.buildBubble();
    if (!this.bubble || !this.bubbleTex) return;
    const w = 320;
    const h = 80;
    const ctx = this.bubbleTex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);
    const big = [...text].length <= 3;
    ctx.font = big
      ? '46px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif'
      : 'bold 24px "Archivo Black", system-ui, sans-serif';
    const tw = Math.min(w - 24, ctx.measureText(text).width + 34);
    ctx.fillStyle = "rgba(229,24,46,0.92)";
    roundRect(ctx, (w - tw) / 2, 12, tw, h - 30, 16);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, h / 2 - 2, w - 30);
    this.bubbleTex.update(false);
    this.bubble.setEnabled(true);
    window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble?.setEnabled(false), ms);
  }

  private buildBubble(): void {
    const w = 320;
    const h = 80;
    const tex = new DynamicTexture(`say_${this.info.uid}`, { width: w, height: h }, this.scene, false);
    tex.hasAlpha = true;
    tex.vScale = -1;
    tex.vOffset = 1;
    const mat = new StandardMaterial(`sayMat_${this.info.uid}`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    const plane = MeshBuilder.CreatePlane(`say_${this.info.uid}`, { width: 1.5, height: 0.38 }, this.scene);
    plane.material = mat;
    plane.position.y = 2.66;
    plane.isPickable = false;
    plane.parent = this.root;
    plane.billboardMode = Mesh.BILLBOARDMODE_Y;
    plane.applyFog = false;
    plane.setEnabled(false);
    this.bubble = plane;
    this.bubbleTex = tex;
  }

  /** The pieces of this avatar that must never bloom: the name plate and the
   *  bubble are drawn unlit and at full emissive, so a glow layer treats them
   *  as the brightest things on the island and haloes every name on screen. */
  excludeFromGlow(glow: { addExcludedMesh(m: Mesh): void }): void {
    if (this.tag) glow.addExcludedMesh(this.tag);
    if (this.bubble) glow.addExcludedMesh(this.bubble);
    glow.addExcludedMesh(this.hit);
  }

  /** Show or hide everything about this person at once — what a distance
   *  budget actually does. */
  setVisible(on: boolean): void {
    this.root.setEnabled(on);
    this.shadow?.setEnabled(on);
  }

  /** A ring under the feet while somebody is speaking, so you can see who is
   *  talking without reading a list. */
  setTalking(on: boolean): void {
    if (!this.tag) return;
    const mat = this.tag.material as StandardMaterial;
    mat.emissiveColor = on ? new Color3(1, 0.55, 0.6) : new Color3(1, 1, 1);
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.bubbleTimer);
    window.clearTimeout(this.emoteTimer);
    this.auraToken++;
    this.aura?.dispose();
    this.aura = null;
    this.weaponHeld?.dispose();
    this.rig?.dispose();
    this.shadow?.dispose();
    this.tagTex?.dispose();
    this.tag?.material?.dispose();
    this.tag?.dispose();
    this.bubbleTex?.dispose();
    this.bubble?.material?.dispose();
    this.bubble?.dispose();
    this.hit.dispose();
    this.root.dispose();
  }
}

/** Everybody on the island, and the budgets that keep twenty of them drawable.
 *
 *  The roster changes while the world runs — that is what a drop-in world is —
 *  so this is built to be handed a whole new roster at any moment and work out
 *  the difference itself. */
export class Crowd {
  private avatars = new Map<string, Avatar>();
  /** The same array every frame. `Map.values()` into a new array sixty times a
   *  second is twenty-element garbage for nothing; the roster changes a
   *  handful of times in forty minutes. */
  private list: Avatar[] = [];
  private shadowSource: Mesh;
  private shadowMat: StandardMaterial;
  private shadowTex: DynamicTexture;
  /** Re-sorted a few times a second rather than every frame: a budget that
   *  changes its mind sixty times a second is a budget that thrashes. */
  private nextBudgetAt = 0;
  private order: Avatar[] = [];

  constructor(private scene: Scene) {
    // One soft disc, instanced under everybody: the whole island's shadows are
    // a single draw call, and without them everyone looks pasted on.
    const size = 64;
    const tex = new DynamicTexture("shadowTex", { width: size, height: size }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(0,0,0,0.5)");
    grad.addColorStop(0.6, "rgba(0,0,0,0.24)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    tex.update(false);
    tex.hasAlpha = true;
    this.shadowTex = tex;
    const mat = new StandardMaterial("shadowMat", scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.emissiveColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    this.shadowMat = mat;
    const disc = MeshBuilder.CreateDisc("shadow", { radius: 0.44, tessellation: 12 }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.material = mat;
    disc.isVisible = false;
    disc.isPickable = false;
    this.shadowSource = disc;
  }

  get all(): Avatar[] {
    return this.list;
  }
  get(uid: string): Avatar | undefined {
    return this.avatars.get(uid);
  }

  /** The glow pass, while one is running — held so avatars that arrive after
   *  it was built are excluded from it too. */
  private glow: { addExcludedMesh(m: Mesh): void } | null = null;

  /** Told when a glow layer comes and goes. Everything that should not bloom
   *  is excluded once, here, rather than remembered by each caller. */
  useGlow(glow: { addExcludedMesh(m: Mesh): void } | null): void {
    this.glow = glow;
    if (!glow) return;
    glow.addExcludedMesh(this.shadowSource);
    for (const av of this.list) av.excludeFromGlow(glow);
  }

  add(info: AvatarInfo): Avatar {
    const existing = this.avatars.get(info.uid);
    if (existing) return existing;
    const av = new Avatar(this.scene, info, this.shadowSource);
    if (this.glow) av.excludeFromGlow(this.glow);
    this.avatars.set(info.uid, av);
    this.list = [...this.avatars.values()];
    this.nextBudgetAt = 0;
    return av;
  }

  remove(uid: string): void {
    const av = this.avatars.get(uid);
    if (!av) return;
    av.dispose();
    this.avatars.delete(uid);
    this.list = [...this.avatars.values()];
    this.order = this.order.filter((a) => a !== av);
    this.nextBudgetAt = 0;
  }

  /** Distance budgets. Called every frame, does real work a few times a
   *  second, and never loads more than two models at once — a burst of twenty
   *  parallel downloads on arrival is what makes a phone drop the first ten
   *  seconds of a session. */
  budget(now: number, atX: number, atZ: number): void {
    if (now < this.nextBudgetAt) return;
    this.nextBudgetAt = now + 250;
    // Sorted in place — `order` and `list` are the same array, and the only
    // thing that reads the order is the budget itself and the two callers that
    // want "nearest first".
    const list = this.list;
    for (const av of list) {
      const dx = av.pose.x - atX;
      const dz = av.pose.z - atZ;
      (av as unknown as { _d2: number })._d2 = dx * dx + dz * dz;
    }
    list.sort((a, b) => (a as unknown as { _d2: number })._d2 - (b as unknown as { _d2: number })._d2);
    this.order = list;
    let rigs = 0;
    let animated = 0;
    let loading = 0;
    let auras = 0;
    this.lit = 0;
    for (const av of list) {
      const d = Math.sqrt((av as unknown as { _d2: number })._d2);
      av.setVisible((av.info.isLocal || d <= TAG_RANGE) && (!av.replay || av.arrived));
      const wantRig = av.info.isLocal || (rigs < MAX_RIGS && d <= (av.hasRig() ? RIG_DROP : RIG_RANGE));
      if (wantRig) {
        rigs++;
        if (!av.hasRig() && loading < 2) {
          loading++;
          void av.loadRig();
        }
        const wantAnim = av.info.isLocal || animated < MAX_ANIMATED;
        if (wantAnim) animated++;
        av.setAnimating(wantAnim);
        // Your OWN effect always runs — a cosmetic you own is worth least in
        // the one place you cannot see it. Everybody else's is nearest-first.
        const wantAura = av.info.isLocal || (auras < MAX_AURAS && d <= (av.hasAura ? AURA_DROP : AURA_RANGE));
        av.setAura(wantAura);
        if (wantAura) auras++;
        if (wantAura && av.hasAura) this.lit++;
      } else if (!av.info.isLocal) {
        av.dropRig();
      }
    }
  }

  /** How many legendary effects are running right now.
   *
   *  The island reads it to decide whether to run a glow pass at all: a
   *  full-screen bloom is the most expensive thing in this scene, and there is
   *  nothing to bloom on an island where nobody is wearing one. */
  lit = 0;

  /** Nearest first, as of the last budget pass. Used by the voice mixer and by
   *  the "people near you" list, both of which want the same order. */
  get nearest(): Avatar[] {
    return this.order.length ? this.order : this.all;
  }

  dispose(): void {
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    this.list = [];
    this.order = [];
    this.shadowSource.dispose();
    this.shadowMat.dispose();
    this.shadowTex.dispose();
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
