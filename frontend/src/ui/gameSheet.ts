// The CHOOSE GAME sheet: one card per playable game, tap to pick. Opens over
// the lobby, closes on pick or dismiss. Members can open it to see what's
// there but only the leader's taps do anything.
import type { GameInfo } from "../types";
import { needsDownload } from "../platform/packLoader";

export interface GameSheetOptions {
  games: GameInfo[];
  selectedId: string | null;
  canPick: boolean;
  /** Async "is this pack already on the device" — the badge fills in late. */
  isCached: (game: GameInfo) => Promise<boolean>;
  /** null clears the selection. */
  onPick: (gameId: string | null) => void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

let open: HTMLElement | null = null;

export function openGameSheet(opts: GameSheetOptions): void {
  if (open) return;
  const root = document.createElement("div");
  root.className = "gs-backdrop";
  const cards = opts.games
    .map((g) => {
      const selected = g.id === opts.selectedId;
      const players =
        g.matchSizes.duo === g.matchSizes.squad
          ? `${g.matchSizes.squad} players`
          : `${g.matchSizes.duo}–${g.matchSizes.squad} players`;
      // A game whose clock is a ceiling says roughly how long it really takes;
      // one whose clock IS its length says exactly.
      const mins = g.typicalSec
        ? `~${Math.round(g.typicalSec / 60)} min`
        : `${Math.round(g.durationSec / 60)} min`;
      // A game with no pack is ready the moment it is picked; one that HAS a
      // pack but no URL for it has not been published, and cannot be played.
      const free = !needsDownload(g);
      // Three ways a game can be unpickable, and the player is told which.
      // Hiding a held game would be worse than greying it: one that silently
      // vanishes reads as a broken client, and somebody barred from a game
      // deserves to know rather than wonder where it went.
      const stopped = g.bannedReason ?? g.heldReason ?? null;
      const unavailable = (!free && !g.packUrl) || stopped !== null;
      return `
        <button class="gs-card${selected ? " selected" : ""}" data-id="${esc(g.id)}" ${unavailable ? 'data-unavailable="1"' : ""}>
          <span class="gs-art" aria-hidden="true"><span class="gs-art-name">${esc(g.name)}</span></span>
          <span class="gs-body">
            <span class="gs-name">${esc(g.name)}</span>
            <span class="gs-tag">${esc(stopped ?? g.tagline)}</span>
            <span class="gs-meta">${players} · ${mins} · <span class="gs-size">${free ? "no download" : fmtBytes(g.packBytes)}</span>
              <span class="gs-badge hidden">${free ? "Ready" : "Downloaded"}</span>
              ${
                stopped
                  ? `<span class="gs-badge warn">${esc(g.bannedReason ? "You cannot play this" : "On hold")}</span>`
                  : unavailable
                    ? '<span class="gs-badge warn">Not published</span>'
                    : ""
              }
            </span>
          </span>
          ${selected ? '<span class="gs-check" aria-hidden="true">✓</span>' : ""}
        </button>`;
    })
    .join("");
  root.innerHTML = `
    <div class="gs-sheet" role="dialog" aria-label="Choose game">
      <div class="gs-head">
        <span class="gs-kicker">// Games</span>
        <h2 class="gs-title">CHOOSE GAME</h2>
        <button class="gs-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="gs-list">${cards || '<div class="gs-empty">No games available yet.</div>'}</div>
      ${
        opts.canPick && opts.selectedId
          ? '<div class="gs-foot"><button class="btn btn-ghost btn-small gs-clear">Remove selection</button></div>'
          : !opts.canPick
            ? '<div class="gs-foot gs-note">Only the party leader can pick.</div>'
            : ""
      }
    </div>`;
  document.getElementById("ui-root")!.appendChild(root);
  open = root;

  const close = () => {
    root.remove();
    if (open === root) open = null;
  };
  root.querySelector<HTMLButtonElement>(".gs-close")!.onclick = close;
  root.addEventListener("pointerdown", (e) => {
    if (e.target === root) close();
  });
  root.querySelector<HTMLButtonElement>(".gs-clear")?.addEventListener("click", () => {
    opts.onPick(null);
    close();
  });
  root.querySelectorAll<HTMLButtonElement>(".gs-card").forEach((card) => {
    const id = card.dataset.id!;
    const game = opts.games.find((g) => g.id === id)!;
    void opts.isCached(game).then((cached) => {
      if (cached) card.querySelector(".gs-badge")?.classList.remove("hidden");
    });
    if (!opts.canPick || card.dataset.unavailable) {
      card.classList.add("readonly");
      return;
    }
    card.onclick = () => {
      opts.onPick(id === opts.selectedId ? id : id); // re-picking the same game is harmless
      close();
    };
  });
}

export function closeGameSheet(): void {
  open?.remove();
  open = null;
}
