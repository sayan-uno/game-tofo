// Who is worth watching, and who they might already be.
//
// TWO THINGS THIS SCREEN IS NOT. It is not a verdict — every score here has an
// innocent explanation, and the only thing it decides is the order to watch
// matches in. And it is not shown to a player, ever: a cheating score that
// leaks teaches whoever is cheating exactly which dial to turn down.
//
// So the score is always printed WITH ITS REASONS, in words, next to a button
// that opens the match. A number nobody can question is a number nobody should
// trust, and the studio is the thing that actually answers the question.
import { ApiFailure, call } from "../api";
import { esc, num, pill, table } from "../ui";

interface Ranked {
  uid: string;
  username: string | null;
  matches: number;
  inputs: number;
  rejects: number;
  rateRejects: number;
  earlyRejects: number;
  cadence: number | null;
  wins: number;
  contested: number;
  suspicion: { score: number; reasons: string[] };
  lastMatchKey: string | null;
}

interface AltNode {
  uid: string;
  username: string | null;
  banned: boolean;
}
interface AltEdge {
  a: string;
  b: string;
  kind: "device" | "ip";
  seen: number;
}

/** Three bands, because a continuous 0–100 invites false precision. */
const band = (n: number) => (n >= 60 ? "bad" : n >= 30 ? "warn" : "");

export function mountSignals(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  let days = 14;
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (players: Ranked[]) => {
    if (cancelled) return;
    host.innerHTML = `
      <div class="card"><div class="pad" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <span style="font-size:13.5px">
          Measured by the server while it played along — inputs it refused, timing that does not
          vary, wins against real people. <strong>A ranking, not an accusation:</strong> every one of
          these has an innocent explanation, and the studio is what decides.
        </span>
        <span class="spacer" style="flex:1"></span>
        <select id="win">
          <option value="7"${days === 7 ? " selected" : ""}>7 days</option>
          <option value="14"${days === 14 ? " selected" : ""}>14 days</option>
          <option value="30"${days === 30 ? " selected" : ""}>30 days</option>
        </select>
      </div></div>

      <div class="card">
        <header><h2>Worth watching</h2><span class="spacer"></span><span class="count">${players.length}</span></header>
        ${table(
          ["Score", "Player", "Why", "Matches", "Refused", "Timing", "Won", ""].map((h) => `<th>${h}</th>`),
          players.map(
            (p) => `<tr>
              <td>${pill(String(p.suspicion.score), band(p.suspicion.score))}</td>
              <td><a href="#/players/${esc(p.uid)}">${esc(p.username ?? p.uid)}</a></td>
              <td style="max-width:340px">${
                p.suspicion.reasons.length
                  ? p.suspicion.reasons.map((r) => `<div>${esc(r)}</div>`).join("")
                  : `<span class="muted">—</span>`
              }</td>
              <td class="muted">${num(p.matches)}</td>
              <td class="muted">${num(p.rejects)}${
                p.rateRejects ? ` <span class="muted">(${p.rateRejects} rate)</span>` : ""
              }</td>
              <td class="muted">${p.cadence === null ? "—" : `${p.cadence}%`}</td>
              <td class="muted">${p.contested ? `${p.wins}/${p.contested}` : "—"}</td>
              <td>${
                p.lastMatchKey
                  ? `<a href="#/matches/${encodeURIComponent(p.lastMatchKey)}">watch</a>`
                  : `<span class="muted">—</span>`
              }${senior ? ` <button class="btn ghost btn-tiny" data-alts="${esc(p.uid)}">alts</button>` : ""}</td>
            </tr>`
          ),
          "Nobody stands out. That is the ordinary state of things."
        )}
        <div class="pad muted" style="font-size:12.5px">
          Timing is the share of a player's input gaps that are exactly the same length. People vary
          by tens of milliseconds even when trying not to; scripts do not. It is blank for games the
          server takes turns for, where regular means the rules are working.
        </div>
      </div>

      ${senior ? `<div class="card" id="altcard" hidden></div>` : ""}`;

    host.querySelector<HTMLSelectElement>("#win")!.onchange = (e) => {
      days = Number((e.target as HTMLSelectElement).value);
      void load();
    };

    host.querySelectorAll<HTMLButtonElement>("[data-alts]").forEach((btn) => {
      btn.onclick = () => void showAlts(btn.dataset.alts!);
    });
  };

  /** The alt graph for one player. Drawn as a list rather than a spring layout
   *  on purpose: what a moderator needs is "who, how strongly, and are any of
   *  them already banned", and a tangle of circles answers none of those. */
  const showAlts = async (uid: string) => {
    const card = host.querySelector<HTMLElement>("#altcard");
    if (!card) return;
    card.hidden = false;
    card.innerHTML = `<div class="pad"><p class="empty">Looking…</p></div>`;
    try {
      const g = await call<{ nodes: AltNode[]; edges: AltEdge[] }>(`/signals/alts/${encodeURIComponent(uid)}`);
      const by = new Map(g.nodes.map((n) => [n.uid, n]));
      const linked = g.edges
        .flatMap((e) => [
          { other: e.a === uid ? e.b : e.a, kind: e.kind, seen: e.seen, direct: e.a === uid || e.b === uid },
        ])
        .filter((l) => l.other !== uid);
      // Strongest evidence first: a shared device beats a shared address, and
      // a shared address alone is barely evidence at all.
      linked.sort((a, b) => (a.kind === b.kind ? b.seen - a.seen : a.kind === "device" ? -1 : 1));

      card.innerHTML = `
        <header><h2>Linked to ${esc(by.get(uid)?.username ?? uid)}</h2>
          <span class="spacer"></span>
          <span class="count">${linked.length}</span>
          <button class="btn ghost btn-tiny" id="altclose">close</button>
        </header>
        ${table(
          ["Account", "How", "Seen", ""].map((h) => `<th>${h}</th>`),
          linked.map((l) => {
            const n = by.get(l.other);
            return `<tr>
              <td><a href="#/players/${esc(l.other)}">${esc(n?.username ?? l.other)}</a>
                  ${n?.banned ? pill("banned", "bad") : ""}</td>
              <td>${
                l.kind === "device"
                  ? `<b>same device</b>`
                  : `<span class="muted">same address</span>`
              }</td>
              <td class="muted">${num(l.seen)}</td>
              <td>${l.kind === "ip" ? `<span class="muted" style="font-size:12px">weak on its own</span>` : ""}</td>
            </tr>`;
          }),
          "Nothing links this account to another."
        )}
        <div class="pad muted" style="font-size:12.5px">
          A shared <b>device</b> is the same browser on the same machine — strong. A shared
          <b>address</b> is not: families, campuses and mobile carriers put strangers behind one all
          day. Opening this is recorded in the audit trail.
        </div>`;
      card.querySelector<HTMLButtonElement>("#altclose")!.onclick = () => {
        card.hidden = true;
      };
    } catch (e) {
      card.innerHTML = `<div class="pad"><p class="empty">${esc(
        e instanceof ApiFailure ? e.info.error : "Could not read that"
      )}</p></div>`;
    }
  };

  const load = async () => {
    try {
      const r = await call<{ players: Ranked[] }>(`/signals?days=${days}`);
      if (!cancelled) draw(r.players);
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read the signals"
        )}</p></div>`;
      }
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
