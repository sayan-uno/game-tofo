// One player's money, on their own page.
//
// Not a screen of its own: the question it answers — "they say they paid, did
// they?" — is asked while looking at a person, and making somebody carry a UID
// across to another screen to answer it is how support calls get long.
//
// Loaded separately from the profile so a slow money query can never delay the
// page somebody actually came for.
import { ApiFailure, call } from "./api";
import { ask } from "./modal";
import { withSudo } from "./sudo";
import { esc, pill, rupees, table, toast, when } from "./ui";

interface Balance {
  coins: number;
  gems: number;
  spentPaise: number;
}
interface LedgerRow {
  id: number;
  currency: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  ref: string | null;
  note: string | null;
  createdAt: string;
}
interface SessionRow {
  id: string;
  packId: string;
  gems: number;
  amountPaise: number;
  collisionOffset: number;
  status: string;
  createdAt: string;
}
interface WalletData {
  balance: Balance;
  ledger: LedgerRow[];
  sessions: SessionRow[];
}

const REASON: Record<string, string> = {
  purchase: "bought — SMS matched",
  "purchase.manual": "bought — approved by hand",
  "admin.grant": "granted by an admin",
  match: "played a match",
  event: "an event",
  spend: "spent",
};

const STATE: Record<string, "" | "on" | "off" | "bad" | "warn"> = {
  paid: "on",
  approved: "on",
  pending: "warn",
  expired: "off",
  cancelled: "off",
};

/** Paint the wallet block into a slot the profile already rendered. */
export function mountWallet(host: HTMLElement, uid: string, role: string): void {
  const senior = role === "admin" || role === "owner";

  const draw = (d: WalletData) => {
    host.innerHTML = `
      <div class="tiles" style="margin-bottom:10px">
        <div class="tile"><span class="t-label">Gems</span><span class="t-value">${d.balance.gems.toLocaleString()}</span>
          <span class="t-sub">bought, never earned</span></div>
        <div class="tile"><span class="t-label">Coins</span><span class="t-value">${d.balance.coins.toLocaleString()}</span>
          <span class="t-sub">earned by playing</span></div>
        <div class="tile"><span class="t-label">Paid us</span><span class="t-value">₹${rupees(
          d.balance.spentPaise
        )}</span><span class="t-sub">lifetime, actually received</span></div>
      </div>
      ${
        senior
          ? `<div class="pad" style="display:flex;gap:8px"><button class="btn ghost" id="grant">Grant or take back</button></div>`
          : ""
      }
      <div class="pad"><strong style="font-size:13px">Payments they opened</strong></div>
      ${table(
        ["When", "Pack", "<th class='num'>Amount</th>", "State"].map((h) => (h.startsWith("<th") ? h : `<th>${h}</th>`)),
        d.sessions.map(
          (s) => `<tr>
            <td class="muted">${when(s.createdAt)}</td>
            <td>${s.gems.toLocaleString()} gems<div class="muted mono" style="font-size:11px">${esc(s.packId)}</div></td>
            <td class="num">₹${rupees(s.amountPaise)}${
              s.collisionOffset > 0
                ? `<div class="muted" style="font-size:11px">+${s.collisionOffset}p to keep it unique</div>`
                : ""
            }</td>
            <td>${pill(s.status, STATE[s.status] ?? "")}</td>
          </tr>`
        ),
        "They have never opened a payment."
      )}
      <div class="pad"><strong style="font-size:13px">Every movement</strong></div>
      ${table(
        ["When", "What", "<th class='num'>Change</th>", "<th class='num'>After</th>", "Note"].map((h) =>
          h.startsWith("<th") ? h : `<th>${h}</th>`
        ),
        d.ledger.map(
          (l) => `<tr>
            <td class="muted">${when(l.createdAt)}</td>
            <td>${esc(REASON[l.reason] ?? l.reason)}<div class="muted" style="font-size:11px">${esc(l.currency)}</div></td>
            <td class="num" style="color:${l.delta < 0 ? "var(--crimson)" : "var(--green)"}">${
              l.delta > 0 ? "+" : ""
            }${l.delta.toLocaleString()}</td>
            <td class="num muted">${l.balanceAfter.toLocaleString()}</td>
            <td class="muted" style="font-size:11.5px">${esc(l.note ?? l.ref ?? "")}</td>
          </tr>`
        ),
        "Nothing has ever moved in this wallet."
      )}`;

    host.querySelector<HTMLButtonElement>("#grant")?.addEventListener("click", async () => {
      const answer = await ask({
        title: "Change this player's balance",
        intro:
          "Use a negative number to take some back. Gems are somebody's money — granting them without a payment " +
          "is a decision recorded against your name.",
        confirm: "Do it",
        fields: [
          {
            name: "currency",
            label: "Which",
            type: "select",
            value: "coin",
            options: [
              { value: "coin", label: "Coins — earned currency" },
              { value: "gem", label: "Gems — bought currency" },
            ],
          },
          { name: "delta", label: "How many", placeholder: "e.g. 500, or -500" },
          { name: "note", label: "Why", placeholder: "e.g. compensation for the outage on the 21st" },
        ],
        async onSubmit(v) {
          const delta = Number(v.delta);
          if (!Number.isInteger(delta) || delta === 0) return "A whole number, and not zero.";
          if (v.note.trim().length < 4) return "Say why — this has to be answerable for later.";
          try {
            const done = await withSudo(() =>
              call(`/players/${encodeURIComponent(uid)}/wallet`, {
                method: "POST",
                body: JSON.stringify({ currency: v.currency, delta, note: v.note }),
              })
            );
            return done === null ? "Cancelled." : null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) {
        toast("Done — their balance has changed.");
        void load();
      }
    });
  };

  const load = async () => {
    try {
      draw(await call<WalletData>(`/players/${encodeURIComponent(uid)}/wallet`));
    } catch (e) {
      host.innerHTML = `<p class="empty">${esc(
        e instanceof ApiFailure ? e.info.error : "Could not read this player's wallet."
      )}</p>`;
    }
  };

  host.innerHTML = `<p class="muted" style="padding:12px 14px">Loading…</p>`;
  void load();
}
