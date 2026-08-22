// One case: what was reported, what was found, and what was decided.
//
// The timeline is the screen. Notes, evidence and decisions are one list in
// the order they happened, because that is how somebody reads a case they did
// not work on — and it is exactly what the export writes out. Two views of one
// list beats two lists that have to agree.
//
// ATTACHING EVIDENCE IS NOT DECORATION. A replay attached here stops being
// swept by retention, and the subject's chat stops being deleted at fifteen
// days while the case is open. Closing the case lets both go again.
import { ApiFailure, call, callBlob } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, icon, pill, table, toast, when } from "../ui";

interface CaseRow {
  id: string;
  ref: string;
  subjectUid: string;
  subjectName: string | null;
  status: "open" | "resolved";
  title: string;
  assignedTo: string | null;
  openedBy: string | null;
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  reportCount: number;
}

interface Item {
  id: string;
  kind: string;
  refId: string | null;
  atMs: number | null;
  body: string | null;
  addedBy: string | null;
  createdAt: string;
}

interface Report {
  id: string;
  category: string;
  note: string | null;
  reporterUid: string;
  matchKey: string | null;
  caseId: string | null;
  createdAt: string;
}

const KIND: Record<string, string> = {
  report: "report",
  note: "note",
  replay: "replay attached",
  voice: "recording attached",
  moment: "moment flagged",
  sanction: "sanction",
  status: "",
};

export function mountCase(host: HTMLElement, ref: string, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  const canAct = senior || role === "moderator";
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (c: CaseRow, timeline: Item[], reports: Report[]) => {
    if (cancelled) return;
    const mine = reports.filter((r) => r.caseId === c.id);
    const others = reports.filter((r) => r.caseId !== c.id);

    host.innerHTML = `
      <div class="card">
        <header>
          <h2>${esc(c.ref)}</h2>
          ${c.status === "open" ? pill("open", "on") : pill("resolved", "off")}
          <span class="spacer"></span>
          ${
            senior
              ? c.status === "open"
                ? `<button class="btn" id="resolve">Resolve</button>`
                : `<button class="btn ghost" id="reopen">Reopen</button>`
              : ""
          }
          ${senior ? `<button class="btn ghost" id="export">${icon("box")} Export case file</button>` : ""}
        </header>
        <div class="pad">
          <div style="font-size:15px;margin-bottom:6px"><b>${esc(c.title)}</b></div>
          <div class="muted" style="font-size:13px">
            About <a href="#/players/${esc(c.subjectUid)}">${esc(c.subjectName ?? c.subjectUid)}</a>
            · opened ${when(c.openedAt)}${c.openedBy ? ` by ${esc(c.openedBy)}` : ""}
            · ${mine.length} report(s)
            ${c.assignedTo ? `· assigned to ${esc(c.assignedTo)}` : ""}
          </div>
          ${
            c.status === "resolved"
              ? `<div class="pad" style="padding-left:0"><b>${esc(c.resolution ?? "")}</b>${
                  c.resolutionNote ? ` — ${esc(c.resolutionNote)}` : ""
                }<span class="muted"> (${esc(c.resolvedBy ?? "")}, ${when(c.resolvedAt)})</span></div>`
              : `<div class="muted" style="font-size:12.5px;margin-top:6px">
                   While this is open, the evidence on it is kept: replays are not swept and
                   ${esc(c.subjectName ?? c.subjectUid)}'s chat is not deleted at fifteen days.
                 </div>`
          }
        </div>
      </div>

      <div class="card">
        <header><h2>Reported</h2><span class="spacer"></span><span class="count">${mine.length}</span></header>
        ${table(
          ["When", "Why", "What they said", "By", "Where"].map((h) => `<th>${h}</th>`),
          mine.map(
            (r) => `<tr>
              <td class="muted">${when(r.createdAt)}</td>
              <td>${esc(r.category)}</td>
              <td>${r.note ? esc(r.note) : `<span class="muted">no note</span>`}</td>
              <td><a href="#/players/${esc(r.reporterUid)}">${esc(r.reporterUid)}</a></td>
              <td>${
                r.matchKey
                  ? `<a href="#/matches/${encodeURIComponent(r.matchKey)}">watch</a>
                     ${canAct ? `<button class="btn ghost btn-tiny" data-attach="${esc(r.matchKey)}">attach</button>` : ""}`
                  : `<span class="muted">—</span>`
              }</td>
            </tr>`
          ),
          "No report — an admin opened this."
        )}
        ${
          others.length && canAct
            ? `<div class="pad"><button class="btn ghost" id="more">${others.length} other report(s) about this player — attach them</button></div>`
            : ""
        }
      </div>

      <div class="card">
        <header>
          <h2>What happened</h2>
          <span class="spacer"></span>
          ${canAct ? `<button class="btn ghost" id="note">Add a note</button>` : ""}
          ${canAct ? `<button class="btn ghost" id="evidence">Attach evidence</button>` : ""}
        </header>
        <div class="pad">
          ${
            timeline.length
              ? `<ol class="timeline">${timeline
                  .map(
                    (i) => `<li>
                      <span class="muted">${when(i.createdAt)}</span>
                      ${KIND[i.kind] ? `<b>${esc(KIND[i.kind])}</b> ` : ""}
                      ${
                        i.kind === "replay" && i.refId
                          ? `<a href="#/matches/${encodeURIComponent(i.refId)}">${esc(i.refId)}</a>`
                          : i.kind === "moment" && i.refId
                            ? `<a href="#/matches/${encodeURIComponent(i.refId)}?at=${i.atMs ?? 0}">at ${(
                                (i.atMs ?? 0) / 1000
                              ).toFixed(1)}s</a>`
                            : ""
                      }
                      ${i.body ? `<div>${esc(i.body)}</div>` : ""}
                      ${i.addedBy ? `<span class="muted" style="font-size:12px">${esc(i.addedBy)}</span>` : ""}
                    </li>`
                  )
                  .join("")}</ol>`
              : `<p class="empty">Nothing yet.</p>`
          }
        </div>
      </div>`;

    host.querySelector<HTMLButtonElement>("#note")?.addEventListener("click", () => {
      void ask({
        title: "Add a note",
        intro: "It goes on the timeline, and into the export. Write it for somebody who was not here.",
        confirm: "Add it",
        fields: [{ name: "body", label: "Note", type: "textarea" }],
        async onSubmit(v) {
          if (v.body.trim().length < 2) return "Write something first.";
          try {
            await call(`/cases/${c.id}/items`, {
              method: "POST",
              body: JSON.stringify({ kind: "note", body: v.body }),
            });
            void load();
            return null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
    });

    host.querySelector<HTMLButtonElement>("#evidence")?.addEventListener("click", () => {
      void ask({
        title: "Attach evidence",
        intro: "A match, a recording, or a moment inside a match. Attaching a match stops retention sweeping it.",
        confirm: "Attach",
        fields: [
          {
            name: "kind",
            label: "What",
            type: "select",
            value: "replay",
            options: [
              { value: "replay", label: "A match (by its id)" },
              { value: "voice", label: "A voice recording (by its id)" },
              { value: "moment", label: "A moment inside a match" },
            ],
          },
          { name: "refId", label: "Its id", placeholder: "match id, or recording id" },
          { name: "atMs", label: "At (seconds into the match, for a moment)", placeholder: "e.g. 74.5" },
          { name: "body", label: "What it shows", type: "textarea" },
        ],
        async onSubmit(v) {
          if (!v.refId.trim()) return "Which one?";
          try {
            await call(`/cases/${c.id}/items`, {
              method: "POST",
              body: JSON.stringify({
                kind: v.kind,
                refId: v.refId.trim(),
                atMs: v.atMs ? Math.round(Number(v.atMs) * 1000) : null,
                body: v.body,
              }),
            });
            void load();
            return null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
    });

    host.querySelectorAll<HTMLButtonElement>("[data-attach]").forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await call(`/cases/${c.id}/items`, {
            method: "POST",
            body: JSON.stringify({ kind: "replay", refId: btn.dataset.attach, body: "From a report" }),
          });
          toast("Attached, and kept.");
          void load();
        } catch {
          btn.disabled = false;
          toast("Could not attach that");
        }
      };
    });

    host.querySelector<HTMLButtonElement>("#more")?.addEventListener("click", async () => {
      try {
        await call(`/cases/${c.id}/attach`, {
          method: "POST",
          body: JSON.stringify({ reportIds: others.map((r) => r.id) }),
        });
        void load();
      } catch {
        toast("Could not attach those");
      }
    });

    host.querySelector<HTMLButtonElement>("#resolve")?.addEventListener("click", () => {
      void ask({
        title: "Resolve this case",
        intro: "Say what was decided. This is the sentence the export leads with.",
        confirm: "Resolve",
        fields: [
          {
            name: "resolution",
            label: "What was decided",
            type: "select",
            value: "no-action",
            options: [
              { value: "no-action", label: "Nothing — the reports did not hold up" },
              { value: "warned", label: "Warned" },
              { value: "sanctioned", label: "Sanctioned" },
            ],
          },
          { name: "note", label: "Why", type: "textarea" },
        ],
        async onSubmit(v) {
          try {
            await call(`/cases/${c.id}/resolve`, {
              method: "POST",
              body: JSON.stringify({ resolution: v.resolution, note: v.note }),
            });
            void load();
            return null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
    });

    host.querySelector<HTMLButtonElement>("#reopen")?.addEventListener("click", async () => {
      try {
        await call(`/cases/${c.id}/reopen`, { method: "POST" });
        void load();
      } catch {
        toast("Could not reopen it");
      }
    });

    // The export is a download, and downloads do not carry an Authorization
    // header. So it is fetched like everything else and handed to the browser
    // as a blob — which also means a failure is a message on screen rather
    // than a tab that opens onto an error page.
    host.querySelector<HTMLButtonElement>("#export")?.addEventListener("click", async () => {
      const btn = host.querySelector<HTMLButtonElement>("#export")!;
      btn.disabled = true;
      btn.textContent = "Building…";
      try {
        const blob = await withSudo(() => callBlob(`/cases/${c.id}/export`));
        if (blob) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${c.ref}.zip`;
          a.click();
          URL.revokeObjectURL(url);
          toast("Exported.");
        }
      } catch (e) {
        toast(e instanceof ApiFailure ? e.info.error : "Could not build the file");
      }
      btn.disabled = false;
      btn.innerHTML = `${icon("box")} Export case file`;
    });
  };

  const load = async () => {
    try {
      const r = await call<{ case: CaseRow; timeline: Item[]; reports: Report[] }>(
        `/cases/${encodeURIComponent(ref)}`
      );
      if (!cancelled) draw(r.case, r.timeline, r.reports);
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read that case"
        )}</p></div>`;
      }
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
