// Which matches can be watched.
//
// Built from the ROWS rather than the archived files: opening fifty replays to
// draw a table would be absurd, and Postgres already knows who played what.
import { call } from "../api";
import { esc, num, pill, table, when } from "../ui";

interface Row {
  matchKey: string; gameId: string; bytes: number; tier: string;
  expiresAt: string | null; createdAt: string;
  reason: string | null; playerCount: number | null; ticks: number | null;
  players: { name: string; placement: number; isBot: boolean; uid: string | null }[];
}

export function mountMatches(host: HTMLElement, uid: string, go: (h: string) => void): () => void {
  let cancelled = false;
  host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;

  void (async () => {
    const query = uid ? `?uid=${encodeURIComponent(uid)}` : "";
    const { replays } = await call<{ replays: Row[] }>(`/replays${query}`).catch(() => ({ replays: [] as Row[] }));
    if (cancelled) return;

    const rows = replays.map((r) => {
      const winner = r.players.find((p) => p.placement === 1);
      const humans = r.players.filter((p) => !p.isBot).length;
      return `<tr class="click" data-key="${esc(r.matchKey)}">
        <td class="mono">${esc(r.gameId)}</td>
        <td class="muted">${when(r.createdAt)}</td>
        <td>${winner ? `<strong>${esc(winner.name)}</strong>` : `<span class="muted">—</span>`}</td>
        <td class="num">${humans} / ${num(r.playerCount)}</td>
        <td><span class="muted">${esc(r.reason ?? "—")}</span></td>
        <td>${r.tier === "hold" ? pill("kept", "warn") : `<span class="muted">${esc(r.tier)}</span>`}</td>
        <td class="num muted">${num(r.bytes)} B</td>
        <td class="mono muted">${esc(r.matchKey)}</td>
      </tr>`;
    });

    host.innerHTML = `<div class="card">
      <header>
        <h2>${uid ? "Matches for this player" : "Recent matches"}</h2>
        <span class="spacer"></span><span class="count">${replays.length}</span>
      </header>
      ${table(
        // The match id is shown, not just carried in the row: an admin needs
        // to be able to read one off the screen and paste it into a query.
        ["Game", "When", "Winner", "People", "Ended", "Retention", "Size", "Match"].map(
          (h, i) => `<th${i === 3 || i === 6 ? ' style="text-align:right"' : ""}>${h}</th>`
        ),
        rows,
        "No replays yet. They appear as matches finish."
      )}
    </div>
    <p class="muted" style="font-size:12.5px">Open one to watch it back.</p>`;

    host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
      tr.onclick = () => go(`#/matches/${tr.dataset.key}`);
    });
  })();

  return () => {
    cancelled = true;
  };
}
