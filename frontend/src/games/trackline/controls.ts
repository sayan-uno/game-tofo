// Input: keys on desktop, swipes on touch. Emits one of the four sim inputs;
// the runtime stamps the tick. Attached to the canvas only while a match runs
// and removed on dispose, so the lobby's own pointer handling is untouched.
//
// The swipe fires the moment the finger crosses the threshold, NOT on lift.
// Two reasons: a runner has to react while the thumb is still moving (waiting
// for pointerup reads as "the game ignored me"), and a gesture the browser
// cancels mid-way never delivers an up at all.
//
// ONE input per gesture, however far the finger travels. An earlier cut
// re-armed after each threshold crossing so a long drag could cross two
// lanes; a single ordinary flick then fired six times and threw the runner
// straight into the outer rail. Two lanes = two swipes, as in every game of
// this kind.
import type { InputKind } from "../../shared/games/trackline/sim";

/** Minimum swipe travel, in CSS px, before a gesture counts. */
const SWIPE_PX = 26;

interface Gesture {
  id: number;
  x: number;
  y: number;
  /** Set once this gesture has produced its input; further movement is part
   *  of the same flick and must not fire again. */
  fired: boolean;
}

export class Controls {
  private gesture: Gesture | null = null;

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const kind = keyToInput(e.key);
    if (!kind) return;
    e.preventDefault();
    this.emit(kind);
  };

  private onDown = (e: PointerEvent) => {
    if (this.gesture) return; // one finger at a time
    this.gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false };
  };

  private onMove = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g || g.fired || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dx) < SWIPE_PX && Math.abs(dy) < SWIPE_PX) return;
    g.fired = true;
    if (Math.abs(dx) >= Math.abs(dy)) this.emit(dx < 0 ? "left" : "right");
    else this.emit(dy < 0 ? "jump" : "roll");
  };

  /** Ends the gesture however it finishes — lifted, cancelled, or lost off
   *  the canvas (hence the window-level listeners). */
  private onEnd = (e: PointerEvent) => {
    if (this.gesture && e.pointerId === this.gesture.id) this.gesture = null;
  };

  constructor(
    private canvas: HTMLCanvasElement,
    private emit: (kind: InputKind) => void
  ) {
    window.addEventListener("keydown", this.onKey);
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onEnd);
    window.addEventListener("pointercancel", this.onEnd);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onEnd);
    window.removeEventListener("pointercancel", this.onEnd);
  }
}

function keyToInput(key: string): InputKind | null {
  switch (key) {
    case "ArrowLeft":
    case "a":
    case "A":
      return "left";
    case "ArrowRight":
    case "d":
    case "D":
      return "right";
    case "ArrowUp":
    case "w":
    case "W":
    case " ":
      return "jump";
    case "ArrowDown":
    case "s":
    case "S":
      return "roll";
    default:
      return null;
  }
}
