// Payment sessions — every QR this platform has put in front of somebody.
//
// A row appears the moment a player presses Buy, whether or not they ever pay.
// That is deliberate and it is what makes the screen useful: the question this
// answers is not "who paid" (the ledger knows that) but "somebody says they
// paid and did not get their gems — what actually happened to them".
//
// The amount column carries the weight. Two live sessions can never share an
// amount, so an odd price like ₹100.02 is not a mistake — it is the mechanism,
// and the offset column says so out loud rather than leaving an admin to
// wonder whether the player was overcharged.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, pill, rupees, table, toast, when } from "../ui";
import { bindWindowBar, lastHours, windowBar, windowParams, type Window } from "../timeWindow";

interface Session {
  id: string;
  uid: string;
  username: string;
  packId: string;
  gems: number;
  basePaise: number;
  amountPaise: number;
  collisionOffset: number;
  status: "pending" | "paid" | "approved" | "expired" | "cancelled";
  expiresAt: string;
  graceUntil: string;
  settledAt: string | null;
  upiRef: string | null;
  approvedBy: string | null;
  createdAt: string;
}

interface Totals {
  sessions: number;
  settled: number;
  paise: number;
  rupees: string;
  live: number;
  unmatched: number;
}

const STATUS: Record<Session["status"], { label: string; kind: "" | "on" | "off" | "bad" | "warn" }> = {
  pending: { label: "waiting", kind: "warn" },
  paid: { label: "paid", kind: "on" },
  approved: { label: "approved by hand", kind: "on" },
  expired: { label: "timed out", kind: "off" },
  cancelled: { label: "closed", kind: "off" },
};

/** How long a waiting session has left, as a person reads it. Recomputed on a
 *  timer rather than baked into the row, so a screen left open is not lying
 *  about a QR that expired ten minutes ago. */
function remaining(s: Session): string {
  if (s.status !== "pending") return "";
  const now = Date.now();
  const qr = new Date(s.expiresAt).getTime() - now;
  const grace = new Date(s.graceUntil).getTime() - now;
  if (qr > 0) return `${Math.ceil(qr / 1000)}s left`;
  if (grace > 0) return `expired · ${Math.ceil(grace / 1000)}s of grace`;
  return "over";
}

export function mountPaySessions(host: HTMLElement, role: string, go: (h: string) => void): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  const w: Window = lastHours(24);
  const filters = { status: "", who: "", amount: "" };
  let rows: Session[] = [];
  let cursor: string | null = null;
  let ticker = 0;

  host.innerHTML = `<p class="empty">Loading…</p>`;

  const rowHtml = (s: Session): string => {
    const st = STATUS[s.status];
    const live = s.status === "pending";
    const canApprove = senior && (s.status === "pending" || s.status === "expired");
    return `<tr data-id="${esc(s.id)}">
      <td class="muted">${when(s.createdAt)}</td>
      <td>
        <strong class="click" data-uid="${esc(s.uid)}" style="cursor:pointer">${esc(s.username)}</strong>
        <div class="muted mono" style="font-size:11px">${esc(s.uid)}</div>
      </td>
      <td>${s.gems.toLocaleString()} gems<div class="muted mono" style="font-size:11px">${esc(s.packId)}</div></td>
      <td class="num">
        <strong>₹${rupees(s.amountPaise)}</strong>
        ${
          s.collisionOffset > 0
            ? `<div class="muted" style="font-size:11px" title="Another player was already paying ₹${rupees(
                s.basePaise
              )} when this one opened, so this session was given its own amount.">+${s.collisionOffset}p · #${
                s.collisionOffset + 1
              } at this price</div>`
            : ""
        }
      </td>
      <td>${pill(st.label, st.kind)}${
        live ? `<div class="muted countdown" style="font-size:11px">${esc(remaining(s))}</div>` : ""
      }</td>
      <td class="muted mono" style="font-size:11px">${
        s.upiRef ? esc(s.upiRef) : s.approvedBy ? esc(s.approvedBy) : "—"
      }</td>
      <td>${canApprove ? `<button class="btn ghost btn-tiny" data-approve="${esc(s.id)}">Approve</button>` : ""}</td>
    </tr>`;
  };

  const draw = (totals: Totals | null) => {
    host.innerHTML = `
      <div class="tiles">
        <div class="tile"><span class="t-label">Opened</span><span class="t-value">${
          totals?.sessions ?? "—"
        }</span><span class="t-sub">QR codes shown in this window</span></div>
        <div class="tile"><span class="t-label">Settled</span><span class="t-value">${
          totals?.settled ?? "—"
        }</span><span class="t-sub">paid or approved by hand</span></div>
        <div class="tile"><span class="t-label">Taken</span><span class="t-value">₹${
          totals?.rupees ?? "—"
        }</span><span class="t-sub">what actually arrived</span></div>
        <div class="tile ${totals?.live ? "live" : ""}"><span class="t-label">In the air</span><span class="t-value">${
          totals?.live ?? "—"
        }</span><span class="t-sub">being paid right now</span></div>
        <div class="tile ${totals?.unmatched ? "warn" : ""}"><span class="t-label">Unmatched</span><span class="t-value">${
          totals?.unmatched ?? "—"
        }</span><span class="t-sub">money in, nobody credited</span></div>
      </div>

      <div class="card">
        <header><h2>Payment sessions</h2><span class="spacer"></span>
          <span class="count" id="n">${rows.length}</span></header>
        ${windowBar(w, {
          extra: `
            <select data-f="status">
              <option value="">every outcome</option>
              <option value="pending">waiting</option>
              <option value="paid">paid</option>
              <option value="approved">approved by hand</option>
              <option value="expired">timed out</option>
              <option value="cancelled">closed</option>
            </select>
            <input type="text" data-f="who" placeholder="a UID or a name" size="14" />
            <input type="text" data-f="amount" placeholder="an amount, e.g. 100.02" size="14"
                   title="The exact rupees the bank said — this is how you find whose payment it was" />`,
          note: "A row appears when Buy is pressed, paid or not.",
        })}
        <div id="tbl">${table(
          ["When", "Who", "Buying", "<th class='num'>Amount</th>", "State", "Reference", ""].map((h) =>
            h.startsWith("<th") ? h : `<th>${h}</th>`
          ),
          rows.map(rowHtml),
          "Nothing in this window. Widen the dates, or clear the filters."
        )}</div>
        <div class="pad"><button class="btn ghost" id="more" ${cursor ? "" : "hidden"}>Load more</button></div>
      </div>

      <div class="card"><div class="pad muted" style="font-size:12.5px">
        An <strong>odd amount</strong> is not an overcharge. While one player is paying ₹100.00 the next is
        quoted ₹100.01 — a bank SMS names only an amount, so no two live payments may share one.
        <strong>Approve</strong> credits the gems on your say-so: use it when the money is in your UPI
        history but the SMS never matched, and check the <strong>Payment log</strong> first.
      </div></div>`;

    const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel);
    (q<HTMLSelectElement>('[data-f="status"]') as HTMLSelectElement).value = filters.status;
    (q<HTMLInputElement>('[data-f="who"]') as HTMLInputElement).value = filters.who;
    (q<HTMLInputElement>('[data-f="amount"]') as HTMLInputElement).value = filters.amount;

    host.querySelectorAll<HTMLElement>("[data-f]").forEach((el) => {
      const key = el.dataset.f as keyof typeof filters;
      el.addEventListener("change", () => {
        filters[key] = (el as HTMLInputElement).value.trim();
      });
      el.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") {
          filters[key] = (el as HTMLInputElement).value.trim();
          void load();
        }
      });
    });
    bindWindowBar(host, w, () => void load());
    q<HTMLButtonElement>("#more")!.onclick = () => void load(true);
    wireRows();
  };

  /** Re-attached after every paint, because the table is rebuilt rather than
   *  patched — a listener bound to a row that no longer exists is a button
   *  that silently stops working. */
  const wireRows = () => {
    host.querySelectorAll<HTMLElement>("[data-uid]").forEach((el) => {
      el.onclick = () => go(`#/players/${encodeURIComponent(el.dataset.uid!)}`);
    });
    host.querySelectorAll<HTMLButtonElement>("[data-approve]").forEach((btn) => {
      btn.onclick = () => void approve(btn.dataset.approve!);
    });
  };

  const approve = async (id: string) => {
    const s = rows.find((r) => r.id === id);
    if (!s) return;
    const answer = await ask({
      title: `Credit ${s.gems.toLocaleString()} gems to ${s.username}?`,
      intro:
        `They were quoted ₹${rupees(s.amountPaise)} for ${s.packId}. Only do this once you have seen the money ` +
        `in your UPI history — this credits gems on your say-so, and it is recorded against your name.`,
      confirm: "Credit them",
      fields: [
        {
          name: "note",
          label: "Why",
          placeholder: "e.g. UPI ref 313080502571 found in history, player rang in",
          note: "Goes in the ledger line and the audit trail.",
        },
      ],
      async onSubmit(v) {
        if (v.note.trim().length < 4) return "Say why — a grant nobody can account for later is worse than none.";
        try {
          const done = await withSudo(() =>
            call(`/payments/sessions/${encodeURIComponent(id)}/approve`, {
              method: "POST",
              body: JSON.stringify({ note: v.note }),
            })
          );
          return done === null ? "Cancelled." : null;
        } catch (e) {
          return e instanceof ApiFailure ? e.info.error : "That did not work";
        }
      },
    });
    if (answer) {
      toast("Credited. The player has been told if they are online.");
      void load();
    }
  };

  const load = async (append = false) => {
    const params = windowParams(w);
    if (filters.status) params.set("status", filters.status);
    if (filters.who) params.set("who", filters.who);
    if (filters.amount) params.set("amount", filters.amount);
    if (append && cursor) params.set("cursor", cursor);
    try {
      const [page, totals] = await Promise.all([
        call<{ sessions: Session[]; cursor: string | null }>(`/payments/sessions?${params}`),
        append
          ? Promise.resolve(null)
          : call<Totals>(`/payments/totals?${windowParams(w)}`).catch(() => null),
      ]);
      if (cancelled) return;
      cursor = page.cursor;
      rows = append ? [...rows, ...page.sessions] : page.sessions;
      if (append) {
        // Append rather than repaint: the filters are where the admin left
        // them, and rebuilding the card would put the focus somewhere else.
        host.querySelector("#tbl tbody")?.insertAdjacentHTML("beforeend", page.sessions.map(rowHtml).join(""));
        host.querySelector<HTMLElement>("#n")!.textContent = String(rows.length);
        host.querySelector<HTMLButtonElement>("#more")!.hidden = !cursor;
        wireRows();
      } else {
        draw(totals);
      }
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read the payment sessions."
        )}</p></div>`;
      }
    }
  };

  void load();
  // The countdowns only. A screen that refetched every second would be a
  // screen nobody could keep open, and the only thing that changes second to
  // second is how long a QR has left.
  ticker = window.setInterval(() => {
    host.querySelectorAll<HTMLElement>("tr[data-id]").forEach((tr) => {
      const s = rows.find((r) => r.id === tr.dataset.id);
      const cell = tr.querySelector<HTMLElement>(".countdown");
      if (s && cell) cell.textContent = remaining(s);
    });
  }, 1000);

  return () => {
    cancelled = true;
    window.clearInterval(ticker);
  };
}
