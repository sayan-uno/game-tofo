import { api } from "../api/http";
import { toast } from "./toast";
import { setCatalog } from "../game/assets";
import { PreviewScene } from "../game/previewScene";
import { startRenderLoop } from "../game/engine";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Scene } from "@babylonjs/core/scene";
import type { CatalogCharacter, CatalogEmote, CatalogWeapon, CollectionData } from "../types";

/** The player's collection: characters they can wear, emotes they can perform.
 *
 *  Ships as its own lazy chunk (main.ts warms it on idle), so the lobby's
 *  critical path never pays for it. While it is open the lobby scene stops
 *  rendering entirely and the SAME engine draws a small preview scene instead —
 *  one scene, one context, no extra GPU cost over the lobby it replaced.
 *
 *  The item grid is opaque DOM on the right; the left column is deliberately
 *  transparent and the preview camera is aimed at exactly that box.
 */

export interface OpenCollectionOptions {
  engine: Engine;
  /** The lobby's scene. Both scenes share one canvas, so its input has to be
   *  detached while this page owns the view — otherwise drags meant for the
   *  preview also spin the lobby camera behind it, and closing the page reveals
   *  a lobby that quietly rotated. */
  lobbyScene: Scene;
  /** Put the lobby's render loop back when the page closes. */
  restoreLobby: () => void;
  /** Fires after a successful equip so the caller can refresh anything local. */
  onEquipped?: (characterId: string) => void;
}

/** Session cache — the catalog is identical every time and changes only when
 *  the player equips, which we patch in locally. */
let cached: CollectionData | null = null;

export async function fetchCollection(force = false): Promise<CollectionData> {
  if (cached && !force) return cached;
  cached = await api.get<CollectionData>("/api/collection");
  setCatalog(cached);
  return cached;
}

/** Warm the catalog into memory (and into `assets`) without drawing anything —
 *  the lobby needs it to know which model each squadmate is wearing. */
export const primeCollection = () => fetchCollection().catch(() => null);

/** The mounted page, if any — a double tap must never stack two. */
let screen: HTMLElement | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const ICONS: Record<string, string> = {
  back: `<path d="m15 18-6-6 6-6"/>`,
  user: `<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  spark: `<path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="m5.6 5.6 2.8 2.8"/><path d="m15.6 15.6 2.8 2.8"/><path d="m18.4 5.6-2.8 2.8"/><path d="m8.4 15.6-2.8 2.8"/>`,
  sword: `<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/>`,
  none: `<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>`,
  check: `<path d="m5 12 5 5L20 6"/>`,
  play: `<path d="M6 4l14 8-14 8z"/>`,
};
const icon = (k: string, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] ?? ""}</svg>`;

/** No artwork yet, so every tile draws a deterministic placeholder: a tinted
 *  panel keyed off the item id plus its initials. Stable per item (the same
 *  character is always the same colour) and costs zero network requests. */
const THUMB_ICON: Record<string, string> = { character: "user", weapon: "sword", emote: "spark" };

function placeholderTile(id: string, label: string, kind: "character" | "weapon" | "emote"): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const initials = label
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  return `<span class="cl-thumb" style="--h:${hue}">
      ${icon(THUMB_ICON[kind], "cl-thumb-icon")}
      <span class="cl-thumb-txt">${esc(initials)}</span>
    </span>`;
}

const CATEGORY_LABEL: Record<CatalogEmote["category"], string> = {
  emote: "Emote",
  locomotion: "Move",
  traversal: "Action",
};

export async function openCollection(opts: OpenCollectionOptions): Promise<void> {
  if (screen) return;

  const canvas = opts.engine.getRenderingCanvas() as HTMLCanvasElement | null;
  if (!canvas) return;

  const page = document.createElement("div");
  page.className = "cl-screen";
  page.innerHTML = `
    <header class="cl-head">
      <button class="cl-back" type="button" aria-label="Close collection">${icon("back")}</button>
      <div class="cl-head-text">
        <span class="cl-kicker">// Locker</span>
        <h2 class="cl-head-title">COLLECTION</h2>
      </div>
      <img class="cl-head-logo" src="/logo-red.png" alt="" width="34" height="34" />
    </header>
    <div class="cl-body">
      <div class="cl-stage">
        <div class="cl-stage-status">Loading…</div>
      </div>
      <section class="cl-panel">
        <div class="cl-tabs" role="tablist">
          <button class="cl-tab active" role="tab" data-tab="characters">Characters</button>
          <button class="cl-tab" role="tab" data-tab="weapons">Weapons</button>
          <button class="cl-tab" role="tab" data-tab="emotes">Emotes</button>
        </div>
        <div class="cl-grid" role="list"></div>
        <div class="cl-foot"></div>
      </section>
    </div>`;
  document.getElementById("ui-root")!.appendChild(page);
  screen = page;

  const stage = page.querySelector<HTMLElement>(".cl-stage")!;
  const status = page.querySelector<HTMLElement>(".cl-stage-status")!;
  const grid = page.querySelector<HTMLElement>(".cl-grid")!;
  const foot = page.querySelector<HTMLElement>(".cl-foot")!;

  // --- take the canvas -----------------------------------------------------
  // Nothing below exists yet, so this failure unmounts directly rather than
  // going through close() — which tears down a preview that was never built.
  let data: CollectionData;
  try {
    data = await fetchCollection();
  } catch {
    page.remove();
    screen = null;
    toast("Couldn't load your collection", true);
    return;
  }
  if (screen !== page) return; // closed while the request was in flight

  opts.lobbyScene.detachControl();
  const preview = new PreviewScene(opts.engine, data.lobbyIdleClip);
  let last = performance.now();
  startRenderLoop(opts.engine, () => {
    const now = performance.now();
    preview.spin(now - last);
    last = now;
    preview.scene.render();
  });

  const aim = () => preview.setViewportFromRect(stage.getBoundingClientRect(), canvas);
  aim();
  // The stage box moves with orientation changes and the tab bar; ResizeObserver
  // catches every cause without polling a rect every frame.
  const resizeObserver = new ResizeObserver(aim);
  resizeObserver.observe(stage);
  window.addEventListener("resize", aim);

  // --- state ---------------------------------------------------------------
  type Tab = "characters" | "weapons" | "emotes";
  let tab: Tab = "characters";
  let selectedCharacter = data.equippedCharacter;
  /** null is a real choice here — empty-handed — not "nothing selected". The
   *  coalesce covers a client that outlives a backend rollback, where the
   *  field simply isn't in the response. */
  let selectedWeapon: string | null = data.equippedWeapon ?? null;
  let previewCharacter = "";

  async function showCharacter(id: string) {
    status.textContent = "Loading…";
    status.classList.remove("hidden");
    const ok = await preview.setCharacter(id);
    if (!screen) return;
    previewCharacter = ok ? id : "";
    status.classList.toggle("hidden", ok);
    if (!ok) status.textContent = "Model unavailable";
  }

  function renderFoot() {
    if (tab === "emotes") {
      foot.innerHTML = `<p class="cl-hint">Tap any clip to see it on your character.</p>`;
      return;
    }
    const worn = tab === "characters" ? selectedCharacter === data.equippedCharacter : selectedWeapon === data.equippedWeapon;
    const label = worn
      ? `${icon("check", "cl-equip-ic")} Equipped`
      : tab === "weapons" && selectedWeapon === null
        ? "Put away"
        : "Equip";
    foot.innerHTML = `<button class="btn btn-primary cl-equip" ${worn ? "disabled" : ""}>${label}</button>`;
    const btn = foot.querySelector<HTMLButtonElement>(".cl-equip")!;
    btn.onclick = () => void equip(btn);
  }

  /** Equips whichever slot the open tab owns. The response carries BOTH slots,
   *  so the local copy stays whole even though the request named one. */
  async function equip(btn: HTMLButtonElement) {
    btn.disabled = true;
    const forCharacter = tab === "characters";
    try {
      const res = await api.post<{ equippedCharacter: string; equippedWeapon: string | null }>(
        "/api/collection/equip",
        forCharacter ? { characterId: selectedCharacter } : { weaponId: selectedWeapon }
      );
      data.equippedCharacter = res.equippedCharacter;
      data.equippedWeapon = res.equippedWeapon;
      if (cached) {
        cached.equippedCharacter = res.equippedCharacter;
        cached.equippedWeapon = res.equippedWeapon;
      }
      opts.onEquipped?.(res.equippedCharacter);
      renderGrid();
      renderFoot();
      toast(forCharacter ? "Character equipped" : res.equippedWeapon ? "Weapon equipped" : "Weapon put away");
    } catch (err) {
      btn.disabled = false;
      const fallback = forCharacter ? "Couldn't equip that character" : "Couldn't equip that weapon";
      toast(err instanceof Error ? err.message : fallback, true);
    }
  }

  function renderGrid() {
    if (tab === "characters") {
      grid.className = "cl-grid cl-grid-char";
      grid.innerHTML = data.characters
        .map((c: CatalogCharacter) => {
          const on = c.id === selectedCharacter;
          const worn = c.id === data.equippedCharacter;
          return `<button class="cl-card ${on ? "sel" : ""}" role="listitem" data-id="${esc(c.id)}">
              ${placeholderTile(c.id, c.name, "character")}
              <span class="cl-card-name">${esc(c.name)}</span>
              <span class="cl-card-meta">${esc(c.rarity)}</span>
              ${worn ? `<span class="cl-badge">${icon("check")}</span>` : ""}
            </button>`;
        })
        .join("");
      grid.querySelectorAll<HTMLButtonElement>(".cl-card").forEach((card) => {
        card.onclick = () => {
          const id = card.dataset.id!;
          if (id === selectedCharacter) return;
          selectedCharacter = id;
          renderGrid();
          renderFoot();
          void showCharacter(id);
        };
      });
    } else if (tab === "weapons") {
      grid.className = "cl-grid cl-grid-char";
      // The empty hand leads the grid, because putting a weapon away has to be
      // as reachable as picking one up — and it is a look in its own right.
      const empty = `<button class="cl-card ${selectedWeapon === null ? "sel" : ""}" role="listitem" data-id="">
          <span class="cl-thumb cl-thumb-none">${icon("none", "cl-thumb-icon")}</span>
          <span class="cl-card-name">No weapon</span>
          <span class="cl-card-meta">empty hand</span>
          ${data.equippedWeapon === null ? `<span class="cl-badge">${icon("check")}</span>` : ""}
        </button>`;
      grid.innerHTML =
        empty +
        (data.weapons ?? [])
          .map((w: CatalogWeapon) => {
            const on = w.id === selectedWeapon;
            const worn = w.id === data.equippedWeapon;
            return `<button class="cl-card ${on ? "sel" : ""}" role="listitem" data-id="${esc(w.id)}">
              ${placeholderTile(w.id, w.name, "weapon")}
              <span class="cl-card-name">${esc(w.name)}</span>
              <span class="cl-card-meta">${esc(w.rarity)}</span>
              ${worn ? `<span class="cl-badge">${icon("check")}</span>` : ""}
            </button>`;
          })
          .join("");
      grid.querySelectorAll<HTMLButtonElement>(".cl-card").forEach((card) => {
        card.onclick = () => {
          const id = card.dataset.id || null;
          if (id === selectedWeapon) return;
          selectedWeapon = id;
          renderGrid();
          renderFoot();
          void preview.setWeapon(id);
        };
      });
    } else {
      grid.className = "cl-grid cl-grid-emote";
      grid.innerHTML = data.emotes
        .map(
          (e: CatalogEmote) => `<button class="cl-card cl-card-emote" role="listitem" data-id="${esc(e.id)}">
              ${placeholderTile(e.id, e.name, "emote")}
              <span class="cl-card-name">${esc(e.name)}</span>
              <span class="cl-card-meta">${CATEGORY_LABEL[e.category]} · ${e.duration.toFixed(1)}s</span>
              <span class="cl-play">${icon("play")}</span>
            </button>`
        )
        .join("");
      grid.querySelectorAll<HTMLButtonElement>(".cl-card").forEach((card) => {
        card.onclick = () => {
          const id = card.dataset.id!;
          grid.querySelectorAll(".cl-card").forEach((c) => c.classList.toggle("sel", c === card));
          void preview.playClip(id).then((ok) => {
            if (!ok && screen) toast("That clip couldn't be loaded", true);
          });
        };
      });
    }
  }

  page.querySelectorAll<HTMLButtonElement>(".cl-tab").forEach((btn) => {
    btn.onclick = () => {
      const next = btn.dataset.tab as Tab;
      if (next === tab) return;
      tab = next;
      page.querySelectorAll(".cl-tab").forEach((t) => t.classList.toggle("active", t === btn));
      renderGrid();
      renderFoot();
      // Emotes need somebody to perform them, and a weapon needs a hand to be
      // held in — make sure the equipped character is the one on stage when
      // the player switches to either.
      if (tab !== "characters" && previewCharacter !== data.equippedCharacter) {
        selectedCharacter = data.equippedCharacter;
        void showCharacter(data.equippedCharacter);
      }
    };
  });

  renderGrid();
  renderFoot();
  // The weapon first: the preview keeps it across character swaps, so setting
  // it before the model lands means it is simply there when the model arrives,
  // with no second load and no flicker.
  void preview.setWeapon(selectedWeapon);
  void showCharacter(selectedCharacter);

  // --- teardown ------------------------------------------------------------
  function close() {
    if (!screen) return;
    resizeObserver.disconnect();
    window.removeEventListener("resize", aim);
    document.removeEventListener("keydown", onKey);
    screen.remove();
    screen = null;
    preview.dispose();
    opts.lobbyScene.attachControl();
    opts.restoreLobby();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  page.querySelector<HTMLButtonElement>(".cl-back")!.onclick = close;
  document.addEventListener("keydown", onKey);
}
