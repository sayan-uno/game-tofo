// Trackline's in-match HUD: DOM, updated on change only (never per frame
// unless a value actually changed) — the compositor does the rest.
import type { RosterEntry } from "../../shared/core/protocol";

export class TracklineHud {
  private root: HTMLElement;
  private timerEl: HTMLElement;
  private scoreEl: HTMLElement;
  private coinsEl: HTMLElement;
  private rows = new Map<string, { el: HTMLElement; status: HTMLElement; last: string }>();
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
      <div class="tl-hint">Swipe or ← → to change lane · up to jump · down to roll</div>`;
    host.appendChild(this.root);
    this.timerEl = this.root.querySelector(".tl-timer")!;
    this.scoreEl = this.root.querySelector(".tl-score-n")!;
    this.coinsEl = this.root.querySelector(".tl-coins-n")!;
    const board = this.root.querySelector<HTMLElement>(".tl-board")!;
    for (const r of roster) {
      const el = document.createElement("div");
      el.className = `tl-row${r.uid === you ? " me" : ""}`;
      const name = document.createElement("span");
      name.className = "tl-name";
      name.textContent = r.name;
      const status = document.createElement("span");
      status.className = "tl-status";
      status.textContent = "";
      el.append(name, status);
      board.appendChild(el);
      this.rows.set(r.uid, { el, status, last: "" });
    }
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

  setEnded(): void {
    this.root.classList.add("ended");
  }

  dispose(): void {
    this.root.remove();
  }
}
