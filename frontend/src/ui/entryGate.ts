/**
 * Mobile game-entry gate: fullscreen + landscape, PUBG/Free Fire style.
 *
 * Browsers only allow requestFullscreen() and screen.orientation.lock() inside
 * a user gesture, and the Google sign-in popup's click doesn't count for our
 * page — so phones get a one-tap "TAP TO ENTER" gate right after auth. The tap
 * is the gesture that flips the device into fullscreen landscape.
 *
 * Desktop (fine pointer) skips the gate entirely.
 */

const isTouchDevice = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/** Fullscreen + landscape lock. Each step degrades gracefully:
 *  iPhone < iOS 16.4 has no element fullscreen, Safari never allows lock —
 *  there the CSS #rotate-overlay asks the player to physically rotate. */
async function enterImmersive(): Promise<void> {
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch {
    /* denied or unsupported — playable in-browser regardless */
  }
  try {
    // TS lib.dom dropped lock() typings (Safari lacks it), hence the cast.
    const orientation = screen.orientation as unknown as {
      lock?: (o: string) => Promise<void>;
    };
    if (orientation?.lock) await orientation.lock("landscape");
  } catch {
    /* Safari/desktop: lock unavailable — rotate overlay covers portrait play */
  }
}

/**
 * On touch devices, shows the tap-to-enter gate and resolves once the player
 * taps (after kicking off fullscreen+landscape). Resolves immediately on
 * desktop. Returns a `close` callback — call it when the game is actually
 * ready so the gate's "ENTERING…" state covers engine load time.
 */
export function passEntryGate(): Promise<() => void> {
  if (!isTouchDevice()) return Promise.resolve(() => {});

  // If fullscreen ever drops mid-game (system back gesture), the rotate
  // overlay doubles as the tap surface that re-enters immersive mode.
  document
    .getElementById("rotate-overlay")
    ?.addEventListener("click", () => void enterImmersive());

  return new Promise((resolve) => {
    const root = document.getElementById("ui-root")!;
    const gate = document.createElement("div");
    gate.className = "entry-gate";
    // Suppresses the portrait rotate-overlay while the gate is on screen
    // (the gate is the tap surface that unlocks landscape in the first place).
    document.body.classList.add("gating");
    gate.innerHTML = `
      <div class="eg-glow" aria-hidden="true"></div>
      <img class="eg-logo" src="/logo-red.png" alt="" width="96" height="96" />
      <div class="eg-brand">TOFO <span>GAMES</span></div>
      <div class="eg-tap">
        <span class="eg-tap-idle">Tap to <em>enter</em></span>
        <span class="eg-tap-busy">Entering<em>…</em></span>
      </div>
      <p class="eg-note">Best played in fullscreen landscape</p>
    `;
    root.appendChild(gate);

    gate.addEventListener(
      "click",
      () => {
        void enterImmersive();
        gate.classList.add("busy");
        resolve(() => {
          gate.remove();
          document.body.classList.remove("gating");
        });
      },
      { once: true }
    );
  });
}
