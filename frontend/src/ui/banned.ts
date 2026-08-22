// What a banned player sees.
//
// Before this they got `Connection error: BANNED:Cheating` in a toast — the
// truth, delivered as though it were a bug. A sanction should say what it is,
// how long it lasts, and how to argue with it, because a decision with no way
// back is the one that turns a mistake into a lost player.
//
// The appeal goes into the SAME queue as everybody else's reports, and the
// route behind it is the one thing a full ban does not refuse. One a day: an
// appeal is answered by a person, and twenty copies do not make that person
// read faster.
import { api } from "../api/http";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "in 3 days", "in 2 hours" — a ban with no end reads as forever, and most of
 *  them are not. */
function until(iso: string | null): string {
  if (!iso) return "This one does not expire.";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "It has expired — try signing in again.";
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `It lifts in about ${h} hour${h === 1 ? "" : "s"}.`;
  const d = Math.round(h / 24);
  return `It lifts in about ${d} day${d === 1 ? "" : "s"}.`;
}

let open: HTMLElement | null = null;

export function showBanned(reason: string, expiresAt: string | null = null): void {
  if (open) return;
  const root = document.createElement("div");
  root.className = "bn-screen";
  root.innerHTML = `
    <div class="bn-card" role="alertdialog" aria-label="Account suspended">
      <div class="bn-kicker">// Account suspended</div>
      <h1 class="bn-title">You cannot play right now</h1>
      <p class="bn-reason"></p>
      <p class="bn-until">${esc(until(expiresAt))}</p>
      <div class="bn-appeal">
        <button class="btn btn-ghost bn-open" type="button">I think this is wrong</button>
        <div class="bn-form" hidden>
          <textarea class="bn-note" maxlength="500" rows="4"
            placeholder="What should we look at? Say which match, if you remember."></textarea>
          <div class="bn-row">
            <span class="bn-msg"></span>
            <button class="btn btn-red btn-small bn-send" type="button">Send it</button>
          </div>
        </div>
      </div>
    </div>`;

  // The reason is written by a moderator; it goes in as text.
  root.querySelector<HTMLElement>(".bn-reason")!.textContent = reason || "No reason was given.";
  document.getElementById("ui-root")!.appendChild(root);
  open = root;

  const form = root.querySelector<HTMLElement>(".bn-form")!;
  const msg = root.querySelector<HTMLElement>(".bn-msg")!;
  const send = root.querySelector<HTMLButtonElement>(".bn-send")!;

  root.querySelector<HTMLButtonElement>(".bn-open")!.onclick = (e) => {
    (e.currentTarget as HTMLButtonElement).hidden = true;
    form.hidden = false;
    root.querySelector<HTMLTextAreaElement>(".bn-note")!.focus();
  };

  send.onclick = () => {
    const note = root.querySelector<HTMLTextAreaElement>(".bn-note")!.value.trim();
    if (note.length < 3) {
      msg.textContent = "Say what you want looked at.";
      return;
    }
    send.disabled = true;
    send.textContent = "Sending…";
    msg.textContent = "";
    void api
      .post("/api/reports/appeal", { note })
      .then(() => {
        form.innerHTML = `<p class="bn-sent">Your appeal is in the queue. Somebody will read it.</p>`;
      })
      .catch((err: unknown) => {
        send.disabled = false;
        send.textContent = "Send it";
        msg.textContent = err instanceof Error ? err.message : "Could not send that";
      });
  };
}

export function hideBanned(): void {
  open?.remove();
  open = null;
}
