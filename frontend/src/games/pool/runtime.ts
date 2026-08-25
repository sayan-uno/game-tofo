// 8-ball on the client: the table, the thumb, and the one loop that draws it.
//
// It draws on its OWN two-dimensional canvases rather than through Babylon, for
// the reason Ludo and carrom do — a pool table seen from above is flat, and a
// flat table drawn as geometry is sharper, smaller and very much cheaper than
// the same table built out of meshes. The platform hands every game the 3D
// engine because the first game needed it, not because a game must use it.
// Nothing here touches the engine at all; the render loop the platform installs
// simply calls a function that paints.
//
// THE TABLE IS NOT TURNED FOR ANYBODY. Carrom rotates the board per seat,
// because a carrom player owns an edge and an aim gesture only means something
// from behind it. Pool has no edges: both sides play the whole table and the
// cue ball may be anywhere on it, so turning the table for one player would
// turn it away from the other. Head rail on the left, foot rail on the right,
// the same picture for everyone.
//
// WHAT A STROKE DOES. Nothing, to the table. The gesture sends a REQUEST and
// pulls the cue back on the spot; no ball moves until the server writes the
// shot and it comes back through the ordinary input relay. The reason is in the
// simulation's header and it is not squeamishness — on a platform that relays
// an input to everyone except its sender, a client that struck its own cue ball
// would be the one participant unable to discover that nobody else had.
//
// THE CONTROLS, and why there are four of them.
//
//   AIM     drag anywhere on the cloth. The line points from the cue ball at
//           your finger — no inversion to hold in your head, the whole table as
//           runway, and a full 360°. Letting go changes nothing.
//   FINE    a bar, because a pot is a quarter of a degree wide and a thumb is
//           eight millimetres. It swings the aim two degrees end to end and
//           springs back to the middle, folding what it did into the aim, so it
//           can be used over and over to walk the line onto a ball.
//   POWER   its own bar. It keeps its value between shots.
//   PLACE   only when the cue ball is in hand: drag the ball itself. Where it
//           lands is decided by the SHARED `nearestSpot`, so the ghost under
//           the thumb is exactly where the server will put it.
//   SHOOT   a button. Nothing leaves this device until it is pressed.
import type { GameRuntime, GameRuntimeContext } from "../../platform/types";
import type { MatchEnd, MatchInputRelay, QuickKind, Standing } from "../../shared/core/protocol";
import { QUICK_CHAT } from "../../shared/core/protocol";
import {
  BALL_R,
  CUE,
  DURATION_TICKS,
  HALF_X,
  HALF_Y,
  NUDGE_KIND,
  PER_GROUP,
  PoolSim,
  TICK_MS,
  aimKind,
  askKind,
  ballName,
  firstHit,
  nearestSpot,
  parseInput,
  remaining,
  teamOf,
  type PoolState,
} from "../../shared/games/pool/index";
import { PoolHud } from "./hud";
import {
  layoutFor,
  liveBounds,
  onCue,
  paintAim,
  paintBall,
  paintBalls,
  paintCue,
  paintGhostCue,
  paintImpact,
  paintKitchen,
  paintTable,
  strokeDraw,
  toTable,
  type AimDraw,
  type Layout,
} from "./paint";
import { GROUP, weightWord } from "./theme";

/** How long a request may sit unanswered before the shot is offered again. The
 *  server answers in a fraction of this; it exists so that a gesture the
 *  platform quietly dropped is one the player can simply make again, rather
 *  than a turn lost to a countdown they cannot influence. */
const RETRY_MS = 2200;
/** Frames per second while only a highlight is pulsing and the table is still.
 *  A pulse does not need sixty. */
const IDLE_FPS = 30;

/** How far from the cue ball a finger has to be before it counts as an aim.
 *  Closer than this the direction is mostly noise — a thumb-width of travel
 *  would swing the line through ninety degrees. */
const AIM_MIN = BALL_R * 2.2;

/** How far the fine bar can swing the aim, end to end. Two degrees: enough to
 *  cross a ball at the far rail, small enough that the whole bar is spent on
 *  the part of the angle a drag cannot reach. Expressed as the sine, because
 *  the aim is a vector and this file is not obliged to avoid trigonometry — but
 *  there is no reason to reach for it either. */
const TRIM_SWING = 0.0175;

/** The weight a player starts with, and gets back each match. Firm enough to
 *  run the length of the table and still have something left at the far end. */
const POWER_DEFAULT = 0.5;

/** How long the cue keeps going after it has reached the ball.
 *
 *  A stroke that stopped dead on contact reads as a poke; every player follows
 *  through, and the ball has already gone by then so it costs nothing to show.
 *  The ring that comes off the contact spot is shorter still — it is
 *  punctuation, and punctuation that outstays the sentence is a smear. */
const FOLLOW_MS = 240;
const IMPACT_MS = 190;

/** ---------------------------------------------------------------------------
 *  Letting the table watch you think.
 *
 *  Most of a frame of pool is watching somebody else walk round the table, and
 *  a version of this game where the other side saw nothing until a ball moved
 *  would be a version where nobody knew what was about to happen. So while a
 *  player composes, their placement, their angle and their weight go out as
 *  `m…` inputs and everyone draws them.
 *
 *  FOUR TIMES A SECOND AT MOST, and only when something actually changed. The
 *  platform's ceiling for this game is six inputs a second and the commit needs
 *  room inside it; more to the point every accepted input is ARCHIVED, so an
 *  aim sent per frame would be a sixtyfold replay for no more information than
 *  this. The change test is coarse for the same reason — a thumb resting on the
 *  glass jitters, and jitter is not news.
 * ------------------------------------------------------------------------- */
const AIM_SEND_MS = 250;
/** Smallest change worth telling anyone about, in the wire's own integer units
 *  (thousandths). Two degrees of angle, a fiftieth of the table, a twentieth of
 *  the power. */
const AIM_STEP = { dir: 35, spot: 20, power: 50 };

/** What somebody else is about to do, as last heard. */
interface Intent {
  x: number;
  y: number;
  dx: number;
  dy: number;
  p: number;
  tick: number;
}

export class PoolRuntime implements GameRuntime {
  private root: HTMLElement;
  private tableCanvas: HTMLCanvasElement;
  private liveCanvas: HTMLCanvasElement;
  private bg: CanvasRenderingContext2D;
  private fg: CanvasRenderingContext2D;
  private layout: Layout;
  private dpr = 1;

  private sim: PoolSim;
  private players: number;
  private mySeat: number;
  private myTeam: number;
  private seatOf = new Map<string, number>();
  private hud: PoolHud;

  private startAt: number | null = null;
  /** The clock this runtime reads. Date.now() while a player is playing; a
   *  clock the console drives while somebody is watching it back. */
  private readonly now: () => number;
  /** Nobody is playing — see GameRuntimeContext.spectator. Pool already treats
   *  every input as remote (the server authors them all and relays them to
   *  everyone including the asker), so only the GESTURES have to be refused. */
  private readonly spectator: boolean;
  private tick = 0;
  private durationTicks: number;

  // ---- the shot being composed -------------------------------------------
  //
  // All of these survive a shot on purpose: a player who has found the weight
  // they like should not have to find it again next turn.
  private aimDir = { x: 1, y: 0 };
  private aimPower = POWER_DEFAULT;
  /** Where this player has asked for the cue ball, while it is in hand. Only
   *  read when the table is actually offering it. */
  private spot = { x: 0, y: 0 };
  /** The fine bar's position, −1…1. Folded into `aimDir` and zeroed the moment
   *  the knob is let go, which is what makes it usable repeatedly. */
  private trim = 0;
  /** A drag on the cloth: aiming, or moving the cue ball. */
  private drag: { id: number; mode: "place" | "aim" } | null = null;
  /** Has this player taken a shot? The control hint goes away after one. */
  private shotOnce = false;
  /** The HUD is told about the bars only when they move, not per frame. */
  private lastBars = "";
  /** What every seat is currently lining up, by seat — theirs from the wire,
   *  and nobody's until they touch something. */
  private intent = new Map<number, Intent>();
  /** The last aim actually put on the wire, and when. */
  private sentAim: { x: number; y: number; dx: number; dy: number; p: number } | null = null;
  private sentAimAt = 0;

  /** The request we have made about the turn currently on the table.
   *
   *  Keyed on the turn INSTANCE rather than cleared when the answer arrives.
   *  The server stamps its answer a fifth of a second ahead so that nobody has
   *  to rewind for it, which leaves a window between the answer landing on the
   *  wire and the table acting on it — and a flag cleared on arrival would
   *  spend that window inviting a stroke that has already been made. */
  private asked: { key: string; at: number } | null = null;
  private lastSig = "";
  private lastPaintAt = 0;
  private lastTurnKey = "";
  private ended = false;
  private disposed = false;
  private onResize: () => void;
  private observer: ResizeObserver | null = null;
  private detach: (() => void)[] = [];

  constructor(private ctx: GameRuntimeContext) {
    this.now = ctx.now ?? Date.now;
    this.spectator = ctx.spectator === true;
    this.players = ctx.roster.length >= 3 ? 4 : 2;
    // The server sorts the roster by seat, so the index IS the seat — the same
    // contract the other four games rely on.
    ctx.roster.forEach((r, seat) => this.seatOf.set(r.uid, seat));
    this.mySeat = this.seatOf.get(ctx.you) ?? 0;
    this.myTeam = teamOf(this.mySeat, this.players);

    const rules = ctx.rules ?? {};
    this.durationTicks =
      Number.isFinite(rules.durationTicks) && rules.durationTicks > 0
        ? Math.round(rules.durationTicks)
        : DURATION_TICKS;
    this.sim = new PoolSim(ctx.seed, this.players, this.durationTicks);

    this.root = document.createElement("div");
    this.root.className = "pl-root";
    this.tableCanvas = document.createElement("canvas");
    this.tableCanvas.className = "pl-canvas pl-table";
    this.liveCanvas = document.createElement("canvas");
    this.liveCanvas.className = "pl-canvas pl-live";
    this.root.appendChild(this.tableCanvas);
    this.root.appendChild(this.liveCanvas);
    ctx.hudRoot.appendChild(this.root);
    this.bg = this.tableCanvas.getContext("2d")!;
    this.fg = this.liveCanvas.getContext("2d")!;

    this.hud = new PoolHud({
      root: this.root,
      myTeam: this.myTeam,
      spectator: this.spectator,
      seats: ctx.roster.slice(0, this.players).map((r, seat) => ({
        seat,
        team: teamOf(seat, this.players),
        name: r.name,
        you: r.uid === ctx.you,
        ours: teamOf(seat, this.players) === this.myTeam,
        uid: r.uid,
      })),
      onQuick: (kind, id) => ctx.sendQuick(kind, id),
      onPower: (p) => {
        this.setPower(p);
        this.maybeSendAim(this.state());
      },
      onTrim: (t) => {
        this.setTrim(t);
        this.maybeSendAim(this.state());
      },
      onTrimEnd: () => this.foldTrim(),
      onShoot: () => this.shoot(),
    });

    this.layout = layoutFor(1, 1);
    this.onResize = () => this.resize();
    // A ResizeObserver rather than a per-frame size check: reading an element's
    // width every frame forces the browser to lay the page out again, which is
    // exactly the cost this game is built to avoid.
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.root);
    }
    window.addEventListener("resize", this.onResize);
    window.addEventListener("orientationchange", this.onResize);
    if (!this.spectator) this.attachControls();
  }

  // ---- lifecycle ----------------------------------------------------------

  async prepare(): Promise<void> {
    this.resize();
  }

  go(localStartAt: number): void {
    this.startAt = localStartAt;
    // Knowing WHEN tick zero lands changes what the HUD should show — a turn
    // clock cannot start before there is a clock — but it changes nothing on
    // the table, so the signature below would not notice.
    this.lastSig = "";
    this.lastTurnKey = "";
  }

  seedInputs(inputs: MatchInputRelay[]): void {
    for (const i of inputs) this.feed(i);
  }

  onRemoteInput(input: MatchInputRelay): void {
    this.feed(input);
  }

  private feed(input: MatchInputRelay): void {
    const seat = this.seatOf.get(input.uid);
    if (seat === undefined) return;
    this.sim.addInput({ tick: input.tick, seat, kind: input.kind });
    // An aim and a commit both say where somebody is pointing. Neither moves
    // anything — `addInput` above has already thrown them away — so this is the
    // only thing that reads them, and it is presentation and nothing else.
    const parsed = parseInput(input.kind);
    if (parsed && (parsed.type === "aim" || parsed.type === "ask")) {
      const prev = this.intent.get(seat);
      // Out-of-order delivery is ordinary; an older aim must not overwrite a
      // newer one just because it arrived second.
      if (!prev || input.tick >= prev.tick) {
        this.intent.set(seat, { ...parsed.shot, tick: input.tick });
        this.lastSig = "";
      }
    }
  }

  /** What this seat is lining up, if it is theirs to line up and they have said
   *  anything about it since the turn began. */
  private intentOf(s: PoolState, seat: number): Intent | null {
    const i = this.intent.get(seat);
    if (!i || s.phase !== "aim" || s.turn !== seat) return null;
    // Stamped before this turn opened, so it belongs to a turn that is over —
    // which is exactly what a studio hands you after a scrub.
    return i.tick >= s.since ? i : null;
  }

  onLeft(uid: string): void {
    const seat = this.seatOf.get(uid);
    if (seat !== undefined) this.hud.setGone(seat, true);
  }

  onQuick(uid: string, kind: QuickKind, id: string): void {
    const seat = this.seatOf.get(uid);
    if (seat === undefined) return;
    const text = kind === "emote" ? id : (QUICK_CHAT.find((q) => q.id === id)?.text ?? "");
    if (text) this.hud.say(seat, text);
  }

  end(): void {
    this.ended = true;
    this.asked = null;
    this.drag = null;
    this.paint(this.state());
  }

  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("orientationchange", this.onResize);
    for (const off of this.detach) off();
    this.detach = [];
    this.hud.dispose();
    this.root.remove();
  }

  // ---- the results card ---------------------------------------------------

  resultsHeadline(result: MatchEnd, you: string): { headline: string; sub: string } | null {
    // A match the server gave up on is not a rack anyone won; the platform
    // already has the right words for that, so say nothing and let it.
    if (result.reason === "aborted") return null;
    const me = result.standings.find((x) => x.uid === you);
    const cleared = result.standings.some((x) => x.detail?.cleared === 1);
    const sub = cleared ? "The black went down" : "Time ran out — fewest left wins";
    if (!me) return { headline: "Game over", sub };
    if (me.forfeit) return { headline: "You left the table", sub: "" };
    // A DRAW IS BOTH SIDES SHARING FIRST, not "everybody has a 1".
    //
    // Somebody who walked out is demoted to second whatever the table did (see
    // the server's rank), so on a level rack with a walk-out in it "everyone is
    // first" is false and the rest would each have been told they had won.
    // Reading it off the SIDES is the only version that survives that.
    const firsts = result.standings.filter((x) => x.placement === 1);
    const drawn = new Set(firsts.map((x) => x.detail?.team ?? 0)).size > 1;
    if (drawn) return { headline: "Draw", sub: "Level on balls" };
    if (me.placement === 1) return { headline: this.players > 2 ? "Your side wins!" : "You win!", sub };
    return { headline: this.players > 2 ? "Your side loses" : "You lose", sub };
  }

  describeStanding(s: Standing): string {
    const d = s.detail;
    const balls = d.balls ?? 0;
    const bits = [`${balls} ball${balls === 1 ? "" : "s"}`];
    if (d.black === 1) bits.push("🎱 the black");
    const group = d.group ?? -1;
    if (group === 0 || group === 1) bits.push(GROUP[group].name.toLowerCase());
    if ((d.fouls ?? 0) > 0) bits.push(`${d.fouls} foul${d.fouls === 1 ? "" : "s"}`);
    if (this.players > 2 && (d.left ?? 0) > 0) bits.push(`${d.left} left`);
    return bits.join(" · ");
  }

  /** Dev-only introspection for the headless harness and the preview page. */
  debug(): unknown {
    const s = this.state();
    return {
      local: { tick: s.tick, seat: this.mySeat, team: this.myTeam },
      phase: s.phase,
      turn: s.turn,
      shots: s.shots,
      open: s.open,
      groups: [s.group[0], s.group[1]],
      left: [s.group[0] < 0 ? PER_GROUP : remaining(s, s.group[0]), s.group[1] < 0 ? PER_GROUP : remaining(s, s.group[1])],
      ballInHand: s.ballInHand,
      over: s.over,
      decided: s.decided,
      winner: s.winner,
    };
  }

  // ---- the loop -----------------------------------------------------------

  private state(): PoolState {
    return this.sim.state;
  }

  render(): void {
    if (this.disposed) return;
    const now = this.now();
    if (this.startAt !== null) {
      const t = Math.floor((now - this.startAt) / TICK_MS);
      this.tick = Math.max(0, Math.min(t, this.durationTicks));
      this.sim.advanceTo(this.tick);
    }
    const s = this.state();
    this.maybeSendAim(s);
    // While balls are rolling every frame is a different table, so there is
    // nothing to compare and no point comparing it. A stroke is the same: the
    // cloth is still, but the cue is moving through it and the signature below
    // cannot see a cue.
    if (s.phase === "shoot" || s.phase === "stroke") {
      this.syncHud(s);
      this.lastSig = "";
      this.lastPaintAt = now;
      this.paint(s);
      return;
    }
    const sig = this.signature(s);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.syncHud(s);
    } else if (!this.animating(s) || now - this.lastPaintAt < 1000 / IDLE_FPS) {
      // Nothing moved and nothing is moving: the cheapest frame there is.
      return;
    }
    this.lastPaintAt = now;
    this.paint(s);
  }

  /** Everything the live layer draws from, outside a shot. Ball POSITIONS are
   *  in it — unlike carrom's, where a disc between shots only moves when one is
   *  returned to the board. Here the cue ball moves under the thumb, so the
   *  spot has to be part of the comparison. */
  private signature(s: PoolState): string {
    return [
      s.phase,
      s.turn,
      s.since,
      s.shots,
      s.over ? 1 : 0,
      s.alive.join(""),
      s.away.map((a) => (a ? 1 : 0)).join(""),
      s.quit.map((q) => (q ? 1 : 0)).join(""),
      s.ballInHand ? 1 : 0,
      this.spot.x.toFixed(3),
      this.spot.y.toFixed(3),
      this.aimDir.x.toFixed(4),
      this.aimDir.y.toFixed(4),
      this.trim.toFixed(3),
      this.aimPower.toFixed(3),
      this.drag ? 1 : 0,
      this.waiting(s) ? 1 : 0,
      this.ended ? 1 : 0,
    ].join("|");
  }

  /** The play head, with the fraction of a tick the clock is into it.
   *
   *  Only the stroke and its follow-through read this. Everything else in this
   *  game happens on tick boundaries, but a backswing drawn in twelve steps
   *  stutters on a phone that can draw sixty — and the swing is the one moment
   *  of this game somebody is looking straight at. */
  private fineTick(): number {
    if (this.startAt === null) return this.tick;
    const t = (this.now() - this.startAt) / TICK_MS;
    return t < 0 ? 0 : t > this.durationTicks ? this.durationTicks : t;
  }

  private animating(s: PoolState): boolean {
    if (this.drag) return true;
    // The recoil is the one animation with no state behind it: the table has
    // not changed and will not until the server answers, so the signature
    // cannot notice it and the frame has to be asked for by name.
    if (this.waiting(s)) return true;
    // The cue ball pulsing while it waits for somebody to do something.
    return !s.over && !this.ended && s.phase === "aim";
  }

  // ---- input --------------------------------------------------------------

  private attachControls(): void {
    const el = this.liveCanvas;
    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    // Phones synthesize a mouse click after every touch. The platform kills
    // those on the Babylon canvas; this is a different surface and needs its
    // own, or the drag that takes the shot also lands on whatever the chat
    // wheel opens underneath it.
    const noGhost = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchend", noGhost, { passive: false });
    this.detach.push(() => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("touchend", noGhost);
    });
  }

  /** Has tick zero actually arrived? The platform runs a three-second countdown
   *  after `go()`, during which the server refuses any input as being from the
   *  future — so a cue ball that invited a stroke then would be inviting one it
   *  could only swallow. */
  private started(): boolean {
    return this.startAt !== null && this.now() >= this.startAt;
  }

  private myTurn(s: PoolState): boolean {
    return (
      this.started() && !this.ended && !s.over && s.phase === "aim" && s.turn === this.mySeat && !s.quit[this.mySeat]
    );
  }

  /** Which turn the table is waiting on. Every turn begins on its own tick, so
   *  this changes exactly once per turn and never repeats. */
  private turnKey(s: PoolState): string {
    return `${s.turn}:${s.since}`;
  }

  /** Have we already answered THIS turn and not yet seen it move on? The retry
   *  window is what makes a gesture the platform quietly dropped into one the
   *  player can simply make again. */
  private waiting(s: PoolState): boolean {
    return this.asked !== null && this.asked.key === this.turnKey(s) && this.now() - this.asked.at <= RETRY_MS;
  }

  private point(e: PointerEvent): { x: number; y: number } {
    const rect = this.liveCanvas.getBoundingClientRect();
    return toTable(this.layout, e.clientX - rect.left, e.clientY - rect.top);
  }

  private onDown(e: PointerEvent): void {
    // Whatever else a gesture does, it puts the chat wheel away.
    this.hud.closeWheel();
    const s = this.state();
    // Marked away: any touch anywhere is how you come back, and it has to work
    // off-turn — an away seat's turn resolves itself long before you could
    // reach it. The server reads the request and gives the clock back.
    if (this.started() && !s.over && s.away[this.mySeat] && !s.quit[this.mySeat]) {
      this.ctx.sendInput({ tick: this.stamp(), kind: NUDGE_KIND });
      this.lastSig = "";
      return;
    }
    if (!this.myTurn(s) || this.waiting(s)) return;
    const p = this.point(e);
    // A touch on the cue ball moves it, but only while it is actually in hand;
    // otherwise every aim that started near the cue ball would be a drag of a
    // ball that is not going anywhere.
    const canPlace = s.ballInHand || !s.alive[CUE];
    const mode = canPlace && onCue(this.layout, s, p.x, p.y) ? "place" : "aim";
    this.drag = { id: e.pointerId, mode };
    this.liveCanvas.setPointerCapture?.(e.pointerId);
    if (mode === "place") this.setSpot(p.x, p.y);
    else this.aimAt(p);
    this.maybeSendAim(s);
    this.lastSig = "";
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const p = this.point(e);
    if (d.mode === "place") this.setSpot(p.x, p.y);
    else this.aimAt(p);
    this.maybeSendAim(this.state());
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.liveCanvas.releasePointerCapture?.(e.pointerId);
    this.maybeSendAim(this.state());
    this.lastSig = "";
    // Nothing else. Letting go of an aim does not PLAY it — that is the whole
    // point of the SHOOT button, and it is what makes changing your mind free.
    // What does leave is the aim itself, so the table can watch.
  }

  /** Point the cue ball at whatever the finger is over. Straight at it, not
   *  away from it: pointing is not a thing anyone has to be taught. */
  private aimAt(p: { x: number; y: number }): void {
    const from = this.cueSpot();
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < AIM_MIN) return;
    this.aimDir = { x: dx / len, y: dy / len };
    // A coarse aim replaces the fine one rather than adding to it: the bar is
    // for walking the line onto a ball, and a trim left over from the last ball
    // is a bug nobody would ever attribute to the bar.
    this.trim = 0;
    this.lastSig = "";
  }

  /** Where this player is asking for the cue ball, clamped to the cloth. The
   *  legality of the spot is NOT decided here — see `cueSpot`. */
  private setSpot(x: number, y: number): void {
    const lim = BALL_R;
    this.spot = {
      x: Math.max(-HALF_X + lim, Math.min(HALF_X - lim, x)),
      y: Math.max(-HALF_Y + lim, Math.min(HALF_Y - lim, y)),
    };
    this.lastSig = "";
  }

  private setPower(p: number): void {
    const v = p < 0 ? 0 : p > 1 ? 1 : p;
    if (v === this.aimPower) return;
    this.aimPower = v;
    this.lastSig = "";
  }

  private setTrim(t: number): void {
    const v = t < -1 ? -1 : t > 1 ? 1 : t;
    if (v === this.trim) return;
    this.trim = v;
    this.lastSig = "";
  }

  /** The fine bar was let go. Whatever it was doing becomes the aim, and the
   *  knob goes back to the middle ready to do it again — which is what turns a
   *  two-degree control into an unlimited one. */
  private foldTrim(): void {
    if (this.trim !== 0) {
      const d = this.trimmed();
      this.aimDir = d;
      this.trim = 0;
      this.lastSig = "";
    }
    this.maybeSendAim(this.state());
  }

  /** The aim as the bar currently has it: the base direction rotated by the
   *  trim. A small-angle rotation done as a shear and re-normalised, which is
   *  the same answer to well under a pixel and needs no trigonometry. */
  private trimmed(): { x: number; y: number } {
    if (this.trim === 0) return this.aimDir;
    const k = this.trim * TRIM_SWING;
    const x = this.aimDir.x - this.aimDir.y * k;
    const y = this.aimDir.y + this.aimDir.x * k;
    const len = Math.sqrt(x * x + y * y) || 1;
    return { x: x / len, y: y / len };
  }

  /** Where the cue ball ACTUALLY is, or will be. While it is in hand this is
   *  the requested spot run through the SHARED `nearestSpot`, so what the
   *  player is looking at is where the shot will come from — the same function
   *  the server and every replay use. */
  private cueSpot(): { x: number; y: number } {
    const s = this.state();
    if (s.ballInHand || !s.alive[CUE]) {
      return nearestSpot(this.spot.x, this.spot.y, s.x, s.y, s.alive, s.behindLine);
    }
    return { x: s.x[CUE], y: s.y[CUE] };
  }

  /** The five integers that describe what we are about to do. */
  private shotNumbers(): { x: number; y: number; dx: number; dy: number; p: number } {
    const dir = this.trimmed();
    let dx = Math.round(dir.x * 1000);
    let dy = Math.round(dir.y * 1000);
    // Refused by the parser, and unreachable from a real aim — but a rounding
    // that landed on it would silently drop the shot.
    if (dx === 0 && dy === 0) dx = 1000;
    dx = Math.max(-1000, Math.min(1000, dx));
    dy = Math.max(-1000, Math.min(1000, dy));
    const from = this.cueSpot();
    return {
      x: Math.max(-1000, Math.min(1000, Math.round(from.x * 1000))),
      y: Math.max(-500, Math.min(500, Math.round(from.y * 1000))),
      dx,
      dy,
      p: Math.round(this.aimPower * 1000),
    };
  }

  /** Tell the table what we are lining up — if it has changed enough to be
   *  worth a packet, and not more often than AIM_SEND_MS. Called from the frame
   *  loop as well as the pointer path, so a drag costs one input every quarter
   *  second however fast the thumb is. */
  private maybeSendAim(s: PoolState): void {
    if (this.spectator || !this.myTurn(s) || this.waiting(s)) return;
    const now = this.now();
    if (now - this.sentAimAt < AIM_SEND_MS) return;
    const n = this.shotNumbers();
    const was = this.sentAim;
    if (
      was &&
      Math.abs(n.dx - was.dx) < AIM_STEP.dir &&
      Math.abs(n.dy - was.dy) < AIM_STEP.dir &&
      Math.abs(n.x - was.x) < AIM_STEP.spot &&
      Math.abs(n.y - was.y) < AIM_STEP.spot &&
      Math.abs(n.p - was.p) < AIM_STEP.power
    ) {
      return;
    }
    this.sentAim = n;
    this.sentAimAt = now;
    this.ctx.sendInput({ tick: this.stamp(), kind: aimKind(n.x, n.y, n.dx, n.dy, n.p) });
  }

  /** Send the stroke. The only thing on this screen that puts anything on the
   *  wire, and it does nothing at all unless the table is actually asking. */
  private shoot(): void {
    const s = this.state();
    if (!this.myTurn(s) || this.waiting(s)) return;
    this.drag = null;
    this.shotOnce = true;
    this.asked = { key: this.turnKey(s), at: this.now() };
    const n = this.shotNumbers();
    this.sentAim = n;
    this.sentAimAt = this.now();
    this.ctx.sendInput({ tick: this.stamp(), kind: askKind(n.x, n.y, n.dx, n.dy, n.p) });
    this.trim = 0;
    this.lastSig = "";
  }

  /** Stamped one tick ahead: an input must not be in the past by the time it
   *  lands, and the platform refuses anything more than a quarter second early. */
  private stamp(): number {
    return Math.max(1, Math.min(this.tick + 1, this.durationTicks));
  }

  // ---- drawing ------------------------------------------------------------

  private resize(): void {
    if (this.disposed) return;
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    if (w < 2 || h < 2) return;
    // Two is plenty for flat vector work, and it halves the fill on the phones
    // that claim three or four.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this.layout.w && h === this.layout.h && dpr === this.dpr) return;
    this.dpr = dpr;
    this.layout = layoutFor(w, h);
    for (const c of [this.tableCanvas, this.liveCanvas]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.bg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    paintTable(this.bg, this.layout);
    this.hud.setRail(this.layout.side, this.layout.ctrl);
    this.lastSig = "";
    this.paint(this.state());
  }

  /** The HUD only hears from us when something it shows has changed. */
  private syncHud(s: PoolState): void {
    this.hud.setGroups(s.group[0], s.group[1]);
    this.hud.setBalls(s.alive);
    for (let seat = 0; seat < this.players; seat++) {
      this.hud.setSunk(seat, s.potted[seat]);
      this.hud.setAway(seat, s.away[seat]);
    }
    const turnKey = `${s.turn}|${s.phase}|${s.since}|${s.over ? 1 : 0}`;
    if (turnKey !== this.lastTurnKey) {
      this.lastTurnKey = turnKey;
      // A new turn: whatever we last told the table is about the turn before
      // it, so the first aim of this one must go out however little has moved.
      this.sentAim = null;
      // And a fresh ball in hand starts where the table left it, not where this
      // player last dropped one three turns ago.
      if (s.phase === "aim" && s.turn === this.mySeat && (s.ballInHand || !s.alive[CUE])) {
        this.spot = { x: s.alive[CUE] ? s.x[CUE] : s.behindLine ? -HALF_X * 0.68 : 0, y: s.alive[CUE] ? s.y[CUE] : 0 };
      }
      const waiting = !s.over && s.phase === "aim";
      const remainingMs = waiting && this.startAt !== null ? (s.deadline - s.tick) * TICK_MS : null;
      this.hud.setTurn(s.over ? null : s.turn, remainingMs !== null && remainingMs > 0 ? remainingMs : null);
    }
    const [text, tone] = this.bannerFor(s);
    this.hud.setBanner(text, tone);
    const mine = !this.spectator && this.myTurn(s) && !this.waiting(s);
    this.hud.setLive(mine, mine);
    const bars = `${this.aimPower.toFixed(3)}|${this.trim.toFixed(3)}`;
    if (bars !== this.lastBars) {
      this.lastBars = bars;
      this.hud.setBars(this.aimPower, this.trim);
    }
    this.hud.setHint(
      mine && !this.shotOnce
        ? s.ballInHand
          ? "Ball in hand — drag the cue ball, then aim and SHOOT"
          : "Drag the table to aim · FINE to adjust · then SHOOT"
        : ""
    );
  }

  private bannerFor(s: PoolState): [string, "" | "good" | "bad"] {
    if (s.over || this.ended) return ["", ""];
    // The platform's 3·2·1 is on screen and says everything worth saying;
    // "your shot" while a stroke would be refused says the opposite of the truth.
    if (!this.started()) return ["", ""];
    if (!this.spectator && s.away[this.mySeat] && !s.quit[this.mySeat]) {
      return ["You're away — touch the table to come back", "bad"];
    }
    // In a replay nobody is playing, so nothing is "yours" — the banner names
    // the person instead. A watcher told "Your shot" reads it as an invitation.
    const mine = !this.spectator && s.turn === this.mySeat;
    const who = this.ctx.roster[s.turn]?.name ?? "They";
    switch (s.phase) {
      case "aim": {
        if (this.waiting(s)) return ["Playing…", ""];
        if (mine) {
          if (!s.broken) return ["Your break", "good"];
          if (s.ballInHand) return [s.behindLine ? "Ball in hand — behind the line" : "Ball in hand", "good"];
          const group = s.group[this.myTeam];
          if (group >= 0 && remaining(s, group) === 0) return ["On the black", "good"];
          return ["Your shot", "good"];
        }
        // WHAT they are lining up, in words. The ring on the cloth and the
        // length of the backswing say it too, and this says it for anyone who
        // would rather be told than watch for it — the difference between
        // "they are thinking" and "they are about to smash it".
        const theirs = this.intentOf(s, s.turn);
        return [theirs ? `${who} is lining up ${weightWord(theirs.p)}` : `${who} is lining up`, ""];
      }
      case "stroke": {
        const shot = s.shot;
        if (!shot) return ["", ""];
        const word = weightWord(shot.p);
        return [mine ? `You play it ${word}` : `${who} plays it ${word}`, ""];
      }
      case "shoot":
        return ["", ""];
      case "beat": {
        const l = s.last;
        if (!l) return ["", ""];
        const ours = teamOf(l.seat, this.players) === this.myTeam;
        const them = this.ctx.roster[l.seat]?.name ?? "They";
        const who2 = !this.spectator && l.seat === this.mySeat ? "You" : them;
        if (l.foul === "black") return [`${who2} potted the black early`, ours ? "bad" : "good"];
        if (l.foul === "scratch") return [`${who2} scratched`, ours ? "bad" : "good"];
        if (l.foul === "miss") return [`${who2} hit nothing`, ours ? "bad" : "good"];
        if (l.foul === "wrong-ball") return [`${who2} hit the wrong ball first`, ours ? "bad" : "good"];
        if (l.foul === "no-rail") return [`${who2} — no ball reached a cushion`, ours ? "bad" : "good"];
        if (l.black) return [`🎱 ${who2} sank the black`, ours ? "good" : "bad"];
        if (l.assigned) {
          const group = s.group[teamOf(l.seat, this.players)];
          const name = group >= 0 ? GROUP[group].name.toLowerCase() : "a group";
          return [`${who2} is on ${name}`, ours ? "good" : "bad"];
        }
        if (l.own.length > 0) {
          const what = l.own.length === 1 ? ballName(l.own[0]) : `${l.own.length} balls`;
          return [`${who2} potted ${what}`, ours ? "good" : "bad"];
        }
        if (l.opp.length > 0) return [`${who2} potted one of theirs`, ours ? "bad" : "good"];
        return ["", ""];
      }
      default:
        return ["", ""];
    }
  }

  /** One frame of the live layer. */
  private paint(s: PoolState): void {
    const l = this.layout;
    const g = this.fg;
    const b = liveBounds(l);
    g.clearRect(b.x, b.y, b.w, b.h);

    const now = this.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);

    // The band the cue ball has to be put down in, while that rule is on.
    if (!s.over && !this.ended && s.phase === "aim" && s.behindLine && (s.ballInHand || !s.alive[CUE])) {
      paintKitchen(g, l);
    }

    paintBalls(g, l, s);

    // SOMEBODY ELSE IS LINING UP, and you can watch them do it.
    //
    // Their placement, their angle and their weight, live off the wire — the
    // whole reason `m…` exists. Until they have touched anything there is
    // nothing to draw, which is the honest picture: they have not decided yet.
    const watching = !s.over && !this.ended && s.phase === "aim" && (s.turn !== this.mySeat || this.spectator);
    if (watching) {
      const theirs = this.intentOf(s, s.turn);
      if (theirs) this.paintIntent(g, l, s, theirs);
    }

    // THE STROKE, and the follow-through after it. Drawn for everybody at the
    // table and drawn from the SHOT — see paintSwing.
    if (s.phase === "stroke" || s.phase === "shoot") {
      this.paintSwing(g, l, s);
    } else if (this.myTurn(s) && !this.spectator) {
      const from = this.cueSpot();
      const dir = this.trimmed();
      const canPlace = s.ballInHand || !s.alive[CUE];
      if (canPlace) {
        // The ball is not on the table yet, so draw where it is going to be.
        paintBall(g, l, CUE, from.x, from.y, 0.9);
        paintGhostCue(g, l, from.x, from.y, this.drag?.mode === "place" ? 1 : pulse);
      }
      const hit = firstHit(s, from.x, from.y, dir.x, dir.y, CUE);
      let throwDir: { x: number; y: number } | null = null;
      if (hit.index >= 0) {
        // Where the struck ball sets off: along the line of centres at contact,
        // which is the whole of aiming and is exactly what the solver does.
        const ox = s.x[hit.index] - hit.hx;
        const oy = s.y[hit.index] - hit.hy;
        const len = Math.sqrt(ox * ox + oy * oy) || 1;
        throwDir = { x: ox / len, y: oy / len };
      }
      // The shot has been asked for and the server has not answered yet. The
      // cue stays exactly where it was addressed, dimmed — it reads as "that is
      // the shot, and it is gone", where an animation here would be a second
      // stroke played half a second before the real one.
      const held = this.waiting(s);
      const aim: AimDraw = {
        from,
        dir,
        power: this.aimPower,
        hit: { x: hit.hx, y: hit.hy, ball: hit.index },
        throwDir,
        live: !held && this.drag?.mode === "aim",
        fade: held ? 0.45 : 1,
      };
      paintAim(g, l, aim);
    }
  }

  /** The cue playing the shot: back, through, and on past the ball.
   *
   *  READ ENTIRELY OFF `s.shot` — the shot the server wrote, which is in the
   *  log — so the person taking it, the three people watching it and a console
   *  scrubbing it a week later are all looking at the same swing over the same
   *  ticks. Nothing here consults a live aim, which is exactly why it survives
   *  into a replay when the live aim does not.
   *
   *  How far the cue goes back is the POWER, so the weight of a shot is finally
   *  something the whole table can see. */
  private paintSwing(g: CanvasRenderingContext2D, l: Layout, s: PoolState): void {
    const shot = s.shot;
    if (!shot) return;
    const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy);
    if (!(len > 0)) return;
    const dir = { x: shot.dx / len, y: shot.dy / len };
    const power = shot.p / 1000;
    const theirs = this.spectator || shot.seat !== this.mySeat;
    const from = shot.from;

    if (s.phase === "stroke") {
      const span = Math.max(1, s.deadline - s.since);
      const raw = (this.fineTick() - s.since) / span;
      const u = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const hit = firstHit(s, from.x, from.y, dir.x, dir.y, CUE);
      let throwDir: { x: number; y: number } | null = null;
      if (hit.index >= 0) {
        const ox = s.x[hit.index] - hit.hx;
        const oy = s.y[hit.index] - hit.hy;
        const l2 = Math.sqrt(ox * ox + oy * oy) || 1;
        throwDir = { x: ox / l2, y: oy / l2 };
      }
      paintAim(g, l, {
        from,
        dir,
        power,
        hit: { x: hit.hx, y: hit.hy, ball: hit.index },
        throwDir,
        theirs,
        draw: strokeDraw(u),
        // The lines have said everything they have to say by the time the cue
        // is coming through. The last of the swing is the swing.
        fade: u < 0.62 ? 1 : Math.max(0, 1 - (u - 0.62) / 0.3),
      });
      return;
    }

    // Contact has happened and the ball has gone.
    const since = (this.fineTick() - s.since) * TICK_MS;
    if (since < 0 || since > FOLLOW_MS) return;
    const v = since / FOLLOW_MS;
    paintCue(g, l, from, dir, power, theirs, -0.14 * v, (1 - v) * (theirs ? 0.5 : 0.85));
    if (since < IMPACT_MS) paintImpact(g, l, from, power, since / IMPACT_MS);
  }

  /** Draw what another seat is lining up. Nothing has to be rotated — the table
   *  is the same way up for everybody — but the placement still goes through
   *  `nearestSpot`, for the same reason ours does: it is where the cue ball
   *  will ACTUALLY be, not where their thumb happens to be. */
  private paintIntent(g: CanvasRenderingContext2D, l: Layout, s: PoolState, i: Intent): void {
    const len = Math.sqrt(i.dx * i.dx + i.dy * i.dy);
    if (!(len > 0)) return;
    const dir = { x: i.dx / len, y: i.dy / len };
    const from =
      s.ballInHand || !s.alive[CUE]
        ? nearestSpot(i.x / 1000, i.y / 1000, s.x, s.y, s.alive, s.behindLine)
        : { x: s.x[CUE], y: s.y[CUE] };
    if (s.ballInHand || !s.alive[CUE]) paintBall(g, l, CUE, from.x, from.y, 0.75);
    const hit = firstHit(s, from.x, from.y, dir.x, dir.y, CUE);
    let throwDir: { x: number; y: number } | null = null;
    if (hit.index >= 0) {
      const ox = s.x[hit.index] - hit.hx;
      const oy = s.y[hit.index] - hit.hy;
      const l2 = Math.sqrt(ox * ox + oy * oy) || 1;
      throwDir = { x: ox / l2, y: oy / l2 };
    }
    paintAim(g, l, {
      from,
      dir,
      power: i.p / 1000,
      hit: { x: hit.hx, y: hit.hy, ball: hit.index },
      throwDir,
      theirs: true,
      live: false,
    });
  }
}
