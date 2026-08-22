// Trackline's in-match HUD: DOM, updated on change only (never per frame
// unless a value actually changed) — the compositor does the rest.
import { QUICK_CHAT, QUICK_EMOTE, type QuickKind, type RosterEntry } from "../../shared/core/protocol";
import { onTalkingChange } from "../../voice/livekit";

export class TracklineHud {
  private root: HTMLElement;
  private timerEl: HTMLElement;
  private scoreEl: HTMLElement;
  private coinsEl: HTMLElement;
  private rows = new Map<string, { el: HTMLElement; status: HTMLElement; last: string; mic: HTMLElement }>();
  private untalk: (() => void) | null = null;
  private flashEl!: HTMLElement;
  private spectateEl!: HTMLElement;
  private watchingEl!: HTMLElement;
  private wheelEl!: HTMLElement;
  private sayBtn!: HTMLButtonElement;
  private flashTimer: number | null = null;
  private lastTimer = "";
  private lastScore = -1;
  private lastCoins = -1;

  constructor(host: HTMLElement, roster: RosterEntry[], you: string) {
    this.root = document.createElement("div");
    this.root.className = "tl-hud";
    this.root.innerHTML = `
      <div class="tl-top">
        <div class="tl-timer">2:00</div>
        <div class="tl-score"><span class="tl-score-n">0</span><span class="tl-coins">🪙 <span class="tl-coins-n">0</span></span></div>
      </div>
      <div class="tl-board"></div>
      <div class="tl-flash" aria-live="polite"></div>
      <div class="tl-spectate" hidden>SPECTATING <b class="tl-watching"></b><span class="tl-spectate-hint">← → to switch</span></div>
      <div class="tl-say">
        <button class="tl-say-btn" type="button" aria-label="Quick chat">💬</button>
        <div class="tl-wheel" hidden></div>
      </div>
      <div class="tl-hint">Swipe or ← → to change lane · up to jump · down to roll</div>`;
    host.appendChild(this.root);
    this.timerEl = this.root.querySelector(".tl-timer")!;
    this.flashEl = this.root.querySelector(".tl-flash")!;
    this.spectateEl = this.root.querySelector(".tl-spectate")!;
    this.watchingEl = this.root.querySelector(".tl-watching")!;
    this.buildWheel();
    this.scoreEl = this.root.querySelector(".tl-score-n")!;
    this.coinsEl = this.root.querySelector(".tl-coins-n")!;
    const board = this.root.querySelector<HTMLElement>(".tl-board")!;
    for (const r of roster) {
      const el = document.createElement("div");
      el.className = `tl-row${r.uid === you ? " me" : ""}`;
      // A microphone that shows only while they are actually talking. During
      // a match this is the only way to tell who is speaking — everyone's
      // mic is on, so "mic on" would light the whole board and say nothing.
      const mic = document.createElement("i");
      mic.className = "tl-mic";
      mic.textContent = "🎙";
      const name = document.createElement("span");
      name.className = "tl-name";
      name.textContent = r.name;
      const status = document.createElement("span");
      status.className = "tl-status";
      status.textContent = "";
      el.append(mic, name, status);
      board.appendChild(el);
      this.rows.set(r.uid, { el, status, last: "", mic });
    }

    // Event-driven, never per frame: LiveKit tells every client at once, so
    // the whole table sees the same person light up at the same moment.
    this.untalk = onTalkingChange((uids) => {
      for (const [uid, row] of this.rows) {
        const talking = uids.has(uid);
        if (row.mic.classList.contains("live") !== talking) row.mic.classList.toggle("live", talking);
      }
    });
  }

  /** Seconds remaining → "m:ss"; repaints only when the text changes. */
  setRemaining(seconds: number): void {
    const s = Math.max(0, Math.ceil(seconds));
    const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (text === this.lastTimer) return;
    this.lastTimer = text;
    this.timerEl.textContent = text;
    this.timerEl.classList.toggle("urgent", s <= 10);
  }

  setStatus(uid: string, text: string, cls?: "left" | "out"): void {
    const row = this.rows.get(uid);
    if (!row || row.last === text + (cls ?? "")) return;
    row.last = text + (cls ?? "");
    row.status.textContent = text;
    row.el.classList.toggle("left", cls === "left");
    row.el.classList.toggle("out", cls === "out");
  }

  /** The local player's own score and coin count, big and central. */
  setScore(score: number, coins: number, alive: boolean): void {
    if (score !== this.lastScore) {
      this.lastScore = score;
      this.scoreEl.textContent = String(score);
    }
    if (coins !== this.lastCoins) {
      this.lastCoins = coins;
      this.coinsEl.textContent = String(coins);
    }
    this.root.classList.toggle("dead", !alive);
  }

  /** A short shout in the middle of the screen: near miss, roof run, coins.
   *
   *  Replaces whatever is already showing rather than queueing. During a run
   *  these arrive in bursts, and a queue would still be spelling out the first
   *  one several seconds after the moment it described had passed. */
  flash(text: string, kind: "near" | "roof" | "coin" = "near"): void {
    this.flashEl.textContent = text;
    this.flashEl.className = `tl-flash show ${kind}`;
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashEl.className = "tl-flash";
      this.flashTimer = null;
    }, 900);
  }

  /** Who the camera is following now that you are out — or null while alive. */
  setSpectating(name: string | null): void {
    this.spectateEl.hidden = name === null;
    if (name !== null && this.watchingEl.textContent !== name) this.watchingEl.textContent = name;
  }

  /** Called when the local player picks a phrase or an emote. */
  onSay: ((kind: QuickKind, id: string) => void) | null = null;

  private buildWheel(): void {
    this.sayBtn = this.root.querySelector(".tl-say-btn")!;
    this.wheelEl = this.root.querySelector(".tl-wheel")!;
    for (const e of QUICK_EMOTE) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tl-wheel-emote";
      b.textContent = e;
      b.onclick = () => this.pick("emote", e);
      this.wheelEl.appendChild(b);
    }
    for (const q of QUICK_CHAT) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tl-wheel-chat";
      // textContent, never innerHTML — even for our own strings, so this stays
      // safe the day the list becomes data.
      b.textContent = q.text;
      b.onclick = () => this.pick("chat", q.id);
      this.wheelEl.appendChild(b);
    }
    this.sayBtn.onclick = () => {
      this.wheelEl.hidden = !this.wheelEl.hidden;
      this.sayBtn.classList.toggle("open", !this.wheelEl.hidden);
    };
  }

  private pick(kind: QuickKind, id: string): void {
    this.wheelEl.hidden = true;
    this.sayBtn.classList.remove("open");
    this.onSay?.(kind, id);
  }

  setEnded(): void {
    this.root.classList.add("ended");
    this.setSpectating(null);
  }

  dispose(): void {
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.untalk?.();
    this.untalk = null;
    this.root.remove();
  }
}
