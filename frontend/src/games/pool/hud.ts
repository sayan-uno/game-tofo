// The pool HUD: the seat cards, the two racks of balls, the line that says what
// just happened, the controls, and the quick-chat wheel.
//
// All DOM rather than canvas, for the reason every board game here gives: text
// in an element scales with the reader's settings, can be read out, and costs
// nothing per frame because none of it is repainted between the moments it
// changes. The turn clock is the clearest case — on the canvas it would force a
// repaint every frame for eighteen seconds while nothing else moved; here it is
// one CSS animation, started when the turn begins and then left alone.
//
// WHAT THIS HAS THAT NO OTHER GAME HERE DOES is the two racks. 8-ball is not
// played by counting: it is played by looking at which of YOUR seven are still
// up, and a number cannot say that. So each side gets its seven balls drawn as
// chips, in their printed colours, and a potted one goes dark. Both racks are
// shown greyed while the table is still open, because until somebody pots one
// legally neither side owns anything — which is a rule people forget, and a
// picture that shows it is worth a paragraph of banner text.
import { onTalkingChange } from "../../voice/livekit";
import { QUICK_CHAT, QUICK_EMOTE, type QuickKind } from "../../shared/core/protocol";
import { EIGHT, PER_GROUP } from "../../shared/games/pool/index";
import { GROUP, ballPaint } from "./theme";

export interface HudSeat {
  seat: number;
  team: number;
  name: string;
  you: boolean;
  /** Same side as the local player (includes the local player). */
  ours: boolean;
  /** Matches the LiveKit participant identity, which is how the speaking
   *  indicator finds the right card. Absent for bots — they never talk. */
  uid?: string;
}

export interface HudDeps {
  root: HTMLElement;
  seats: HudSeat[];
  /** The local player's side, so the racks know which is "us". */
  myTeam: number;
  onQuick: (kind: QuickKind, id: string) => void;
  /** The weight of the next shot, 0…1. */
  onPower: (p: number) => void;
  /** Fine aim, −1…1 of the trim range, while the knob is held. */
  onTrim: (t: number) => void;
  /** The knob was let go: fold the trim into the aim and re-centre. */
  onTrimEnd: () => void;
  /** Take the shot. */
  onShoot: () => void;
  /** Nobody is playing — this is a replay. The controls are not drawn at all:
   *  a watcher who can see a SHOOT button will press it, and a replay somebody
   *  can appear to steer is not a replay. */
  spectator: boolean;
}

interface Bar {
  el: HTMLElement;
  fill: HTMLElement;
  knob: HTMLElement;
}

export class PoolHud {
  private cards = new Map<number, HTMLElement>();
  private chips: HTMLElement[][] = [[], []];
  private racks: HTMLElement[] = [];
  private eight: HTMLElement;
  private banner: HTMLElement;
  private hint: HTMLElement;
  private wheel: HTMLElement;
  private quickBtn: HTMLButtonElement;
  private bubbleTimers = new Map<number, number>();
  private strip!: HTMLElement;
  private shootBtn!: HTMLButtonElement;
  private power!: Bar;
  private trim!: Bar;
  private live = false;
  private lastBanner = "";
  private lastHint = "";
  private lastGroups = "";
  private lastAlive = "";
  private micOf = new Map<string, HTMLElement>();
  private untalk: (() => void) | null = null;

  constructor(private deps: HudDeps) {
    // ---- the seat cards, in one strip along the top ----------------------
    const head = document.createElement("div");
    head.className = "pl-players";
    for (const s of deps.seats) {
      const card = document.createElement("div");
      card.className = `pl-card${s.ours ? " ours" : ""}`;
      card.innerHTML = `
        <span class="pl-dot"></span>
        <span class="pl-who"><span class="pl-name"></span><i class="pl-mic">🎙</i><span class="pl-sunk">0</span></span>
        <span class="pl-timer"><i></i></span>
        <span class="pl-bubble"></span>`;
      // A username is user input and never goes near innerHTML.
      card.querySelector<HTMLElement>(".pl-name")!.textContent = s.you ? `${s.name} (you)` : s.name;
      card.querySelector<HTMLElement>(".pl-sunk")!.title = "Balls you potted";
      head.appendChild(card);
      this.cards.set(s.seat, card);
      if (s.uid) this.micOf.set(s.uid, card.querySelector<HTMLElement>(".pl-mic")!);
    }
    deps.root.appendChild(head);

    // Only while they are actually speaking — everyone's mic is on, so "mic on"
    // would light every card and mean nothing.
    this.untalk = onTalkingChange((uids) => {
      for (const [uid, mic] of this.micOf) {
        const talking = uids.has(uid);
        if (mic.classList.contains("live") !== talking) mic.classList.toggle("live", talking);
      }
    });

    // ---- the two racks, with the black between them ----------------------
    const score = document.createElement("div");
    score.className = "pl-score";
    for (const team of [0, 1]) {
      const rack = document.createElement("div");
      rack.className = `pl-rack open${team === deps.myTeam ? " mine" : ""}`;
      const label = document.createElement("b");
      label.className = "pl-rack-label";
      label.textContent = team === deps.myTeam ? "You" : "Them";
      rack.appendChild(label);
      const row = document.createElement("span");
      row.className = "pl-chips";
      // Seven placeholders. Which seven they ARE is not known until the table
      // is decided, so they are drawn blank and filled in by setGroups.
      for (let k = 0; k < PER_GROUP; k++) {
        const chip = document.createElement("i");
        chip.className = "pl-chip";
        row.appendChild(chip);
        this.chips[team].push(chip);
      }
      rack.appendChild(row);
      score.appendChild(rack);
      this.racks.push(rack);
      if (team === 0) {
        const black = document.createElement("i");
        black.className = "pl-chip pl-eight";
        this.paintChip(black, EIGHT);
        black.title = "The black";
        score.appendChild(black);
        this.eight = black;
      }
    }
    this.eight ??= document.createElement("i");
    deps.root.appendChild(score);

    this.banner = document.createElement("div");
    this.banner.className = "pl-banner";
    deps.root.appendChild(this.banner);

    this.hint = document.createElement("div");
    this.hint.className = "pl-hint hidden";
    deps.root.appendChild(this.hint);

    // ---- the controls ----------------------------------------------------
    //
    // THREE things, because they are three decisions and a player changes their
    // mind about them in any order — carrom's lesson, and pool needs it more.
    //
    //   the table   drag anywhere to aim, and drag the cue ball to place it
    //   POWER       its own bar, kept between shots
    //   FINE        the one control carrom did not need. A pot is a quarter of
    //               a degree wide and a thumb is not, so this bar swings the
    //               aim by two degrees end to end and springs back to the
    //               middle when released, folding what it did into the aim. It
    //               can therefore be used over and over to walk the line onto a
    //               ball, which no absolute control can do.
    const strip = document.createElement("div");
    strip.className = `pl-strip${deps.spectator ? " watch" : ""}`;
    this.power = this.makeBar(strip, "pl-power", "Power", (v) => deps.onPower(v));
    this.trim = this.makeBar(
      strip,
      "pl-trim",
      "Fine aim",
      (v) => deps.onTrim(v * 2 - 1),
      () => deps.onTrimEnd()
    );
    this.shootBtn = document.createElement("button");
    this.shootBtn.type = "button";
    this.shootBtn.className = "pl-shoot";
    this.shootBtn.textContent = "SHOOT";
    this.shootBtn.disabled = true;
    this.shootBtn.onclick = () => deps.onShoot();
    strip.appendChild(this.shootBtn);
    deps.root.appendChild(strip);
    this.strip = strip;

    this.quickBtn = document.createElement("button");
    this.quickBtn.type = "button";
    this.quickBtn.className = "pl-quick-btn";
    this.quickBtn.textContent = "💬";
    this.quickBtn.setAttribute("aria-label", "Say something");
    deps.root.appendChild(this.quickBtn);

    this.wheel = document.createElement("div");
    this.wheel.className = "pl-wheel hidden";
    for (const q of QUICK_CHAT) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q.text;
      b.onclick = () => {
        deps.onQuick("chat", q.id);
        this.toggleWheel(false);
      };
      this.wheel.appendChild(b);
    }
    const row = document.createElement("div");
    row.className = "pl-emotes";
    for (const e of QUICK_EMOTE) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = e;
      b.onclick = () => {
        deps.onQuick("emote", e);
        this.toggleWheel(false);
      };
      row.appendChild(b);
    }
    this.wheel.appendChild(row);
    deps.root.appendChild(this.wheel);
    this.quickBtn.onclick = () => this.toggleWheel(this.wheel.classList.contains("hidden"));
  }

  /** Give a chip the printed ball's colours. A stripe is a white chip with a
   *  coloured band, exactly as the ball on the table is. */
  private paintChip(chip: HTMLElement, ball: number): void {
    const skin = ballPaint(ball);
    chip.style.setProperty("--pl-c", skin.main);
    chip.style.setProperty("--pl-cl", skin.light);
    chip.classList.toggle("striped", skin.striped);
    chip.textContent = String(ball);
  }

  /** ---------------------------------------------------------------------
   *  One slider. Pointer-driven rather than an <input type=range>, because a
   *  range input on a canvas game is a different control on every browser and
   *  cannot be dragged from outside its own thumb — which is exactly the
   *  gesture a player makes when they grab a bar in a hurry.
   * ------------------------------------------------------------------- */
  private makeBar(
    parent: HTMLElement,
    cls: string,
    label: string,
    onChange: (v: number) => void,
    onEnd?: () => void
  ): Bar {
    const el = document.createElement("div");
    el.className = `pl-bar ${cls}`;
    el.innerHTML = `<span class="pl-bar-label"></span><span class="pl-bar-track"><i class="pl-bar-fill"></i><b class="pl-bar-knob"></b></span>`;
    el.querySelector<HTMLElement>(".pl-bar-label")!.textContent = label;
    const track = el.querySelector<HTMLElement>(".pl-bar-track")!;
    const fill = el.querySelector<HTMLElement>(".pl-bar-fill")!;
    const knob = el.querySelector<HTMLElement>(".pl-bar-knob")!;
    let dragging = -1;
    const read = (e: PointerEvent) => {
      const box = track.getBoundingClientRect();
      const v = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
      onChange(v < 0 ? 0 : v > 1 ? 1 : v);
    };
    el.addEventListener("pointerdown", (e) => {
      if (!this.live) return;
      dragging = e.pointerId;
      el.setPointerCapture?.(e.pointerId);
      read(e);
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (dragging === e.pointerId) read(e);
    });
    const end = (e: PointerEvent) => {
      if (dragging !== e.pointerId) return;
      dragging = -1;
      el.releasePointerCapture?.(e.pointerId);
      onEnd?.();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    parent.appendChild(el);
    return { el, fill, knob };
  }

  /** Where the controls actually are. The strip's height comes from the same
   *  layout that decided how much room the table could have, so the two can
   *  never disagree about who owns the bottom of the screen. */
  setRail(side: number, ctrl: number): void {
    const style = this.deps.root.style;
    style.setProperty("--pl-side", `${Math.max(0, Math.round(side))}px`);
    style.setProperty("--pl-ctrl", `${Math.round(ctrl)}px`);
  }

  /** Draw the two bars where the game says they are. Called only when a value
   *  changes, not per frame. */
  setBars(power: number, trim: number): void {
    const set = (b: Bar, v: number) => {
      const pct = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
      if (b.fill.style.width !== pct) b.fill.style.width = pct;
      if (b.knob.style.left !== pct) b.knob.style.left = pct;
    };
    set(this.power, power);
    set(this.trim, (trim + 1) / 2);
  }

  /** Are the controls this player's to use right now? Everything is disabled
   *  together — a live SHOOT button on somebody else's turn is a button that
   *  does nothing, which is worse than one that is plainly off. */
  setLive(live: boolean, canShoot: boolean): void {
    if (this.deps.spectator) return;
    if (this.live !== live) {
      this.live = live;
      this.strip.classList.toggle("off", !live);
    }
    if (this.shootBtn.disabled === canShoot) this.shootBtn.disabled = !canShoot;
    this.shootBtn.classList.toggle("ready", canShoot);
  }

  setBanner(text: string, tone: "" | "good" | "bad" = ""): void {
    const key = `${tone}|${text}`;
    if (key === this.lastBanner) return;
    this.lastBanner = key;
    this.banner.textContent = text;
    this.banner.className = `pl-banner${tone ? ` ${tone}` : ""}${text ? "" : " hidden"}`;
  }

  /** The line that explains the controls. Shown while it is your shot and you
   *  have not taken one, and never again once you have — a hint that stays up
   *  after you have understood it is clutter. */
  setHint(text: string): void {
    if (text === this.lastHint) return;
    this.lastHint = text;
    this.hint.textContent = text;
    this.hint.classList.toggle("hidden", !text);
  }

  /** Which side owns which group, or −1 apiece while the table is open. This
   *  is what fills the seven blank chips in with real balls. */
  setGroups(group0: number, group1: number): void {
    const key = `${group0}|${group1}`;
    if (key === this.lastGroups) return;
    this.lastGroups = key;
    for (const team of [0, 1]) {
      const group = team === 0 ? group0 : group1;
      const rack = this.racks[team];
      rack.classList.toggle("open", group < 0);
      const label = rack.querySelector<HTMLElement>(".pl-rack-label")!;
      const who = team === this.deps.myTeam ? "You" : "Them";
      label.textContent = group < 0 ? `${who} · open` : `${who} · ${GROUP[group].name}`;
      for (let k = 0; k < PER_GROUP; k++) {
        const chip = this.chips[team][k];
        if (group < 0) {
          chip.removeAttribute("style");
          chip.classList.remove("striped");
          chip.textContent = "";
          chip.dataset.ball = "";
        } else {
          const ball = group === 0 ? k + 1 : EIGHT + 1 + k;
          this.paintChip(chip, ball);
          chip.dataset.ball = String(ball);
        }
      }
      // A rack that has just been filled in has to be re-dimmed against the
      // table it was filled in from, and `lastAlive` would suppress that.
      this.lastAlive = "";
    }
  }

  /** Dim the balls that are down. `alive` is the shared table's own array, so
   *  there is no second opinion about what is still up. */
  setBalls(alive: readonly number[]): void {
    const key = alive.join("");
    if (key === this.lastAlive) return;
    this.lastAlive = key;
    for (const team of [0, 1]) {
      for (const chip of this.chips[team]) {
        const ball = Number(chip.dataset.ball ?? 0);
        chip.classList.toggle("down", ball > 0 && !alive[ball]);
      }
    }
    this.eight.classList.toggle("down", !alive[EIGHT]);
  }

  /** How many of their own group this player personally put down. */
  setSunk(seat: number, n: number): void {
    const el = this.cards.get(seat)?.querySelector<HTMLElement>(".pl-sunk");
    if (el) el.textContent = String(n);
  }

  setGone(seat: number, gone: boolean): void {
    this.cards.get(seat)?.classList.toggle("gone", gone);
  }

  /** Not waiting for this seat any more — its turns play themselves until its
   *  owner touches the screen. */
  setAway(seat: number, away: boolean): void {
    this.cards.get(seat)?.classList.toggle("away", away);
  }

  /** Whose shot it is, and how long they have left.
   *
   *  `remainingMs` starts one CSS animation and is then left to run; a null
   *  stops the clock. Called only when the turn actually changes, which is what
   *  keeps an eighteen-second wait free. */
  setTurn(seat: number | null, remainingMs: number | null): void {
    for (const [s, card] of this.cards) {
      const active = s === seat;
      card.classList.toggle("turn", active);
      const bar = card.querySelector<HTMLElement>(".pl-timer i")!;
      if (!active || remainingMs === null || remainingMs <= 0) {
        bar.style.animation = "none";
        bar.style.transform = "scaleX(0)";
        continue;
      }
      // Restart the animation from the top: removing and re-adding it in one go
      // is the only reliable way to replay a CSS animation.
      bar.style.animation = "none";
      void bar.offsetWidth;
      bar.style.transform = "";
      bar.style.animation = `pl-timer ${Math.round(remainingMs)}ms linear forwards`;
    }
  }

  /** Someone said one of the fixed phrases. */
  say(seat: number, text: string): void {
    const card = this.cards.get(seat);
    if (!card) return;
    const bubble = card.querySelector<HTMLElement>(".pl-bubble")!;
    bubble.textContent = text;
    bubble.classList.add("on");
    clearTimeout(this.bubbleTimers.get(seat));
    this.bubbleTimers.set(
      seat,
      window.setTimeout(() => bubble.classList.remove("on"), 2600)
    );
  }

  /** Put the wheel away — anything else the player does dismisses it. */
  closeWheel(): void {
    this.toggleWheel(false);
  }

  private toggleWheel(show: boolean): void {
    this.wheel.classList.toggle("hidden", !show);
    this.quickBtn.classList.toggle("on", show);
  }

  dispose(): void {
    this.untalk?.();
    this.untalk = null;
    for (const t of this.bubbleTimers.values()) clearTimeout(t);
    this.bubbleTimers.clear();
  }
}
