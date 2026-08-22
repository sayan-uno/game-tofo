// The Ludo HUD: the player cards, the line that says what is happening, and
// the quick-chat wheel.
//
// All of it is DOM rather than canvas, and deliberately so. Text drawn into a
// canvas has to be laid out by hand, does not scale with the reader's settings,
// cannot be selected and is invisible to a screen reader; text in an element is
// all of those things for free and costs nothing per frame, because none of it
// is repainted between the moments it actually changes.
//
// The turn clock is the clearest case. Drawn on the canvas it would force a
// repaint every frame of every turn, for ten seconds at a time, on a screen
// where nothing else was moving. Here it is one CSS animation, set once when
// the turn begins and left alone.
import { onTalkingChange } from "../../voice/livekit";
import { QUICK_CHAT, QUICK_EMOTE, type QuickKind } from "../../shared/core/protocol";
import { PALETTE } from "./theme";

export interface HudSeat {
  seat: number;
  corner: number;
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
}

export class LudoHud {
  private cards = new Map<number, HTMLElement>();
  private banner: HTMLElement;
  private wheel: HTMLElement;
  private quickBtn: HTMLButtonElement;
  private bubbleTimers = new Map<number, number>();
  private lastBanner = "";
  private micOf = new Map<string, HTMLElement>();
  private untalk: (() => void) | null = null;

  constructor(private deps: HudDeps) {
    const rail = document.createElement("div");
    rail.className = "ld-players";
    for (const s of deps.seats) {
      const p = PALETTE[s.corner];
      const card = document.createElement("div");
      card.className = "ld-card";
      card.style.setProperty("--ld-c", p.main);
      card.style.setProperty("--ld-cl", p.light);
      card.innerHTML = `
        <span class="ld-dot"></span>
        <span class="ld-who"><span class="ld-name"></span><i class="ld-mic">🎙</i><span class="ld-home">0/4</span></span>
        <span class="ld-timer"><i></i></span>
        <span class="ld-bubble"></span>`;
      // A username is user input and never goes near innerHTML.
      card.querySelector<HTMLElement>(".ld-name")!.textContent = s.you ? `${s.name} (you)` : s.name;
      rail.appendChild(card);
      this.cards.set(s.seat, card);
      if (s.uid) this.micOf.set(s.uid, card.querySelector<HTMLElement>(".ld-mic")!);
    }
    // Only while they are actually speaking — everyone's mic is on, so
    // "mic on" would light every card and mean nothing.
    this.untalk = onTalkingChange((uids) => {
      for (const [uid, mic] of this.micOf) {
        const talking = uids.has(uid);
        if (mic.classList.contains("live") !== talking) mic.classList.toggle("live", talking);
      }
    });
    deps.root.appendChild(rail);

    this.banner = document.createElement("div");
    this.banner.className = "ld-banner";
    deps.root.appendChild(this.banner);

    this.quickBtn = document.createElement("button");
    this.quickBtn.type = "button";
    this.quickBtn.className = "ld-quick-btn";
    this.quickBtn.textContent = "💬";
    this.quickBtn.setAttribute("aria-label", "Say something");
    deps.root.appendChild(this.quickBtn);

    this.wheel = document.createElement("div");
    this.wheel.className = "ld-wheel hidden";
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
    row.className = "ld-emotes";
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

  /** The rails either side of the board, and the dice sitting in the right one,
   *  so the cards and the status line place themselves BESIDE the board rather
   *  than over it — a pill floating across the bottom arm can hide a token, and
   *  the rail beside the dice was empty anyway. */
  setRails(rail: number, die: number): void {
    const style = this.deps.root.style;
    style.setProperty("--ld-rail", `${Math.max(72, rail)}px`);
    style.setProperty("--ld-die", `${Math.round(die)}px`);
  }

  setBanner(text: string, tone: "" | "good" | "bad" = ""): void {
    const key = `${tone}|${text}`;
    if (key === this.lastBanner) return;
    this.lastBanner = key;
    this.banner.textContent = text;
    this.banner.className = `ld-banner${tone ? ` ${tone}` : ""}${text ? "" : " hidden"}`;
  }

  setHome(seat: number, home: number): void {
    const el = this.cards.get(seat)?.querySelector<HTMLElement>(".ld-home");
    if (el) el.textContent = `${home}/4`;
  }

  setFinished(seat: number, place: number | null): void {
    const card = this.cards.get(seat);
    if (!card) return;
    card.classList.toggle("done", place !== null);
    const el = card.querySelector<HTMLElement>(".ld-home");
    if (el && place !== null) el.textContent = place === 1 ? "🏆 1st" : `#${place}`;
  }

  setGone(seat: number, gone: boolean): void {
    this.cards.get(seat)?.classList.toggle("gone", gone);
  }

  /** Not waiting for this seat any more — its turns play themselves until its
   *  owner touches the screen. */
  setAway(seat: number, away: boolean): void {
    const card = this.cards.get(seat);
    if (!card) return;
    card.classList.toggle("away", away);
  }

  /** Whose turn it is, and how long they have left.
   *
   *  `remainingMs` starts one CSS animation and is then left to run; passing a
   *  null stops the clock. Called only when the turn actually changes, which is
   *  what keeps a ten-second wait free. */
  setTurn(seat: number | null, remainingMs: number | null): void {
    for (const [s, card] of this.cards) {
      const active = s === seat;
      card.classList.toggle("turn", active);
      const bar = card.querySelector<HTMLElement>(".ld-timer i")!;
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
      bar.style.animation = `ld-timer ${Math.round(remainingMs)}ms linear forwards`;
    }
  }

  /** Someone said one of the fixed phrases. */
  say(seat: number, text: string): void {
    const card = this.cards.get(seat);
    if (!card) return;
    const bubble = card.querySelector<HTMLElement>(".ld-bubble")!;
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
