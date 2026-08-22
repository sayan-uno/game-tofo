// Reporting somebody.
//
// Opened from two places — a row on the results screen and another player's
// profile — because those are the two moments somebody actually wants it. A
// report filed from a results screen carries the match id, which is the whole
// point: it lands in the queue with the replay and any voice recording already
// attached to it, and an admin's first click is the studio rather than a
// forensic hunt for which match was meant.
//
// The sheet says the same thing however it ends. Whether the report was
// written down, silently deduped, or was about a bot, the player is told
// "Reported" and nothing else — a reporting button that reveals what happened
// to the person you reported is a button people press to find things out.
import { api } from "../api/http";
import { toast } from "./toast";

export interface ReportOptions {
  uid: string;
  name: string;
  /** Present when reporting from a results screen. */
  matchId?: string | null;
  lobbyId?: string | null;
}

const CATEGORIES: { id: string; label: string; hint: string }[] = [
  { id: "voice", label: "Abusive voice", hint: "What they said on the microphone" },
  { id: "text", label: "Abusive text", hint: "Messages in chat" },
  { id: "cheating", label: "Cheating", hint: "Playing in a way the game should not allow" },
  { id: "griefing", label: "Griefing", hint: "Ruining the match on purpose" },
  { id: "name", label: "Offensive name", hint: "Their username itself" },
];

const NOTE_MAX = 500;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let open: HTMLElement | null = null;

export function openReport(opts: ReportOptions): void {
  if (open) return;
  const root = document.createElement("div");
  root.className = "rp-backdrop";
  root.innerHTML = `
    <div class="rp-sheet" role="dialog" aria-label="Report player">
      <div class="rp-head">
        <span class="rp-kicker">// Report</span>
        <h2 class="rp-title"></h2>
        <button class="rp-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="rp-list">
        ${CATEGORIES.map(
          (c) => `<button class="rp-cat" type="button" data-id="${c.id}">
              <span class="rp-cat-label">${esc(c.label)}</span>
              <span class="rp-cat-hint">${esc(c.hint)}</span>
            </button>`
        ).join("")}
      </div>
      <div class="rp-note-wrap">
        <textarea class="rp-note" maxlength="${NOTE_MAX}" rows="3"
          placeholder="Anything else we should know? (optional)"></textarea>
      </div>
      <div class="rp-foot">
        <span class="rp-msg"></span>
        <button class="btn btn-ghost btn-small rp-cancel" type="button">Cancel</button>
        <button class="btn btn-red btn-small rp-send" type="button" disabled>Send report</button>
      </div>
    </div>`;

  // The name goes in as text, never as markup: it is somebody's own writing.
  root.querySelector<HTMLElement>(".rp-title")!.textContent = opts.name || opts.uid;
  document.getElementById("ui-root")!.appendChild(root);
  open = root;

  const close = () => {
    root.remove();
    if (open === root) open = null;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  root.querySelector<HTMLButtonElement>(".rp-close")!.onclick = close;
  root.querySelector<HTMLButtonElement>(".rp-cancel")!.onclick = close;
  root.addEventListener("pointerdown", (e) => {
    if (e.target === root) close();
  });

  let picked: string | null = null;
  const send = root.querySelector<HTMLButtonElement>(".rp-send")!;
  const msg = root.querySelector<HTMLElement>(".rp-msg")!;

  root.querySelectorAll<HTMLButtonElement>(".rp-cat").forEach((btn) => {
    btn.onclick = () => {
      picked = btn.dataset.id!;
      root.querySelectorAll(".rp-cat").forEach((b) => b.classList.toggle("picked", b === btn));
      send.disabled = false;
    };
  });

  send.onclick = () => {
    if (!picked) return;
    send.disabled = true;
    send.textContent = "Sending…";
    msg.textContent = "";
    void api
      .post("/api/reports", {
        uid: opts.uid,
        category: picked,
        note: root.querySelector<HTMLTextAreaElement>(".rp-note")!.value,
        matchId: opts.matchId ?? undefined,
        lobbyId: opts.lobbyId ?? undefined,
      })
      .then(() => {
        close();
        toast("Reported. Thanks — somebody will look.");
      })
      .catch((err: unknown) => {
        send.disabled = false;
        send.textContent = "Send report";
        msg.textContent = err instanceof Error ? err.message : "Could not send that";
      });
  };
}

export function closeReport(): void {
  open?.remove();
  open = null;
}
