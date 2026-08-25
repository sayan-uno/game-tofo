// The Dots & Boxes HUD: the player cards, how much of the board is gone, the
// line that says what just happened, the chat wheel, and the one control this
// game has.
//
// All of it is DOM rather than canvas, for the reason every 2D game here gives:
// text in an element scales with the reader's settings, can be read by a screen
// reader, and costs nothing per frame because none of it is repainted between
// the moments it actually changes. The turn clock is the clearest case — drawn
// on the canvas it would force a repaint every frame for twelve seconds at a
// time while nothing else moved.
//
// Cards are split across BOTH rails, half each. It is a free-for-all, so there
// is no side to put anybody on; splitting them keeps each card wide enough to
// hold a name at a readable size, and on a two-player board it puts the two of
// them either side of the grid like a scoreboard.
import { onTalkingChange } from "../../voice/livekit";
import { QUICK_CHAT, QUICK_EMOTE, type QuickKind } from "../../shared/core/protocol";
import { BOX_COUNT } from "../../shared/games/dots/index";
import { SEATS } from "./theme";

export interface HudSeat {
  seat: number;
  name: string;
  you: boolean;
  /** Matches the LiveKit participant identity, which is how the speaking
   *  indicator finds the right card. Absent for bots — they never talk. */
  uid?: string;
}

export interface HudDeps {
  root: HTMLElement;
  seats: HudSeat[];
  onQuick: (kind: QuickKind, id: string) => void;
  /** Draw the line the player has chosen. */
  onDraw: () => void;
  /** Nobody is playing — this is a replay. The control is not drawn at all: a
   *  watcher who can see a button will press it, and a replay somebody can
   *  appear to steer is not a replay. */
  spectator: boolean;
}

export class DotsHud {
  private cards = new Map<number, HTMLElement>();
  private banner: HTMLElement;
  private hint: HTMLElement;
  private wheel: HTMLElement;
  private quickBtn: HTMLButtonElement;
  private strip: HTMLElement;
  private drawBtn: HTMLButtonElement;
  private tally: HTMLElement;
  private bubbleTimers = new Map<number, number>();
  private lastBanner = "";
  private lastHint = "";
  private lastTally = "";
  private micOf = new Map<string, HTMLElement>();
  private untalk: (() => void) | null = null;

  constructor(private deps: HudDeps) {
    const half = Math.ceil(deps.seats.length / 2);
    for (const left of [true, false]) {
      const rail = document.createElement("div");
      rail.className = `dt-players ${left ? "dt-left" : "dt-right"}`;
      for (const s of deps.seats.filter((_, i) => (i < half) === left)) {
        const c = SEATS[s.seat % SEATS.length];
        const card = document.createElement("div");
        card.className = "dt-card";
        card.style.setProperty("--dt-c", c.main);
        card.style.setProperty("--dt-cl", c.light);
        card.innerHTML = `
          <span class="dt-dot"></span>
          <span class="dt-who"><span class="dt-name"></span><i class="dt-mic">🎙</i><span class="dt-boxes">0</span></span>
          <span class="dt-timer"><i></i></span>
          <span class="dt-bubble"></span>`;
        // A username is user input and never goes near innerHTML.
        card.querySelector<HTMLElement>(".dt-name")!.textContent = s.you ? `${s.name} (you)` : s.name;
        card.querySelector<HTMLElement>(".dt-boxes")!.title = "Boxes taken";
        rail.appendChild(card);
        this.cards.set(s.seat, card);
        if (s.uid) this.micOf.set(s.uid, card.querySelector<HTMLElement>(".dt-mic")!);
      }
      deps.root.appendChild(rail);
      if (left) this.ourRail = rail;
    }

    // Only while they are actually speaking — everyone's mic is on, so "mic on"
    // would light every card and mean nothing.
    this.untalk = onTalkingChange((uids) => {
      for (const [uid, mic] of this.micOf) {
        const talking = uids.has(uid);
        if (mic.classList.contains("live") !== talking) mic.classList.toggle("live", talking);
      }
    });

    // How much board is left. One number rather than four, because the four are
    // already on the cards and what a player cannot see from those is how near
    // the end they are.
    this.tally = document.createElement("div");
    this.tally.className = "dt-tally";
    deps.root.appendChild(this.tally);

    this.banner = document.createElement("div");
    this.banner.className = "dt-banner";
    this.ourRail.appendChild(this.banner);
    this.hint = document.createElement("div");
    this.hint.className = "dt-hint hidden";
    this.ourRail.appendChild(this.hint);

    this.strip = document.createElement("div");
    this.strip.className = `dt-strip${deps.spectator ? " watch" : ""}`;
    const say = document.createElement("span");
    say.className = "dt-picked";
    this.strip.appendChild(say);
    this.picked = say;
    this.drawBtn = document.createElement("button");
    this.drawBtn.type = "button";
    this.drawBtn.className = "dt-draw";
    this.drawBtn.textContent = "DRAW";
    this.drawBtn.disabled = true;
    this.drawBtn.onclick = () => deps.onDraw();
    this.strip.appendChild(this.drawBtn);
    deps.root.appendChild(this.strip);

    this.quickBtn = document.createElement("button");
    this.quickBtn.type = "button";
    this.quickBtn.className = "dt-quick-btn";
    this.quickBtn.textContent = "💬";
    this.quickBtn.setAttribute("aria-label", "Say something");
    deps.root.appendChild(this.quickBtn);

    this.wheel = document.createElement("div");
    this.wheel.className = "dt-wheel hidden";
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
    row.className = "dt-emotes";
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

  private ourRail!: HTMLElement;
  private picked!: HTMLElement;

  /** Where the chrome goes. Both numbers come from the LAYOUT — the same one
   *  that decided how much room the grid could have — so the two can never
   *  disagree about who owns the edges of the screen. */
  setFrame(rail: number, ctrl: number): void {
    const style = this.deps.root.style;
    style.setProperty("--dt-rail", `${Math.max(66, Math.round(rail))}px`);
    style.setProperty("--dt-ctrl", `${Math.round(ctrl)}px`);
  }

  setBanner(text: string, tone: "" | "good" | "bad" = ""): void {
    const key = `${tone}|${text}`;
    if (key === this.lastBanner) return;
    this.lastBanner = key;
    this.banner.textContent = text;
    this.banner.className = `dt-banner${tone ? ` ${tone}` : ""}${text ? "" : " hidden"}`;
  }

  /** The control hint, under the banner and only until the first line. */
  setHint(text: string): void {
    if (text === this.lastHint) return;
    this.lastHint = text;
    this.hint.textContent = text;
    this.hint.classList.toggle("hidden", !text);
  }

  setTally(claimed: number): void {
    const text = `${claimed} / ${BOX_COUNT} boxes taken`;
    if (text === this.lastTally) return;
    this.lastTally = text;
    this.tally.textContent = text;
  }

  setBoxes(seat: number, n: number, leading: boolean): void {
    const card = this.cards.get(seat);
    if (!card) return;
    const el = card.querySelector<HTMLElement>(".dt-boxes");
    // Written out in full rather than a number plus a CSS ::after, because the
    // word has to change with the number and a pseudo-element cannot count.
    if (el) el.textContent = `${n} box${n === 1 ? "" : "es"}`;
    card.classList.toggle("lead", leading);
  }

  setGone(seat: number, gone: boolean): void {
    this.cards.get(seat)?.classList.toggle("gone", gone);
  }

  /** Not waiting for this seat any more — its turns play themselves until its
   *  owner touches the screen. */
  setAway(seat: number, away: boolean): void {
    this.cards.get(seat)?.classList.toggle("away", away);
  }

  /** Whose turn it is, and how long they have left.
   *
   *  `remainingMs` starts one CSS animation and is then left to run; a null
   *  stops the clock. Called only when the turn actually changes, which is what
   *  keeps a twelve-second wait free. */
  setTurn(seat: number | null, remainingMs: number | null): void {
    for (const [s, card] of this.cards) {
      const active = s === seat;
      card.classList.toggle("turn", active);
      const bar = card.querySelector<HTMLElement>(".dt-timer i")!;
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
      bar.style.animation = `dt-timer ${Math.round(remainingMs)}ms linear forwards`;
    }
  }

  /** The one control: what has been chosen, and the button that plays it. */
  setPick(text: string, canDraw: boolean, live: boolean): void {
    if (this.deps.spectator) return;
    if (this.picked.textContent !== text) this.picked.textContent = text;
    this.strip.classList.toggle("off", !live);
    if (this.drawBtn.disabled === canDraw) this.drawBtn.disabled = !canDraw;
    this.drawBtn.classList.toggle("ready", canDraw);
  }

  /** Someone said one of the fixed phrases. */
  say(seat: number, text: string): void {
    const card = this.cards.get(seat);
    if (!card) return;
    const bubble = card.querySelector<HTMLElement>(".dt-bubble")!;
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
