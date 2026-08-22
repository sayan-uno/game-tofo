// The two switches that affect everybody at once.
//
// Maintenance mode turns new connections away — but leaves matches already
// running alone, because cutting those short is the thing maintenance is
// trying to avoid. Messages to players are NOT here: they live in Notices, so
// that every send is a row somebody can look at, resend, or take back.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, toast } from "../ui";

interface Flags {
  maintenance: boolean;
  /** Epoch ms the window opens; 0 when nothing is scheduled. */
  maintenanceAt: number;
  maintenanceMessage: string;
}

/** A datetime-local value, in the admin's own timezone. */
const localValue = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

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
            <b>Maintenance ${f.maintenance ? "— HAPPENING NOW" : f.maintenanceAt ? "— scheduled" : "— off"}</b>
            <span>${
              f.maintenance
                ? `Everybody is being held behind a notice they cannot close. ${esc(f.maintenanceMessage)}`
                : f.maintenanceAt
                  ? `Starts ${new Date(f.maintenanceAt).toLocaleString()}. Everyone online has been told; matches running then will be ended.`
                  : "Players can connect and play normally."
            }</span>
          </div>
          ${
            f.maintenance || f.maintenanceAt
              ? `<button class="btn ghost" id="maintoff" ${senior ? "" : "disabled"}>${
                  f.maintenance ? "End it" : "Call it off"
                }</button>`
              : `<button class="btn" id="maintplan" ${senior ? "" : "disabled"}>Schedule it</button>`
          }
        </div>
        ${
          f.maintenance || f.maintenanceAt
            ? ""
            : `<div class="switch">
                 <div class="txt">
                   <b>Start it right now</b>
                   <span>No warning, every match ended on the spot. For an emergency — otherwise schedule it.</span>
                 </div>
                 <button class="btn ghost" id="maintnow" ${senior ? "" : "disabled"}>Start now</button>
               </div>`
        }
      </div>
      <div class="card"><div class="pad" style="font-size:13.5px">
        Sending a message to players lives in <strong>Notices</strong>, where every send is recorded
        and can be taken back. It used to be here too, which meant a notice sent from this screen
        appeared on nobody's list and could not be undone.
      </div></div>
      ${senior ? "" : `<p class="muted" style="font-size:12.5px">These are admin and owner actions. You can see them, not change them.</p>`}`;

    if (!senior) return;

    host.querySelector<HTMLButtonElement>("#maintplan")?.addEventListener("click", async () => {
      const answer = await ask({
        title: "Schedule maintenance",
        intro:
          "Everyone online is told straight away. Anybody mid-match sees a line in the corner; " +
          "when the window opens every match is ended and nobody can play until you end it.",
        confirm: "Schedule it",
        fields: [
          { name: "at", label: "When it starts", type: "text", value: localValue(Date.now() + 45 * 60_000) },
          {
            name: "message",
            label: "What players are told",
            type: "textarea",
            value: "TOFO is going down for a short update — back shortly.",
          },
        ],
        async onSubmit(v) {
          const at = new Date(v.at).getTime();
          if (!Number.isFinite(at)) return "That is not a time I can read.";
          try {
            const done = await withSudo(() =>
              call<{ flags: Flags }>("/platform", {
                method: "POST",
                body: JSON.stringify({ maintenanceAt: at, maintenanceMessage: v.message }),
              })
            );
            return done === null ? "Cancelled." : null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) {
        toast("Maintenance scheduled. Everyone online has been told.");
        void load();
      }
    });

    host.querySelector<HTMLButtonElement>("#maintoff")?.addEventListener("click", async () => {
      try {
        const done = await withSudo(() =>
          call<{ flags: Flags }>("/platform", { method: "POST", body: JSON.stringify({ maintenanceAt: 0 }) })
        );
        if (done === null) return;
        toast("Maintenance is off. Players can get back in.");
        void load();
      } catch (e) {
        toast(e instanceof ApiFailure ? e.info.error : "That did not work");
      }
    });

    host.querySelector<HTMLButtonElement>("#maintnow")?.addEventListener("click", async () => {
      const answer = await ask({
        title: "Start maintenance NOW?",
        intro:
          "No warning is given. Every match in progress ends immediately and every player is held " +
          "behind a notice they cannot close. Schedule it instead unless this is an emergency.",
        confirm: "Start it now",
        danger: true,
        fields: [
          {
            name: "message",
            label: "What players are told",
            type: "textarea",
            value: "TOFO is down for maintenance — back shortly.",
          },
        ],
        async onSubmit(v) {
          if ((v.message ?? "").trim().length < 4) return "Say what is happening — every player is shown this.";
          try {
            const done = await withSudo(() =>
              call<{ flags: Flags }>("/platform", {
                method: "POST",
                body: JSON.stringify({ maintenance: true, maintenanceMessage: v.message }),
              })
            );
            return done === null ? "Cancelled." : null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) {
        toast("Maintenance has started.");
        void load();
      }
    });

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
