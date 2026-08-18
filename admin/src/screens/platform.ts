// The two switches that affect everybody at once.
//
// Maintenance mode turns new connections away — but leaves matches already
// running alone, because cutting those short is the thing maintenance is
// trying to avoid. The notice is pushed to everyone already online, which is
// why it goes out over the command channel rather than just being stored.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, toast } from "../ui";

interface Flags { maintenance: boolean; maintenanceMessage: string; notice: string }

export function mountPlatform(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (f: Flags) => {
    host.innerHTML = `
      <div class="card">
        <header><h2>Switches</h2></header>
        <div class="switch">
          <div class="txt">
            <b>Maintenance mode ${f.maintenance ? "— ON" : "— off"}</b>
            <span>${
              f.maintenance
                ? "Nobody new can connect. Matches already running are left to finish."
                : "Players can connect normally."
            }</span>
          </div>
          <button class="btn ${f.maintenance ? "ghost" : ""}" id="maint" ${senior ? "" : "disabled"}>
            ${f.maintenance ? "Turn off" : "Turn on"}
          </button>
        </div>
        <div class="switch">
          <div class="txt">
            <b>Notice to everyone online</b>
            <span>${f.notice ? esc(f.notice) : "Nothing is being shown."}</span>
          </div>
          <button class="btn ghost" id="notice" ${senior ? "" : "disabled"}>Send</button>
        </div>
      </div>
      ${senior ? "" : `<p class="muted" style="font-size:12.5px">These are admin and owner actions. You can see them, not change them.</p>`}`;

    if (!senior) return;

    host.querySelector<HTMLButtonElement>("#maint")!.onclick = async () => {
      const turningOn = !f.maintenance;
      const answer = await ask({
        title: turningOn ? "Turn maintenance mode ON?" : "Turn maintenance mode off?",
        intro: turningOn
          ? "Nobody new will be able to connect. Matches already running will be left to finish."
          : "Players will be able to connect again straight away.",
        confirm: turningOn ? "Turn it on" : "Turn it off",
        fields: turningOn
          ? [{ name: "message", label: "What players are told", value: "TOFO is down for maintenance — back shortly." }]
          : [],
        async onSubmit(v) {
          try {
            const done = await withSudo(() =>
              call<{ flags: Flags }>("/platform", {
                method: "POST",
                body: JSON.stringify({ maintenance: turningOn, maintenanceMessage: v.message ?? undefined }),
              })
            );
            return done === null ? "Cancelled." : null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) {
        toast(turningOn ? "Maintenance mode is on." : "Maintenance mode is off.");
        void load();
      }
    };

    host.querySelector<HTMLButtonElement>("#notice")!.onclick = async () => {
      const answer = await ask({
        title: "Send a notice",
        intro: "It appears for everyone who is online right now.",
        confirm: "Send it",
        fields: [{ name: "notice", label: "Message", type: "textarea", placeholder: "e.g. Ranked resets in 10 minutes." }],
        async onSubmit(v) {
          if (v.notice.trim().length < 3) return "Write something first.";
          try {
            const done = await withSudo(() =>
              call("/platform", { method: "POST", body: JSON.stringify({ notice: v.notice.trim() }) })
            );
            return done === null ? "Cancelled." : null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) {
        toast("Notice sent.");
        void load();
      }
    };
  };

  const load = async () => {
    try {
      const { flags } = await call<{ flags: Flags }>("/platform");
      if (!cancelled) draw(flags);
    } catch {
      if (!cancelled) host.innerHTML = `<div class="card"><p class="empty">Could not read the platform switches.</p></div>`;
    }
  };
  void load();
  return () => {
    cancelled = true;
  };
}
