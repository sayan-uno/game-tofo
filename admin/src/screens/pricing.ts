// Price management — what the collection costs.
//
// This screen lists the CATALOG, not the price table, and that choice is the
// whole design. No row means free, so a table of prices would show only the
// things somebody has already thought about and silently omit everything they
// have not — and "what have I not priced yet" is the question this screen
// exists to answer.
//
// Three states per item, and they are deliberately three rather than two:
//
//   NOT PRICED   nobody has decided. Free, because that is the default.
//   FREE         an admin decided, out loud. Also free, and different.
//   PRICED       costs coins or gems, and is owned only once bought.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, num, pill, table, toast, when } from "../ui";

interface Row {
  id: string;
  kind: "character" | "weapon" | "emote";
  name: string;
  rarity?: string;
  /** False for the starter character and the movement clips — things no
   *  player chooses and none may therefore be charged for. */
  priceable: boolean;
  why?: string;
  /** null = free, whether decided or merely never set. */
  currency: "coin" | "gem" | null;
  price: number;
  /** True when somebody has actually set something, free included. */
  priced: boolean;
  owners: number;
  withdrawn: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

const MONEY: Record<string, { label: string; icon: string }> = {
  coin: { label: "coins", icon: "◉" },
  gem: { label: "gems", icon: "◆" },
};

export function mountPricing(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  let rows: Row[] = [];
  const filters = { kind: "", state: "", q: "" };
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const visible = () =>
    rows.filter((r) => {
      if (filters.kind && r.kind !== filters.kind) return false;
      if (filters.state === "free" && r.currency !== null) return false;
      if (filters.state === "paid" && r.currency === null) return false;
      if (filters.state === "unset" && r.priced) return false;
      if (filters.q && !`${r.name} ${r.id}`.toLowerCase().includes(filters.q.toLowerCase())) return false;
      return true;
    });

  const draw = () => {
    const shown = visible();
    const paid = rows.filter((r) => r.currency !== null);
    const inGems = paid.filter((r) => r.currency === "gem").length;

    host.innerHTML = `
      <div class="tiles">
        <div class="tile"><span class="t-label">In the collection</span><span class="t-value">${rows.length}</span>
          <span class="t-sub">characters, weapons and emotes</span></div>
        <div class="tile"><span class="t-label">Free</span><span class="t-value">${rows.length - paid.length}</span>
          <span class="t-sub">anyone can wear them</span></div>
        <div class="tile"><span class="t-label">Priced</span><span class="t-value">${paid.length}</span>
          <span class="t-sub">${inGems} for gems, ${paid.length - inGems} for coins</span></div>
        <div class="tile"><span class="t-label">Bought</span><span class="t-value">${num(
          rows.reduce((a, r) => a + r.owners, 0)
        )}</span><span class="t-sub">times, across every player</span></div>
      </div>

      <div class="card">
        <header><h2>Collection prices</h2><span class="spacer"></span>
          <span class="count">${shown.length}${shown.length === rows.length ? "" : ` of ${rows.length}`}</span></header>
        <div class="pad logfilters">
          <select data-f="kind">
            <option value="">everything</option>
            <option value="character">characters</option>
            <option value="weapon">weapons</option>
            <option value="emote">emotes</option>
          </select>
          <select data-f="state">
            <option value="">any price</option>
            <option value="free">free</option>
            <option value="paid">costs something</option>
            <option value="unset">never priced</option>
          </select>
          <input type="text" data-f="q" placeholder="a name or an id" size="18" />
          <span class="spacer" style="flex:1"></span>
          <span class="muted" style="font-size:12px">Nothing priced is free — that is the default, not a gap.</span>
        </div>
        ${table(
          ["Item", "What", "Price", "<th class='num'>Owners</th>", "Set by", ""].map((h) =>
            h.startsWith("<th") ? h : `<th>${h}</th>`
          ),
          shown.map(
            (r) => `<tr class="${r.withdrawn ? "forfeit" : ""}">
              <td>
                <strong>${esc(r.name)}</strong>
                ${r.withdrawn ? pill("withdrawn", "bad") : ""}
                <div class="muted mono" style="font-size:11px">${esc(r.id)}</div>
              </td>
              <td class="muted">${esc(r.kind)}${r.rarity ? `<div style="font-size:11px">${esc(r.rarity)}</div>` : ""}</td>
              <td>${
                r.currency
                  ? `<strong>${MONEY[r.currency].icon} ${r.price.toLocaleString()}</strong>
                     <div class="muted" style="font-size:11px">${MONEY[r.currency].label}</div>`
                  : r.priced
                    ? pill("free", "on")
                    : `<span class="muted">free — never priced</span>`
              }</td>
              <td class="num ${r.owners ? "" : "muted"}">${r.owners ? num(r.owners) : "—"}</td>
              <td class="muted" style="font-size:11.5px">${
                r.updatedBy ? `${esc(r.updatedBy)}<div>${when(r.updatedAt)}</div>` : "—"
              }</td>
              <td>${
                !senior
                  ? ""
                  : r.priceable
                    ? `<button class="btn ghost btn-tiny" data-price="${esc(r.id)}">Price it</button>`
                    : `<span class="muted" style="font-size:11.5px" title="${esc(r.why ?? "")}">not for sale</span>`
              }</td>
            </tr>`
          ),
          rows.length === 0 ? "The catalog is empty." : "Nothing matches those filters."
        )}
      </div>

      <div class="card"><div class="pad muted" style="font-size:12.5px">
        <strong>Coins</strong> are earned by playing; <strong>gems</strong> are bought with real money. Pricing
        something in gems is charging for it.
        <br><br>
        Everything is <strong>claimed</strong> before it can be worn, free or not. So pricing something can
        never take it off anybody who already has it — their claim is a row, and a row does not care what
        the thing costs today. Only somebody claiming it <strong>from now on</strong> pays.
      </div></div>
      ${senior ? "" : `<p class="muted" style="font-size:12.5px">Setting a price is an admin and owner action.</p>`}`;

    (host.querySelector('[data-f="kind"]') as HTMLSelectElement).value = filters.kind;
    (host.querySelector('[data-f="state"]') as HTMLSelectElement).value = filters.state;
    (host.querySelector('[data-f="q"]') as HTMLInputElement).value = filters.q;
    host.querySelectorAll<HTMLElement>("[data-f]").forEach((el) => {
      const key = el.dataset.f as keyof typeof filters;
      const apply = () => {
        filters[key] = (el as HTMLInputElement).value.trim();
        draw();
      };
      el.addEventListener("change", apply);
      if (el.tagName === "INPUT") el.addEventListener("input", apply);
    });

    host.querySelectorAll<HTMLButtonElement>("[data-price]").forEach((btn) => {
      btn.onclick = () => void price(rows.find((r) => r.id === btn.dataset.price)!);
    });
  };

  const price = async (item: Row) => {
    const answer = await ask({
      title: `Price ${item.name}`,
      intro:
        `${item.kind === "emote" ? "An emote" : item.kind === "weapon" ? "A weapon" : "A character"} in the ` +
        `collection.${item.owners > 0 ? ` ${item.owners} player(s) have claimed it already — they keep it.` : ""}`,
      confirm: "Save it",
      fields: [
        {
          name: "currency",
          label: "How it is paid for",
          type: "select",
          value: item.currency ?? "free",
          options: [
            { value: "free", label: "Free — anyone can wear it" },
            { value: "coin", label: "Coins — earned by playing" },
            { value: "gem", label: "Gems — bought with real money" },
          ],
        },
        {
          name: "price",
          label: "How many",
          value: item.price > 0 ? String(item.price) : "",
          note: "Ignored when it is free.",
        },
      ],
      async onSubmit(v) {
        if (v.currency !== "free") {
          const n = Number(v.price);
          if (!Number.isInteger(n) || n < 1) return "Give a whole number of at least 1, or choose Free.";
        }
        try {
          const done = await withSudo(() =>
            call(`/pricing/${encodeURIComponent(item.id)}`, {
              method: "POST",
              body: JSON.stringify({ currency: v.currency, price: Number(v.price || 0) }),
            })
          );
          return done === null ? "Cancelled." : null;
        } catch (e) {
          return e instanceof ApiFailure ? e.info.error : "That did not work";
        }
      },
    });
    if (answer) {
      toast("Saved.");
      void load();
    }
  };

  const load = async () => {
    try {
      const { items } = await call<{ items: Row[] }>("/pricing");
      if (cancelled) return;
      rows = items;
      draw();
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read the collection prices."
        )}</p></div>`;
      }
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
