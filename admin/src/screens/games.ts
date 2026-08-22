// Taking a game away — from everybody, or from one person.
//
// Two powers, deliberately on one screen, because they are the same decision
// at two sizes and an admin reaching for one should see the other.
//
// Neither touches a match already running. By the time a game is being held,
// what matters is the matches about to start; ending the ones in flight would
// punish the players least involved.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, pill, table, toast } from "../ui";

interface GameRow {
  id: string;
  name: string;
  heldReason: string | null;
  banned: { uid: string | null; username: string | null; reason: string }[];
}

interface Item {
  id: string;
  name: string;
  kind: "character" | "weapon" | "emote";
  withdrawn: boolean;
}

export function mountGames(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (games: GameRow[], items: Item[]) => {
    const held = games.filter((g) => g.heldReason).length;
    host.innerHTML = `
      <div class="card"><div class="pad" style="font-size:13.5px">
        Holding a game stops anyone <strong>starting</strong> it. Matches already running
        are left to finish — cutting those short punishes the players least involved.
        A player barred from one game keeps the rest of the platform.
        ${held > 0 ? `<strong>${held} on hold right now.</strong>` : ""}
      </div></div>
      ${games
        .map(
          (g) => `<div class="card">
        <header>
          <h2>${esc(g.name)} <span class="mono muted" style="font-size:11.5px">${esc(g.id)}</span></h2>
          <span class="spacer"></span>
          ${g.heldReason ? pill("on hold", "bad") : pill("playable", "on")}
        </header>
        <div class="switch">
          <div class="txt">
            <b>${g.heldReason ? "Nobody can start this" : "Anyone can start this"}</b>
            <span>${g.heldReason ? esc(g.heldReason) : "No hold in place."}</span>
          </div>
          <button class="btn ${g.heldReason ? "ghost" : ""}" data-hold="${esc(g.id)}" ${senior ? "" : "disabled"}>
            ${g.heldReason ? "Let them play" : "Hold it"}
          </button>
        </div>
        <div class="switch">
          <div class="txt">
            <b>Barred from this game</b>
            <span>${
              g.banned.length === 0
                ? "Nobody."
                : g.banned
                    .map((b) => `${esc(b.username ?? b.uid ?? "?")} — ${esc(b.reason)}`)
                    .join(" · ")
            }</span>
          </div>
          <button class="btn ghost" data-ban="${esc(g.id)}" ${senior ? "" : "disabled"}>Bar a player</button>
        </div>
        ${g.banned
          .map(
            (b) => `<div class="switch">
              <div class="txt"><b class="mono">${esc(b.uid ?? "?")}</b><span>${esc(b.reason)}</span></div>
              <button class="btn ghost" data-unban="${esc(g.id)}" data-uid="${esc(b.uid ?? "")}" ${
                senior ? "" : "disabled"
              }>Let them play</button>
            </div>`
          )
          .join("")}
      </div>`
        )
        .join("")}
      <div class="card">
        <header><h2>Collection</h2><span class="spacer"></span>
          <span class="count">${items.filter((i) => i.withdrawn).length} withdrawn</span></header>
        <div class="pad" style="font-size:13.5px">
          Withdrawing an item is not deleting it. It stays in the game and in the bucket — it simply
          stops being offered and stops being accepted, so a client that asks for it anyway is refused.
          Anybody already wearing it keeps it on until they change.
        </div>
        ${table(
          ["Item", "Kind", "", ""].map((h) => `<th>${h}</th>`),
          items.map(
            (i) => `<tr class="${i.withdrawn ? "forfeit" : ""}">
              <td><strong>${esc(i.name)}</strong> <span class="mono muted" style="font-size:11px">${esc(i.id)}</span></td>
              <td class="muted">${esc(i.kind)}</td>
              <td>${i.withdrawn ? pill("withdrawn", "bad") : pill("available", "on")}</td>
              <td>${
                senior
                  ? `<button class="btn ghost" data-item="${esc(i.id)}" data-on="${i.withdrawn ? "0" : "1"}">${
                      i.withdrawn ? "Put it back" : "Withdraw"
                    }</button>`
                  : ""
              }</td>
            </tr>`
          ),
          "The catalogue is empty."
        )}
      </div>
      ${
        senior
          ? ""
          : `<p class="muted" style="font-size:12.5px">These are admin and owner actions. You can see them, not change them.</p>`
      }`;

    if (!senior) return;

    host.querySelectorAll<HTMLButtonElement>("[data-hold]").forEach((btn) => {
      const g = games.find((x) => x.id === btn.dataset.hold)!;
      btn.onclick = async () => {
        const turningOn = !g.heldReason;
        const answer = await ask({
          title: turningOn ? `Hold ${g.name}?` : `Let people play ${g.name} again?`,
          intro: turningOn
            ? "Nobody will be able to pick it or start it. Matches already running finish normally."
            : "It becomes playable again straight away.",
          confirm: turningOn ? "Hold it" : "Release it",
          // Players are SHOWN this, so it is not optional and not a code.
          fields: turningOn
            ? [{ name: "reason", label: "What players are told", value: `${g.name} is unavailable for a moment.` }]
            : [],
          async onSubmit(v) {
            try {
              const done = await withSudo(() =>
                call(`/games/${encodeURIComponent(g.id)}/hold`, {
                  method: "POST",
                  body: JSON.stringify({ on: turningOn, reason: v.reason ?? undefined }),
                })
              );
              return done === null ? "Cancelled." : null;
            } catch (e) {
              return e instanceof ApiFailure ? e.info.error : "That did not work";
            }
          },
        });
        if (answer) {
          toast(turningOn ? `${g.name} is on hold.` : `${g.name} is playable again.`);
          void load();
        }
      };
    });

    host.querySelectorAll<HTMLButtonElement>("[data-ban]").forEach((btn) => {
      const g = games.find((x) => x.id === btn.dataset.ban)!;
      btn.onclick = async () => {
        const answer = await ask({
          title: `Bar somebody from ${g.name}`,
          intro: "They keep every other game. Their party is told who is holding it up, by name.",
          confirm: "Bar them",
          fields: [
            { name: "uid", label: "Their UID" },
            { name: "reason", label: "What they are told", placeholder: "e.g. Repeatedly ruining Ludo for others." },
          ],
          async onSubmit(v) {
            if (!v.uid?.trim()) return "Which player?";
            try {
              const done = await withSudo(() =>
                call(`/games/${encodeURIComponent(g.id)}/ban`, {
                  method: "POST",
                  body: JSON.stringify({ uid: v.uid.trim(), on: true, reason: v.reason }),
                })
              );
              return done === null ? "Cancelled." : null;
            } catch (e) {
              return e instanceof ApiFailure ? e.info.error : "That did not work";
            }
          },
        });
        if (answer) {
          toast(`Barred from ${g.name}.`);
          void load();
        }
      };
    });

    host.querySelectorAll<HTMLButtonElement>("[data-item]").forEach((btn) => {
      btn.onclick = async () => {
        const on = btn.dataset.on === "1";
        try {
          const done = await withSudo(() =>
            call<{ ok: boolean }>(`/collection/${encodeURIComponent(btn.dataset.item!)}`, {
              method: "POST",
              body: JSON.stringify({ on }),
            })
          );
          if (done === null) return;
          toast(on ? "Withdrawn — nobody can see or wear it." : "Back in the collection.");
          void load();
        } catch (e) {
          toast(e instanceof ApiFailure ? e.info.error : "That did not work");
        }
      };
    });

    host.querySelectorAll<HTMLButtonElement>("[data-unban]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const done = await withSudo(() =>
            call<{ ok: boolean }>(`/games/${encodeURIComponent(btn.dataset.unban!)}/ban`, {
              method: "POST",
              body: JSON.stringify({ uid: btn.dataset.uid, on: false }),
            })
          );
          if (done === null) return;
          toast("They can play it again.");
          void load();
        } catch (e) {
          toast(e instanceof ApiFailure ? e.info.error : "That did not work");
        }
      };
    });
  };

  const load = async () => {
    try {
      const [{ games }, { items }] = await Promise.all([
        call<{ games: GameRow[] }>("/games"),
        call<{ items: Item[] }>("/collection"),
      ]);
      if (!cancelled) draw(games, items);
    } catch {
      if (!cancelled) host.innerHTML = `<div class="card"><p class="empty">Could not read the games.</p></div>`;
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
