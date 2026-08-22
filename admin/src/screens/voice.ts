// Who is being recorded, and what came back.
//
// The most intrusive screen in the console, and it is written to feel like it:
// it says out loud what a recording covers, it shows the budget counting down,
// and playing something back is a deliberate click that gets audited.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, pill, table, toast, when } from "../ui";

interface Status {
  ready: boolean; why: string; running: number; retentionDays: number; partyRetentionDays: number;
  recorder: { alive: boolean; sessions: number };
}
interface Target {
  id: string; uid: string; username: string | null; reason: string;
  createdAt: string; expiresAt: string; maxMatches: number; matchesUsed: number;
}


export function mountVoice(host: HTMLElement, role: string, go: (h: string) => void): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;

  const load = async () => {
    const [status, targets] = await Promise.all([
      call<Status>("/voice/status").catch(() => null),
      call<{ targets: Target[] }>("/voice/targets").catch(() => ({ targets: [] as Target[] })),
    ]);
    if (cancelled) return;
    draw(status, targets.targets);
  };

  function draw(status: Status | null, targets: Target[]): void {
    const banner = !status
      ? ""
      : status.ready
        ? `<div class="card"><div class="pad" style="font-size:13.5px">
             <strong>Recording is armed.</strong> The recorder is up and holding
             ${status.recorder.sessions} session${status.recorder.sessions === 1 ? "" : "s"}.
             Voice is kept for ${status.retentionDays} days, then deleted automatically.
             Every party is replayed for ${status.partyRetentionDays} days whether or not anyone is flagged;
             voice is added only when somebody in it is.
           </div></div>`
        : `<div class="card" style="border-color:var(--amber)"><div class="pad" style="color:var(--amber);font-size:13.5px">
             <strong>Voice recording is not available.</strong> ${esc(status.why)}.
             Parties are still replayed — only the sound is missing.
           </div></div>`;

    const targetRows = targets.map((t) => {
      const left = t.maxMatches - t.matchesUsed;
      return `<tr class="click" data-uid="${esc(t.uid)}">
        <td><strong>${esc(t.username ?? t.uid)}</strong></td>
        <td class="mono">${esc(t.uid)}</td>
        <td>${esc(t.reason)}</td>
        <td class="muted">${when(t.expiresAt)}</td>
        <td class="num">${left <= 3 ? pill(`${left} left`, "warn") : `${t.matchesUsed} / ${t.maxMatches}`}</td>
        <td>${senior ? `<button class="btn ghost stop" data-id="${esc(t.id)}" data-who="${esc(t.username ?? t.uid)}">Stop</button>` : ""}</td>
      </tr>`;
    });

    host.innerHTML = `
      ${banner}
      <div class="card">
        <header><h2>Being recorded</h2><span class="spacer"></span><span class="count">${targets.length}</span></header>
        ${table(
          ["Player", "UID", "Reason", "Expires", "Matches", ""].map(
            (h, i) => `<th${i === 4 ? ' style="text-align:right"' : ""}>${h}</th>`
          ),
          targetRows,
          "Nobody is being recorded. Start one from a player's page."
        )}
      </div>`;

    host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
      tr.onclick = () => go(`#/players/${tr.dataset.uid}`);
    });
    host.querySelectorAll<HTMLButtonElement>("button.stop").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        void stopRecording(b.dataset.id!, b.dataset.who!, load);
      };
    });
  }

  void load();
  return () => {
    cancelled = true;
  };
}

export async function stopRecording(id: string, who: string, reload: () => void): Promise<void> {
  const answer = await ask({
    title: `Stop recording ${who}?`,
    intro: "Nothing further is recorded. What has already been captured is kept until its retention runs out.",
    confirm: "Stop it",
    async onSubmit() {
      try {
        const done = await withSudo(() => call(`/voice/targets/${encodeURIComponent(id)}`, { method: "DELETE" }));
        return done === null ? "Cancelled." : null;
      } catch (e) {
        return e instanceof ApiFailure ? e.info.error : "That did not work";
      }
    },
  });
  if (answer) {
    toast(`Recording stopped for ${who}.`);
    reload();
  }
}

/** The action that appears on a player's page. */
export async function startRecording(uid: string, who: string, reload: () => void): Promise<void> {
  const answer = await ask({
    title: `Record ${who}'s voice?`,
    intro:
      "This records EVERYONE with them — in their matches and in their party — not only them. That is what makes it useful and it is also the reason it is budgeted, alerted and audited.",
    confirm: "Start recording",
    fields: [
      { name: "reason", label: "Why — ten characters or more", placeholder: "e.g. three reports of abusive voice chat this week" },
      { name: "days", label: "Stop after (days)", type: "select", value: "7",
        options: [1, 3, 7, 14, 30].map((d) => ({ value: String(d), label: `${d} day${d > 1 ? "s" : ""}` })) },
      { name: "matches", label: "Or after this many matches", type: "select", value: "20",
        options: [5, 10, 20, 50, 100].map((m) => ({ value: String(m), label: `${m} matches` })) },
    ],
    async onSubmit(v) {
      if (v.reason.trim().length < 10) return "Write a real reason — it is the record of why this happened.";
      try {
        const done = await withSudo(() =>
          call(`/players/${encodeURIComponent(uid)}/voice`, {
            method: "POST",
            body: JSON.stringify({ reason: v.reason.trim(), days: Number(v.days), matches: Number(v.matches) }),
          })
        );
        return done === null ? "Cancelled." : null;
      } catch (e) {
        return e instanceof ApiFailure ? e.info.error : "That did not work";
      }
    },
  });
  if (answer) {
    toast(`Recording ${who}. It stops on its own — by date or by match count.`);
    reload();
  }
}
