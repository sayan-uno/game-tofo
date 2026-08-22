// Notices that were sent, and can be taken back.
//
// ONE SEND IS ONE ROW, whoever it reached. A notice to the whole platform is
// not forty thousand rows to tidy — it is one line saying who it went to, with
// one button that takes it back.
//
// Taking it back matters in exactly one window: before the people who were
// offline come back. After that it is only tidying. That is why the list shows
// the audience so plainly — "everyone" is the one where deleting still changes
// what somebody will see.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, pill, table, toast, when } from "../ui";

interface Notice {
  id: string;
  body: string;
  audience: "everyone" | "online" | "players";
  uids: string[];
  sentBy: string | null;
  sentAt: string;
  deletedAt: string | null;
}

const who = (n: Notice): string =>
  n.audience === "everyone"
    ? "everyone, including anybody who has not signed in yet"
    : n.audience === "online"
      ? `${n.uids.length} online at the time`
      : n.uids.join(", ");

export function mountNotices(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (notices: Notice[]) => {
    const live = notices.filter((n) => !n.deletedAt).length;
    host.innerHTML = `
      <div class="card"><div class="pad" style="font-size:13.5px">
        Players read these in their lobby, whenever they like. Deleting one takes it off every
        list and stops it reaching anybody who was offline when it went out — which is the only
        window in which taking it back changes anything.
        ${live > 0 ? `<strong>${live} standing.</strong>` : ""}
        <span class="spacer"></span>
      </div>
      <div class="pad"><button class="btn" id="send" ${senior ? "" : "disabled"}>Send a notice</button></div>
      </div>
      <div class="card">
        <header><h2>Sent</h2><span class="spacer"></span><span class="count">${notices.length}</span></header>
        ${table(
          ["When", "Message", "Who saw it", "", ""].map((h) => `<th>${h}</th>`),
          notices.map(
            (n) => `<tr class="${n.deletedAt ? "forfeit" : ""}">
              <td class="muted">${when(n.sentAt)}</td>
              <td>${esc(n.body)}</td>
              <td class="muted">${esc(who(n))}</td>
              <td>${n.deletedAt ? pill("taken back", "bad") : pill("standing", "on")}</td>
              <td>${
                n.deletedAt || !senior
                  ? ""
                  : `<button class="btn ghost" data-del="${esc(n.id)}">Take it back</button>`
              }</td>
            </tr>`
          ),
          "Nothing has been sent."
        )}
      </div>
      ${senior ? "" : `<p class="muted" style="font-size:12.5px">Sending is an admin and owner action.</p>`}`;

    host.querySelector<HTMLButtonElement>("#send")?.addEventListener("click", async () => {
      const answer = await ask({
        title: "Send a notice",
        intro: "Players can read it, close it, and find it again in their lobby.",
        confirm: "Send it",
        fields: [
          { name: "body", label: "Message", type: "textarea", placeholder: "e.g. Ranked resets in 10 minutes." },
          {
            name: "audience",
            label: "Who sees it",
            type: "select",
            value: "online",
            options: [
              { value: "online", label: "Everyone online right now" },
              { value: "everyone", label: "Everyone — including people who are offline" },
              { value: "players", label: "Only the UIDs below" },
            ],
          },
          { name: "uids", label: "UIDs, separated by commas", placeholder: "1234567890, 9876543210" },
        ],
        async onSubmit(v) {
          if (v.body.trim().length < 3) return "Write something first.";
          if (v.audience === "players" && !v.uids.trim()) return "Which players? Give at least one UID.";
          try {
            const done = await withSudo(() =>
              call("/notices", {
                method: "POST",
                body: JSON.stringify({ body: v.body, audience: v.audience, uids: v.uids }),
              })
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
    });

    host.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        const n = notices.find((x) => x.id === btn.dataset.del);
        const answer = await ask({
          title: "Take this notice back?",
          intro:
            n?.audience === "everyone"
              ? "It disappears from every player's list, and nobody who was offline will ever see it."
              : "It disappears from the list of everybody it was sent to.",
          confirm: "Take it back",
          danger: true,
          async onSubmit() {
            try {
              const done = await withSudo(() =>
                call<{ ok: boolean }>(`/notices/${encodeURIComponent(btn.dataset.del!)}`, { method: "DELETE" })
              );
              return done === null ? "Cancelled." : null;
            } catch (e) {
              return e instanceof ApiFailure ? e.info.error : "That did not work";
            }
          },
        });
        if (answer) {
          toast("Taken back.");
          void load();
        }
      };
    });
  };

  const load = async () => {
    try {
      const { notices } = await call<{ notices: Notice[] }>("/notices");
      if (!cancelled) draw(notices);
    } catch {
      if (!cancelled) host.innerHTML = `<div class="card"><p class="empty">Could not read the notices.</p></div>`;
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
