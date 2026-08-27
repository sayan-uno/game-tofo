// Walking about, on a phone and on a keyboard.
//
// Three inputs and no menus: a stick you drag to walk, a RUN button, and a
// drag anywhere else to look around. Everything is read once a frame — nothing
// here allocates, and nothing here decides anything, so the runtime can throw
// the whole object away when the world closes.
//
// TWO PHONE TRAPS ARE CLOSED HERE, both of them things that only ever show up
// on a real handset:
//
//   GHOST CLICKS. A touch on the canvas synthesises a mouse event a moment
//   later. Left alone it lands on whatever DOM has since appeared under the
//   finger — a player card, the leave button — so the touch that ended a drag
//   presses something. `touchend` is cancelled on the canvas to stop it.
//
//   THE OVERLAY THAT EATS TOUCHES. `#ui-root > *` sets pointer-events: auto
//   with an id's specificity, and the game's HUD root passes it to its own
//   children. A full-screen div for the stick's artwork would therefore
//   swallow every touch meant for the canvas. The artwork sets
//   pointer-events: none INLINE, which no selector can lose to.
import { RUN_SPEED, WALK_SPEED } from "../../shared/games/social/index";

/** Pixels of drag for a full-speed push. */
const STICK_R = 62;
/** Below this the stick is treated as centred — thumbs rest, they do not
 *  return to exactly where they started. */
const DEAD = 0.16;
/** How much of the screen's width belongs to the stick. */
const STICK_ZONE = 0.46;
/** Radians of camera yaw per pixel dragged. */
const LOOK_X = 0.0055;
const LOOK_Y = 0.0032;
const PITCH_MIN = -0.22;
const PITCH_MAX = 0.62;

export interface MoveRead {
  /** Camera-relative, already normalised: x is right, z is forward. */
  x: number;
  z: number;
  /** Metres per second the stick is asking for. */
  speed: number;
  running: boolean;
}

export class Controls {
  yaw = 0;
  pitch = 0.18;
  distance = 6.2;

  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private look: { id: number; x: number; y: number } | null = null;
  private keys = new Set<string>();
  private runOn = false;
  private readonly out: MoveRead = { x: 0, z: 0, speed: 0, running: false };
  private base: HTMLElement;
  private knob: HTMLElement;
  private onRun: (on: boolean) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
    startYaw: number
  ) {
    this.yaw = startYaw;
    const wrap = document.createElement("div");
    wrap.className = "sx-stick";
    // Inline, deliberately — see the header. This must never take a touch.
    wrap.style.pointerEvents = "none";
    wrap.innerHTML = `<div class="sx-stick-base"></div><div class="sx-stick-knob"></div>`;
    hudRoot.appendChild(wrap);
    this.base = wrap;
    this.knob = wrap.querySelector<HTMLElement>(".sx-stick-knob")!;

    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    window.addEventListener("pointercancel", this.up);
    canvas.addEventListener("touchend", this.noGhost, { passive: false });
    window.addEventListener("keydown", this.key);
    window.addEventListener("keyup", this.key);
    canvas.addEventListener("wheel", this.wheel, { passive: true });
  }

  /** Told when RUN flips, so the button can paint itself. */
  watchRun(fn: (on: boolean) => void): void {
    this.onRun = fn;
    fn(this.runOn);
  }

  toggleRun(): void {
    this.runOn = !this.runOn;
    this.onRun(this.runOn);
  }

  /** True while a finger is on the stick — the runtime uses it to decide
   *  whether a tap was a tap or the end of a drag. */
  get steering(): boolean {
    return this.stick !== null;
  }

  /** When the player last aimed the camera themselves, and whether they are
   *  doing it now. The camera settles behind a moving player on its own — see
   *  the runtime — and it must not fight a thumb that is deliberately looking
   *  somewhere else. */
  lookedAt = 0;
  get looking(): boolean {
    return this.look !== null;
  }

  private noGhost = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault();
  };

  private down = (e: PointerEvent): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const left = e.clientX < w * STICK_ZONE;
    if (left && !this.stick) {
      // The stick appears WHERE THE THUMB LANDS rather than at a fixed spot: a
      // fixed base means finding it first, and on a phone that is the
      // difference between walking and hunting for a control.
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      this.base.classList.add("on");
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.knob.style.transform = "translate(-50%, -50%)";
    } else if (!this.look) {
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.lookedAt = Date.now();
    }
  };

  private move = (e: PointerEvent): void => {
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
      const dx = this.stick.x - this.stick.ox;
      const dy = this.stick.y - this.stick.oy;
      const len = Math.hypot(dx, dy);
      const k = len > STICK_R ? STICK_R / len : 1;
      this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
      return;
    }
    if (this.look && e.pointerId === this.look.id) {
      this.yaw -= (e.clientX - this.look.x) * LOOK_X;
      this.pitch = clamp(this.pitch + (e.clientY - this.look.y) * LOOK_Y, PITCH_MIN, PITCH_MAX);
      this.look.x = e.clientX;
      this.look.y = e.clientY;
      this.lookedAt = Date.now();
    }
  };

  private up = (e: PointerEvent): void => {
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
      this.base.classList.remove("on");
    }
    if (this.look && e.pointerId === this.look.id) {
      this.look = null;
      this.lookedAt = Date.now();
    }
  };

  private key = (e: KeyboardEvent): void => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === "keydown") {
      if (k === "Shift") {
        this.runOn = true;
        this.onRun(true);
      }
      this.keys.add(k);
    } else {
      if (k === "Shift") {
        this.runOn = false;
        this.onRun(false);
      }
      this.keys.delete(k);
    }
  };

  private wheel = (e: WheelEvent): void => {
    this.distance = clamp(this.distance + Math.sign(e.deltaY) * 0.6, 3.2, 11);
  };

  /** What the player is asking for this frame. Returns a SHARED object. */
  read(): MoveRead {
    let x = 0;
    let z = 0;
    if (this.stick) {
      const dx = this.stick.x - this.stick.ox;
      // Screen Y grows downward; forward is up the screen.
      const dy = -(this.stick.y - this.stick.oy);
      x = dx / STICK_R;
      z = dy / STICK_R;
    }
    if (this.keys.has("w") || this.keys.has("ArrowUp")) z += 1;
    if (this.keys.has("s") || this.keys.has("ArrowDown")) z -= 1;
    if (this.keys.has("d") || this.keys.has("ArrowRight")) x += 1;
    if (this.keys.has("a") || this.keys.has("ArrowLeft")) x -= 1;
    const len = Math.hypot(x, z);
    if (len < DEAD) {
      this.out.x = 0;
      this.out.z = 0;
      this.out.speed = 0;
      this.out.running = false;
      return this.out;
    }
    const k = Math.min(1, len) / len;
    this.out.x = x * k;
    this.out.z = z * k;
    // A stick pushed halfway walks slowly; RUN is what gets you across the
    // island. The keyboard is always full push, so Shift is its only gear.
    const push = Math.min(1, len);
    this.out.running = this.runOn && push > 0.5;
    this.out.speed = (this.out.running ? RUN_SPEED : WALK_SPEED) * push;
    return this.out;
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerup", this.up);
    window.removeEventListener("pointercancel", this.up);
    this.canvas.removeEventListener("touchend", this.noGhost);
    window.removeEventListener("keydown", this.key);
    window.removeEventListener("keyup", this.key);
    this.canvas.removeEventListener("wheel", this.wheel);
    this.base.remove();
  }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
