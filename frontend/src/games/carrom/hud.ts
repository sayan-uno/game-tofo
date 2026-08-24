// The carrom HUD: the two sides' cards, the board score, the line that says
// what just happened, and the quick-chat wheel.
//
// All of it is DOM rather than canvas, for Ludo's reasons: text in an element
// scales with the reader's settings, can be read by a screen reader, and costs
// nothing per frame because none of it is repainted between the moments it
// actually changes. The turn clock is the clearest case — drawn on the canvas
// it would force a repaint every frame for fourteen seconds at a time while
// nothing else moved; here it is one CSS animation, set once when the turn
// begins and then left alone.
//
// THE ONE THING THIS DOES THAT LUDO'S DOES NOT is take sides. Carrom is two
// against two, so the cards are split down the two rails — yours on the left,
// theirs on the right — and the score between them counts coins, not places.
// A doubles player has to know at a glance whose shot helps them.
import { onTalkingChange } from "../../voice/livekit";
import { QUICK_CHAT, QUICK_EMOTE, type QuickKind } from "../../shared/core/protocol";
import { COINS_PER_TEAM } from "../../shared/games/carrom/index";
import { TEAM } from "./theme";

export interface HudSeat {
  seat: number;
  team: number;
  name: string;
  you: boolean;
  /** Same team as the local player (includes the local player). */
  ours: boolean;
  /** Matches the LiveKit participant identity, which is how the speaking
   *  indicator finds the right card. Absent for bots — they never talk. */
  uid?: string;
}

export interface HudDeps {
  root: HTMLElement;
  seats: HudSeat[];
  /** The local player's side, so the score knows which half is "us". */
  myTeam: number;
  onQuick: (kind: QuickKind, id: string) => void;
  /** The striker moved along its base line, −1…1. */
  onSlide: (t: number) => void;
  /** The weight of the next flick, 0…1. */
  onPower: (p: number) => void;
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

export class CarromHud {
  private cards = new Map<number, HTMLElement>();
  private counts: HTMLElement[] = [];
  private banner: HTMLElement;
  private hint: HTMLElement;
  private wheel: HTMLElement;
  private quickBtn: HTMLButtonElement;
  private bubbleTimers = new Map<number, number>();
  private strip!: HTMLElement;
  private ourRail!: HTMLElement;
  private shootBtn!: HTMLButtonElement;
  private power!: Bar;
  private slide!: Bar;
  private live = false;
  private lastBanner = "";
  private lastHint = "";
  private micOf = new Map<string, HTMLElement>();
  private untalk: (() => void) | null = null;

  constructor(private deps: HudDeps) {
    for (const ours of [true, false]) {
      const rail = document.createElement("div");
      rail.className = `cr-players ${ours ? "cr-ours" : "cr-theirs"}`;
      for (const s of deps.seats.filter((x) => x.ours === ours)) {
        const t = TEAM[s.team] ?? TEAM[0];
        const card = document.createElement("div");
        card.className = "cr-card";
        card.style.setProperty("--cr-c", t.main);
        card.style.setProperty("--cr-cl", t.light);
        card.innerHTML = `
          <span class="cr-dot"></span>
          <span class="cr-who"><span class="cr-name"></span><i class="cr-mic">🎙</i><span class="cr-sunk">0</span></span>
          <span class="cr-timer"><i></i></span>
          <span class="cr-bubble"></span>`;
        // A username is user input and never goes near innerHTML.
        card.querySelector<HTMLElement>(".cr-name")!.textContent = s.you ? `${s.name} (you)` : s.name;
        card.querySelector<HTMLElement>(".cr-sunk")!.title = "Coins pocketed";
        rail.appendChild(card);
        this.cards.set(s.seat, card);
        if (s.uid) this.micOf.set(s.uid, card.querySelector<HTMLElement>(".cr-mic")!);
      }
      deps.root.appendChild(rail);
      if (ours) this.ourRail = rail;
    }

    // Only while they are actually speaking — everyone's mic is on, so "mic on"
    // would light every card and mean nothing.
    this.untalk = onTalkingChange((uids) => {
      for (const [uid, mic] of this.micOf) {
        const talking = uids.has(uid);
        if (mic.classList.contains("live") !== talking) mic.classList.toggle("live", talking);
      }
    });

    // The board score: how many of each colour are down, out of nine.
    const score = document.createElement("div");
    score.className = "cr-score";
    for (const team of [0, 1]) {
      const t = TEAM[team];
      const side = document.createElement("span");
      side.className = `cr-side${team === deps.myTeam ? " mine" : ""}`;
      side.style.setProperty("--cr-c", t.main);
      side.innerHTML = `<i class="cr-chip"></i><b class="cr-n">0</b><span class="cr-of">/${COINS_PER_TEAM}</span>`;
      this.counts.push(side.querySelector<HTMLElement>(".cr-n")!);
      score.appendChild(side);
      if (team === 0) {
        const vs = document.createElement("span");
        vs.className = "cr-vs";
        vs.textContent = "vs";
        score.appendChild(vs);
      }
    }
    deps.root.appendChild(score);

    // UNDER THE PLAYER'S OWN CARDS, not over the board.
    //
    // It started at the bottom of the screen, which is now the control strip,
    // and then at the top — where it and the hint together covered the far edge
    // of the felt and the coins sitting on it. In the rail it is beside the
    // board instead of on it, and it follows the cards down whatever the screen
    // is shaped like, because the rail is a column and these are the last two
    // things in it.
    this.banner = document.createElement("div");
    this.banner.className = "cr-banner";
    this.ourRail.appendChild(this.banner);

    this.hint = document.createElement("div");
    this.hint.className = "cr-hint hidden";
    this.ourRail.appendChild(this.hint);

    // ---- the controls ----------------------------------------------------
    //
    // THREE separate things, because they are three separate decisions and a
    // player changes their mind about them in any order. Rolled into one drag
    // — which is how this game shipped first — the aim could not be adjusted
    // without recharging the weight, the striker could not be nudged without
    // losing the aim, and there was no way to back out of a shot at all.
    const strip = document.createElement("div");
    strip.className = `cr-strip${deps.spectator ? " watch" : ""}`;

    this.power = this.makeBar(strip, "cr-power", "Power", (v) => deps.onPower(v));
    this.slide = this.makeBar(strip, "cr-slide", "Striker", (v) => deps.onSlide(v * 2 - 1));

    this.shootBtn = document.createElement("button");
    this.shootBtn.type = "button";
    this.shootBtn.className = "cr-shoot";
    this.shootBtn.textContent = "SHOOT";
    this.shootBtn.disabled = true;
    this.shootBtn.onclick = () => deps.onShoot();
    strip.appendChild(this.shootBtn);
    deps.root.appendChild(strip);
    this.strip = strip;

    this.quickBtn = document.createElement("button");
    this.quickBtn.type = "button";
    this.quickBtn.className = "cr-quick-btn";
    this.quickBtn.textContent = "💬";
    this.quickBtn.setAttribute("aria-label", "Say something");
    deps.root.appendChild(this.quickBtn);

    this.wheel = document.createElement("div");
    this.wheel.className = "cr-wheel hidden";
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
    row.className = "cr-emotes";
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

  /** ---------------------------------------------------------------------
   *  One slider. Pointer-driven rather than an <input type=range>, because a
   *  range input on a canvas game is a different control on every browser and
   *  cannot be dragged from outside its own thumb — which is exactly the
   *  gesture a player makes when they grab a bar in a hurry.
   * ------------------------------------------------------------------- */
  private makeBar(parent: HTMLElement, cls: string, label: string, onChange: (v: number) => void): Bar {
    const el = document.createElement("div");
    el.className = `cr-bar ${cls}`;
    el.innerHTML = `<span class="cr-bar-label"></span><span class="cr-bar-track"><i class="cr-bar-fill"></i><b class="cr-bar-knob"></b></span>`;
    el.querySelector<HTMLElement>(".cr-bar-label")!.textContent = label;
    const track = el.querySelector<HTMLElement>(".cr-bar-track")!;
    const fill = el.querySelector<HTMLElement>(".cr-bar-fill")!;
    const knob = el.querySelector<HTMLElement>(".cr-bar-knob")!;
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
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    parent.appendChild(el);
    return { el, fill, knob };
  }

  /** Where the controls actually are. The strip's height comes from the same
   *  layout that decided how much room the board could have, so the two can
   *  never disagree about who owns the bottom of the screen. */
  setRail(rail: number, ctrl: number): void {
    const style = this.deps.root.style;
    style.setProperty("--cr-rail", `${Math.max(66, Math.round(rail))}px`);
    style.setProperty("--cr-ctrl", `${Math.round(ctrl)}px`);
  }

  /** Draw the two bars where the game says they are. Called only when a value
   *  changes, not per frame. */
  setBars(power: number, slide: number): void {
    const set = (b: Bar, v: number) => {
      const pct = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
      if (b.fill.style.width !== pct) b.fill.style.width = pct;
      if (b.knob.style.left !== pct) b.knob.style.left = pct;
    };
    set(this.power, power);
    set(this.slide, (slide + 1) / 2);
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
    this.banner.className = `cr-banner${tone ? ` ${tone}` : ""}${text ? "" : " hidden"}`;
  }

  /** The line under the board that explains the controls. Shown while it is
   *  your shot and you have not started one, and never again once you have —
   *  a hint that stays up after you have understood it is clutter. */
  setHint(text: string): void {
    if (text === this.lastHint) return;
    this.lastHint = text;
    this.hint.textContent = text;
    this.hint.classList.toggle("hidden", !text);
  }

  setScore(light: number, dark: number): void {
    if (this.counts[0]) this.counts[0].textContent = String(light);
    if (this.counts[1]) this.counts[1].textContent = String(dark);
  }

  setSunk(seat: number, n: number): void {
    const el = this.cards.get(seat)?.querySelector<HTMLElement>(".cr-sunk");
    if (el) el.textContent = String(n);
  }

  /** They covered the queen — the one personal thing on a team scoreboard. */
  setQueen(seat: number, has: boolean): void {
    this.cards.get(seat)?.classList.toggle("queen", has);
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
   *  keeps a fourteen-second wait free. */
  setTurn(seat: number | null, remainingMs: number | null): void {
    for (const [s, card] of this.cards) {
      const active = s === seat;
      card.classList.toggle("turn", active);
      const bar = card.querySelector<HTMLElement>(".cr-timer i")!;
      if (!active || remainingMs === null || remainingMs <= 0) {
        bar.style.animation = "none";
        bar.style.transform = "scaleX(0)";
        continue;
      }
      // Restart the animation from the top: removing and re-adding it in one
      // go is the only reliable way to replay a CSS animation.
      bar.style.animation = "none";
      void bar.offsetWidth;
      bar.style.transform = "";
      bar.style.animation = `cr-timer ${Math.round(remainingMs)}ms linear forwards`;
    }
  }

  /** Someone said one of the fixed phrases. */
  say(seat: number, text: string): void {
    const card = this.cards.get(seat);
    if (!card) return;
    const bubble = card.querySelector<HTMLElement>(".cr-bubble")!;
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
