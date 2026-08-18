// Everything currently in force, newest first.
//
// The point of this screen is the question "who is under a sanction right
// now" — which the player pages cannot answer, because you would have to know
// who to look at first.
import { call } from "../api";
import { esc, pill, sanctionLabel, table, when } from "../ui";

interface Row {
  id: string; type: string; reason: string; createdAt: string;
  expiresAt: string | null; uid: string; username: string | null;
}

export function mountSanctions(host: HTMLElement, go: (h: string) => void): () => void {
  let cancelled = false;
  host.innerHTML = `<p class="empty">Loading…</p>`;

  void (async () => {
    const { sanctions } = await call<{ sanctions: Row[] }>("/sanctions").catch(() => ({ sanctions: [] as Row[] }));
    if (cancelled) return;
    const rows = sanctions.map(
      (s) => `<tr class="click" data-uid="${esc(s.uid)}">
        <td><strong>${esc(s.username ?? s.uid)}</strong></td>
        <td class="mono">${esc(s.uid)}</td>
        <td>${pill(sanctionLabel(s.type), "bad")}</td>
        <td>${esc(s.reason)}</td>
        <td class="muted">${when(s.createdAt)}</td>
        <td class="muted">${s.expiresAt ? when(s.expiresAt) : "permanent"}</td>
      </tr>`
    );
    host.innerHTML = `<div class="card">
      <header><h2>In force</h2><span class="spacer"></span><span class="count">${sanctions.length}</span></header>
      ${table(
        ["Player", "UID", "Type", "Reason", "Applied", "Until"].map((h) => `<th>${h}</th>`),
        rows,
        "Nothing is in force. Nobody is banned, barred or muted."
      )}
    </div>
    <p class="muted" style="font-size:12.5px">Open a player to lift a sanction or add one.</p>`;
    host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
      tr.onclick = () => go(`#/players/${tr.dataset.uid}`);
    });
  })();

  return () => {
    cancelled = true;
  };
}
