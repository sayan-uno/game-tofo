// Orders — who took what, and what it cost them.
//
// One row per CLAIM, free ones included, because "who has this" and "who paid
// for this" are the same question with a filter on it rather than two tables.
// A free claim is still a thing somebody chose, and knowing which free items
// people actually take is how you find out what is worth pricing.
//
// The window means the same thing here as on the payment screens, so one can
// be lined up against the other: gems bought on one, gems spent on this.
import { ApiFailure, call } from "../api";
import { esc, num, pill, table, when } from "../ui";
import { bindWindowBar, lastHours, windowBar, windowParams, type Window } from "../timeWindow";

interface Order {
  uid: string;
  username: string | null;
  itemId: string;
  currency: "coin" | "gem" | null;
  pricePaid: number;
  source: string;
  at: string;
}

interface Totals {
  claims: number;
  paid: number;
  coins: number;
  gems: number;
  players: number;
  top: { itemId: string; claims: number; coins: number; gems: number }[];
}

/** What a row's `source` actually means. The database stores one word; nobody
 *  should have to remember which of them predate the claim system. */
const SOURCE: Record<string, { label: string; kind: "" | "on" | "off" | "bad" | "warn" }> = {
  purchase: { label: "bought", kind: "on" },
  claim: { label: "claimed free", kind: "" },
  grant: { label: "given by an admin", kind: "warn" },
  legacy: { label: "already had it", kind: "off" },
  grandfathered: { label: "already wearing it", kind: "off" },
};

export function mountOrders(host: HTMLElement, go: (h: string) => void): () => void {
  let cancelled = false;
  const w: Window = lastHours(24 * 7);
  const filters = { currency: "", who: "" };
  let rows: Order[] = [];
  let cursor: string | null = null;

  host.innerHTML = `<p class="empty">Loading…</p>`;

  const rowHtml = (o: Order): string => {
    const src = SOURCE[o.source] ?? { label: o.source, kind: "" as const };
    return `<tr>
      <td class="muted">${when(o.at)}</td>
      <td>
        <strong class="click" data-uid="${esc(o.uid)}" style="cursor:pointer">${esc(o.username ?? o.uid)}</strong>
        <div class="muted mono" style="font-size:11px">${esc(o.uid)}</div>
      </td>
      <td class="mono">${esc(o.itemId)}</td>
      <td class="num">${
        o.currency
          ? `<strong>${o.currency === "gem" ? "◆" : "◉"} ${num(o.pricePaid)}</strong>
             <div class="muted" style="font-size:11px">${o.currency === "gem" ? "gems" : "coins"}</div>`
          : `<span class="muted">free</span>`
      }</td>
      <td>${pill(src.label, src.kind)}</td>
    </tr>`;
  };

  const draw = (totals: Totals | null) => {
    host.innerHTML = `
      <div class="tiles">
        <div class="tile"><span class="t-label">Claims</span><span class="t-value">${
          totals ? num(totals.claims) : "—"
        }</span><span class="t-sub">items taken in this window</span></div>
        <div class="tile"><span class="t-label">Paid for</span><span class="t-value">${
          totals ? num(totals.paid) : "—"
        }</span><span class="t-sub">the rest were free</span></div>
        <div class="tile"><span class="t-label">Gems spent</span><span class="t-value">${
          totals ? num(totals.gems) : "—"
        }</span><span class="t-sub">bought with real money</span></div>
        <div class="tile"><span class="t-label">Coins spent</span><span class="t-value">${
          totals ? num(totals.coins) : "—"
        }</span><span class="t-sub">earned by playing</span></div>
        <div class="tile"><span class="t-label">Players</span><span class="t-value">${
          totals ? num(totals.players) : "—"
        }</span><span class="t-sub">took at least one thing</span></div>
      </div>

      <div class="card">
        <header><h2>Orders</h2><span class="spacer"></span><span class="count" id="n">${rows.length}</span></header>
        ${windowBar(w, {
          extra: `
            <select data-f="currency">
              <option value="">everything</option>
              <option value="gem">paid in gems</option>
              <option value="coin">paid in coins</option>
              <option value="free">free</option>
            </select>
            <input type="text" data-f="who" placeholder="a UID, a name or an item" size="18" />`,
          note: "One row per claim — free ones too.",
        })}
        <div id="tbl">${table(
          ["When", "Who", "What", "<th class='num'>Paid</th>", "How"].map((h) =>
            h.startsWith("<th") ? h : `<th>${h}</th>`
          ),
          rows.map(rowHtml),
          "Nothing was claimed in this window."
        )}</div>
        <div class="pad"><button class="btn ghost" id="more" ${cursor ? "" : "hidden"}>Load more</button></div>
      </div>

      ${
        totals && totals.top.length
          ? `<div class="card">
              <header><h2>What people take</h2><span class="spacer"></span>
                <span class="count">${totals.top.length}</span></header>
              <div class="wrap"><table class="tbl">
                <thead><tr><th>Item</th><th class="num">Claims</th><th class="num">Gems</th><th class="num">Coins</th></tr></thead>
                <tbody>${totals.top
                  .map(
                    (t) => `<tr>
                      <td class="mono">${esc(t.itemId)}</td>
                      <td class="num">${num(t.claims)}</td>
                      <td class="num ${t.gems ? "" : "muted"}">${t.gems ? num(t.gems) : "—"}</td>
                      <td class="num ${t.coins ? "" : "muted"}">${t.coins ? num(t.coins) : "—"}</td>
                    </tr>`
                  )
                  .join("")}</tbody>
              </table></div>
              <div class="pad muted" style="font-size:12.5px">
                Ordered by how often each is taken. A free item near the top is one worth thinking about
                pricing; a priced one near the bottom is one priced too high.
              </div>
            </div>`
          : ""
      }`;

    (host.querySelector('[data-f="currency"]') as HTMLSelectElement).value = filters.currency;
    (host.querySelector('[data-f="who"]') as HTMLInputElement).value = filters.who;
    host.querySelectorAll<HTMLElement>("[data-f]").forEach((el) => {
      const key = el.dataset.f as keyof typeof filters;
      el.addEventListener("change", () => {
        filters[key] = (el as HTMLInputElement).value.trim();
        void load();
      });
      el.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") {
          filters[key] = (el as HTMLInputElement).value.trim();
          void load();
        }
      });
    });
    bindWindowBar(host, w, () => void load());
    host.querySelector<HTMLButtonElement>("#more")!.onclick = () => void load(true);
    wireRows();
  };

  const wireRows = () => {
    host.querySelectorAll<HTMLElement>("[data-uid]").forEach((el) => {
      el.onclick = () => go(`#/players/${encodeURIComponent(el.dataset.uid!)}`);
    });
  };

  const load = async (append = false) => {
    const params = windowParams(w);
    if (filters.currency) params.set("currency", filters.currency);
    if (filters.who) params.set("who", filters.who);
    if (append && cursor) params.set("cursor", cursor);
    try {
      const [page, totals] = await Promise.all([
        call<{ orders: Order[]; cursor: string | null }>(`/orders?${params}`),
        append ? Promise.resolve(null) : call<Totals>(`/orders/totals?${windowParams(w)}`).catch(() => null),
      ]);
      if (cancelled) return;
      cursor = page.cursor;
      rows = append ? [...rows, ...page.orders] : page.orders;
      if (append) {
        host.querySelector("#tbl tbody")?.insertAdjacentHTML("beforeend", page.orders.map(rowHtml).join(""));
        host.querySelector<HTMLElement>("#n")!.textContent = String(rows.length);
        host.querySelector<HTMLButtonElement>("#more")!.hidden = !cursor;
        wireRows();
      } else {
        draw(totals);
      }
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read the orders."
        )}</p></div>`;
      }
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
