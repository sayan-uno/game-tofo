// The emote sheet: tap your own character in the lobby, pick something to
// perform, and the whole squad sees it.
//
// Its own lazy chunk (main.ts pulls it on the tap), so the lobby's first frame
// never pays for a menu most sessions won't open. The LIST is a filter over
// the catalog — see getPerformableEmotes — so shipping a new dance is a
// catalog line and nothing in here changes.
import { getPerformableEmotes } from "../game/assets";

/** The mounted sheet, if any — a double tap must never stack two. */
let sheet: HTMLElement | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One deterministic tint per emote, so a clip is always the same colour and
 *  players learn the grid by shape rather than by reading it every time. */
function tint(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}

const NOTE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>
</svg>`;

export interface EmoteSheetOptions {
  /** Fired with the chosen clip id. The sheet closes itself first, so the
   *  caller can start the performance without a menu sitting over it. */
  onPick: (emoteId: string) => void;
  /** Called as the sheet opens, to warm the clips while the player reads. */
  onOpen?: () => void;
}

export function openEmoteSheet(opts: EmoteSheetOptions): void {
  if (sheet) return;
  const emotes = getPerformableEmotes();

  const root = document.createElement("div");
  root.className = "em-screen";
  root.innerHTML = `
    <div class="em-backdrop"></div>
    <section class="em-sheet" role="dialog" aria-label="Emotes">
      <header class="em-head">
        <span class="em-kicker">// Perform</span>
        <h3 class="em-title">EMOTES</h3>
        <button class="em-close" type="button" aria-label="Close">✕</button>
      </header>
      ${
        emotes.length === 0
          ? `<p class="em-empty">No emotes yet. Anything you unlock shows up here.</p>`
          : `<div class="em-grid" role="list">
              ${emotes
                .map(
                  (emote) => `<button class="em-card" role="listitem" type="button" data-id="${esc(emote.id)}">
                    <span class="em-thumb" style="--h:${tint(emote.id)}">${NOTE_ICON}</span>
                    <span class="em-name">${esc(emote.name)}</span>
                    <span class="em-meta">${emote.duration.toFixed(1)}s</span>
                  </button>`
                )
                .join("")}
            </div>`
      }
      <p class="em-hint">Your whole squad sees it.</p>
    </section>`;

  document.getElementById("ui-root")!.appendChild(root);
  sheet = root;
  opts.onOpen?.();

  const close = () => {
    if (sheet !== root) return;
    document.removeEventListener("keydown", onKey);
    root.remove();
    sheet = null;
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  root.querySelector<HTMLButtonElement>(".em-close")!.onclick = close;
  root.querySelector<HTMLElement>(".em-backdrop")!.onclick = close;
  document.addEventListener("keydown", onKey);

  root.querySelectorAll<HTMLButtonElement>(".em-card").forEach((card) => {
    card.onclick = () => {
      const id = card.dataset.id!;
      // Close FIRST: the point of the emote is watching it, and a menu over
      // the character is the one thing guaranteed to be in the way.
      close();
      opts.onPick(id);
    };
  });
}

/** Shut the sheet from outside — e.g. the player left the lobby underneath it. */
export function closeEmoteSheet(): void {
  sheet?.remove();
  sheet = null;
}
