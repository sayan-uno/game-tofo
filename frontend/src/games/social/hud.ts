// The island's own chrome: a clock, who can hear you, and the two buttons.
//
// Everything here is a DIRECT child of the game's HUD root, and that is not a
// styling preference — `.match-hud-root > *` turns pointer events ON for its
// children, so a full-screen wrapper would quietly swallow every touch meant
// for the canvas underneath. Buttons are buttons; the stick's artwork (in
// controls.ts) opts out inline.
//
// Nothing repaints on a timer it does not need: the clock ticks once a second,
// the earshot count only when the number changes.
import { QUICK_EMOTE } from "../../shared/core/protocol";
import { getPerformableEmotes } from "../../game/assets";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface HudHooks {
  onRun(): void;
  onEmote(id: string): void;
  onQuick(id: string): void;
  onPeople(): void;
  /** The dial was tapped — open the whole island. */
  onMap(): void;
}

export class SocialHud {
  private bar: HTMLElement;
  private runBtn: HTMLButtonElement;
  private emoteBtn: HTMLButtonElement;
  private sheet: HTMLElement | null = null;
  private closing: HTMLElement | null = null;
  private people: HTMLElement | null = null;
  private clockEl: HTMLElement;
  private mapBtn: HTMLElement;
  private mapCanvas: HTMLCanvasElement;
  private whereEl: HTMLElement;
  private lastWhere = "";
  private fullMap: HTMLElement | null = null;
  private nearEl: HTMLElement;
  private lastClock = "";
  private lastNear = -1;

  constructor(
    private root: HTMLElement,
    private hooks: HudHooks
  ) {
    const bar = document.createElement("div");
    bar.className = "sx-bar";
    bar.innerHTML = `
      <button class="sx-people" type="button" aria-label="Who is here">
        <span class="sx-near">0</span><span class="sx-near-label">in earshot</span>
      </button>
      <div class="sx-clock" aria-label="Time left on this island">40:00</div>`;
    root.appendChild(bar);
    this.bar = bar;
    this.clockEl = bar.querySelector<HTMLElement>(".sx-clock")!;
    this.nearEl = bar.querySelector<HTMLElement>(".sx-near")!;
    bar.querySelector<HTMLButtonElement>(".sx-people")!.onclick = () => hooks.onPeople();

    // The dial. Its own direct child of the HUD root, because it is tapped —
    // see the note at the top about what a full-bleed wrapper would do to the
    // touches meant for the canvas.
    const map = document.createElement("button");
    map.className = "sx-minimap";
    map.type = "button";
    map.setAttribute("aria-label", "Map");
    map.innerHTML = `<canvas></canvas><span class="sx-where"></span>`;
    root.appendChild(map);
    this.mapBtn = map;
    this.mapCanvas = map.querySelector<HTMLCanvasElement>("canvas")!;
    this.whereEl = map.querySelector<HTMLElement>(".sx-where")!;
    map.onclick = () => hooks.onMap();

    const pad = document.createElement("div");
    pad.className = "sx-pad";
    pad.innerHTML = `
      <button class="sx-btn sx-emote" type="button" aria-label="Emote">😀</button>
      <button class="sx-btn sx-run" type="button" aria-label="Run">RUN</button>`;
    root.appendChild(pad);
    this.emoteBtn = pad.querySelector<HTMLButtonElement>(".sx-emote")!;
    this.runBtn = pad.querySelector<HTMLButtonElement>(".sx-run")!;
    this.runBtn.onclick = () => hooks.onRun();
    this.emoteBtn.onclick = () => this.openSheet();
  }

  /** The dial's canvas, for whoever is drawing it. */
  get minimap(): HTMLCanvasElement {
    return this.mapCanvas;
  }

  /** The name of the place under the player — printed under the dial, because
   *  "The Bandstand" is an answer to "where are you" and a pair of
   *  coordinates is not. */
  setWhere(place: string): void {
    if (place === this.lastWhere) return;
    this.lastWhere = place;
    this.whereEl.textContent = place;
  }

  /** The whole island, over everything. `paint` is handed the canvas each time
   *  it needs redrawing — which is on open and then once a second, because a
   *  map is read rather than watched. */
  showMap(
    paint: (canvas: HTMLCanvasElement) => void,
    tap?: (canvas: HTMLCanvasElement, clientX: number, clientY: number) => void
  ): void {
    if (this.fullMap) return;
    const el = document.createElement("div");
    el.className = "sx-sheet sx-map-sheet";
    el.innerHTML = `
      <div class="sx-sheet-card sx-map-card">
        <header><span class="sx-kicker">// The island</span><h3>MAP</h3>
          <button class="sx-close" type="button" aria-label="Close">✕</button></header>
        <div class="sx-map-wrap"><canvas></canvas></div>
        <p class="sx-map-key">
          <span class="sx-dot me"></span> you ·
          <span class="sx-dot squad"></span> your group, by number ·
          <span class="sx-dot friend"></span> friends ·
          <span class="sx-dot near"></span> within earshot ·
          <span class="sx-dot other"></span> everyone else
        </p>
        <p class="sx-map-key sx-map-hint">tap the island to mark a spot for your group</p>
      </div>`;
    this.root.appendChild(el);
    this.fullMap = el;
    const canvas = el.querySelector<HTMLCanvasElement>("canvas")!;
    const close = () => {
      window.clearInterval(timer);
      el.remove();
      if (this.fullMap === el) this.fullMap = null;
    };
    el.querySelector<HTMLButtonElement>(".sx-close")!.onclick = close;
    el.onclick = (e) => {
      if (e.target === el) close();
    };
    if (tap) {
      // Pointer, not click: on a phone a click arrives ~300 ms late and after
      // a synthesized mouse event we would then have to swallow.
      canvas.style.cursor = "crosshair";
      canvas.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        tap(canvas, e.clientX, e.clientY);
        // Repaint at once — a mark that appears a second later reads as a
        // tap that missed.
        paint(canvas);
      });
    }
    // One frame now, then once a second. Nobody walks far enough between
    // seconds for a map at this scale to notice.
    requestAnimationFrame(() => paint(canvas));
    const timer = window.setInterval(() => {
      if (!el.isConnected) return window.clearInterval(timer);
      paint(canvas);
    }, 1000);
  }

  setRunning(on: boolean): void {
    this.runBtn.classList.toggle("on", on);
  }

  /** Milliseconds left before the island closes. */
  setClock(ms: number): void {
    const total = Math.max(0, Math.round(ms / 1000));
    const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    if (text === this.lastClock) return;
    this.lastClock = text;
    this.clockEl.textContent = text;
    this.clockEl.classList.toggle("soon", total <= 60);
  }

  setNear(n: number): void {
    if (n === this.lastNear) return;
    this.lastNear = n;
    this.nearEl.textContent = String(n);
    this.bar.querySelector<HTMLElement>(".sx-people")!.classList.toggle("alone", n === 0);
  }

  /** The five seconds before everybody goes home. Deliberately unmissable —
   *  it is the only thing on this island that happens TO a player. */
  showClosing(secondsLeft: () => number): void {
    if (this.closing) return;
    const el = document.createElement("div");
    el.className = "sx-closing";
    el.innerHTML = `<div class="sx-closing-n"></div><div class="sx-closing-t">The island is closing</div>`;
    this.root.appendChild(el);
    this.closing = el;
    const num = el.querySelector<HTMLElement>(".sx-closing-n")!;
    let shown = "";
    const tick = () => {
      if (!this.closing) return;
      const n = Math.max(0, Math.ceil(secondsLeft()));
      const text = n > 0 ? String(n) : "";
      if (text !== shown) {
        shown = text;
        num.textContent = text;
        num.classList.remove("pop");
        void num.offsetWidth;
        num.classList.add("pop");
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  /** Who is standing near you, nearest first. Rebuilt on open only. */
  showPeople(rows: { name: string; metres: number; heard: boolean }[]): void {
    this.people?.remove();
    const el = document.createElement("div");
    el.className = "sx-sheet sx-people-sheet";
    el.innerHTML = `
      <div class="sx-sheet-card">
        <header><span class="sx-kicker">// Nearby</span><h3>WHO IS HERE</h3>
          <button class="sx-close" type="button" aria-label="Close">✕</button></header>
        ${
          rows.length === 0
            ? `<p class="sx-empty">Nobody within earshot. Walk over to somebody — you can hear anyone within 20 m.</p>`
            : `<ul class="sx-people-list">${rows
                .map(
                  (r) =>
                    `<li${r.heard ? ' class="heard"' : ""}><span class="sx-pn">${esc(r.name)}</span><span class="sx-pd">${Math.round(r.metres)} m</span></li>`
                )
                .join("")}</ul>`
        }
      </div>`;
    this.root.appendChild(el);
    this.people = el;
    const close = () => {
      el.remove();
      if (this.people === el) this.people = null;
    };
    el.querySelector<HTMLButtonElement>(".sx-close")!.onclick = close;
    el.onclick = (e) => {
      if (e.target === el) close();
    };
  }

  /** The emote sheet: whatever this player owns, plus the six emoji everybody
   *  has. Two rows rather than two menus — the emoji are what somebody with no
   *  microphone actually uses, and burying them would be burying the whole
   *  conversation for that player. */
  private openSheet(): void {
    if (this.sheet) return;
    const owned = getPerformableEmotes();
    const el = document.createElement("div");
    el.className = "sx-sheet";
    el.innerHTML = `
      <div class="sx-sheet-card">
        <header><span class="sx-kicker">// Say something</span><h3>EMOTES</h3>
          <button class="sx-close" type="button" aria-label="Close">✕</button></header>
        <div class="sx-quick">${QUICK_EMOTE.map((e) => `<button type="button" data-q="${esc(e)}">${e}</button>`).join("")}</div>
        ${
          owned.length === 0
            ? `<p class="sx-empty">No emotes equipped yet. Anything you unlock in Collections shows up here.</p>`
            : `<div class="sx-emotes">${owned
                .map(
                  (e) =>
                    `<button type="button" data-e="${esc(e.id)}"><span class="sx-em-name">${esc(e.name)}</span><span class="sx-em-len">${e.duration.toFixed(1)}s</span></button>`
                )
                .join("")}</div>`
        }
      </div>`;
    this.root.appendChild(el);
    this.sheet = el;
    const close = () => {
      el.remove();
      if (this.sheet === el) this.sheet = null;
    };
    el.querySelector<HTMLButtonElement>(".sx-close")!.onclick = close;
    el.onclick = (e) => {
      if (e.target === el) close();
    };
    el.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => {
      b.onclick = () => {
        close();
        this.hooks.onQuick(b.dataset.q!);
      };
    });
    el.querySelectorAll<HTMLButtonElement>("[data-e]").forEach((b) => {
      b.onclick = () => {
        // Close FIRST: the point of an emote is watching it, and a menu over
        // the character is the one thing guaranteed to be in the way.
        close();
        this.hooks.onEmote(b.dataset.e!);
      };
    });
  }

  dispose(): void {
    this.fullMap?.remove();
    this.mapBtn.remove();
    this.closing?.remove();
    this.closing = null;
    this.sheet?.remove();
    this.people?.remove();
    this.bar.remove();
    this.runBtn.parentElement?.remove();
  }
}
