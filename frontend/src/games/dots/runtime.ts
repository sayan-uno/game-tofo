// Dots & Boxes on the client: the grid, the finger, and the one loop that
// draws it.
//
// It paints onto its OWN two canvases rather than through Babylon, for the
// reason every flat game here does: a grid of dots drawn as geometry is
// sharper, smaller and very much cheaper than the same grid built out of
// meshes. Nothing here touches the engine at all; the render loop the platform
// installs simply calls a function that paints.
//
// THE CONTROL, and why it is this one. A line is two pixels wide and a finger
// is forty, so "tap the line you want" is not a control — it is a lottery. What
// a player can always do is be NEAREST to the line they want, so a touch
// anywhere on the grid picks the closest free line and shows it, a drag moves
// that choice around, and nothing is drawn until it is confirmed.
//
// Confirming has two ways in, because they suit different moments: tap the line
// you have already chosen a second time (fast, and where your finger already
// is), or press DRAW (unmissable, and reachable while your other hand is
// holding the phone). Neither is a mode — both are live at once, always.
//
// WHAT A TAP DOES TO THE BOARD: nothing. Choosing is local, and the line is
// only drawn when the SERVER writes the move and it comes back through the
// ordinary input relay. The reason is in the simulation's header comment and it
// is not squeamishness — on a platform that relays an input to everyone except
// its sender, a client that drew its own line would be the one participant
// unable to discover that nobody else had.
//
// AND THE TABLE CAN WATCH YOU CHOOSE. The line under your finger goes out as a
// hover, four times a second at most, and everyone draws it in your colour.
// Bots do it too — a seat that goes from nothing to a drawn line is the one
// tell no roster entry can hide.
import type { GameRuntime, GameRuntimeContext } from "../../platform/types";
import type { MatchEnd, MatchInputRelay, QuickKind, Standing } from "../../shared/core/protocol";
import { QUICK_CHAT } from "../../shared/core/protocol";
import {
  BOX_COUNT,
  CLAIM_TICKS,
  DRAW_TICKS,
  DURATION_TICKS,
  DotsSim,
  LINE_BOXES,
  NUDGE_KIND,
  TICK_MS,
  askKind,
  hoverKind,
  lineName,
  parseInput,
  sidesOf,
  type DotsState,
} from "../../shared/games/dots/index";
import { DotsHud } from "./hud";
import { layoutFor, nearestFree, paintGrid, paintLive, type Layout, type LiveDraw } from "./paint";

/** How long a request may sit unanswered before the line is offered again. The
 *  server answers in a fraction of this; it exists so that a tap the platform
 *  quietly dropped is one the player can simply make again, rather than a turn
 *  lost to a countdown they cannot influence. */
const RETRY_MS = 2000;
/** Frames per second while only a highlight is pulsing and nothing has moved. */
const IDLE_FPS = 30;

/** A press that travels less than this is a TAP, and a tap on a line already
 *  chosen is the confirm. Measured in cells rather than pixels so it means the
 *  same thing on a phone and on a laptop. */
const TAP_SLOP = 0.35;

/** Letting the table watch you think: at most this often, and only when the
 *  line under the finger actually changed. Every accepted input is archived, so
 *  a hover sent per frame would be a twentyfold replay for no more information
 *  than this. */
const HOVER_SEND_MS = 250;

export class DotsRuntime implements GameRuntime {
  private root: HTMLElement;
  private gridCanvas: HTMLCanvasElement;
  private liveCanvas: HTMLCanvasElement;
  private bg: CanvasRenderingContext2D;
  private fg: CanvasRenderingContext2D;
  private layout: Layout;
  private dpr = 1;

  private sim: DotsSim;
  private players: number;
  private mySeat: number;
  private seatOf = new Map<string, number>();
  private hud: DotsHud;

  private startAt: number | null = null;
  /** The clock this runtime reads. Date.now() while a player is playing; a
   *  clock the console drives while somebody is watching it back. */
  private readonly now: () => number;
  /** Nobody is playing — see GameRuntimeContext.spectator. Every input here is
   *  already remote (the server authors them all and relays them to everyone
   *  including the asker), so only the TOUCHES have to be refused. */
  private readonly spectator: boolean;
  private tick = 0;
  private durationTicks: number;

  // ---- the move being composed ------------------------------------------
  /** The free line the local player has chosen, or -1. */
  private pick = -1;
  /** A press in flight: where it started and what was chosen before it. */
  private press: { id: number; x: number; y: number; was: number } | null = null;
  private drewOnce = false;

  /** What every other seat is hovering over, by seat. */
  private hovers = new Map<number, { line: number; tick: number }>();
  /** The last hover actually put on the wire, and when. */
  private sentHover = -1;
  private sentHoverAt = 0;

  /** The request we have made about the turn currently on the table, keyed on
   *  the turn INSTANCE rather than cleared when the answer arrives — the server
   *  stamps its answer a few ticks ahead so nobody has to rewind for it, and a
   *  flag cleared on arrival would spend that window inviting a tap that has
   *  already been made. */
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
    // contract every other game here relies on.
    ctx.roster.forEach((r, seat) => this.seatOf.set(r.uid, seat));
    this.mySeat = this.seatOf.get(ctx.you) ?? 0;

    const rules = ctx.rules ?? {};
    this.durationTicks =
      Number.isFinite(rules.durationTicks) && rules.durationTicks > 0
        ? Math.round(rules.durationTicks)
        : DURATION_TICKS;
    this.sim = new DotsSim(ctx.seed, this.players, this.durationTicks);

    this.root = document.createElement("div");
    this.root.className = "dt-root";
    this.gridCanvas = document.createElement("canvas");
    this.gridCanvas.className = "dt-canvas dt-grid";
    this.liveCanvas = document.createElement("canvas");
    this.liveCanvas.className = "dt-canvas dt-live";
    this.root.appendChild(this.gridCanvas);
    this.root.appendChild(this.liveCanvas);
    ctx.hudRoot.appendChild(this.root);
    this.bg = this.gridCanvas.getContext("2d")!;
    this.fg = this.liveCanvas.getContext("2d")!;

    this.hud = new DotsHud({
      root: this.root,
      spectator: this.spectator,
      seats: ctx.roster.slice(0, this.players).map((r, seat) => ({
        seat,
        name: r.name,
        you: r.uid === ctx.you,
        uid: r.uid,
      })),
      onQuick: (kind, id) => ctx.sendQuick(kind, id),
      onDraw: () => this.commit(),
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
    // the grid, so the signature below would not notice.
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
    // A hover and a request both say which line somebody is looking at. Neither
    // moves anything — `addInput` above has already thrown them away — so this
    // is the only thing that reads them, and it is presentation and nothing
    // else. An older one must not overwrite a newer one just because it arrived
    // second, which is ordinary on any network.
    const parsed = parseInput(input.kind);
    if (parsed && (parsed.type === "hover" || parsed.type === "ask")) {
      const prev = this.hovers.get(seat);
      if (!prev || input.tick >= prev.tick) {
        this.hovers.set(seat, { line: parsed.line, tick: input.tick });
        this.lastSig = "";
      }
    }
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
    this.press = null;
    this.pick = -1;
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
    // A match the server gave up on is not a grid anyone won; the platform
    // already has the right words for that, so say nothing and let it.
    if (result.reason === "aborted") return null;
    const s = this.state();
    const me = result.standings.find((x) => x.uid === you);
    const sub = s.decided
      ? s.claimed >= BOX_COUNT
        ? "Every box taken"
        : "Out of reach with boxes still open"
      : "Time ran out — most boxes wins";
    if (!me) return { headline: "Game over", sub };
    if (me.forfeit) return { headline: "You left the game", sub: "" };
    const firsts = result.standings.filter((x) => x.placement === 1);
    if (me.placement === 1) {
      return { headline: firsts.length > 1 ? "Draw" : "You win!", sub: firsts.length > 1 ? "Level on boxes" : sub };
    }
    return { headline: me.placement === 2 ? "Second" : me.placement === 3 ? "Third" : `#${me.placement}`, sub };
  }

  describeStanding(s: Standing): string {
    const d = s.detail;
    const boxes = d.boxes ?? 0;
    const bits = [`${boxes} box${boxes === 1 ? "" : "es"}`];
    if ((d.best ?? 0) > 1) bits.push(`run of ${d.best}`);
    if ((d.gifts ?? 0) > 0) bits.push(`${d.gifts} given away`);
    return bits.join(" · ");
  }

  /** Dev-only introspection for the headless harness and the preview page. */
  debug(): unknown {
    const s = this.state();
    return {
      local: { tick: s.tick, seat: this.mySeat },
      phase: s.phase,
      turn: s.turn,
      drawn: s.drawn,
      claimed: s.claimed,
      score: s.score,
      pick: this.pick,
      over: s.over,
      decided: s.decided,
      winner: s.winner,
    };
  }

  // ---- the loop -----------------------------------------------------------

  private state(): DotsState {
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
    this.maybeSendHover(s);
    // A line being drawn or a box filling in wants every frame it can get.
    if (s.phase === "draw") {
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

  /** Everything the live layer draws from, outside an animation. `drawn` covers
   *  every line and `claimed` every box, so two grids with the same pair really
   *  are the same picture. */
  private signature(s: DotsState): string {
    return [
      s.phase,
      s.turn,
      s.since,
      s.drawn,
      s.claimed,
      s.over ? 1 : 0,
      s.away.map((a) => (a ? 1 : 0)).join(""),
      s.quit.map((q) => (q ? 1 : 0)).join(""),
      this.pick,
      [...this.hovers].map(([k, v]) => `${k}:${v.line}`).join(","),
      this.waiting(s) ? 1 : 0,
      this.ended ? 1 : 0,
    ].join("|");
  }

  private animating(s: DotsState): boolean {
    if (this.press) return true;
    if (this.waiting(s)) return true;
    // The pulse around the line the player has chosen.
    return !s.over && !this.ended && s.phase === "turn" && this.pick >= 0;
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
    // own, or the tap that draws a line also lands on whatever the chat wheel
    // opens underneath it.
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
   *  future — so a line that invited a tap then would be inviting one it could
   *  only swallow. */
  private started(): boolean {
    return this.startAt !== null && this.now() >= this.startAt;
  }

  private myTurn(s: DotsState): boolean {
    return (
      this.started() && !this.ended && !s.over && s.phase === "turn" && s.turn === this.mySeat && !s.quit[this.mySeat]
    );
  }

  /** Which turn the table is waiting on. Every turn begins on its own tick, so
   *  this changes exactly once per turn and never repeats. */
  private turnKey(s: DotsState): string {
    return `${s.turn}:${s.since}`;
  }

  /** Have we already answered THIS turn and not yet seen it move on? */
  private waiting(s: DotsState): boolean {
    return this.asked !== null && this.asked.key === this.turnKey(s) && this.now() - this.asked.at <= RETRY_MS;
  }

  private point(e: PointerEvent): { x: number; y: number } {
    const rect = this.liveCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onDown(e: PointerEvent): void {
    // Whatever else a touch does, it puts the chat wheel away.
    this.hud.closeWheel();
    const s = this.state();
    // Marked away: any touch anywhere is how you come back, and it has to work
    // off-turn — an absent seat's turn resolves itself long before you could
    // reach it. The server reads the request and gives the clock back.
    if (this.started() && !s.over && s.away[this.mySeat] && !s.quit[this.mySeat]) {
      this.ctx.sendInput({ tick: this.stamp(), kind: NUDGE_KIND });
      this.lastSig = "";
      return;
    }
    if (!this.myTurn(s) || this.waiting(s)) return;
    const p = this.point(e);
    const line = nearestFree(this.layout, s, p.x, p.y);
    this.press = { id: e.pointerId, x: p.x, y: p.y, was: this.pick };
    this.liveCanvas.setPointerCapture?.(e.pointerId);
    if (line >= 0) this.choose(line);
    this.lastSig = "";
  }

  private onMove(e: PointerEvent): void {
    const p = this.press;
    if (!p || p.id !== e.pointerId) return;
    const at = this.point(e);
    const line = nearestFree(this.layout, this.state(), at.x, at.y);
    if (line >= 0) this.choose(line);
  }

  private onUp(e: PointerEvent): void {
    const p = this.press;
    if (!p || p.id !== e.pointerId) return;
    this.press = null;
    this.liveCanvas.releasePointerCapture?.(e.pointerId);
    this.lastSig = "";
    const at = this.point(e);
    const moved = Math.hypot(at.x - p.x, at.y - p.y) > this.layout.cell * TAP_SLOP;
    // A TAP on the line that was ALREADY chosen is the confirm. A first tap
    // only ever chooses, so a finger landing somewhere unintended can never
    // draw a line — which on a board where one line decides a chain of six is
    // the difference between a game and an argument.
    if (!moved && this.pick >= 0 && this.pick === p.was) this.commit();
  }

  private choose(line: number): void {
    if (line === this.pick) return;
    this.pick = line;
    this.lastSig = "";
    this.maybeSendHover(this.state(), true);
  }

  /** Stamped one tick ahead: an input must not be in the past by the time it
   *  lands, and the platform refuses anything more than a quarter second early. */
  private stamp(): number {
    return Math.max(1, Math.min(this.tick + 1, this.durationTicks));
  }

  /** Tell the table which line we are looking at — if it changed, and not more
   *  often than HOVER_SEND_MS. Called from the choosing path AND from the frame
   *  loop: the first is what makes it leave the instant it is chosen, the
   *  second is what catches a choice made and then left alone. */
  private maybeSendHover(s: DotsState, eager = false): void {
    if (this.spectator || this.pick < 0) return;
    if (!this.myTurn(s) || this.waiting(s)) return;
    if (this.pick === this.sentHover) return;
    const now = this.now();
    if (!eager && now - this.sentHoverAt < HOVER_SEND_MS) return;
    if (eager && now - this.sentHoverAt < HOVER_SEND_MS) return;
    this.sentHover = this.pick;
    this.sentHoverAt = now;
    this.ctx.sendInput({ tick: this.stamp(), kind: hoverKind(this.pick) });
  }

  /** Ask for the chosen line. The only thing on this screen that puts a MOVE on
   *  the wire, and it does nothing at all unless the table is actually asking. */
  private commit(): void {
    const s = this.state();
    if (!this.myTurn(s) || this.waiting(s)) return;
    if (this.pick < 0 || s.line[this.pick] >= 0) return;
    this.press = null;
    this.drewOnce = true;
    this.asked = { key: this.turnKey(s), at: this.now() };
    this.ctx.sendInput({ tick: this.stamp(), kind: askKind(this.pick) });
    this.lastSig = "";
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
    for (const c of [this.gridCanvas, this.liveCanvas]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.bg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    paintGrid(this.bg, this.layout);
    this.hud.setFrame(this.layout.rail, this.layout.ctrl);
    this.lastSig = "";
    this.paint(this.state());
  }

  /** The HUD only hears from us when something it shows has changed. */
  private syncHud(s: DotsState): void {
    this.hud.setTally(s.claimed);
    let top = 0;
    for (let seat = 0; seat < this.players; seat++) top = Math.max(top, s.score[seat]);
    for (let seat = 0; seat < this.players; seat++) {
      this.hud.setBoxes(seat, s.score[seat], top > 0 && s.score[seat] === top);
      this.hud.setAway(seat, s.away[seat]);
    }
    const turnKey = `${s.turn}|${s.phase}|${s.since}|${s.over ? 1 : 0}`;
    if (turnKey !== this.lastTurnKey) {
      this.lastTurnKey = turnKey;
      // A new turn is a new choice: the line we had chosen belonged to the last
      // one, and offering it again would invite a move nobody meant.
      if (s.phase === "turn") {
        this.pick = -1;
        this.sentHover = -1;
      }
      const waiting = !s.over && s.phase === "turn";
      const remaining = waiting && this.startAt !== null ? (s.deadline - s.tick) * TICK_MS : null;
      this.hud.setTurn(s.over ? null : s.turn, remaining !== null && remaining > 0 ? remaining : null);
    }
    const [text, tone] = this.bannerFor(s);
    this.hud.setBanner(text, tone);
    const mine = !this.spectator && this.myTurn(s) && !this.waiting(s);
    this.hud.setPick(
      this.pick >= 0 ? lineName(this.pick) : mine ? "Touch the grid to choose a line" : "",
      mine && this.pick >= 0,
      mine
    );
    this.hud.setHint(mine && !this.drewOnce ? "Touch to choose · touch again or press DRAW" : "");
  }

  private bannerFor(s: DotsState): [string, "" | "good" | "bad"] {
    if (s.over || this.ended) return ["", ""];
    // The platform's 3·2·1 is on screen and says everything worth saying;
    // "your turn" while a tap would be refused says the opposite of the truth.
    if (!this.started()) return ["", ""];
    if (!this.spectator && s.away[this.mySeat] && !s.quit[this.mySeat]) {
      return ["You're away — touch the grid to come back", "bad"];
    }
    const mine = !this.spectator && s.turn === this.mySeat;
    const who = this.ctx.roster[s.turn]?.name ?? "They";
    if (s.phase === "turn") {
      if (this.waiting(s)) return ["Drawing…", ""];
      return mine ? ["Your line", "good"] : [`${who} is choosing`, ""];
    }
    const last = s.last;
    if (s.phase === "draw" && last) {
      const them = this.ctx.roster[last.seat]?.name ?? "They";
      const who2 = !this.spectator && last.seat === this.mySeat ? "You" : them;
      const ours = !this.spectator && last.seat === this.mySeat;
      if (last.boxes.length === 2) return [`${who2} took two!`, ours ? "good" : "bad"];
      if (last.boxes.length === 1) {
        return [last.run > 2 ? `${who2} — ${last.run} in a row` : `${who2} took a box`, ours ? "good" : "bad"];
      }
      return ["", ""];
    }
    return ["", ""];
  }

  /** One frame of the live layer. */
  private paint(s: DotsState): void {
    const l = this.layout;
    const now = this.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    const frac = this.startAt !== null ? Math.min(1, Math.max(0, (now - this.startAt) / TICK_MS - this.tick)) : 0;
    const at = s.tick + frac;

    // How far through the line and each box fill the last move is. All of it is
    // read off the SIMULATION's clock, so the animation can never finish before
    // or after the rules say the move did.
    const last = s.phase === "draw" ? s.last : null;
    const drawing = last ? clamp01((at - s.since) / DRAW_TICKS) : 1;
    const claiming: number[] = [];
    if (last) {
      for (let i = 0; i < last.boxes.length; i++) {
        const from = s.since + DRAW_TICKS + i * CLAIM_TICKS;
        claiming.push(clamp01((at - from) / CLAIM_TICKS));
      }
    }

    // Only the seats that are actually choosing right now, and only for the
    // turn they are choosing on: a hover from a turn that is over is a finger
    // that moved ten minutes ago, and a studio scrub hands you plenty of those.
    const hovers = new Map<number, number>();
    if (!s.over && !this.ended && s.phase === "turn") {
      const h = this.hovers.get(s.turn);
      if (h && h.tick >= s.since && (s.turn !== this.mySeat || this.spectator)) hovers.set(s.turn, h.line);
    }

    const picked: number[] = [];
    if (this.pick >= 0 && s.line[this.pick] < 0) {
      for (const box of LINE_BOXES[this.pick]) if (s.box[box] < 0 && sidesOf(s, box) === 3) picked.push(box);
    }

    const draw: LiveDraw = {
      drawing,
      claiming,
      pick: this.spectator ? -1 : this.pick,
      picked,
      hovers,
      pulse,
    };
    paintLive(this.fg, l, s, draw);
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
