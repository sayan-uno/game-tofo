// Carrom on the client: the board, the thumb, and the one loop that draws it.
//
// It draws on its OWN two-dimensional canvases rather than through Babylon,
// for Ludo's reason — a carrom board is flat, and a flat board drawn as
// geometry is sharper, smaller and very much cheaper than the same board built
// out of meshes. The platform hands every game the 3D engine because the first
// game needed it, not because a game must use it. Nothing here touches the
// engine at all; the render loop the platform installs simply calls a function
// that paints.
//
// YOU ARE ALWAYS AT THE BOTTOM. Whichever edge of the table the server sat you
// at, the board is drawn turned so that your base line is the near one — which
// is how carrom is played, and what makes an aim gesture mean anything. The
// rotation is `toLocal` from the shared board and it is applied exactly once
// per disc, per frame.
//
// WHAT A FLICK DOES. Nothing, to the board. The gesture sends a REQUEST and
// springs the striker on the spot; the disc itself does not move until the
// server writes the shot and it comes back through the ordinary input relay.
// The reason is in the simulation's header comment and it is not squeamishness
// — on a platform that relays an input to everyone except its sender, a client
// that fired its own striker would be the one participant unable to discover
// that nobody else had. What the player sees is a striker that recoils under
// their thumb the instant they let go, so the round trip is spent rather than
// waited out.
//
// THE CONTROLS, and why they are three things and not one.
//
// The first version of this screen did the whole shot with a single drag on the
// felt: pull back from anywhere, the aim was the opposite of the drag, the
// weight was how far you pulled, and letting go fired. It reads well written
// down and it is horrible to use, for three reasons that all showed up the
// first time somebody played it.
//
//   * IT COULD NOT TURN ALL THE WAY ROUND. A flick was forward-only, so the aim
//     hit a wall at each end of the sweep instead of going round, and a coin
//     sitting behind the base line could not be aimed at at all. The rule is
//     gone (see the shared sim) and the aim is now a full circle.
//   * IT COULD NOT BE STOPPED. Aim, weight and shot were the same gesture, so
//     there was no moment between deciding and firing in which to change your
//     mind — and no way to nudge the striker without throwing the aim away.
//   * THE STRIKER WAS HARD TO MOVE, because moving it meant finding an
//     invisible strip of felt and dragging along it.
//
// So: three controls, each doing one thing, all of them live at once.
//
//   AIM      drag anywhere on the felt. The line points from the striker at
//            your finger — no inversion to hold in your head, the whole board
//            as runway, and a full 360°. Letting go changes nothing.
//   POWER    its own bar. It keeps its value between shots, so the weight you
//            like is the weight you get.
//   STRIKER  its own bar, and you can still grab the disc itself.
//   SHOOT    a button. Nothing leaves this device until it is pressed.
import type { GameRuntime, GameRuntimeContext } from "../../platform/types";
import type { MatchEnd, MatchInputRelay, QuickKind, Standing } from "../../shared/core/protocol";
import { QUICK_CHAT } from "../../shared/core/protocol";
import {
  BASE_HALF,
  BASE_Y,
  CarromSim,
  COINS_PER_TEAM,
  DURATION_TICKS,
  KIND_DARK,
  KIND_LIGHT,
  NUDGE_KIND,
  STRIKER_R,
  TICK_MS,
  aimKind,
  askKind,
  baseSpot,
  parseInput,
  firstHit,
  nearestFreeSlot,
  sideOf,
  teamOf,
  teamPocketed,
  toLocal,
  toWorld,
  type CarromState,
} from "../../shared/games/carrom/index";
import { CarromHud } from "./hud";
import {
  layoutFor,
  liveBounds,
  onStriker,
  paintAim,
  paintBoard,
  paintCharged,
  paintDiscs,
  paintGhostStriker,
  paintStrikerAt,
  px,
  toBoard,
  type AimDraw,
  type Layout,
} from "./paint";
import { INK } from "./theme";

/** How long a request may sit unanswered before the flick is offered again.
 *  The server answers in a fraction of this; it exists so that a gesture the
 *  platform quietly dropped is one the player can simply make again, rather
 *  than a turn lost to a countdown they cannot influence. */
const RETRY_MS = 2200;
/** Frames per second while only a highlight is pulsing and the board is still.
 *  A pulse does not need sixty. */
const IDLE_FPS = 30;

/** How far from the striker a finger has to be before it counts as an aim.
 *  Closer than this the direction is mostly noise — a thumb-width of travel
 *  would swing the line through ninety degrees. */
const AIM_MIN = 0.075;

/** The weight a player starts with, and gets back at the start of each match.
 *  Firm enough to cross the board and reach the pack, soft enough that the
 *  first shot of a game is not a scatter. */
const POWER_DEFAULT = 0.55;

/** ---------------------------------------------------------------------------
 *  Letting the table watch you think.
 *
 *  Most of sitting at a carrom board is watching somebody else line a shot up,
 *  and the first version of this game had none of it: the other three saw a
 *  glow on an edge and then, with no warning at all, a struck striker. So while
 *  a player composes, their placement, aim and weight go out as `m…` inputs and
 *  everyone draws them.
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
 *  (thousandths). Two degrees of angle, a fiftieth of the base line, a twentieth
 *  of the power. */
const AIM_STEP = { dir: 35, slot: 20, power: 50 };

/** What somebody else is about to do, as last heard. */
interface Intent {
  t: number;
  dx: number;
  dy: number;
  p: number;
  /** The tick it was stamped at, so an aim from a turn that is over is not
   *  drawn over the turn that followed it. */
  tick: number;
}

/** THE RECOIL, and why it exists.
 *
 *  A flick does not move the striker: the request goes to the server, the
 *  server writes the shot, and the shot comes back through the ordinary relay a
 *  fifth of a second later. Without something to look at, that fifth of a
 *  second is a screen on which nothing at all happened when the player let go —
 *  which reads as a dropped tap, and the next thing they do is tap again.
 *
 *  So the striker springs. It sits pulled back along its own aim at the instant
 *  of release and returns to the base line over RECOIL_MS, which is roughly the
 *  round trip; by the time it is home the real shot has usually landed and the
 *  striker is away. The same trick as Ludo's tumbling die, and for the same
 *  reason: spend the round trip rather than wait it out. */
const RECOIL_MS = 150;
const RECOIL_PULL = 0.075;

export class CarromRuntime implements GameRuntime {
  private root: HTMLElement;
  private boardCanvas: HTMLCanvasElement;
  private liveCanvas: HTMLCanvasElement;
  private bg: CanvasRenderingContext2D;
  private fg: CanvasRenderingContext2D;
  private layout: Layout;
  private dpr = 1;

  private sim: CarromSim;
  private players: number;
  private mySeat: number;
  private mySide: number;
  private myTeam: number;
  private myKind: number;
  private seatOf = new Map<string, number>();
  private hud: CarromHud;

  private startAt: number | null = null;
  /** The clock this runtime reads. Date.now() while a player is playing; a
   *  clock the console drives while somebody is watching it back. */
  private readonly now: () => number;
  /** Nobody is playing — see GameRuntimeContext.spectator. Carrom already
   *  treats every input as remote (the server authors them all and relays them
   *  to everyone including the asker), so only the GESTURES have to be refused. */
  private readonly spectator: boolean;
  private tick = 0;
  private durationTicks: number;

  // ---- the shot being composed -------------------------------------------
  //
  // All three survive a shot on purpose: a player who has found the angle they
  // like should not have to find it again because the striker moved an inch.
  private aimT = 0;
  private aimDir = { x: 0, y: 1 };
  private aimPower = POWER_DEFAULT;
  /** A drag on the felt: aiming, or dragging the striker itself. */
  private drag: { id: number; mode: "slide" | "aim" } | null = null;
  /** Has this player ever taken a shot? The control hint goes away after one. */
  private shotOnce = false;
  /** The HUD is told about the bars only when they move, not per frame. */
  private lastBars = "";
  /** What every seat is currently lining up, by seat — theirs from the wire,
   *  and nobody's until they touch something. */
  private intent = new Map<number, Intent>();
  /** The last aim actually put on the wire, and when. */
  private sentAim: { t: number; dx: number; dy: number; p: number } | null = null;
  private sentAimAt = 0;

  /** The request we have made about the turn currently on the table.
   *
   *  Keyed on the turn INSTANCE rather than cleared when the answer arrives.
   *  The server stamps its answer a fifth of a second ahead so that nobody has
   *  to rewind for it, which leaves a window between the answer landing on the
   *  wire and the board acting on it — and a flag cleared on arrival would
   *  spend that window inviting a flick that has already been made. */
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
    // contract the other two games rely on.
    ctx.roster.forEach((r, seat) => this.seatOf.set(r.uid, seat));
    this.mySeat = this.seatOf.get(ctx.you) ?? 0;
    this.mySide = sideOf(this.mySeat, this.players);
    this.myTeam = teamOf(this.mySeat, this.players);
    this.myKind = this.myTeam === 0 ? KIND_LIGHT : KIND_DARK;

    const rules = ctx.rules ?? {};
    this.durationTicks =
      Number.isFinite(rules.durationTicks) && rules.durationTicks > 0
        ? Math.round(rules.durationTicks)
        : DURATION_TICKS;
    this.sim = new CarromSim(ctx.seed, this.players, this.durationTicks);

    this.root = document.createElement("div");
    this.root.className = "cr-root";
    this.boardCanvas = document.createElement("canvas");
    this.boardCanvas.className = "cr-canvas cr-board";
    this.liveCanvas = document.createElement("canvas");
    this.liveCanvas.className = "cr-canvas cr-live";
    this.root.appendChild(this.boardCanvas);
    this.root.appendChild(this.liveCanvas);
    ctx.hudRoot.appendChild(this.root);
    this.bg = this.boardCanvas.getContext("2d")!;
    this.fg = this.liveCanvas.getContext("2d")!;

    this.hud = new CarromHud({
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
      onSlide: (t) => {
        this.setSlot(t);
        this.maybeSendAim(this.state());
      },
      onPower: (p) => {
        this.setPower(p);
        this.maybeSendAim(this.state());
      },
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
    // the board, so the signature below would not notice.
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
  private intentOf(s: CarromState, seat: number): Intent | null {
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
    // A match the server gave up on is not a board anyone won; the platform
    // already has the right words for that, so say nothing and let it.
    if (result.reason === "aborted") return null;
    const s = this.state();
    const me = result.standings.find((x) => x.uid === you);
    const cleared = result.standings.some((x) => x.detail?.cleared === 1);
    const sub = cleared
      ? this.players > 2
        ? "Nine coins down"
        : "All nine down"
      : "Time ran out — most coins wins";
    if (!me) return { headline: "Game over", sub };
    if (me.forfeit) return { headline: "You left the game", sub: "" };
    // A DRAW IS BOTH SIDES SHARING FIRST, not "everybody has a 1".
    //
    // Somebody who walked out is demoted to second whatever the board did (see
    // the server's rank), so on a level board with a walk-out in it "everyone
    // is first" is false and the remaining three would each have been told they
    // had won. Reading it off the SIDES is the only version that survives that.
    const firsts = result.standings.filter((x) => x.placement === 1);
    const drawn = new Set(firsts.map((x) => x.detail?.team ?? 0)).size > 1;
    if (drawn) return { headline: "Draw", sub: s.decided ? sub : "Level on coins" };
    if (me.placement === 1) {
      return { headline: this.players > 2 ? "Your side wins!" : "You win!", sub };
    }
    return { headline: this.players > 2 ? "Your side loses" : "You lose", sub };
  }

  describeStanding(s: Standing): string {
    const d = s.detail;
    const coins = d.coins ?? 0;
    const bits = [`${coins} coin${coins === 1 ? "" : "s"}`];
    if (d.queen === 1) bits.push("👑 queen");
    if ((d.fouls ?? 0) > 0) bits.push(`${d.fouls} foul${d.fouls === 1 ? "" : "s"}`);
    if (this.players > 2) bits.push(`side ${d.board ?? 0}/${COINS_PER_TEAM}`);
    return bits.join(" · ");
  }

  /** Dev-only introspection for the headless harness and the preview page. */
  debug(): unknown {
    const s = this.state();
    return {
      local: { tick: s.tick, seat: this.mySeat, side: this.mySide, team: this.myTeam },
      phase: s.phase,
      turn: s.turn,
      shots: s.shots,
      coins: [teamPocketed(s, 0), teamPocketed(s, 1)],
      queenBy: s.queenBy,
      over: s.over,
      decided: s.decided,
      winner: s.winner,
    };
  }

  // ---- the loop -----------------------------------------------------------

  private state(): CarromState {
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
    // While discs are moving every frame is a different board, so there is
    // nothing to compare and no point comparing it.
    if (s.phase === "shoot") {
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

  /** Everything the live layer draws from, outside a shot. Positions are not in
   *  it and do not need to be: between shots a disc only moves when one is
   *  RETURNED to the board, and a returned disc changes `alive`. */
  private signature(s: CarromState): string {
    return [
      s.phase,
      s.turn,
      s.since,
      s.shots,
      s.over ? 1 : 0,
      s.alive.join(""),
      s.away.map((a) => (a ? 1 : 0)).join(""),
      s.quit.map((q) => (q ? 1 : 0)).join(""),
      this.aimT.toFixed(3),
      this.aimDir.x.toFixed(3),
      this.aimDir.y.toFixed(3),
      this.aimPower.toFixed(3),
      this.drag ? 1 : 0,
      this.waiting(s) ? 1 : 0,
      this.ended ? 1 : 0,
    ].join("|");
  }

  private animating(s: CarromState): boolean {
    if (this.drag) return true;
    // The recoil is the one animation with no state behind it: the board has
    // not changed and will not until the server answers, so the signature
    // cannot notice it and the frame has to be asked for by name.
    if (this.waiting(s)) return true;
    // The striker pulsing while it waits for its owner to do something.
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
   *  future — so a striker that invited a flick then would be inviting one it
   *  could only swallow. */
  private started(): boolean {
    return this.startAt !== null && this.now() >= this.startAt;
  }

  private myTurn(s: CarromState): boolean {
    return this.started() && !this.ended && !s.over && s.phase === "aim" && s.turn === this.mySeat && !s.quit[this.mySeat];
  }

  /** Which turn the table is waiting on. Every turn begins on its own tick, so
   *  this changes exactly once per turn and never repeats. */
  private turnKey(s: CarromState): string {
    return `${s.turn}:${s.since}`;
  }

  /** Have we already answered THIS turn and not yet seen it move on? The retry
   *  window is what makes a gesture the platform quietly dropped into one the
   *  player can simply make again. */
  private waiting(s: CarromState): boolean {
    return this.asked !== null && this.asked.key === this.turnKey(s) && this.now() - this.asked.at <= RETRY_MS;
  }

  private point(e: PointerEvent): { x: number; y: number } {
    const rect = this.liveCanvas.getBoundingClientRect();
    return toBoard(this.layout, e.clientX - rect.left, e.clientY - rect.top);
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
    // A touch that lands on the striker itself grabs it; anything else aims.
    // The grab is a circle round the disc rather than the band of felt it used
    // to be — see `onStriker`.
    const mode = onStriker(p.x, p.y, this.effectiveT()) ? "slide" : "aim";
    this.drag = { id: e.pointerId, mode };
    this.liveCanvas.setPointerCapture?.(e.pointerId);
    if (mode === "slide") this.setSlot(p.x / BASE_HALF);
    else this.aimAt(p);
    this.maybeSendAim(s);
    this.lastSig = "";
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const p = this.point(e);
    if (d.mode === "slide") this.setSlot(p.x / BASE_HALF);
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
    // Nothing else. Letting go of an aim does not FIRE it — that is the whole
    // point of the SHOOT button, and it is what makes changing your mind free.
    // What does leave is the aim itself, so the table can watch.
  }

  /** Point the striker at whatever the finger is over.
   *
   *  Straight at it, not away from it. The pull-back this replaced put the
   *  striker's runway off the bottom of the screen and made "aim up" mean "drag
   *  down", both of which a player has to be taught. Pointing is not taught. */
  private aimAt(p: { x: number; y: number }): void {
    const from = baseSpot(this.effectiveT());
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < AIM_MIN) return;
    this.aimDir = { x: dx / len, y: dy / len };
  }

  private setSlot(t: number): void {
    const v = t < -1 ? -1 : t > 1 ? 1 : t;
    if (v === this.aimT) return;
    this.aimT = v;
    this.lastSig = "";
  }

  /** The four integers that describe what we are about to do. */
  private shotNumbers(): { t: number; dx: number; dy: number; p: number } {
    let dx = Math.round(this.aimDir.x * 1000);
    let dy = Math.round(this.aimDir.y * 1000);
    // Refused by the parser, and unreachable from a real aim — but a rounding
    // that lands on it would silently drop the shot.
    if (dx === 0 && dy === 0) dy = 1000;
    dx = Math.max(-1000, Math.min(1000, dx));
    dy = Math.max(-1000, Math.min(1000, dy));
    return { t: Math.round(this.effectiveT() * 1000), dx, dy, p: Math.round(this.aimPower * 1000) };
  }

  /** Tell the table what we are lining up — if it has changed enough to be
   *  worth a packet, and not more often than AIM_SEND_MS. Called from the frame
   *  loop rather than from every pointer move, so a drag costs one input every
   *  quarter second however fast the thumb is. */
  private maybeSendAim(s: CarromState): void {
    if (this.spectator || !this.myTurn(s) || this.waiting(s)) return;
    const now = this.now();
    if (now - this.sentAimAt < AIM_SEND_MS) return;
    const n = this.shotNumbers();
    const was = this.sentAim;
    if (
      was &&
      Math.abs(n.dx - was.dx) < AIM_STEP.dir &&
      Math.abs(n.dy - was.dy) < AIM_STEP.dir &&
      Math.abs(n.t - was.t) < AIM_STEP.slot &&
      Math.abs(n.p - was.p) < AIM_STEP.power
    ) {
      return;
    }
    this.sentAim = n;
    this.sentAimAt = now;
    this.ctx.sendInput({ tick: this.stamp(), kind: aimKind(n.t, n.dx, n.dy, n.p) });
  }

  private setPower(p: number): void {
    const v = p < 0 ? 0 : p > 1 ? 1 : p;
    if (v === this.aimPower) return;
    this.aimPower = v;
    this.lastSig = "";
  }

  /** Send the shot. The only thing on this screen that puts anything on the
   *  wire, and it does nothing at all unless the table is actually asking. */
  private shoot(): void {
    const s = this.state();
    if (!this.myTurn(s) || this.waiting(s)) return;
    this.drag = null;
    this.shotOnce = true;
    this.asked = { key: this.turnKey(s), at: this.now() };
    // Rounded independently, which is fine: the simulation normalises whatever
    // pair of integers arrives, so a vector a thousandth off unit is the same
    // shot to within far less than a pixel.
    const n = this.shotNumbers();
    this.sentAim = n;
    this.sentAimAt = this.now();
    this.ctx.sendInput({ tick: this.stamp(), kind: askKind(n.t, n.dx, n.dy, n.p) });
    this.lastSig = "";
  }

  /** Stamped one tick ahead: an input must not be in the past by the time it
   *  lands, and the platform refuses anything more than a quarter second early. */
  private stamp(): number {
    return Math.max(1, Math.min(this.tick + 1, this.durationTicks));
  }

  /** Where the striker actually sits: the requested placement, moved to the
   *  nearest one it fits in. The SAME function the server and every replay use,
   *  so what the player is looking at is where the shot will come from. */
  private effectiveT(): number {
    const s = this.state();
    return nearestFreeSlot(this.mySide, this.aimT, s.x, s.y, s.alive);
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
    for (const c of [this.boardCanvas, this.liveCanvas]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.bg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    paintBoard(this.bg, this.layout);
    this.hud.setRail(this.layout.rail, this.layout.ctrl);
    this.lastSig = "";
    this.paint(this.state());
  }

  /** The HUD only hears from us when something it shows has changed. */
  private syncHud(s: CarromState): void {
    this.hud.setScore(teamPocketed(s, 0), teamPocketed(s, 1));
    for (let seat = 0; seat < this.players; seat++) {
      this.hud.setSunk(seat, s.coinsBy[seat]);
      this.hud.setAway(seat, s.away[seat]);
      this.hud.setQueen(seat, s.queenBy === seat);
    }
    const turnKey = `${s.turn}|${s.phase}|${s.since}|${s.over ? 1 : 0}`;
    if (turnKey !== this.lastTurnKey) {
      this.lastTurnKey = turnKey;
      // A new turn: whatever we last told the table is about the turn before
      // it, so the first aim of this one must go out however little has moved.
      this.sentAim = null;
      const waiting = !s.over && s.phase === "aim";
      const remaining = waiting && this.startAt !== null ? (s.deadline - s.tick) * TICK_MS : null;
      this.hud.setTurn(s.over ? null : s.turn, remaining !== null && remaining > 0 ? remaining : null);
    }
    const [text, tone] = this.bannerFor(s);
    this.hud.setBanner(text, tone);
    const mine = !this.spectator && this.myTurn(s) && !this.waiting(s);
    this.hud.setLive(mine, mine);
    const bars = `${this.aimPower.toFixed(3)}|${this.aimT.toFixed(3)}`;
    if (bars !== this.lastBars) {
      this.lastBars = bars;
      this.hud.setBars(this.aimPower, this.aimT);
    }
    this.hud.setHint(mine && !this.shotOnce ? "Drag the board to aim · set the bars · then SHOOT" : "");
  }

  private bannerFor(s: CarromState): [string, "" | "good" | "bad"] {
    if (s.over || this.ended) return ["", ""];
    // The platform's 3·2·1 is on screen and says everything worth saying;
    // "your shot" while a flick would be refused says the opposite of the truth.
    if (!this.started()) return ["", ""];
    if (!this.spectator && s.away[this.mySeat] && !s.quit[this.mySeat]) {
      return ["You're away — touch the board to come back", "bad"];
    }
    // In a replay nobody is playing, so nothing is "yours" — the banner names
    // the person instead. A watcher told "Your shot" reads it as an invitation.
    const mine = !this.spectator && s.turn === this.mySeat;
    const who = this.ctx.roster[s.turn]?.name ?? "They";
    switch (s.phase) {
      case "aim":
        if (this.waiting(s)) return ["Shooting…", ""];
        return mine ? ["Your shot", "good"] : [`${who} is lining up`, ""];
      case "shoot":
        return ["", ""];
      case "beat": {
        const l = s.last;
        if (!l) return ["", ""];
        const them = this.ctx.roster[l.seat]?.name ?? "They";
        const ours = teamOf(l.seat, this.players) === this.myTeam;
        const who2 = !this.spectator && l.seat === this.mySeat ? "You" : them;
        if (l.foul === "striker") return [`${who2} pocketed the striker`, ours ? "bad" : "good"];
        if (l.foul === "miss") return [`${who2} touched nothing`, ours ? "bad" : "good"];
        if (l.queen) return [`👑 ${who2} took the queen`, ours ? "good" : "bad"];
        if (l.queenReturned) return ["Queen not covered — back she goes", ""];
        if (l.own > 0) return [`${who2} pocketed ${l.own}`, ours ? "good" : "bad"];
        if (l.opp > 0) return [`${who2} gave away ${l.opp}`, ours ? "bad" : "good"];
        return ["", ""];
      }
      default:
        return ["", ""];
    }
  }

  /** One frame of the live layer. */
  private paint(s: CarromState): void {
    const l = this.layout;
    const g = this.fg;
    const b = liveBounds(l);
    g.clearRect(b.x, b.y, b.w, b.h);

    const now = this.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);

    // SOMEBODY ELSE IS LINING UP, and you can watch them do it.
    //
    // Their placement, their angle and their weight, live off the wire — the
    // whole reason `m…` exists. Until they have touched anything there is
    // nothing to draw but a glow on their edge, which is the honest picture:
    // they have not decided yet.
    const watching = !s.over && !this.ended && s.phase === "aim" && (s.turn !== this.mySeat || this.spectator);
    if (watching) {
      const theirs = this.intentOf(s, s.turn);
      if (theirs) this.paintIntent(g, l, s, s.turn, theirs);
      else this.paintTheirLine(g, l, s.turn, 0.35 + 0.45 * pulse);
    }

    paintDiscs(g, l, s, this.mySide, this.myKind, s.phase === "shoot" ? 0.35 : 0);

    if (this.myTurn(s) && !this.waiting(s) && !this.spectator) {
      const t = this.effectiveT();
      const local = baseSpot(t);
      const world = toWorld(this.mySide, local.x, local.y);
      const dirWorld = toWorld(this.mySide, this.aimDir.x, this.aimDir.y);
      const hitWorld = firstHit(s, world.x, world.y, dirWorld.x, dirWorld.y);
      const hitLocal = toLocal(this.mySide, hitWorld.hx, hitWorld.hy);
      const aim: AimDraw = {
        from: { x: local.x, y: local.y },
        dir: this.aimDir,
        power: this.aimPower,
        hit: { x: hitLocal.x, y: hitLocal.y, disc: hitWorld.index >= 0 },
        live: this.drag?.mode === "aim",
      };
      paintAim(g, l, aim);
      paintGhostStriker(g, l, t, this.drag ? 1 : pulse * 0.7);
    } else if (this.waiting(s) && s.phase === "aim" && !this.spectator) {
      // The gesture has been made and the shot is on its way back. See
      // RECOIL_MS: the striker is drawn springing off its own base line, so the
      // moment reads as "away it goes" and not as "did that register?".
      const since = this.asked ? now - this.asked.at : RECOIL_MS;
      const u = since >= RECOIL_MS ? 1 : since / RECOIL_MS;
      const back = RECOIL_PULL * (1 - u) * (1 - u);
      const spot = baseSpot(this.effectiveT());
      paintCharged(g, l, spot.x - this.aimDir.x * back, spot.y - this.aimDir.y * back, spot.x, spot.y);
    }
  }

  /** Draw what another seat is lining up, in OUR frame.
   *
   *  Everything they sent is in THEIR frame — they are at the bottom of their
   *  own screen too — so it goes their-local → world → our-local, and the
   *  trajectory is the same shared ray test that draws our own. The placement
   *  is run through `nearestFreeSlot` for the same reason ours is: it is where
   *  the striker will ACTUALLY be, not where their thumb happens to be. */
  private paintIntent(g: CanvasRenderingContext2D, l: Layout, s: CarromState, seat: number, i: Intent): void {
    const side = sideOf(seat, this.players);
    const slot = nearestFreeSlot(side, i.t / 1000, s.x, s.y, s.alive);
    const theirs = baseSpot(slot);
    const world = toWorld(side, theirs.x, theirs.y);
    const len = Math.sqrt(i.dx * i.dx + i.dy * i.dy);
    if (!(len > 0)) return;
    const dirWorld = toWorld(side, i.dx / len, i.dy / len);
    const hitWorld = firstHit(s, world.x, world.y, dirWorld.x, dirWorld.y);
    const from = toLocal(this.mySide, world.x, world.y);
    const dir = toLocal(this.mySide, dirWorld.x, dirWorld.y);
    const hit = toLocal(this.mySide, hitWorld.hx, hitWorld.hy);
    paintAim(g, l, {
      from,
      dir,
      power: i.p / 1000,
      hit: { x: hit.x, y: hit.y, disc: hitWorld.index >= 0 },
      live: false,
      theirs: true,
    });
    paintStrikerAt(g, l, from.x, from.y, 0.5);
  }

  /** A soft glow along another player's base line while they choose. */
  private paintTheirLine(g: CanvasRenderingContext2D, l: Layout, seat: number, alpha: number): void {
    const side = sideOf(seat, this.players);
    // Their base line, expressed in THEIR frame and rotated into ours.
    const a = toLocal(this.mySide, ...worldPair(side, -BASE_HALF, -BASE_Y));
    const c = toLocal(this.mySide, ...worldPair(side, BASE_HALF, -BASE_Y));
    const pa = px(l, a.x, a.y);
    const pc = px(l, c.x, c.y);
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = INK.home;
    g.lineWidth = Math.max(2, l.r * 0.016);
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(pa.x, pa.y);
    g.lineTo(pc.x, pc.y);
    g.stroke();
    g.restore();
    // And the striker waiting on it, so the eye has something to look at.
    const mid = toLocal(this.mySide, ...worldPair(side, 0, -BASE_Y));
    const pm = px(l, mid.x, mid.y);
    g.save();
    g.globalAlpha = alpha * 0.5;
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.beginPath();
    g.arc(pm.x, pm.y, STRIKER_R * l.r * 0.8, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

/** `toWorld` returns a point; the two rotations below want a pair to spread. */
function worldPair(side: number, x: number, y: number): [number, number] {
  const w = toWorld(side, x, y);
  return [w.x, w.y];
}
