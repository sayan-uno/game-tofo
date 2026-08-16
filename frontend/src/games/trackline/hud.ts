// Trackline's in-match HUD: DOM, updated on change only (never per frame
// unless a value actually changed) — the compositor does the rest.
import type { RosterEntry } from "../../shared/core/protocol";

export class TracklineHud {
  private root: HTMLElement;
  private timerEl: HTMLElement;
  private rows = new Map<string, { el: HTMLElement; status: HTMLElement }>();
  private lastTimer = "";

  constructor(host: HTMLElement, roster: RosterEntry[], you: string) {
    this.root = document.createElement("div");
    this.root.className = "tl-hud";
    this.root.innerHTML = `
      <div class="tl-top">
        <div class="tl-timer">2:00</div>
      </div>
      <div class="tl-board"></div>
      <div class="tl-hint">Swipe or ← → to change lane</div>`;
    host.appendChild(this.root);
    this.timerEl = this.root.querySelector(".tl-timer")!;
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
      this.rows.set(r.uid, { el, status });
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
    if (!row) return;
    if (row.status.textContent !== text) row.status.textContent = text;
    row.el.classList.toggle("left", cls === "left");
    row.el.classList.toggle("out", cls === "out");
  }

  setEnded(): void {
    this.root.classList.add("ended");
  }

  dispose(): void {
    this.root.remove();
  }
}
