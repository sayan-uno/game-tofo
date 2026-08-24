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
   *  detached while this page owns the view — otherwise a drag meant for the
   *  preview also turns whichever lobby character is standing behind it, and
   *  closing the page reveals a squad that quietly rotated. */
  lobbyScene: Scene;
  /** Put the lobby's render loop back when the page closes. */
  restoreLobby: () => void;
  /** Fires after a successful equip so the caller can refresh anything local. */
  onEquipped?: (characterId: string) => void;
  /** Open with this item selected and scrolled to.
   *
   *  What makes an event worth pinning: an advert for a weapon that drops the
   *  player at the top of a locker and leaves them to find it is an advert
   *  that wastes their time. */
  focusItem?: string;
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
  startRenderLoop(opts.engine, () => preview.scene.render());

  // Drag the stage to turn the model, exactly as the lobby turns a character.
  //
  // The listeners go on the STAGE ELEMENT, not the canvas. This page is a
  // full-screen overlay inside #ui-root, and `#ui-root > *` sets
  // `pointer-events: auto` with an id's specificity — which beats the
  // `.cl-screen { pointer-events: none }` that was meant to make this a hole.
  // So nothing here ever reaches the canvas, and a scene-level pointer handler
  // is silently dead. Listening on the element the player is actually touching
  // needs no hole at all, and no cascade can switch it off.
  let turningPointer: number | null = null;
  let turnLastX = 0;
  stage.addEventListener("pointerdown", (e) => {
    turningPointer = e.pointerId;
    turnLastX = e.clientX;
    preview.grabTurn();
    stage.classList.add("turning");
    stage.setPointerCapture(e.pointerId); // keep the drag even if it leaves the box
  });
  stage.addEventListener("pointermove", (e) => {
    if (turningPointer !== e.pointerId) return;
    const moved = e.clientX - turnLastX;
    if (moved === 0) return;
    turnLastX = e.clientX;
    // Measured against the CANVAS, so a swipe turns a character by the same
    // amount here as it does on the podium.
    preview.turnBy(moved, canvas.clientWidth || 1);
  });
  const endTurn = (e: PointerEvent) => {
    if (turningPointer !== e.pointerId) return;
    turningPointer = null;
    stage.classList.remove("turning");
    preview.releaseTurn();
  };
  stage.addEventListener("pointerup", endTurn);
  stage.addEventListener("pointercancel", endTurn);

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
  /** The emote tab needs a selection too, now that it has a footer — claiming
   *  is about one clip, not about whichever one last played. */
  let selectedEmote: string | null = null;

  async function showCharacter(id: string) {
    status.textContent = "Loading…";
    status.classList.remove("hidden");
    const ok = await preview.setCharacter(id);
    if (!screen) return;
    previewCharacter = ok ? id : "";
    status.classList.toggle("hidden", ok);
    if (!ok) status.textContent = "Model unavailable";
  }

  /** The tag on a card nobody has claimed yet.
   *
   *  Free things say FREE rather than showing nothing, because under a claim
   *  system "free" is a state you act on — one tap — and a blank card looks
   *  like something you already have. */
  const priceTag = (item: { owned: boolean; price?: { currency: string; amount: number } | null }): string => {
    if (item.owned) return "";
    if (!item.price) return `<span class="cl-price free">FREE</span>`;
    const coin = item.price.currency === "coin";
    return `<span class="cl-price ${coin ? "coin" : "gem"}">
      <img src="/store/${coin ? "coin" : "gem"}.webp" alt="" width="14" height="14" />
      ${item.price.amount.toLocaleString("en-IN")}
    </span>`;
  };

  /** Can they afford the thing they are looking at? */
  const affords = (price: { currency: string; amount: number }): boolean => {
    const wallet = data.balance ?? { coins: 0, gems: 0 };
    return (price.currency === "coin" ? wallet.coins : wallet.gems) >= price.amount;
  };

  /** Whatever the open tab has selected — the one thing the footer is about. */
  const selected = ():
    | (CatalogCharacter | CatalogWeapon | CatalogEmote)
    | undefined => {
    if (tab === "characters") return data.characters.find((c) => c.id === selectedCharacter);
    if (tab === "weapons") {
      return selectedWeapon === null ? undefined : (data.weapons ?? []).find((w) => w.id === selectedWeapon);
    }
    return data.emotes.find((e) => e.id === selectedEmote);
  };

  function renderFoot() {
    const item = selected();

    // NOT CLAIMED YET is the first question, before equipping is even a
    // thought. Free or paid, it is the same button in the same place — the
    // price is what changes, not the shape of the page.
    if (item && !item.owned) {
      const price = item.price ?? null;
      const enough = price === null || affords(price);
      const coin = price?.currency === "coin";
      foot.innerHTML = `
        <button class="btn btn-primary cl-claim" ${enough ? "" : "disabled"}>
          ${price ? `<img src="/store/${coin ? "coin" : "gem"}.webp" alt="" width="18" height="18" />` : ""}
          ${
            price === null
              ? "Claim — free"
              : enough
                ? `Claim for ${price.amount.toLocaleString("en-IN")}`
                : `Need ${price.amount.toLocaleString("en-IN")}`
          }
        </button>
        ${
          enough
            ? ""
            : `<p class="cl-hint">${
                coin ? "Coins are earned by playing." : "Tap the gem chip in the lobby to get more."
              }</p>`
        }`;
      const claimBtn = foot.querySelector<HTMLButtonElement>(".cl-claim")!;
      claimBtn.onclick = () => void claim(claimBtn, item.id);
      return;
    }

    // Claimed. An emote has nothing to equip — performing it is the lobby's
    // job — so it says so rather than offering a button that does nothing.
    if (tab === "emotes") {
      foot.innerHTML = `<p class="cl-hint">${
        item ? "Yours — use it from the lobby by tapping your own character." : "Tap any clip to see it on your character."
      }</p>`;
      return;
    }

    const worn =
      tab === "characters" ? selectedCharacter === data.equippedCharacter : selectedWeapon === data.equippedWeapon;
    const label = worn
      ? `${icon("check", "cl-equip-ic")} Equipped`
      : tab === "weapons" && selectedWeapon === null
        ? "Put away"
        : "Equip";
    foot.innerHTML = `<button class="btn btn-primary cl-equip" ${worn ? "disabled" : ""}>${label}</button>`;
    const btn = foot.querySelector<HTMLButtonElement>(".cl-equip")!;
    btn.onclick = () => void equip(btn);
  }

  /** Claim an item — the one door into owning anything, free or paid.
   *
   *  The server decides what it costs; this only names the thing. On success
   *  the item is marked owned locally and the footer turns into an Equip, so
   *  claiming and wearing is two taps in the same place. */
  async function claim(btn: HTMLButtonElement, itemId: string) {
    btn.disabled = true;
    try {
      const res = await api.post<{
        free: boolean;
        spent: number;
        currency: string | null;
        balance: { coins: number; gems: number };
      }>("/api/collection/claim", { itemId });
      data.balance = res.balance;
      const mark = (list: { id: string; owned: boolean }[] | undefined) => {
        const hit = list?.find((i) => i.id === itemId);
        if (hit) hit.owned = true;
      };
      mark(data.characters);
      mark(data.weapons);
      mark(data.emotes);
      if (cached) {
        cached.balance = res.balance;
        for (const list of [cached.characters, cached.weapons, cached.emotes]) {
          const hit = (list as { id: string; owned: boolean }[] | undefined)?.find((i) => i.id === itemId);
          if (hit) hit.owned = true;
        }
      }
      // The lobby chips read the store module's balance, so tell it — spending
      // changes the same number a purchase changes.
      void import("./store").then((m) => m.setBalance({ ...res.balance, spentPaise: 0 })).catch(() => undefined);
      renderGrid();
      renderFoot();
      toast(res.free ? "Claimed — it's yours" : "Unlocked — put it on");
    } catch (err) {
      btn.disabled = false;
      toast(err instanceof Error ? err.message : "Couldn't claim that", true);
    }
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
          return `<button class="cl-card ${on ? "sel" : ""} ${c.owned ? "" : "locked"}" role="listitem" data-id="${esc(c.id)}">
              ${placeholderTile(c.id, c.name, "character")}
              <span class="cl-card-name">${esc(c.name)}</span>
              <span class="cl-card-meta">${esc(c.rarity)}</span>
              ${priceTag(c)}
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
            return `<button class="cl-card ${on ? "sel" : ""} ${w.owned ? "" : "locked"}" role="listitem" data-id="${esc(w.id)}">
              ${placeholderTile(w.id, w.name, "weapon")}
              <span class="cl-card-name">${esc(w.name)}</span>
              <span class="cl-card-meta">${esc(w.rarity)}</span>
              ${priceTag(w)}
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
          (e: CatalogEmote) => `<button class="cl-card cl-card-emote ${e.owned ? "" : "locked"} ${
            e.id === selectedEmote ? "sel" : ""
          }" role="listitem" data-id="${esc(e.id)}">
              ${placeholderTile(e.id, e.name, "emote")}
              <span class="cl-card-name">${esc(e.name)}</span>
              <span class="cl-card-meta">${CATEGORY_LABEL[e.category]} · ${e.duration.toFixed(1)}s</span>
              ${priceTag(e)}
              <span class="cl-play">${icon("play")}</span>
            </button>`
        )
        .join("");
      grid.querySelectorAll<HTMLButtonElement>(".cl-card").forEach((card) => {
        card.onclick = () => {
          const id = card.dataset.id!;
          selectedEmote = id;
          grid.querySelectorAll(".cl-card").forEach((c) => c.classList.toggle("sel", c === card));
          renderFoot();
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

  // Land on the thing they tapped the event for.
  //
  // THE TAB FIRST. Only the open tab's cards exist in the page, so looking for
  // a weapon while Characters is showing finds nothing and leaves the player
  // exactly where they did not want to be — which is what "I picked a weapon
  // and it sent me to characters" was. Which tab owns the item is a question
  // only the catalogue can answer, and the catalogue is right here.
  if (opts.focusItem) {
    const wanted = opts.focusItem;
    const owner: Tab | null = data.characters.some((c) => c.id === wanted)
      ? "characters"
      : data.weapons.some((w) => w.id === wanted)
        ? "weapons"
        : data.emotes.some((e) => e.id === wanted)
          ? "emotes"
          : null;
    if (owner) {
      // Through the tab's own button, so everything switching a tab normally
      // does — the grid, the footer, putting the equipped character back on
      // stage for a weapon or an emote — happens here too.
      const tabBtn = page.querySelector<HTMLButtonElement>(`.cl-tab[data-tab="${owner}"]`);
      if (owner !== tab && tabBtn) tabBtn.click();
      const target = page.querySelector<HTMLElement>(`.cl-card[data-id="${CSS.escape(wanted)}"]`);
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.classList.add("cl-focus");
        target.click();
      }
    }
  }

  page.querySelector<HTMLButtonElement>(".cl-back")!.onclick = close;
  document.addEventListener("keydown", onKey);
}
