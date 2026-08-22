// Ludo on the client: the board, the taps, and the one loop that draws it.
//
// It draws on its OWN two-dimensional canvases rather than through Babylon. A
// Ludo board is flat by nature, and a flat board drawn as geometry is sharper,
// smaller and very much cheaper than the same board built out of meshes — the
// platform hands every game the 3D engine because the first game needed it, not
// because a game must use it. Nothing here touches the engine at all; the
// render loop the platform installs simply calls a function that paints.
//
// TWO THINGS MAKE IT CHEAP, and both matter more here than in a runner.
//
// The board is painted once, onto its own canvas underneath, and never again
// until the window changes size. The live canvas above it carries the tokens
// and the dice, and is cleared over the board's square only.
//
// And a turn-based game is idle most of the time. A frame in which nothing has
// changed and nothing is animating does no drawing whatsoever — it advances the
// simulation, compares a short signature, and returns. Waiting for the player
// on your left to make up their mind costs the battery almost nothing.
//
// WHAT A TAP DOES. Nothing, to the board. Tapping the dice or a token sends a
// REQUEST and starts an animation; the piece itself does not move until the
// server writes the move and it comes back through the ordinary input relay.
// The reason is in the simulation's header comment, and it is not squeamishness
// — on a platform that relays an input to everyone except its sender, a client
// that moved its own piece would be the one participant unable to discover that
// nobody else had. What the player sees is a die that starts tumbling under
// their thumb and a token that lifts, so the round trip is spent rather than
// waited out.
import type { GameRuntime, GameRuntimeContext } from "../../platform/types";
import type { MatchEnd, MatchInputRelay, QuickKind, Standing } from "../../shared/core/protocol";
import { QUICK_CHAT } from "../../shared/core/protocol";
import {
  DURATION_TICKS,
  HOP_TICKS,
  LudoSim,
  POS_HOME,
  POS_YARD,
  TICK_MS,
  TOKENS_PER_PLAYER,
  cellOf,
  cornerOf,
  isSafeRing,
  legalMoves,
  ringIndexOf,
  tokensHome,
  type LudoState,
} from "../../shared/games/ludo/index";
import { LudoHud } from "./hud";
import {
  capturedFrom,
  hopLegs,
  layoutFor,
  paintBoard,
  paintDie,
  paintTarget,
  paintToken,
  px,
  walkCells,
  type Layout,
  type TokenDraw,
} from "./paint";
import { PALETTE } from "./theme";

/** How long a request may sit unanswered before the tap is offered again. The
 *  server answers in a fraction of this; it exists so that a tap the platform
 *  quietly dropped is a tap you can simply make again, rather than a turn you
 *  lose to a countdown you cannot influence. */
const RETRY_MS = 2200;
/** Frames per second while only a highlight is pulsing and the board is still.
 *  A pulse does not need sixty. */
const IDLE_FPS = 30;

export class LudoRuntime implements GameRuntime {
  private root: HTMLElement;
  private boardCanvas: HTMLCanvasElement;
  private liveCanvas: HTMLCanvasElement;
  private bg: CanvasRenderingContext2D;
  private fg: CanvasRenderingContext2D;
  private layout: Layout;
  private dpr = 1;

  private sim: LudoSim;
  private players: number;
  private mySeat: number;
  private seatOf = new Map<string, number>();
  private corners: number[] = [];
  private hud: LudoHud;

  private startAt: number | null = null;
  /** The clock this runtime reads. Date.now() while a player is playing; a
   *  clock the console drives while somebody is watching it back. */
  private readonly now: () => number;
  /** Nobody is playing — see GameRuntimeContext.spectator. Ludo already treats
   *  every input as remote (the server authors them all, and relays them to
   *  everyone including the asker), so only the TAPS have to be refused. */
  private readonly spectator: boolean;
  private tick = 0;
  private durationTicks: number;

  /** The request we have made about the question currently on the table.
   *
   *  Keyed on the phase INSTANCE rather than cleared when the answer arrives.
   *  The server stamps its answer a few ticks ahead so that nobody has to
   *  rewind for it, which means there is a window between the answer landing
   *  on the wire and the board acting on it — and a flag cleared on arrival
   *  would spend that window telling the player to tap the dice they have
   *  already tapped. Tied to the phase instead, the offer comes back exactly
   *  when the question changes, and not a frame before. */
  private asked: { key: string; kind: string; at: number } | null = null;
  private lastSig = "";
  private lastPaintAt = 0;
  private lastTurnKey = "";
  /** The face the dice is lying on. A die between turns shows what it last
   *  rolled, the way one on a table does — a blank white square reads as a
   *  missing texture rather than as an invitation. */
  private lastFace = 6;
  private ended = false;
  private disposed = false;
  private onResize: () => void;
  private observer: ResizeObserver | null = null;

  constructor(private ctx: GameRuntimeContext) {
    this.now = ctx.now ?? Date.now;
    this.spectator = ctx.spectator === true;
    this.players = Math.max(2, Math.min(4, ctx.roster.length));
    // The server sorts the roster by seat, so the index IS the seat — the same
    // contract the runner relies on.
    ctx.roster.forEach((r, seat) => this.seatOf.set(r.uid, seat));
    this.mySeat = this.seatOf.get(ctx.you) ?? 0;
    for (let s = 0; s < this.players; s++) this.corners.push(cornerOf(s, this.players));

    const rules = ctx.rules ?? {};
    this.durationTicks = Number.isFinite(rules.durationTicks) && rules.durationTicks > 0
      ? Math.round(rules.durationTicks)
      : DURATION_TICKS;
    this.sim = new LudoSim(ctx.seed, this.players, this.durationTicks);

    this.root = document.createElement("div");
    this.root.className = "ld-root";
    this.boardCanvas = document.createElement("canvas");
    this.boardCanvas.className = "ld-canvas ld-board";
    this.liveCanvas = document.createElement("canvas");
    this.liveCanvas.className = "ld-canvas ld-live";
    this.root.appendChild(this.boardCanvas);
    this.root.appendChild(this.liveCanvas);
    ctx.hudRoot.appendChild(this.root);
    this.bg = this.boardCanvas.getContext("2d")!;
    this.fg = this.liveCanvas.getContext("2d")!;

    this.hud = new LudoHud({
      root: this.root,
      seats: ctx.roster.slice(0, this.players).map((r, seat) => ({
        seat,
        corner: cornerOf(seat, this.players),
        name: r.name,
        you: r.uid === ctx.you,
        uid: r.uid,
      })),
      onQuick: (kind, id) => ctx.sendQuick(kind, id),
    });

    this.layout = layoutFor(1, 1);
    this.onResize = () => this.resize();
    // A ResizeObserver rather than a per-frame size check: reading an element's
    // width every frame forces the browser to lay the page out again, which is
    // exactly the cost this game is built to avoid. The window listeners stay
    // as well, for the phone that changes orientation without resizing the
    // element we are watching.
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.root);
    }
    window.addEventListener("resize", this.onResize);
    window.addEventListener("orientationchange", this.onResize);
    // A tap on the board must not be able to roll a die in a match that is
    // over. See GameRuntimeContext.spectator.
    if (!this.spectator) this.liveCanvas.addEventListener("pointerdown", (e) => this.onTap(e));
    // Phones synthesize a mouse click after every touch. The platform kills
    // those on the Babylon canvas; this is a different surface and needs its
    // own, or the tap that rolls the dice also lands on whatever the wheel
    // opens underneath it.
    this.liveCanvas.addEventListener(
      "touchend",
      (e) => {
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );
  }

  // ---- lifecycle ----------------------------------------------------------

  async prepare(): Promise<void> {
    this.resize();
  }

  go(localStartAt: number): void {
    this.startAt = localStartAt;
    // Knowing WHEN tick zero lands changes what the HUD should show — the turn
    // clock cannot start before there is a clock — but it changes nothing on
    // the board, so the signature below would not notice. Force the next frame
    // to re-sync, or the very first turn is played with a dead timer.
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
    this.paint(this.state());
  }

  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("orientationchange", this.onResize);
    this.hud.dispose();
    this.root.remove();
  }

  // ---- the results card ---------------------------------------------------

  resultsHeadline(result: MatchEnd, you: string): { headline: string; sub: string } | null {
    // A match the server gave up on is not a game anyone won; the platform
    // already has the right words for that, so say nothing and let it.
    if (result.reason === "aborted") return null;
    const me = result.standings.find((s) => s.uid === you);
    // Read the BOARD, not the reason. "All home" in front of four people who
    // got nothing home is worse than saying nothing, and the platform's reason
    // describes how the match ended rather than what happened on it.
    const finishers = this.state().order.length;
    const sub =
      finishers > 0
        ? finishers === 1
          ? "First one home"
          : "Everyone home but one"
        : "Time ran out — furthest round wins";
    if (!me) return { headline: "Game over", sub };
    if (me.forfeit) return { headline: "You left the game", sub: "" };
    if (me.placement === 1) {
      const shared = result.standings.filter((s) => s.placement === 1).length > 1;
      return { headline: shared ? "Draw" : "You win!", sub };
    }
    return { headline: me.placement === 2 ? "Second" : me.placement === 3 ? "Third" : `#${me.placement}`, sub };
  }

  describeStanding(s: Standing): string {
    const d = s.detail;
    const bits = [`${d.home ?? 0}/4 home`];
    if ((d.captures ?? 0) > 0) bits.push(`${d.captures} knocked out`);
    if (d.finished === 1) bits.push("finished");
    return bits.join(" · ");
  }

  /** Dev-only introspection for the headless harness. */
  debug(): unknown {
    const s = this.state();
    return {
      local: { tick: s.tick, seat: this.mySeat },
      phase: s.phase,
      turn: s.turn,
      die: s.die,
      pos: s.pos,
      over: s.over,
      order: s.order,
    };
  }

  // ---- the loop -----------------------------------------------------------

  private state(): LudoState {
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
    const sig = this.signature(s);
    const changed = sig !== this.lastSig;
    if (changed) {
      this.lastSig = sig;
      this.syncHud(s);
    } else if (!this.animating(s) || (!this.moving(s) && now - this.lastPaintAt < 1000 / IDLE_FPS)) {
      // Nothing moved and nothing is moving: the cheapest frame there is.
      return;
    }
    this.lastPaintAt = now;
    this.paint(s);
  }

  /** Everything the live layer draws from. When this is unchanged and nothing
   *  is in flight, the frame can be skipped outright. */
  private signature(s: LudoState): string {
    return `${s.phase}|${s.turn}|${s.die}|${s.since}|${s.over ? 1 : 0}|${s.away.map((a) => (a ? 1 : 0)).join("")}|${s.pos.map((r) => r.join(",")).join(";")}|${this.waiting(s) ? this.asked?.kind : ""}|${this.ended ? 1 : 0}`;
  }

  /** Something is actually travelling, and wants every frame it can get. */
  private moving(s: LudoState): boolean {
    return s.phase === "hop" || s.phase === "spin" || this.waiting(s);
  }

  private animating(s: LudoState): boolean {
    if (s.phase === "hop" || s.phase === "spin") return true;
    if (this.waiting(s)) return true;
    // A pulsing ring around a token you may choose, or around the dice.
    return !s.over && s.turn === this.mySeat && (s.phase === "roll" || s.phase === "pick");
  }

  // ---- input --------------------------------------------------------------

  /** Has tick zero actually arrived? The platform runs a three-second countdown
   *  after `go()`, during which the server refuses any input as being from the
   *  future — so a die that glowed then would be inviting a tap it could only
   *  swallow. */
  private started(): boolean {
    return this.startAt !== null && this.now() >= this.startAt;
  }

  private myTurn(s: LudoState): boolean {
    return this.started() && !this.ended && !s.over && s.turn === this.mySeat && !s.quit[this.mySeat];
  }

  /** Which question the table is asking. Every phase begins on its own tick, so
   *  this changes exactly once per question and never repeats. */
  private phaseKey(s: LudoState): string {
    return `${s.turn}:${s.phase}:${s.since}`;
  }

  /** Have we already answered THIS question and not yet seen it move on?
   *  The retry window is what makes a tap the platform quietly dropped into a
   *  tap you can simply make again, rather than a turn lost to a countdown. */
  private waiting(s: LudoState): boolean {
    return this.asked !== null && this.asked.key === this.phaseKey(s) && this.now() - this.asked.at <= RETRY_MS;
  }

  private onTap(e: PointerEvent): void {
    // Whatever else a tap does, it puts the chat wheel away.
    this.hud.closeWheel();
    const s = this.state();
    // Marked away: any tap anywhere is how you come back, and it has to work
    // off-turn — an away seat's turn resolves itself long before you could
    // reach it. The server reads the request and gives the clock back.
    if (this.started() && !s.over && s.away[this.mySeat] && !s.quit[this.mySeat]) {
      this.ctx.sendInput({ tick: Math.max(1, Math.min(this.tick + 1, this.durationTicks)), kind: "roll" });
      this.lastSig = "";
      return;
    }
    if (!this.myTurn(s) || this.waiting(s)) return;
    const rect = this.liveCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (s.phase === "roll") {
      const l = this.layout;
      const pad = l.dsize * 0.45;
      const onDie = x >= l.dx - pad && x <= l.dx + l.dsize + pad && y >= l.dy - pad && y <= l.dy + l.dsize + pad;
      // The dice is the only thing to tap on this phase, and it is small on a
      // phone, so anywhere on the rail beside the board counts too.
      const onRail = x > l.bx + l.size;
      if (onDie || onRail) this.send("roll");
      return;
    }
    if (s.phase !== "pick") return;
    const moves = legalMoves(s, this.mySeat, s.die);
    if (!moves.length) return;
    const corner = cornerOf(this.mySeat, this.players);
    const reach = this.layout.cell * 0.55;
    let best = -1;
    let bestDist = Infinity;
    for (let t = 0; t < TOKENS_PER_PLAYER; t++) {
      const pos = s.pos[this.mySeat][t];
      if (pos === POS_HOME) continue;
      const p = px(this.layout, cellOf(corner, pos, t));
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > reach || d >= bestDist) continue;
      // Tokens sharing a square are one move; whichever was tapped, the one
      // the rules offer is the one that gets sent.
      const rep = moves.find((m) => s.pos[this.mySeat][m] === pos);
      if (rep === undefined) continue;
      bestDist = d;
      best = rep;
    }
    if (best >= 0) this.send(`t${best}`);
  }

  private send(kind: string): void {
    // Stamped one tick ahead: it must not be in the past by the time it lands,
    // and the platform refuses anything more than a quarter second early.
    const tick = Math.max(1, Math.min(this.tick + 1, this.durationTicks));
    this.asked = { key: this.phaseKey(this.state()), kind, at: this.now() };
    this.ctx.sendInput({ tick, kind });
    this.lastSig = ""; // repaint at once, so the tap feels answered
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
    paintBoard(this.bg, this.layout, this.corners);
    this.hud.setRails(this.layout.bx, this.layout.dsize);
    this.lastSig = "";
    this.paint(this.state());
  }

  /** The HUD only hears from us when something it shows has changed. */
  private syncHud(s: LudoState): void {
    for (let seat = 0; seat < this.players; seat++) {
      this.hud.setHome(seat, tokensHome(s, seat));
      this.hud.setAway(seat, s.away[seat]);
      const place = s.order.indexOf(seat);
      this.hud.setFinished(seat, place >= 0 ? place + 1 : null);
    }
    const turnKey = `${s.turn}|${s.phase}|${s.since}|${s.over ? 1 : 0}`;
    if (turnKey !== this.lastTurnKey) {
      this.lastTurnKey = turnKey;
      const waiting = !s.over && (s.phase === "roll" || s.phase === "pick");
      const remaining = waiting && this.startAt !== null ? (s.deadline - s.tick) * TICK_MS : null;
      this.hud.setTurn(s.over ? null : s.turn, remaining !== null && remaining > 0 ? remaining : null);
    }
    this.hud.setBanner(...this.bannerFor(s));
  }

  private bannerFor(s: LudoState): [string, "" | "good" | "bad"] {
    if (s.over || this.ended) return ["", ""];
    // The platform's 3·2·1 is on screen and says everything worth saying;
    // "your turn" while a tap would be refused says the opposite of the truth.
    if (!this.started()) return ["", ""];
    if (s.away[this.mySeat] && !s.quit[this.mySeat]) return ["You're away — tap to rejoin", "bad"];
    const mine = s.turn === this.mySeat;
    const who = this.ctx.roster[s.turn]?.name ?? "They";
    switch (s.phase) {
      case "roll":
        if (this.waiting(s)) return ["Rolling…", ""];
        return mine ? ["Your turn — tap the dice", "good"] : [`${who} to roll`, ""];
      case "spin":
        return [mine ? "Rolling…" : `${who} is rolling`, ""];
      case "pick":
        if (this.waiting(s)) return ["Moving…", ""];
        return mine ? [`You rolled ${s.die} — pick a token`, "good"] : [`${who} rolled ${s.die}`, ""];
      case "hop": {
        const h = s.hop;
        if (h?.taken.length) return [h.seat === this.mySeat ? "Knocked out!" : `${who} knocked one out`, h.seat === this.mySeat ? "good" : "bad"];
        if (h && h.to === POS_HOME) return [h.seat === this.mySeat ? "Home!" : `${who} is home`, "good"];
        return ["", ""];
      }
      case "pass":
        if (s.passReason === "three-sixes") return [mine ? "Three sixes — turn lost" : `${who} rolled three sixes`, "bad"];
        return [mine ? `No move with a ${s.die}` : `${who} can't move`, mine ? "bad" : ""];
      default:
        return ["", ""];
    }
  }

  /** One frame of the live layer. */
  private paint(s: LudoState): void {
    const l = this.layout;
    const g = this.fg;
    // Clear only what we draw on: the board square, and the dice beside it.
    //
    // The board's margin is not decoration. A knocked-out token flies back to
    // its yard along an arc that lifts it more than a square and a half, and a
    // token knocked off the top row of the ring goes clean over the edge of the
    // board — clearing only the board itself leaves it smeared across the table
    // for the rest of the match.
    const m = l.cell * 2.4;
    g.clearRect(l.bx - m, l.by - m, l.size + m * 2, l.size + m * 2);
    const dpad = l.dsize * 0.9;
    g.clearRect(l.dx - dpad, l.dy - dpad, l.dsize + dpad * 2, l.dsize + dpad * 2);

    const now = this.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    const frac = this.startAt !== null ? Math.min(1, Math.max(0, (now - this.startAt) / TICK_MS - this.tick)) : 0;
    const at = s.tick + frac;

    const waiting = this.waiting(s);
    const chooseable = this.myTurn(s) && s.phase === "pick" && !waiting ? legalMoves(s, this.mySeat, s.die) : [];

    // Where a chosen token would land.
    for (const t of chooseable) {
      const corner = cornerOf(this.mySeat, this.players);
      const from = s.pos[this.mySeat][t];
      const to = from === POS_YARD ? 0 : from + s.die;
      const ring = ringIndexOf(corner, to);
      const takes = ring >= 0 && !isSafeRing(ring) && this.enemyOn(s, this.mySeat, ring);
      paintTarget(g, l, cellOf(corner, to, t), takes, pulse);
    }

    // Every token. A stack on one square draws as a single piece with a count
    // rather than four circles fighting over the same forty pixels; the yard
    // is the exception, because each token has its own resting circle there.
    const hop = s.phase === "hop" ? s.hop : null;
    // A knocked-out token's position is already its yard — the move was applied
    // in full when the hop began — so without this it would sit at home AND fly
    // there at the same time, for the whole length of the flight.
    const inFlight = new Set<string>();
    if (hop) for (const v of hop.taken) inFlight.add(`${v.seat}:${v.token}`);
    const draws: TokenDraw[] = [];
    for (let seat = 0; seat < this.players; seat++) {
      const corner = cornerOf(seat, this.players);
      const count = new Map<number, number>();
      for (let t = 0; t < TOKENS_PER_PLAYER; t++) {
        if (inFlight.has(`${seat}:${t}`)) continue;
        if (hop && hop.seat === seat && hop.token === t) continue; // counted on its own
        const pos = s.pos[seat][t];
        count.set(pos, (count.get(pos) ?? 0) + 1);
      }
      const drawn = new Set<number>();
      for (let t = 0; t < TOKENS_PER_PLAYER; t++) {
        if (inFlight.has(`${seat}:${t}`)) continue;
        const pos = s.pos[seat][t];
        const moving = hop !== null && hop.seat === seat && hop.token === t;
        if (!moving && pos !== POS_YARD) {
          if (drawn.has(pos)) continue;
          drawn.add(pos);
        }
        const p = moving ? this.hopPoint(hop, corner, at) : px(l, cellOf(corner, pos, t));
        draws.push({
          corner,
          x: p.x,
          y: p.y,
          scale: moving ? 1.14 : 1,
          choosable: !moving && seat === this.mySeat && chooseable.some((m) => s.pos[seat][m] === pos),
          stack: moving || pos === POS_YARD ? 1 : (count.get(pos) ?? 1),
          lifted: moving,
        });
      }
    }
    for (const d of draws) if (!d.lifted) paintToken(g, l, d, pulse);

    // Tokens on their way back to their yard after being knocked out. The walk
    // ends before the phase does — the rest of it is this flight.
    if (hop && hop.taken.length) {
      const landedAt = s.since + hopLegs(hop.from, hop.to) * HOP_TICKS;
      const span = Math.max(1, s.deadline - landedAt);
      const u = Math.min(1, Math.max(0, (at - landedAt) / span));
      const fromCell = capturedFrom(cornerOf(hop.seat, this.players), hop.to);
      if (fromCell) {
        const a = px(l, fromCell);
        for (const v of hop.taken) {
          const vc = cornerOf(v.seat, this.players);
          const b = px(l, cellOf(vc, POS_YARD, v.token));
          const arc = Math.sin(u * Math.PI) * l.cell * 1.6;
          paintToken(
            g,
            l,
            {
              corner: vc,
              x: a.x + (b.x - a.x) * u,
              y: a.y + (b.y - a.y) * u - arc,
              scale: 1 - 0.18 * Math.sin(u * Math.PI),
              choosable: false,
              stack: 1,
              lifted: true,
            },
            pulse
          );
        }
      }
    }
    for (const d of draws) if (d.lifted) paintToken(g, l, d, pulse);

    // The dice, in the colour of whoever is holding it.
    const holder = PALETTE[cornerOf(s.over ? this.mySeat : s.turn, this.players)];
    const tumbling = (waiting && this.asked?.kind === "roll") || s.phase === "spin";
    const spin = tumbling ? (now % 700) / 700 : 0;
    if (s.die > 0) this.lastFace = s.die;
    const face = s.die > 0 ? s.die : this.lastFace;
    const glow = this.myTurn(s) && s.phase === "roll" && !waiting ? pulse : 0;
    paintDie(g, l, tumbling ? 0 : face, spin, glow, holder.main);
  }

  private enemyOn(s: LudoState, seat: number, ring: number): boolean {
    for (let o = 0; o < this.players; o++) {
      if (o === seat) continue;
      const c = cornerOf(o, this.players);
      for (let t = 0; t < TOKENS_PER_PLAYER; t++) {
        const p = s.pos[o][t];
        if (p >= 0 && ringIndexOf(c, p) === ring) return true;
      }
    }
    return false;
  }

  /** Where a moving token is right now: along the squares it walks, with a
   *  small arc so it hops rather than slides. */
  private hopPoint(hop: NonNullable<LudoState["hop"]>, corner: number, at: number): { x: number; y: number } {
    const cells = walkCells(corner, hop.from, hop.to, hop.token);
    const legs = Math.max(1, cells.length - 1);
    const u = Math.min(1, Math.max(0, (at - this.state().since) / (legs * HOP_TICKS)));
    const f = u * legs;
    const i = Math.min(legs - 1, Math.floor(f));
    const k = f - i;
    const a = px(this.layout, cells[i]);
    const b = px(this.layout, cells[i + 1] ?? cells[i]);
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k - Math.sin(k * Math.PI) * this.layout.cell * 0.32,
    };
  }
}
