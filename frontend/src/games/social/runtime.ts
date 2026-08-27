// Social Space — the runtime.
//
// One scene, twenty people, no simulation. That last part is the whole shape
// of this file and it is worth saying plainly: NOTHING here is authoritative
// and nothing here is replayed. There is no result to protect, so the local
// player moves themselves and everybody else is drawn from what the server
// last said. The three things that ARE decided in shared code — where the
// island's ground is, what you can walk through, and how loud somebody twelve
// metres away should be — are decided there precisely because the server and
// the console have to agree about them.
//
// Frame budget, in order of cost: twenty characters (capped to twelve models
// and eight skeletons by Crowd), fourteen instanced prop draws, four ground
// draws, one sky. The per-frame work in THIS file is one move, one camera, one
// loop over twenty avatars, and — six times a second, not sixty — one pass to
// work out who you can hear.
import { Scene } from "@babylonjs/core/scene";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { GameRuntime, GameRuntimeContext } from "../../platform/types";
import type { MatchEnd, MatchInputRelay, RosterEntry, Standing, QuickKind } from "../../shared/core/protocol";
import {
  ANIM_IDLE,
  ANIM_RUN,
  ANIM_WALK,
  CAM_FOLLOW_HOLD_MS,
  CLOSING_MS,
  HEAR_MAX_M,
  REPORT_HZ,
  SESSION_MS,
  TICK_RATE,
  TURN_RATE,
  angleDelta,
  heightAt,
  mapArrow,
  packReport,
  readTrack,
  readWire,
  followYaw,
  stickWant,
  type Held,
  TRACK_LEFT,
  resolveMove,
  spawnPoint,
  type Anim,
  type PoseWire,
} from "../../shared/games/social/index";
import { serverToLocal } from "../../platform/clock";
import { toast } from "../../ui/toast";
import { api } from "../../api/http";
import { emitAck } from "../../api/socket";
import { showMemberCard } from "../../ui/memberCard";
import { joinVoice, onTalkingChange } from "../../voice/livekit";
import { Crowd, type Avatar } from "./avatars";
import { HAZE, Island, cameraAt, cameraWants } from "./island";
import { Controls } from "./controls";
import { SocialHud } from "./hud";
import { Proximity } from "./proximity";
import { MiniMap, drawFullMap, fullMapToWorld, whereIs, type MapPerson, type MapPin } from "./minimap";

/** A tap that travelled further than this was a drag, not a tap. */
const TAP_SLOP = 10;
const TAP_MS = 400;
/** How often the "who can I add as a friend" list is refreshed. Rarely: it
 *  only changes when somebody arrives, and it is asked again on every roster
 *  change anyway. */
const ADDABLE_MS = 45_000;
/** Over the shoulder, not overhead. The camera sits this far above the
 *  player's feet plus what the look-drag has added, and looks at their chest —
 *  at head height it framed the top of everybody's hat, and any higher turned
 *  a social space into a strategy game. */
const CAM_HEIGHT = 1.6;
const CAM_PITCH_LIFT = 3.2;
const CAM_LOOK_AT = 1.45;
/** THE CAMERA SETTLING IN BEHIND A MOVING PLAYER is what makes turning feel
 *  right, and its absence is what made it feel wrong: the camera used to move
 *  only under a thumb, so walking east while it faced north meant watching
 *  your own character run sideways across the screen. The rates, and the rule
 *  for what a push on the stick means while it does that, are in
 *  shared/games/social/steer.ts — beside the check that runs them. */
/** How fast the camera closes on an obstacle behind it, and how slowly it
 *  comes back out. Fast IN, because being late means a frame inside a tree;
 *  slow OUT, because rushing back is the lurch. */
const CAM_IN_RATE = 14;
const CAM_OUT_RATE = 3.2;
/** How far behind the tape a WATCHED island is drawn. Much further behind than
 *  a live one, because a track samples twice a second rather than ten times:
 *  under one sample of delay there would be nothing to interpolate towards and
 *  every step would be an extrapolation. */
const REPLAY_DELAY_MS = 620;

export class SocialRuntime implements GameRuntime {
  private scene: Scene;
  private camera: TargetCamera;
  private island: Island;
  private crowd: Crowd;
  private controls: Controls | null = null;
  private hud: SocialHud | null = null;
  private minimap: MiniMap | null = null;
  /** Uids on this player's friend list — for the map, and for nothing else. */
  private friends = new Set<string>();
  /** The people this player walked in with, in the order the server numbers
   *  them. Told per-recipient with each roster — see LiveRoster.party. */
  private party: string[] = [];
  /** The spot somebody in the group has marked, if any. */
  private pin: MapPin | null = null;
  /** Rebuilt only when the map needs it, never per frame. */
  private readonly mapPeople: MapPerson[] = [];
  private proximity = new Proximity();
  private me: Avatar | null = null;
  private roster: RosterEntry[] = [];
  private bySeat = new Map<number, string>();
  /** Local-clock time the island opened and the time it closes. */
  private openedAt = 0;
  private endsAt = 0;
  private lastFrame = 0;
  private nextReport = 0;
  private lastSent = { x: 9e9, z: 9e9, ry: 9e9, anim: -1 };
  /** When the last report went out, so the next one can say how far apart
   *  they were. */
  private sentAt = 0;
  private addable = new Set<string>();
  private nextAddableAt = 0;
  private stopTalking: (() => void) | null = null;
  private talking = new Set<string>();
  private tap: { x: number; y: number; at: number } | null = null;
  private disposed = false;
  private ended = false;
  /** The bloom that makes a legendary read as legendary.
   *
   *  Built ONLY when somebody wearing one is actually on screen, and thrown
   *  away again when they are not. It is a full-screen pass and the most
   *  expensive thing in this scene — the runner deliberately goes without one
   *  for exactly that reason. An island is different: it is the one place
   *  people come to be looked at, and a legendary that does not glow here is a
   *  cosmetic that does not work where it matters most. Paying for it only
   *  while there is something to bloom is what makes that affordable.
   *
   *  Quarter-resolution, like the lobby's. */
  private glow: GlowLayer | null = null;
  private glowAt = 0;

  /** The settled camera distance — see CAM_IN_RATE. */
  private camBack = 6.2;
  /** WHERE THE STICK IS POINTING, and where that meant — see stickWant. Kept
   *  between frames so a stick held still keeps its WORLD direction while the
   *  camera swings in behind it. Null while the stick is at rest. */
  private held: Held | null = null;

  /** Reused every proximity pass — see Proximity.due. */
  private readonly neighbours: { uid: string; x: number; z: number }[] = [];
  private readonly camAt = new Vector3();
  private readonly lookAt = new Vector3();
  private readonly now: () => number;
  /** Nobody is playing — see GameRuntimeContext.spectator. */
  private readonly watching: boolean;
  /** Where the studio's camera is looking, eased so a replay does not snap
   *  round every time the person being watched turns. */
  private watchYaw = 0;

  constructor(private ctx: GameRuntimeContext) {
    this.now = ctx.now ?? Date.now;
    this.watching = ctx.spectator === true;
    const scene = new Scene(ctx.engine);
    this.scene = scene;
    scene.clearColor = new Color4(HAZE.r, HAZE.g, HAZE.b, 1);
    // Nothing in this world is hovered, and a pointer-move pick across twenty
    // capsules every mouse move is pure waste.
    scene.skipPointerMovePicking = true;
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = HAZE;
    // Set FROM the cull distances in island.ts, not independently of them: at
    // 140 m — where the trees stop being drawn — this leaves about a third of
    // the object showing through the haze, which is little enough that nobody
    // sees one go. At twenty metres, where people actually are, it is nothing.
    scene.fogDensity = 0.0075;

    this.camera = new TargetCamera("cam", new Vector3(0, 4, -8), scene);
    this.camera.fov = 0.9;
    this.camera.minZ = 0.35;
    // The fog is all but total past two hundred metres, so anything further is
    // being drawn into haze — and a shorter range is depth precision back.
    this.camera.maxZ = 260;
    scene.activeCamera = this.camera;

    // Two lights and no shadow map. The hemispheric one is doing more work
    // than it looks: this scene has no environment texture, so it is the ONLY
    // thing lighting the side of a character that is turned away from the sun,
    // and at the lobby's 0.6 everybody facing away from it read as a
    // silhouette on a sunny lawn. Its ground colour is the light bouncing off
    // the grass, which is why it is green rather than grey.
    const sky = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
    sky.intensity = 1.05;
    sky.diffuse = new Color3(1, 0.99, 0.94);
    sky.groundColor = new Color3(0.5, 0.55, 0.44);
    // Shallow rather than overhead: a sun straight above leaves every face in
    // its own shade, and faces are what people look at.
    const sun = new DirectionalLight("sun", new Vector3(-0.45, -0.62, 0.38), scene);
    sun.intensity = 1.15;
    sun.diffuse = new Color3(1, 0.96, 0.86);
    sun.specular = new Color3(0.12, 0.12, 0.12);
    scene.ambientColor = new Color3(0.22, 0.24, 0.2);

    this.island = new Island(scene);
    this.crowd = new Crowd(scene);
    this.openedAt = this.now();
    this.endsAt = this.openedAt + SESSION_MS;
  }

  // -- arriving -----------------------------------------------------------

  async prepare(): Promise<void> {
    const { rules, seed, roster, you } = this.ctx;
    if (typeof rules.openedAt === "number") this.openedAt = serverToLocal(rules.openedAt);
    if (typeof rules.endsAt === "number") this.endsAt = serverToLocal(rules.endsAt);
    await this.island.build(this.ctx.assets);
    this.applyRoster(roster);
    const me = this.crowd.get(you) ?? null;
    this.me = me;
    if (me) {
      // Where the server said we would land. Working it out from the same
      // shared function rather than waiting to be told keeps the first frame
      // from happening at the origin and then jumping.
      const seat = typeof rules.seat === "number" ? rules.seat : (me.info.seat ?? 0);
      const spawn = spawnPoint(seed, seat);
      me.pose.x = spawn.x;
      me.pose.z = spawn.z;
      me.pose.ry = spawn.ry;
      me.pose.anim = ANIM_IDLE;
      me.place(this.now(), 0);
      // Yours is the one model that is never budgeted away.
      await me.loadRig();
      me.setAnimating(true);
    }
    if (this.watching) {
      // Everybody comes off the tape, the focused player included: there is no
      // local player in a replay, only a camera following one. And nothing may
      // be attached that could author a position nobody ever stood in.
      for (const av of this.crowd.all) av.replay = true;
      this.watchYaw = me?.pose.ry ?? 0;
      return;
    }

    this.controls = new Controls(this.ctx.canvas, this.ctx.hudRoot, me?.pose.ry ?? 0);
    this.hud = new SocialHud(this.ctx.hudRoot, {
      onRun: () => this.controls?.toggleRun(),
      onEmote: (id) => void this.perform(id),
      onQuick: (id) => this.ctx.sendQuick("emote", id),
      onPeople: () => this.showPeople(),
      onMap: () => this.showMap(),
    });
    this.minimap = new MiniMap(this.hud.minimap);
    // Who you already know, so the map can say so. Asked once — a friend list
    // does not change while you are standing in a park, and the answer is
    // about YOUR account rather than about the island, so it leaks nothing
    // about who else is on it.
    void api
      .get<{ friends: { uid: string }[] }>("/api/friends")
      .then((r) => {
        this.friends = new Set((r.friends ?? []).map((f) => f.uid));
      })
      .catch(() => undefined);
    this.controls.watchRun((on) => this.hud?.setRunning(on));
    // DEV-only, and the only way the look-at-it check can report a geometry
    // budget rather than a frame rate.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__tofoSocial = this;
    this.ctx.canvas.addEventListener("pointerdown", this.onTapDown);
    this.ctx.canvas.addEventListener("pointerup", this.onTapUp);
    this.stopTalking = onTalkingChange((uids) => {
      this.talking = new Set(uids);
      for (const av of this.crowd.all) av.setTalking(this.talking.has(av.info.uid));
    });
    this.refreshAddable();
  }

  /** Tick 0 for this world is the moment it OPENED, which for anybody who did
   *  not open it is in the past — see the server's resume payload. The
   *  platform's countdown therefore never appears, which is correct: nobody
   *  counts you into a park. */
  go(localStartAt: number): void {
    this.openedAt = localStartAt;
    if (!this.endsAt) this.endsAt = localStartAt + SESSION_MS;
  }

  // -- what the server says ------------------------------------------------

  onSnap(payload: unknown): void {
    const snap = payload as { t?: unknown; p?: unknown } | null;
    if (!snap || typeof snap.t !== "number" || !Array.isArray(snap.p)) return;
    const at = serverToLocal(snap.t);
    for (const raw of snap.p as PoseWire[]) {
      const read = readWire(raw);
      if (!read) continue;
      const uid = this.bySeat.get(read.seat);
      if (!uid || uid === this.ctx.you) continue;
      // WHEN this pose was true, not when the snapshot carrying it was built.
      // The two differ by up to a report interval, and by a DIFFERENT amount
      // every tick — which is the whole of why people used to stutter while
      // bots did not.
      this.crowd
        .get(uid)
        ?.push(at - read.age, read.pose.x, read.pose.z, read.pose.ry, read.pose.anim);
    }
  }

  /** Mark a spot for the group, or take the marker down. Optimistic: the
   *  server's relay comes straight back and confirms it. */
  private sendPin(at: { x: number; z: number } | null): void {
    // Shown before the server has heard about it. The relay comes straight
    // back and overwrites this with the authoritative one, clamped to the
    // island; the difference is never visible.
    this.pin = at ? { x: at.x, z: at.z, mine: true } : null;
    this.ctx.sendPin(at);
  }

  onPin(uid: string, x: number | null, z: number | null): void {
    this.pin = x === null || z === null ? null : { x, z, mine: uid === this.ctx.you };
  }

  onRoster(roster: RosterEntry[], endsAt: number, party: string[]): void {
    this.party = party;
    this.endsAt = serverToLocal(endsAt);
    this.applyRoster(roster);
    this.refreshAddable(true);
    // ASK FOR THE VOICE ROOM AGAIN.
    //
    // The server hands out no room at all while you are the only person on an
    // island — there is nobody to talk to, and an open LiveKit participant
    // listening to nineteen people who have no microphones costs real money to
    // hear silence. So the first person through the door has no room, and the
    // moment somebody else walks in they need one. Without this they would be
    // standing next to each other unable to hear a word.
    //
    // Idempotent: already in the right room and this returns immediately.
    void joinVoice(`M${this.ctx.matchId}`, (msg, isError) => toast(msg, isError), "match", { proximity: true });
  }

  onClosing(at: number): void {
    this.endsAt = serverToLocal(at);
    this.hud?.showClosing(() => (this.endsAt - this.now()) / 1000);
  }

  onEmote(uid: string, id: string): void {
    void this.crowd.get(uid)?.perform(id);
  }

  onQuick(uid: string, kind: QuickKind, id: string): void {
    if (kind !== "emote") return;
    this.crowd.get(uid)?.say(id, 2600);
  }

  onLeft(uid: string): void {
    // The roster message that follows is what actually removes them; this only
    // stops them being drawn a frame or two early.
    this.crowd.get(uid)?.setVisible(false);
  }

  /** ---- being watched -------------------------------------------------
   *
   *  A LIVE island has no inputs at all: positions ride their own channel and
   *  are relayed and forgotten. An ARCHIVED one is nothing but inputs — the
   *  server writes everybody's walk into the replay's input log as a track of
   *  poses (see shared/games/social/net.ts), precisely so the console's studio
   *  can play it with no idea it is not a match. These two hooks are where
   *  that arrives.
   * ------------------------------------------------------------------- */
  onRemoteInput(input: MatchInputRelay): void {
    this.applyTrack(input);
  }

  /** Everything before the playhead, handed over in one go when the studio
   *  seeks. Order is guaranteed, so this is the same path. */
  seedInputs(inputs: MatchInputRelay[]): void {
    for (const i of inputs) this.applyTrack(i);
  }

  private applyTrack(i: MatchInputRelay): void {
    const av = this.crowd.get(i.uid);
    if (!av) return;
    if (i.kind === TRACK_LEFT) {
      av.setVisible(false);
      return;
    }
    const pose = readTrack(i.kind);
    if (!pose) return;
    // A tick IS the timeline here — the island has no simulation, and `go`
    // gave us the moment tick zero landed on the studio's own clock.
    // From the FILE where the studio supplies it, so a replay written under an
    // older tick rate still plays at the speed it was recorded.
    const rate = typeof this.ctx.rules.tickRate === "number" && this.ctx.rules.tickRate > 0
      ? this.ctx.rules.tickRate
      : TICK_RATE;
    av.push(this.openedAt + (i.tick * 1000) / rate, pose.x, pose.z, pose.ry, pose.anim);
  }

  private applyRoster(roster: RosterEntry[]): void {
    this.roster = roster;
    const seen = new Set<string>();
    this.bySeat.clear();
    for (let i = 0; i < roster.length; i++) {
      const entry = roster[i];
      const seat = entry.seat ?? i;
      seen.add(entry.uid);
      this.bySeat.set(seat, entry.uid);
      const existing = this.crowd.get(entry.uid);
      if (existing) continue;
      this.crowd.add({
        uid: entry.uid,
        name: entry.name,
        character: entry.character,
        weapon: entry.weapon,
        seat,
        isLocal: entry.uid === this.ctx.you,
      });
    }
    for (const av of this.crowd.all) {
      if (!seen.has(av.info.uid)) this.crowd.remove(av.info.uid);
    }
    if (this.me && !seen.has(this.me.info.uid)) this.me = null;
    this.me ??= this.crowd.get(this.ctx.you) ?? null;
  }

  // -- one frame -----------------------------------------------------------

  /** What this island is costing, for the look-at-it check.
   *
   *  Triangles and draw calls rather than a frame rate: the box these checks
   *  run on has no GPU, so its frame rate says nothing about a phone, while
   *  "how much geometry is actually being submitted" is the same number
   *  everywhere and is the thing the budgets in here exist to hold down. */
  debug(): Record<string, number> {
    return {
      activeIndices: this.scene.getActiveIndices(),
      activeMeshes: this.scene.getActiveMeshes().length,
      totalMeshes: this.scene.meshes.length,
      people: this.crowd.all.length,
      near: this.proximity.near,
      // How many characters have a model, and how many of those are wearing a
      // legendary effect. A screenshot cannot answer the second question —
      // the people it shows are usually too far away to tell — and it is
      // exactly the question this game shipped getting wrong.
      rigs: this.crowd.all.filter((a) => a.hasRig()).length,
      lit: this.crowd.lit,
      glow: this.glow ? 1 : 0,
      // Which way the player is facing, and the angle the map's arrow is drawn
      // at. Reported because the arrow has been stuck twice, and a 124-pixel
      // dial in a screenshot is not evidence either way — two numbers taken
      // after turning are.
      heading: Math.round(((this.me?.pose.ry ?? 0) * 180) / Math.PI),
      arrow: Math.round((mapArrow(this.me?.pose.ry ?? 0) * 180) / Math.PI),
      // Where the CAMERA is pointing, and how far back it is sitting. The
      // camera easing round behind a turn is the whole difference between a
      // turn that feels like Free Fire and one that does not, and it cannot be
      // read off a screenshot: the picture after a turn looks the same whether
      // the camera got there in a frame or a second.
      yaw: Math.round(((this.controls?.yaw ?? 0) * 180) / Math.PI),
      back: Math.round(this.camBack * 100) / 100,
      pin: this.pin ? 1 : 0,
    };
  }

  render(): void {
    if (this.disposed) return;
    const now = this.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;

    this.step(dt, now);
    this.island.update(dt * 1000);
    this.scene.render();
  }

  private step(dt: number, now: number): void {
    const me = this.me;
    const controls = this.controls;
    if (this.watching) {
      this.watch(dt, now, me);
      return;
    }
    if (me && controls && !this.ended) {
      const read = controls.read();
      if (read.speed > 0) {
        // WHICH WAY THE PUSH MEANS — see stickWant, and the trap written down
        // above it. In short: camera space at the moment the stick moves,
        // world-locked while it is held, and camera space throughout while a
        // thumb is dragging the view.
        const steering = controls.looking || now - controls.lookedAt <= CAM_FOLLOW_HOLD_MS;
        this.held = stickWant(Math.atan2(read.x, read.z), controls.yaw, steering, this.held);
        const want = this.held.want;

        const dx = Math.sin(want);
        const dz = Math.cos(want);
        const step = read.speed * dt;
        const fromX = me.pose.x;
        const fromZ = me.pose.z;
        const m = resolveMove(fromX + dx * step, fromZ + dz * step);
        me.pose.x = m.x;
        me.pose.z = m.z;
        me.pose.ry += angleDelta(me.pose.ry, want) * Math.min(1, dt * TURN_RATE);
        // …and the camera settles in behind them, unless the player is aiming
        // it somewhere themselves. See CAM_FOLLOW_RATE — this is the whole of
        // why turning feels like turning.
        if (!steering) controls.yaw = followYaw(controls.yaw, me.pose.ry, dt);
        // Walking into a tree should look like walking into a tree, not like
        // running on the spot — but SLIDING along one is still walking, and
        // that is the distinction `blocked` alone cannot make. Testing the
        // flag made a player brushing past a hedge flicker between the walk
        // clip and the idle every frame, which on everybody else's screen is
        // indistinguishable from a bad connection. What settles it is how far
        // they actually got.
        const got = Math.hypot(m.x - fromX, m.z - fromZ);
        me.pose.anim = got < step * 0.3 ? ANIM_IDLE : ((read.running ? ANIM_RUN : ANIM_WALK) as Anim);
      } else {
        me.pose.anim = ANIM_IDLE;
        // A stick at rest forgets where it was pointing: the next push is
        // read against the camera again, which is what makes "tap left" turn
        // you left from wherever you are now looking.
        this.held = null;
      }
      this.report(now, me);
    }

    // Everybody, drawn where they should be for this instant.
    for (const av of this.crowd.all) av.place(now, dt);
    if (me) {
      this.crowd.budget(now, me.pose.x, me.pose.z);
      this.island.cull(now, me.pose.x, me.pose.z);
      for (const av of this.crowd.nearest) av.syncClip();
      const lift = CAM_HEIGHT + (controls?.pitch ?? 0.18) * CAM_PITCH_LIFT;
      const yaw = controls?.yaw ?? 0;
      // Ease the distance rather than taking it raw — see cameraWants.
      const want = cameraWants(me.pose.x, me.pose.z, yaw, controls?.distance ?? 6.2);
      const rate = want < this.camBack ? CAM_IN_RATE : CAM_OUT_RATE;
      this.camBack += (want - this.camBack) * Math.min(1, dt * rate);
      this.camera.position.copyFrom(cameraAt(me.pose.x, me.pose.z, yaw, this.camBack, lift, this.camAt));
      this.lookAt.set(me.pose.x, heightAt(me.pose.x, me.pose.z) + CAM_LOOK_AT, me.pose.z);
      this.camera.setTarget(this.lookAt);

      // Voice, six times a second. Everybody is offered — the ones with no
      // microphone simply are not in the room, and this never has to know
      // which those are.
      if (this.proximity.due(now)) {
        this.neighbours.length = 0;
        for (const a of this.crowd.nearest) {
          if (a === me) continue;
          this.neighbours.push({ uid: a.info.uid, x: a.pose.x, z: a.pose.z });
        }
        this.proximity.update(now, me.pose.x, me.pose.z, this.neighbours);
      }
      this.hud?.setNear(this.proximity.near);
      this.paintMap(now, me);
    }
    this.lightUp(now);
    this.hud?.setClock(this.endsAt - now);
    if (!this.ended && this.endsAt - now <= CLOSING_MS + 250) {
      this.hud?.showClosing(() => (this.endsAt - this.now()) / 1000);
    }
    if (now >= this.nextAddableAt) this.refreshAddable();
  }

  /** One frame of a replay: draw everybody from the tape, and put the camera
   *  behind whoever is being watched.
   *
   *  Deliberately its own path rather than the live one with the controls
   *  removed. Nothing here reads an input device, nothing sends anything, and
   *  nothing touches the voice mixer — a replay that could be steered, or that
   *  could open a microphone, is not a replay. */
  private watch(dt: number, now: number, me: Avatar | null): void {
    for (const av of this.crowd.all) av.place(now, dt, REPLAY_DELAY_MS);
    if (!me) return;
    this.crowd.budget(now, me.pose.x, me.pose.z);
    this.island.cull(now, me.pose.x, me.pose.z);
    for (const av of this.crowd.nearest) av.syncClip();
    // Behind them, easing round as they turn: a camera welded to a facing that
    // is itself interpolated jitters, and a replay is watched, not steered.
    this.lightUp(now);
    this.watchYaw += angleDelta(this.watchYaw, me.pose.ry) * Math.min(1, dt * 2.2);
    const wantBack = cameraWants(me.pose.x, me.pose.z, this.watchYaw, 7.2);
    const rate = wantBack < this.camBack ? CAM_IN_RATE : CAM_OUT_RATE;
    this.camBack += (wantBack - this.camBack) * Math.min(1, dt * rate);
    this.camera.position.copyFrom(
      cameraAt(me.pose.x, me.pose.z, this.watchYaw, this.camBack, CAM_HEIGHT + 0.9, this.camAt)
    );
    this.lookAt.set(me.pose.x, heightAt(me.pose.x, me.pose.z) + CAM_LOOK_AT, me.pose.z);
    this.camera.setTarget(this.lookAt);
  }

  /** Turn the bloom on when there is a legendary in view and off when there is
   *  not. Checked a few times a second, not sixty — the answer changes when
   *  somebody walks up to you, and building or dropping the layer is not
   *  something to do on a whim. */
  private lightUp(now: number): void {
    if (now < this.glowAt) return;
    this.glowAt = now + 900;
    const want = this.crowd.lit > 0;
    if (want === (this.glow !== null)) return;
    if (!want) {
      this.crowd.useGlow(null);
      this.glow?.dispose();
      this.glow = null;
      return;
    }
    void import("@babylonjs/core/Layers/glowLayer").then(({ GlowLayer }) => {
      if (this.disposed || this.glow || this.crowd.lit === 0) return;
      const glow = new GlowLayer("islandGlow", this.scene, { mainTextureRatio: 0.25 });
      glow.intensity = 0.7;
      // Everything that is not a legendary is kept out of it — see
      // Island.excludeFromGlow for what that is worth.
      this.island.excludeFromGlow(glow);
      this.crowd.useGlow(glow);
      this.glow = glow;
    });
  }

  /** Everybody the map should show, reusing one array. Only people the server
   *  actually told us about are in it — which is everybody within seventy
   *  metres, plus your friends wherever they are. */
  private mapPeople_(me: Avatar): MapPerson[] {
    const out = this.mapPeople;
    out.length = 0;
    for (const a of this.crowd.all) {
      if (a === me || !a.arrived) continue;
      const dx = a.pose.x - me.pose.x;
      const dz = a.pose.z - me.pose.z;
      const squad = this.party.indexOf(a.info.uid);
      out.push({
        uid: a.info.uid,
        name: a.info.name,
        x: a.pose.x,
        z: a.pose.z,
        ry: a.pose.ry,
        friend: this.friends.has(a.info.uid),
        // 1-based, and the player themselves is not in the list — so a squad
        // of four reads 1, 2, 3 around a map centred on the fourth.
        squad: squad < 0 ? 0 : squad + 1,
        near: dx * dx + dz * dz <= HEAR_MAX_M * HEAR_MAX_M,
      });
    }
    return out;
  }

  /** THE CHARACTER'S facing, not the camera's.
   *
   *  This was the camera for one round, on the reasoning that a player
   *  standing still and looking around should see the map respond. That was
   *  right while the map ROTATED and wrong the moment it stopped: with a fixed
   *  map the arrow is the player's marker on it, and a marker has to point
   *  where the player is pointing. On a phone you turn by walking, which does
   *  not move the camera at all — so the arrow sat still through every turn a
   *  player actually made, which is the one thing it exists to show. */
  private paintMap(now: number, me: Avatar): void {
    this.minimap?.draw(now, me.pose, this.mapPeople_(me), this.pin);
    this.hud?.setWhere(whereIs(me.pose.x, me.pose.z));
  }

  private showMap(): void {
    const me = this.me;
    if (!me) return;
    this.hud?.showMap(
      (canvas) => drawFullMap(canvas, me.pose, this.mapPeople_(me), this.pin),
      // A tap on the island marks it for the group. Tapping the pin again
      // takes it down, which is how anything that can be put somewhere should
      // be able to be put nowhere.
      (canvas, clientX, clientY) => {
        const at = fullMapToWorld(canvas, clientX, clientY);
        const clearing = this.pin !== null && Math.hypot(this.pin.x - at.x, this.pin.z - at.z) < 6;
        this.sendPin(clearing ? null : at);
      }
    );
  }

  /** Tell the world where we are — ten times a second, and only when it has
   *  actually changed. Standing still costs one message every half second,
   *  which is the keep-alive that stops a stale position being interpolated
   *  for ever on somebody else's screen. */
  private report(now: number, me: Avatar): void {
    if (now < this.nextReport) return;
    const moved =
      Math.abs(me.pose.x - this.lastSent.x) > 0.02 ||
      Math.abs(me.pose.z - this.lastSent.z) > 0.02 ||
      Math.abs(angleDelta(this.lastSent.ry, me.pose.ry)) > 0.02 ||
      me.pose.anim !== this.lastSent.anim;
    if (!moved && now < this.nextReport + 500) return;
    this.nextReport = now + 1000 / REPORT_HZ;
    this.lastSent.x = me.pose.x;
    this.lastSent.z = me.pose.z;
    this.lastSent.ry = me.pose.ry;
    this.lastSent.anim = me.pose.anim;
    // HOW MUCH WALKING THIS REPORT CONTAINS, measured here rather than guessed
    // at the far end. Reports leave on a render frame, so they are spaced by
    // whatever the frame rate happened to be — 100 ms on one device, 116 on
    // another, and neither of them evenly. Sending the gap lets everybody
    // else's interpolation space these two poses exactly as this device did.
    // Without it the receiver assumes they are evenly spaced and the character
    // alternately stalls and sprints. See PoseReport.
    const dt = this.sentAt > 0 ? now - this.sentAt : 0;
    this.sentAt = now;
    this.ctx.sendState(packReport(me.pose, dt));
  }

  // -- meeting people ------------------------------------------------------

  private onTapDown = (e: PointerEvent): void => {
    this.tap = { x: e.clientX, y: e.clientY, at: this.now() };
  };

  private onTapUp = (e: PointerEvent): void => {
    const tap = this.tap;
    this.tap = null;
    if (!tap || this.ended || this.watching) return;
    if (this.now() - tap.at > TAP_MS) return;
    if (Math.abs(e.clientX - tap.x) > TAP_SLOP || Math.abs(e.clientY - tap.y) > TAP_SLOP) return;
    // Only the invisible capsules around people are pickable, so this is a ray
    // against at most twenty small meshes — never against the two hundred and
    // eighty props, which are all marked unpickable for exactly this reason.
    const hit = this.scene.pick(e.clientX, e.clientY, (mesh: AbstractMesh) => mesh.isPickable);
    const uid = (hit?.pickedMesh?.metadata as { uid?: string } | undefined)?.uid;
    if (!uid) return;
    this.openCard(uid);
  };

  private openCard(uid: string): void {
    const entry = this.roster.find((r) => r.uid === uid);
    if (!entry) return;
    showMemberCard(
      {
        // `id` is the platform's internal user id and is never sent to a
        // client; the card only ever addresses people by uid.
        id: "",
        uid,
        name: entry.name,
        avatarUrl: null,
        isLeader: false,
        character: entry.character,
        weapon: entry.weapon,
      },
      {
        // Offered only when the server has said this player can be added. A
        // uid is absent from that list whether it belongs to the server
        // population, to somebody already on your friend list, or to somebody
        // you already have a request with — so the button's absence says
        // nothing about which.
        befriend: this.addable.has(uid)
          ? async () => {
              try {
                await api.post("/api/friends/request", { uid });
                this.addable.delete(uid);
                toast(`Friend request sent to ${entry.name}`);
              } catch (err) {
                toast(err instanceof Error ? err.message : "Could not send that", true);
              }
            }
          : undefined,
      }
    );
  }

  private refreshAddable(force = false): void {
    if (!force && this.now() < this.nextAddableAt) return;
    this.nextAddableAt = this.now() + ADDABLE_MS;
    void emitAck<{ uids: string[] }>("match:addable", { matchId: this.ctx.matchId })
      .then((res) => {
        if (Array.isArray(res?.uids)) this.addable = new Set(res.uids);
      })
      .catch(() => undefined);
  }

  /** Perform an emote: shown here at once, and asked of the server at the same
   *  moment. The optimistic half is deliberate — an emote is a gesture, and a
   *  gesture that waits for a round trip before it happens does not read as
   *  one. If the server refuses (an emote this player does not own, or one too
   *  soon after the last), the refusal is a toast and the animation was a
   *  private rehearsal nobody else saw. */
  private async perform(id: string): Promise<void> {
    const me = this.me;
    void me?.perform(id);
    try {
      const res = await this.ctx.sendEmote(id);
      if (res?.error) toast(res.error, true);
    } catch {
      /* the socket is gone; the world is about to tell us so anyway */
    }
  }

  private showPeople(): void {
    const me = this.me;
    if (!me) return;
    const rows = this.crowd.nearest
      .filter((a) => a !== me)
      .map((a) => ({
        name: a.info.name,
        metres: Math.hypot(a.pose.x - me.pose.x, a.pose.z - me.pose.z),
        heard: false,
      }))
      .filter((r) => r.metres <= 70)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, 20);
    for (const r of rows) r.heard = r.metres <= HEAR_MAX_M;
    this.hud?.showPeople(rows);
  }

  // -- leaving -------------------------------------------------------------

  end(_result: MatchEnd): void {
    this.ended = true;
    this.controls?.dispose();
    this.controls = null;
    this.proximity.reset();
  }

  resultsHeadline(result: MatchEnd, you: string): { headline: string; sub: string } {
    const mine = result.standings.find((s) => s.uid === you);
    const mins = mine?.detail.minutes ?? 0;
    const met = mine?.detail.met ?? 0;
    return {
      headline: result.reason === "aborted" ? "The island closed early" : "You left the island",
      sub:
        met > 0
          ? `${mins} minute${mins === 1 ? "" : "s"} here · you stood with ${met} ${met === 1 ? "person" : "people"}`
          : `${mins} minute${mins === 1 ? "" : "s"} here`,
    };
  }

  describeStanding(standing: Standing): string {
    const mins = standing.detail.minutes ?? 0;
    const met = standing.detail.met ?? 0;
    return `${mins} min${met ? ` · met ${met}` : ""}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ctx.canvas.removeEventListener("pointerdown", this.onTapDown);
    this.ctx.canvas.removeEventListener("pointerup", this.onTapUp);
    this.stopTalking?.();
    this.stopTalking = null;
    this.proximity.reset();
    this.controls?.dispose();
    this.hud?.dispose();
    this.glow?.dispose();
    this.glow = null;
    this.crowd.dispose();
    this.island.dispose();
    this.scene.dispose();
  }
}
