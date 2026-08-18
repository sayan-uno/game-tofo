// Small shared pieces. Nothing clever — but two of them matter for safety and
// one for sanity, so they live in one place rather than being re-typed.
//
//   esc()  — EVERY value that reaches innerHTML goes through this. Player
//            names, admin names and user-agent strings are all chosen by
//            somebody else; a console where one person can run script in
//            another's session is not a console.
//   when() — a relative time you can read at a glance, with the exact one on
//            hover, because "3h ago" is what you want when scanning and
//            "2026-08-18 10:46:15" is what you want when writing it down.

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);

export function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

export const num = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "—";

/** Seconds as something a person reads: 45s, 12m, 3h 20m, 4d 6h. */
export function duration(sec: number | null | undefined): string {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return `<span class="muted">—</span>`;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return `<span class="muted">—</span>`;
  const secs = (Date.now() - t.getTime()) / 1000;
  const rel =
    secs < 45 ? "just now"
    : secs < 5400 ? `${Math.round(secs / 60)}m ago`
    : secs < 172800 ? `${Math.round(secs / 3600)}h ago`
    : `${Math.round(secs / 86400)}d ago`;
  return `<time title="${esc(t.toISOString().replace("T", " ").slice(0, 19))} UTC">${rel}</time>`;
}

export const pill = (text: string, kind: "" | "on" | "off" | "bad" | "warn" = ""): string =>
  `<span class="pill ${kind}">${esc(text)}</span>`;

/** A sanction type as the console words it. The database stores a short key;
 *  nobody should have to remember that "match" means "cannot be matched". */
export const sanctionLabel = (type: string): string =>
  ({
    ban: "banned",
    match: "no matchmaking",
    voice: "voice muted",
    chat: "chat muted",
    "shadow-chat": "shadow muted",
  })[type] ?? type;

const ICONS: Record<string, string> = {
  gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M13.4 10.6 19 5"/><path d="M20.5 15a9 9 0 1 0-17 0"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  play: '<path d="M6 4v16"/><path d="m10 5 9 7-9 7Z"/>',
};
export const icon = (name: keyof typeof ICONS | string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

let toastTimer: number | undefined;
export function toast(message: string): void {
  document.querySelector(".toast")?.remove();
  const t = el(`<div class="toast" role="status">${esc(message)}</div>`);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 4000);
}

/** Rows into a table, or a sentence explaining why there are none. Empty
 *  states say what would put something there — a blank panel just looks
 *  broken. */
export function table(head: string[], rows: string[], emptyMessage: string, tall = false): string {
  if (rows.length === 0) return `<p class="empty">${esc(emptyMessage)}</p>`;
  return `<div class="wrap${tall ? " tall" : ""}"><table class="tbl">
    <thead><tr>${head.join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody></table></div>`;
}
