// What the platform says to a player: a notice, and a maintenance window.
//
// Two things that look similar and are not.
//
//   A NOTICE is information. It is read and dismissed, and the game carries on
//   underneath it. Somebody who was offline when it went out gets it on their
//   way in, once.
//
//   MAINTENANCE is a state. While it is happening there is nothing to carry on
//   with: the platform is not accepting anybody and everything a player could
//   press would fail. So it is not dismissible — a notice you can close over a
//   game that cannot work is worse than no notice, because it invites people
//   to keep trying and blame themselves.
//
// The lead-up is deliberately gentler. Half an hour of warning is no use if it
// takes the game away for half an hour, so before the window opens this is
// only information: a line in the corner for anybody mid-match, who has the
// most to lose and the least attention to spare, and an ordinary notice for
// everybody else.
let curtain: HTMLElement | null = null;
let banner: HTMLElement | null = null;

/** A dismissible message from the platform. */
export function showNotice(message: string, level = "info"): void {
  if (!message.trim()) return;
  document.querySelector(".pf-notice")?.remove();
  const el = document.createElement("div");
  el.className = `pf-notice ${level === "warn" ? "warn" : ""}`;
  el.innerHTML = `
    <div class="pf-card">
      <div class="pf-kicker">// TOFO</div>
      <p class="pf-msg"></p>
      <div class="pf-actions"><button class="btn pf-ok" type="button">Got it</button></div>
    </div>`;
  // textContent, never innerHTML: this string was typed by a person into a
  // console and must not be able to bring markup with it.
  el.querySelector<HTMLElement>(".pf-msg")!.textContent = message;
  el.querySelector<HTMLButtonElement>(".pf-ok")!.onclick = () => el.remove();
  document.getElementById("ui-root")?.appendChild(el);
}

export interface MaintenanceState {
  active: boolean;
  /** Epoch ms when the window opens. 0 when nothing is scheduled. */
  at: number;
  message: string;
}

/**
 * @param inMatch  a player mid-match gets the quiet version of a warning
 * @param onLocked called when the window opens, so voice can be dropped
 */
export function showMaintenance(s: MaintenanceState, inMatch: boolean, onLocked: () => void): void {
  banner?.remove();
  banner = null;

  // ---- over, or never scheduled -------------------------------------------
  if (!s.active && s.at === 0) {
    curtain?.remove();
    curtain = null;
    return;
  }

  // ---- happening ----------------------------------------------------------
  if (s.active) {
    onLocked();
    if (curtain) return; // already held; do not rebuild and flicker
    curtain = document.createElement("div");
    curtain.className = "pf-curtain";
    curtain.innerHTML = `
      <div class="pf-card">
        <div class="pf-kicker">// Maintenance</div>
        <h2 class="pf-title">TOFO is down for maintenance</h2>
        <p class="pf-msg"></p>
        <p class="pf-sub">Nothing can be started until this is over. Come back shortly.</p>
      </div>`;
    curtain.querySelector<HTMLElement>(".pf-msg")!.textContent = s.message;
    document.getElementById("ui-root")?.appendChild(curtain);
    return;
  }

  // ---- coming ------------------------------------------------------------
  const when = new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (inMatch) {
    // A line in the corner. Mid-match is the worst possible moment for a
    // dialog, and this player has the most to lose by being interrupted.
    banner = document.createElement("div");
    banner.className = "pf-banner";
    banner.textContent = `Maintenance at ${when} — this match will end`;
    document.getElementById("ui-root")?.appendChild(banner);
    return;
  }
  showNotice(`${s.message}\n\nMaintenance starts at ${when}. Any match running then will be ended.`, "warn");
}

// ---------------------------------------------------------------------------
// The list a player can come back to
//
// A message that appears once and is gone is a message half of them will say
// they never got. This is read from the server on open rather than kept in the
// page, for one reason: an admin who takes a notice back expects it to be gone
// the next time anybody looks, and a client holding its own copy would still
// be showing it.
// ---------------------------------------------------------------------------
interface StoredNotice {
  id: string;
  body: string;
  sentAt: string;
}

let page: HTMLElement | null = null;

/** The notices page: the same shape as Events, because they are two kinds of
 *  the same thing and should not need learning twice — a list down the side,
 *  the chosen one filling the rest.
 *
 *  Read from the server each time it opens rather than kept in the page: an
 *  admin who takes a notice back expects it gone the next time anybody looks,
 *  and a client holding its own copy would still be showing it. */
export async function toggleNotices(fetchNotices: () => Promise<StoredNotice[]>): Promise<void> {
  if (page) {
    page.remove();
    page = null;
    return;
  }
  let list: StoredNotice[] = [];
  try {
    list = await fetchNotices();
  } catch {
    /* an empty page reads better here than an error nobody can act on */
  }
  page = document.createElement("div");
  page.className = "ev-page";
  page.innerHTML = `
    <header class="ev-head">
      <button class="ev-back" type="button" aria-label="Close">‹</button>
      <div class="ev-head-text"><span class="ev-kicker">// From TOFO</span><h1>Notices</h1></div>
    </header>
    <div class="ev-body">
      <nav class="ev-rail" aria-label="Notices"></nav>
      <section class="ev-main"></section>
    </div>`;
  const rail = page.querySelector<HTMLElement>(".ev-rail")!;
  const main = page.querySelector<HTMLElement>(".ev-main")!;

  const show = (n: StoredNotice) => {
    rail.querySelectorAll(".ev-tile").forEach((t) => t.classList.toggle("on", t.getAttribute("data-id") === n.id));
    main.replaceChildren();
    const card = document.createElement("div");
    card.className = "nt-read";
    const t = document.createElement("time");
    t.textContent = new Date(n.sentAt).toLocaleString();
    const body = document.createElement("p");
    // textContent: typed by a person into a console, and must not be able to
    // bring markup with it.
    body.textContent = n.body;
    card.append(t, body);
    main.appendChild(card);
  };

  if (list.length === 0) {
    const p = document.createElement("p");
    p.className = "ev-empty";
    p.textContent = "Nothing right now.";
    main.appendChild(p);
  }
  for (const n of list) {
    const tile = document.createElement("button");
    tile.className = "ev-tile";
    tile.type = "button";
    tile.setAttribute("data-id", n.id);
    const label = document.createElement("span");
    label.className = "ev-tile-title";
    // First line only in the rail; the whole thing is on the right.
    label.textContent = n.body.split("\n")[0].slice(0, 60);
    tile.appendChild(label);
    tile.onclick = () => show(n);
    rail.appendChild(tile);
  }

  page.querySelector<HTMLButtonElement>(".ev-back")!.onclick = () => {
    page?.remove();
    page = null;
  };
  document.getElementById("ui-root")?.appendChild(page);
  if (list.length > 0) show(list[0]);
}

/** An admin took one back while somebody had the page open. */
export function closeNoticeList(): void {
  page?.remove();
  page = null;
}

/** Is the platform holding everybody right now? Buttons ask before acting, so
 *  a press during maintenance fails quietly instead of hitting a server that
 *  is going to refuse it anyway. */
export const isLocked = (): boolean => curtain !== null;
