// The queue, and the cases it turns into.
//
// This screen is the front door of the whole console. Everything else answers
// a question; this is where the question arrives — and it arrives from a
// player who was in the match, which is why a report filed from a results
// screen carries the match id and a case opened from it is one click away from
// the studio.
//
// TRIAGE IS TWO BUTTONS. Read a report and it is either nothing — dismiss it,
// and the row is kept, because forty dismissed reports from one person is
// itself a pattern — or it is something, and something means a case. There is
// no third state to get stuck in and no queue-within-a-queue.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { esc, pill, table, toast, when } from "../ui";

interface Report {
  id: string;
  kind: "report" | "appeal";
  reporterUid: string;
  reporterName: string | null;
  subjectUid: string;
  subjectName: string | null;
  category: string;
  note: string | null;
  matchKey: string | null;
  lobbyId: string | null;
  caseId: string | null;
  caseRef: string | null;
  status: "new" | "attached" | "dismissed";
  createdAt: string;
}

interface CaseSummary {
  id: string;
  ref: string;
  subjectUid: string;
  subjectName: string | null;
  status: "open" | "resolved";
  title: string;
  assignedTo: string | null;
  openedAt: string;
  resolution: string | null;
  reportCount: number;
}

const WHY: Record<string, string> = {
  voice: "abusive voice",
  text: "abusive text",
  cheating: "cheating",
  griefing: "griefing",
  name: "offensive name",
  appeal: "appealing a sanction",
};

export function mountReports(host: HTMLElement, role: string, go: (hash: string) => void): () => void {
  let cancelled = false;
  const canAct = role === "moderator" || role === "admin" || role === "owner";
  let status: "new" | "attached" | "dismissed" | "all" = "new";
  let picked = new Set<string>();
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (reports: Report[], cases: CaseSummary[]) => {
    if (cancelled) return;
    const rows = reports.map((r) => {
      const about = `<a href="#/players/${esc(r.subjectUid)}">${esc(r.subjectName ?? r.subjectUid)}</a>`;
      const by = `<a href="#/players/${esc(r.reporterUid)}">${esc(r.reporterName ?? r.reporterUid)}</a>`;
      // The match id is a LINK, because the reason a report carries one is so
      // that watching what happened is a click and not an investigation.
      const where = r.matchKey
        ? `<a href="#/matches/${encodeURIComponent(r.matchKey)}">watch</a>`
        : r.lobbyId
          ? `<a href="#/parties/${encodeURIComponent(r.lobbyId)}">party</a>`
          : `<span class="muted">—</span>`;
      return `<tr class="${r.status === "dismissed" ? "forfeit" : ""}">
        <td>${
          canAct && r.status === "new"
            ? `<input type="checkbox" class="pick" data-id="${esc(r.id)}" ${picked.has(r.id) ? "checked" : ""}>`
            : ""
        }</td>
        <td class="muted">${when(r.createdAt)}</td>
        <td>${r.kind === "appeal" ? pill("appeal", "warn") : about}</td>
        <td>${esc(WHY[r.category] ?? r.category)}</td>
        <td>${r.note ? esc(r.note) : `<span class="muted">no note</span>`}</td>
        <td>${by}</td>
        <td>${where}</td>
        <td>${
          r.caseRef
            ? `<a href="#/cases/${esc(r.caseRef)}">${esc(r.caseRef)}</a>`
            : r.status === "dismissed"
              ? pill("dismissed", "off")
              : pill("waiting", "warn")
        }</td>
      </tr>`;
    });

    const openCases = cases.filter((c) => c.status === "open");
    host.innerHTML = `
      <div class="card"><div class="pad" style="font-size:13.5px">
        A report is what a player said. A case is what we did about it — and the case is what
        carries the evidence and exports as a file somebody else can read.
        ${reports.filter((r) => r.status === "new").length > 0 ? `<strong>${reports.filter((r) => r.status === "new").length} waiting.</strong>` : "Nothing is waiting."}
      </div></div>

      <div class="card">
        <header>
          <h2>Reports</h2>
          <span class="spacer"></span>
          <select id="rstatus">
            <option value="new"${status === "new" ? " selected" : ""}>Waiting</option>
            <option value="attached"${status === "attached" ? " selected" : ""}>On a case</option>
            <option value="dismissed"${status === "dismissed" ? " selected" : ""}>Dismissed</option>
            <option value="all"${status === "all" ? " selected" : ""}>All</option>
          </select>
          <span class="count">${reports.length}</span>
        </header>
        ${
          canAct
            ? `<div class="pad" id="bulk" ${picked.size ? "" : 'style="display:none"'}>
                 <button class="btn" id="mkcase">Open a case on ${picked.size} report(s)</button>
                 <button class="btn ghost" id="dismiss">Dismiss them</button>
               </div>`
            : ""
        }
        ${table(
          ["", "When", "About", "Why", "What they said", "Reported by", "Where", "Case"].map((h) => `<th>${h}</th>`),
          rows,
          status === "new" ? "Nothing waiting. That is the good outcome." : "Nothing here."
        )}
      </div>

      <div class="card">
        <header><h2>Open cases</h2><span class="spacer"></span><span class="count">${openCases.length}</span></header>
        ${table(
          ["Case", "About", "Title", "Reports", "Assigned", "Opened"].map((h) => `<th>${h}</th>`),
          openCases.map(
            (c) => `<tr>
              <td><a href="#/cases/${esc(c.ref)}"><b>${esc(c.ref)}</b></a></td>
              <td><a href="#/players/${esc(c.subjectUid)}">${esc(c.subjectName ?? c.subjectUid)}</a></td>
              <td>${esc(c.title)}</td>
              <td class="muted">${c.reportCount}</td>
              <td class="muted">${c.assignedTo ? esc(c.assignedTo) : "—"}</td>
              <td class="muted">${when(c.openedAt)}</td>
            </tr>`
          ),
          "No case is open."
        )}
      </div>
      ${canAct ? "" : `<p class="muted" style="font-size:12.5px">Working the queue is a moderator action. You can read it.</p>`}`;

    host.querySelector<HTMLSelectElement>("#rstatus")!.onchange = (e) => {
      status = (e.target as HTMLSelectElement).value as typeof status;
      picked = new Set();
      void load();
    };

    host.querySelectorAll<HTMLInputElement>(".pick").forEach((box) => {
      box.onchange = () => {
        if (box.checked) picked.add(box.dataset.id!);
        else picked.delete(box.dataset.id!);
        const bulk = host.querySelector<HTMLElement>("#bulk");
        if (bulk) {
          bulk.style.display = picked.size ? "" : "none";
          bulk.querySelector("#mkcase")!.textContent = `Open a case on ${picked.size} report(s)`;
        }
      };
    });

    host.querySelector<HTMLButtonElement>("#mkcase")?.addEventListener("click", () => {
      const chosen = reports.filter((r) => picked.has(r.id));
      const subjects = new Set(chosen.map((r) => r.subjectUid));
      if (subjects.size !== 1) {
        toast("One case is about one player. Pick reports about the same person.");
        return;
      }
      const uid = [...subjects][0];
      void ask({
        title: "Open a case",
        intro: `About ${uid}. Everything you attach to it is kept while the case is open — replays, voice, and their chat.`,
        confirm: "Open it",
        fields: [
          {
            name: "title",
            label: "What is it about",
            value: chosen.length === 1 ? (WHY[chosen[0].category] ?? "") : "Several reports",
          },
        ],
        async onSubmit(v) {
          try {
            const r = await call<{ case: CaseSummary }>("/cases", {
              method: "POST",
              body: JSON.stringify({ uid, title: v.title, reportIds: [...picked] }),
            });
            picked = new Set();
            go(`#/cases/${r.case.ref}`);
            return null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
    });

    host.querySelector<HTMLButtonElement>("#dismiss")?.addEventListener("click", () => {
      void ask({
        title: `Dismiss ${picked.size} report(s)?`,
        intro:
          "They stay on record — a player who files dozens of reports that come to nothing is a pattern worth seeing later.",
        confirm: "Dismiss",
        danger: true,
        fields: [{ name: "reason", label: "Why (for the audit trail)", placeholder: "e.g. nothing in the replay" }],
        async onSubmit(v) {
          try {
            await call("/reports/dismiss", {
              method: "POST",
              body: JSON.stringify({ ids: [...picked], reason: v.reason }),
            });
            picked = new Set();
            void load();
            return null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
    });
  };

  const load = async () => {
    try {
      const [r, c] = await Promise.all([
        call<{ reports: Report[] }>(`/reports?status=${status}`),
        call<{ cases: CaseSummary[] }>("/cases?status=open"),
      ]);
      if (!cancelled) draw(r.reports, c.cases);
    } catch {
      if (!cancelled) host.innerHTML = `<div class="card"><p class="empty">Could not read the queue.</p></div>`;
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
