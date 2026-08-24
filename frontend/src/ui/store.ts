import { ApiError, api } from "../api/http";
import { toast } from "./toast";

/** The gem store, and the payment popup that comes out of it.
 *
 *  Its own lazy chunk, like the collection page — the lobby's critical path
 *  never pays for a screen most sessions never open. Unlike the collection it
 *  takes no canvas and builds no scene: it is DOM over the lobby, so the
 *  podium keeps rendering behind it and closing it costs nothing.
 *
 *  Everything about money comes from the server. The client sends a pack id
 *  and is TOLD what to pay; it never computes a price, never builds the UPI
 *  string and never draws the QR itself. A client that can do any of those is
 *  a client that can pay ₹1 for two thousand gems.
 */

export interface Balance {
  coins: number;
  gems: number;
  spentPaise: number;
}

interface Pack {
  id: string;
  gems: number;
  pricePaise: number;
  art: string;
  tag: string | null;
}

interface Shelf {
  balance: Balance;
  packs: Pack[];
  windowMs: number;
  graceMs: number;
}

interface Session {
  id: string;
  packId: string;
  gems: number;
  amountPaise: number;
  collisionOffset: number;
  status: "pending" | "paid" | "approved" | "expired" | "cancelled";
  expiresAt: string;
  graceUntil: string;
}

interface BuyResult {
  session: Session;
  qrDataUrl: string;
  upiUri: string;
  payeeName: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Paise as a person reads them. Integer arithmetic, exactly as on the server —
 *  the whole gateway depends on ₹100.01 being ₹100.01 and not ₹100.00999. */
export const rupees = (paise: number): string =>
  `${Math.floor(paise / 100).toLocaleString("en-IN")}.${String(paise % 100).padStart(2, "0")}`;

const ICONS: Record<string, string> = {
  back: `<path d="m15 18-6-6 6-6"/>`,
  close: `<path d="M6 6l12 12"/><path d="M18 6 6 18"/>`,
  copy: `<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`,
  check: `<path d="m5 12 5 5L20 6"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
};
const icon = (k: string, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] ?? ""}</svg>`;

/** The mounted page, if any — a double tap must never stack two. */
let screen: HTMLElement | null = null;

/** Everyone who wants to know when the balance changes: the HUD chips, and the
 *  store if it happens to be open. Kept here rather than in the HUD so that a
 *  purchase completed with the store closed still repaints the chips. */
const listeners = new Set<(b: Balance) => void>();
let latest: Balance = { coins: 0, gems: 0, spentPaise: 0 };

export function onBalance(fn: (b: Balance) => void): () => void {
  listeners.add(fn);
  fn(latest);
  return () => listeners.delete(fn);
}

export function setBalance(b: Balance): void {
  latest = b;
  for (const fn of listeners) fn(b);
}

export const currentBalance = (): Balance => latest;

/** Read the wallet without drawing anything — what the HUD does at startup so
 *  the chips are never blank. */
export async function primeWallet(): Promise<Balance | null> {
  try {
    const { balance } = await api.get<{ balance: Balance }>("/api/store/wallet");
    setBalance(balance);
    return balance;
  } catch {
    return null;
  }
}

export async function openStore(): Promise<void> {
  if (screen) return;

  const page = document.createElement("div");
  page.className = "st-screen";
  page.innerHTML = `
    <header class="st-head">
      <button class="st-back" type="button" aria-label="Close the store">${icon("back")}</button>
      <div class="st-head-text">
        <span class="st-kicker">// Store</span>
        <h2 class="st-head-title">GEMS</h2>
      </div>
      <div class="st-wallet">
        <span class="st-chip"><img src="/store/coin.webp" alt="Coins" width="20" height="20" /><b class="st-coins">—</b></span>
        <span class="st-chip"><img src="/store/gem.webp" alt="Gems" width="20" height="20" /><b class="st-gems">—</b></span>
      </div>
    </header>
    <div class="st-body">
      <div class="st-intro">
        <strong>Gems</strong> are bought — 1 gem is ₹1. <strong>Coins</strong> are earned by playing.
      </div>
      <div class="st-grid" role="list"><p class="st-loading">Loading…</p></div>
    </div>`;
  document.getElementById("ui-root")!.appendChild(page);
  screen = page;

  const grid = page.querySelector<HTMLElement>(".st-grid")!;
  const coinsEl = page.querySelector<HTMLElement>(".st-coins")!;
  const gemsEl = page.querySelector<HTMLElement>(".st-gems")!;

  const close = () => {
    if (screen !== page) return;
    stopBalance();
    closePopup();
    page.remove();
    screen = null;
  };
  page.querySelector<HTMLButtonElement>(".st-back")!.onclick = close;

  const stopBalance = onBalance((b) => {
    coinsEl.textContent = b.coins.toLocaleString("en-IN");
    gemsEl.textContent = b.gems.toLocaleString("en-IN");
  });

  let shelf: Shelf;
  try {
    shelf = await api.get<Shelf>("/api/store");
  } catch (err) {
    close();
    toast(err instanceof ApiError ? err.message : "Couldn't open the store", true);
    return;
  }
  if (screen !== page) return; // closed while the request was in flight
  setBalance(shelf.balance);

  grid.innerHTML = shelf.packs
    .map(
      (p) => `<button class="st-card" type="button" role="listitem" data-pack="${esc(p.id)}">
        ${p.tag ? `<span class="st-tag">${esc(p.tag)}</span>` : ""}
        <span class="st-art"><img src="/store/${esc(p.art)}.webp" alt="" loading="lazy" width="384" height="384" /></span>
        <span class="st-amount"><img src="/store/gem.webp" alt="" width="18" height="18" />${p.gems.toLocaleString(
          "en-IN"
        )}</span>
        <span class="st-price">₹${rupees(p.pricePaise)}</span>
      </button>`
    )
    .join("");

  grid.querySelectorAll<HTMLButtonElement>("[data-pack]").forEach((btn) => {
    btn.onclick = () => void buy(btn, shelf.packs.find((p) => p.id === btn.dataset.pack)!);
  });

}

// ---------------------------------------------------------------------------
// The payment popup
// ---------------------------------------------------------------------------

let popup: HTMLElement | null = null;
let popupTimer = 0;
let pollTimer = 0;
/** The session on screen, so a `wallet:update` for a DIFFERENT purchase — an
 *  admin granting gems while a QR is open — repaints the balance without
 *  closing the popup somebody is in the middle of paying. */
let openSessionId: string | null = null;

/** Close the popup. THE PAYMENT KEEPS RUNNING.
 *
 *  This used to cancel the session, which released the amount immediately —
 *  and that was wrong in the way that costs a real player real money. The flow
 *  this store asks for is "screenshot the QR and pay in another app", so the
 *  popup is closed ON THE WAY TO PAYING far more often than instead of it. The
 *  bank SMS then arrived with nothing holding that amount and the purchase had
 *  to be put right by hand.
 *
 *  So closing is only closing. The session lives its full two minutes plus its
 *  grace, the strip at the top of the store says so, and giving up is an
 *  explicit thing somebody chooses there. */
function closePopup(): void {
  window.clearInterval(popupTimer);
  window.clearInterval(pollTimer);
  openSessionId = null;
  popup?.remove();
  popup = null;
}

async function buy(btn: HTMLButtonElement, pack: Pack): Promise<void> {
  if (popup) return;
  btn.disabled = true;
  btn.classList.add("busy");
  let result: BuyResult;
  try {
    // Idempotent per pack on the server: if a payment for this one is already
    // live, this hands back that same session, amount and QR.
    result = await api.post<BuyResult>("/api/store/buy", { packId: pack.id });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't start that payment", true);
    return;
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
  showPopup(result);
}

function showPopup(r: BuyResult): void {
  closePopup();
  openSessionId = r.session.id;

  const el = document.createElement("div");
  el.className = "st-pay";
  el.innerHTML = `
    <div class="st-pay-card" role="dialog" aria-modal="true" aria-label="Pay for gems">
      <button class="st-pay-x" type="button" aria-label="Close">${icon("close")}</button>
      <div class="st-pay-head">
        <span class="st-pay-kicker">// Scan &amp; pay</span>
        <h3 class="st-pay-title">
          <img src="/store/gem.webp" alt="" width="26" height="26" />
          ${r.session.gems.toLocaleString("en-IN")} GEMS
        </h3>
      </div>

      <div class="st-pay-amount">
        <span class="st-pay-amount-label">Pay exactly</span>
        <span class="st-pay-amount-value">₹${rupees(r.session.amountPaise)}</span>
        ${
          r.session.collisionOffset > 0
            ? `<span class="st-pay-odd">Someone else is paying ₹${rupees(
                r.session.amountPaise - r.session.collisionOffset
              )} right now, so this amount is yours alone — it is how we know the payment was you.</span>`
            : ""
        }
      </div>

      <div class="st-qr">
        <img class="st-qr-img" src="${r.qrDataUrl}" alt="UPI QR code" width="512" height="512" />
        <div class="st-qr-veil" hidden>
          <span class="st-qr-veil-txt">QR CODE EXPIRED</span>
        </div>
      </div>

      <ol class="st-steps">
        <li><strong>Screenshot this QR</strong>, or press and hold to save it.</li>
        <li>Open any UPI app — GPay, PhonePe, Paytm — and scan the saved image.</li>
        <li>Pay <strong>exactly ₹${rupees(r.session.amountPaise)}</strong> to <strong>${esc(
          r.payeeName
        )}</strong>. Your gems arrive on their own.</li>
      </ol>

      <div class="st-pay-foot">
        <div class="st-countdown">${icon("clock", "st-clock")}<span class="st-time">2:00</span><span class="st-time-label">left to pay</span></div>
        <a class="st-open-upi" href="${esc(r.upiUri)}">Open a UPI app</a>
      </div>

      <p class="st-pay-note">
        Do not change the amount. Paying a different one means we cannot tell it was you, and it has to
        be sorted out by hand.
      </p>

      <div class="st-pay-done" hidden>
        <span class="st-done-tick">${icon("check")}</span>
        <strong>Paid</strong>
        <span class="st-done-sub"></span>
      </div>
    </div>`;
  document.getElementById("ui-root")!.appendChild(el);
  popup = el;

  const card = el.querySelector<HTMLElement>(".st-pay-card")!;
  const timeEl = el.querySelector<HTMLElement>(".st-time")!;
  const labelEl = el.querySelector<HTMLElement>(".st-time-label")!;
  const veil = el.querySelector<HTMLElement>(".st-qr-veil")!;
  const done = el.querySelector<HTMLElement>(".st-pay-done")!;

  el.querySelector<HTMLButtonElement>(".st-pay-x")!.onclick = () => closePopup();
  // The backdrop closes it, the card does not — a mis-tap while lining up a
  // screenshot must not throw away a QR somebody is about to pay.
  el.onclick = (e) => {
    if (e.target === el) closePopup();
  };

  const expiresAt = new Date(r.session.expiresAt).getTime();
  const graceUntil = new Date(r.session.graceUntil).getTime();

  const paint = () => {
    const now = Date.now();
    if (now < expiresAt) {
      const left = Math.ceil((expiresAt - now) / 1000);
      timeEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      labelEl.textContent = "left to pay";
      card.classList.toggle("ending", left <= 20);
      return;
    }
    // Expired, as far as the QR goes. The AMOUNT is still reserved, though, so
    // somebody who paid in the last moment is told to hold on rather than told
    // it failed — which it very probably has not.
    veil.hidden = false;
    card.classList.add("expired");
    if (now < graceUntil) {
      timeEl.textContent = `${Math.max(0, Math.ceil((graceUntil - now) / 1000))}s`;
      labelEl.textContent = "already paid? hold on";
      return;
    }
    timeEl.textContent = "—";
    labelEl.textContent = "expired";
    window.clearInterval(popupTimer);
  };
  paint();
  popupTimer = window.setInterval(paint, 500);

  const finish = (gems: number) => {
    window.clearInterval(popupTimer);
    window.clearInterval(pollTimer);
    openSessionId = null;
    card.classList.add("paid");
    done.hidden = false;
    done.querySelector<HTMLElement>(".st-done-sub")!.textContent = `${gems.toLocaleString(
      "en-IN"
    )} gems are in your account.`;
    // Long enough to read the number that just changed. A confirmation that is
    // gone before somebody has finished looking at it is a confirmation they
    // will not believe happened.
    window.setTimeout(() => closePopup(), 3400);
  };

  /** The fallback. A socket push arrives first when there is one, but a phone
   *  that switched apps to pay may well have dropped its connection — which is
   *  exactly the moment this has to work. */
  const poll = async () => {
    if (!openSessionId) return;
    try {
      const { session, balance } = await api.get<{ session: Session; balance: Balance }>(
        `/api/store/session/${r.session.id}`
      );
      setBalance(balance);
      if (session.status === "paid" || session.status === "approved") finish(session.gems);
      else if (Date.now() > graceUntil + 5000) window.clearInterval(pollTimer);
    } catch {
      /* a failed poll is not a failed payment — the next one will do */
    }
  };
  pollTimer = window.setInterval(() => void poll(), 3000);
}

/** The socket said the money landed. Called from main.ts.
 *
 *  Reaches a player whose popup is CLOSED as well as one watching it, which is
 *  the case that matters: they screenshotted the code, paid in another app,
 *  and are somewhere else entirely by the time the bank's message arrives. The
 *  chips repaint either way; this is what tells them why. */
export function walletUpdated(balance: Balance, paidSessionId: string | null): void {
  const before = latest.gems;
  setBalance(balance);
  if (!popup || !paidSessionId || paidSessionId !== openSessionId) {
    const gained = balance.gems - before;
    if (gained > 0) toast(`${gained.toLocaleString("en-IN")} gems added to your account`);
    return;
  }
  const card = popup.querySelector<HTMLElement>(".st-pay-card");
  const done = popup.querySelector<HTMLElement>(".st-pay-done");
  if (!card || !done || !done.hidden) return;
  window.clearInterval(popupTimer);
  window.clearInterval(pollTimer);
  openSessionId = null;
  card.classList.add("paid");
  done.hidden = false;
  done.querySelector<HTMLElement>(".st-done-sub")!.textContent = "Your gems are in your account.";
  // Long enough to read the number that just changed. A confirmation that is
  // gone before somebody has finished looking at it is a confirmation they
  // will not believe happened.
  window.setTimeout(() => closePopup(), 3400);
}
