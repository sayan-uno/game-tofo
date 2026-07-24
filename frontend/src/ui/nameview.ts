/** Overflow-proof name display.
 *
 *  Usernames are capped at 15 characters, but 15 wide glyphs (or decorated
 *  Unicode) can still outgrow a chip or a list row. Instead of letting a long
 *  name stretch the layout, every name lives in a fixed window; a name that
 *  fits renders normally, one that doesn't loops a slow reveal — hold the
 *  start, glide left to the end, hold, fade, snap back to the start.
 *
 *  Performance: the loop itself is a pure transform/opacity CSS animation
 *  (compositor-only — zero JS per frame, no layout, no paint on the main
 *  thread). JS runs once per setNameView call: a single measurement inside a
 *  shared rAF batch. Only names that actually overflow ever animate.
 */

const pending = new Set<HTMLElement>();
let rafId = 0;

/** Views that may need re-measuring when the window/orientation changes.
 *  Swept on that (rare) event; detached elements are dropped there. */
const live = new Set<HTMLElement>();
let resizeHooked = false;
let resizeTimer = 0;

export function setNameView(el: HTMLElement, name: string) {
  let track = el.firstElementChild as HTMLElement | null;
  if (!track || !track.classList.contains("nv-track")) {
    el.textContent = "";
    track = document.createElement("span");
    track.className = "nv-track";
    el.appendChild(track);
    el.classList.add("nameview");
  }
  track.textContent = name;
  el.title = name; // desktop hover always shows the full name
  scheduleMeasure(el);
  live.add(el);
  hookResize();
}

function scheduleMeasure(el: HTMLElement) {
  pending.add(el);
  if (!rafId) rafId = requestAnimationFrame(flush);
}

function flush() {
  rafId = 0;
  // Chat/friends rows are rebuilt on every render; without this sweep their
  // old nodes would sit in `live` (a strong ref = detached DOM kept alive)
  // until the next window resize, which on a phone may never come.
  if (live.size > 64) {
    for (const el of live) if (!el.isConnected) live.delete(el);
  }
  // Interleaved read/write is safe here: the writes are class toggles and
  // custom properties feeding a transform animation — none invalidate layout,
  // so every scrollWidth read stays cheap.
  for (const el of pending) {
    if (!el.isConnected) continue;
    const track = el.firstElementChild as HTMLElement | null;
    if (!track) continue;
    const overflow = track.scrollWidth - el.clientWidth;
    if (overflow > 2) {
      // Slow reveal: ~22px/s once the holds are taken out, clamped so tiny
      // overflows don't flicker past and huge ones don't take forever.
      const duration = Math.min(16, Math.max(6, 3 + overflow / 22));
      el.style.setProperty("--nv-x", `${-overflow}px`);
      el.style.setProperty("--nv-dur", `${duration.toFixed(2)}s`);
      el.classList.add("nv-anim");
    } else if (el.classList.contains("nv-anim")) {
      el.classList.remove("nv-anim");
      el.style.removeProperty("--nv-x");
      el.style.removeProperty("--nv-dur");
    }
  }
  pending.clear();
}

function hookResize() {
  if (resizeHooked) return;
  resizeHooked = true;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      for (const el of live) {
        if (el.isConnected) scheduleMeasure(el);
        else live.delete(el); // rebuilt row — let the old node be collected
      }
    }, 150);
  });
}
