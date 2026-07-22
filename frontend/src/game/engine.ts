import { Engine } from "@babylonjs/core/Engines/engine";

/**
 * Engine setup tuned for smooth performance on any device:
 *  - high-performance GPU preference
 *  - hardware scaling capped so ultra-high-DPI phones don't render 4x pixels
 *  - render loop pauses when the tab is hidden (saves battery, keeps sockets alive)
 */
export function createEngine(canvas: HTMLCanvasElement): Engine {
  const engine = new Engine(canvas, true, {
    powerPreference: "high-performance",
    stencil: false,
    preserveDrawingBuffer: false,
    antialias: true,
  });

  // Cap effective resolution: rendering above 1.5x DPR is wasted work in a lobby.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  engine.setHardwareScalingLevel(1 / dpr);

  // Phones: a canvas tap must never synthesize "ghost" mouse events. Babylon
  // input + GUI run on real Pointer Events, so the compat mousedown/mouseup/
  // click that browsers fire AFTER touchend are pure hazard: any DOM overlay
  // a GUI tap opens (e.g. the member menu) mounts under the finger first,
  // catches that late click, and instantly closes ("flickers shut" bug).
  canvas.addEventListener(
    "touchend",
    (e) => {
      if (e.cancelable) e.preventDefault();
    },
    { passive: false }
  );

  window.addEventListener("resize", () => engine.resize());

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) engine.stopRenderLoop();
    else if (activeLoop) engine.runRenderLoop(activeLoop);
  });

  return engine;
}

let activeLoop: (() => void) | null = null;

export function startRenderLoop(engine: Engine, loop: () => void) {
  activeLoop = loop;
  engine.runRenderLoop(loop);
}
