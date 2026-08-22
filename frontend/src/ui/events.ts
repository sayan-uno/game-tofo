// Events: what the platform wants a player to look at.
//
// A pinned event is put in front of them when they ARRIVE — a fresh sign-in or
// a reload — and not again until they arrive again. Deliberately not on every
// return from another tab: something that reappears whenever somebody glances
// away is not an announcement, it is the fastest way to teach people to close
// it without reading it.
//
// "This arrival" is remembered in sessionStorage rather than localStorage,
// which is exactly the difference asked for: a reload or a new sign-in starts
// a new session and the pinned event comes back; switching tabs does not.
import { API_URL } from "../config";

/** Media lives on the API, which is a different origin from the page in both
 *  development and production. A relative path here asks the FRONTEND for it
 *  and gets a 404 — which is exactly what "the image does not load" looked
 *  like. */
export const mediaUrl = (path: string): string => (path.startsWith("/") ? `${API_URL}${path}` : path);

export interface GameEvent {
  id: string;
  title: string;
  kind: "image" | "video" | "html";
  /** Markup for `html`; a URL to fetch for the other two. */
  body: string;
  pinned: boolean;
  itemId: string | null;
  createdAt: string;
}

const SEEN = "tofo.events.seen";

const seenThisArrival = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

const remember = (id: string): void => {
  try {
    const all = seenThisArrival();
    all.add(id);
    sessionStorage.setItem(SEEN, JSON.stringify([...all]));
  } catch {
    /* a private window that refuses storage still gets the event, just again */
  }
};

/** One event, as a card. `onOpenItem` is what makes an advert worth pinning:
 *  an event about a weapon that does not take you to the weapon wastes
 *  everybody's time. */
function card(e: GameEvent, onOpenItem: (itemId: string) => void, onClose: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "ev-overlay";
  el.innerHTML = `
    <div class="ev-card">
      <button class="ev-close" type="button" aria-label="Close">✕</button>
      <div class="ev-media"></div>
      <div class="ev-foot"><h3 class="ev-title"></h3></div>
    </div>`;
  el.querySelector<HTMLElement>(".ev-title")!.textContent = e.title;

  const media = el.querySelector<HTMLElement>(".ev-media")!;
  if (e.kind === "image") {
    const img = document.createElement("img");
    img.src = mediaUrl(e.body);
    img.alt = e.title;
    media.appendChild(img);
  } else if (e.kind === "video") {
    const v = document.createElement("video");
    v.src = mediaUrl(e.body);
    v.autoplay = true;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    media.appendChild(v);
  } else {
    // Authored by an admin in the console, which is a trusted seat — the same
    // seat that can ban accounts and read private messages. It is not player
    // input and is not treated as such.
    media.innerHTML = e.body;
  }

  if (e.itemId) {
    const go = document.createElement("button");
    go.className = "btn btn-red ev-go";
    go.textContent = "See it";
    go.onclick = () => {
      onClose();
      onOpenItem(e.itemId!);
    };
    el.querySelector<HTMLElement>(".ev-foot")!.appendChild(go);
    media.classList.add("clickable");
    media.onclick = () => {
      onClose();
      onOpenItem(e.itemId!);
    };
  }
  el.querySelector<HTMLButtonElement>(".ev-close")!.onclick = onClose;
  return el;
}

/** Show whatever is pinned and has not been seen since this arrival. */
export function showPinned(all: GameEvent[], onOpenItem: (itemId: string) => void): void {
  const seen = seenThisArrival();
  const due = all.filter((e) => e.pinned && !seen.has(e.id));
  if (due.length === 0) return;
  const e = due[0]; // one at a time; the rest are in the list
  const el = card(e, onOpenItem, () => el.remove());
  remember(e.id);
  document.getElementById("ui-root")?.appendChild(el);
}

let page: HTMLElement | null = null;

/** The events page: a list down the side, the chosen one filling the rest.
 *
 *  Full screen, like the locker, because that is what it is competing with —
 *  a panel in the corner reads as a notification, and an event is meant to be
 *  looked at. The list is always visible so somebody who came in for one thing
 *  can see there are others; the big panel is the one they came for.
 */
export function toggleEvents(all: GameEvent[], onOpenItem: (itemId: string) => void): void {
  if (page) {
    page.remove();
    page = null;
    return;
  }
  page = document.createElement("div");
  page.className = "ev-page";
  page.innerHTML = `
    <header class="ev-head">
      <button class="ev-back" type="button" aria-label="Close">‹</button>
      <div class="ev-head-text"><span class="ev-kicker">// What's on</span><h1>Events</h1></div>
    </header>
    <div class="ev-body">
      <nav class="ev-rail" aria-label="Events"></nav>
      <section class="ev-main"></section>
    </div>`;
  const rail = page.querySelector<HTMLElement>(".ev-rail")!;
  const main = page.querySelector<HTMLElement>(".ev-main")!;

  const show = (e: GameEvent) => {
    rail.querySelectorAll(".ev-tile").forEach((t) => t.classList.toggle("on", t.getAttribute("data-id") === e.id));
    main.replaceChildren();
    const media = document.createElement("div");
    media.className = "ev-hero";
    if (e.kind === "image") {
      const img = document.createElement("img");
      img.src = mediaUrl(e.body);
      img.alt = e.title;
      media.appendChild(img);
    } else if (e.kind === "video") {
      const v = document.createElement("video");
      v.src = mediaUrl(e.body);
      v.autoplay = true;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.controls = true;
      media.appendChild(v);
    } else {
      // Authored in the console — a trusted seat, the same one that can ban an
      // account. Not player input, and not treated as such.
      media.innerHTML = e.body;
    }
    const foot = document.createElement("div");
    foot.className = "ev-main-foot";
    const h = document.createElement("h2");
    h.textContent = e.title;
    const t = document.createElement("time");
    t.textContent = new Date(e.createdAt).toLocaleDateString();
    foot.append(h, t);
    if (e.itemId) {
      const go = document.createElement("button");
      go.className = "btn btn-red";
      go.textContent = "See it";
      go.onclick = () => {
        close();
        onOpenItem(e.itemId!);
      };
      foot.appendChild(go);
    }
    main.append(media, foot);
  };

  if (all.length === 0) {
    const p = document.createElement("p");
    p.className = "ev-empty";
    p.textContent = "Nothing on right now.";
    main.appendChild(p);
  }
  for (const e of all) {
    const tile = document.createElement("button");
    tile.className = "ev-tile";
    tile.type = "button";
    tile.setAttribute("data-id", e.id);
    const label = document.createElement("span");
    label.className = "ev-tile-title";
    label.textContent = e.title;
    tile.appendChild(label);
    if (e.pinned) {
      const pin = document.createElement("span");
      pin.className = "ev-pin";
      pin.textContent = "new";
      tile.appendChild(pin);
    }
    tile.onclick = () => show(e);
    rail.appendChild(tile);
  }

  const close = () => {
    page?.remove();
    page = null;
  };
  page.querySelector<HTMLButtonElement>(".ev-back")!.onclick = close;
  document.getElementById("ui-root")?.appendChild(page);
  if (all.length > 0) show(all[0]);
}
