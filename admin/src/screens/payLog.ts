// The payment log — everything that reached the open webhook, whatever it was.
//
// This screen exists because the route it reports on is reachable by anybody.
// Two very different jobs, on one table:
//
//   THE MONEY. A credit that matched a session says whose it was; one that
//   matched nothing says so plainly and offers the shortlist of who it might
//   have been. That is the whole manual-approval loop: read the row here, take
//   the candidate to Payment sessions, approve it there.
//
//   THE DOOR. Scanners find open routes. What they send is a row like any
//   other — stored as text, shown escaped, never interpreted — so an admin can
//   see the knocking without the knocking being able to do anything.
import { ApiFailure, call } from "../api";
import { esc, pill, rupees, table, when } from "../ui";
import { bindWindowBar, lastHours, windowBar, windowParams, type Window } from "../timeWindow";

type Outcome = "verified" | "unmatched" | "duplicate" | "ignored" | "rejected" | "malformed";

interface HookRow {
  id: number;
  outcome: Outcome;
  detail: string;
  body: string;
  amountPaise: number | null;
  upiRef: string | null;
  sessionId: string | null;
  uid: string | null;
  ip: string | null;
  createdAt: string;
}

interface Candidate {
  id: string;
  uid: string;
  username: string;
  packId: string;
  gems: number;
  amountPaise: number;
  status: string;
  createdAt: string;
}

/** What each outcome MEANS, in the words an admin would use. The database
 *  stores one word; nobody should have to remember what "ignored" was decided
 *  to cover. */
const OUTCOME: Record<Outcome, { label: string; kind: "" | "on" | "off" | "bad" | "warn"; blurb: string }> = {
  verified: { label: "verified", kind: "on", blurb: "matched a live session — the gems went out" },
  unmatched: {
    label: "not verified",
    kind: "warn",
    blurb: "real money, correct key, but no session was holding that amount — yours to check",
  },
  duplicate: { label: "already counted", kind: "off", blurb: "the same bank reference arrived twice" },
  ignored: { label: "not a payment", kind: "off", blurb: "nothing in the message said money arrived" },
  rejected: { label: "refused", kind: "bad", blurb: "wrong key, or too many requests — nothing was read from it" },
  malformed: { label: "unreadable", kind: "bad", blurb: "the body was not a JSON object we could read" },
};

export function mountPayLog(host: HTMLElement, go: (h: string) => void): () => void {
  let cancelled = false;
  const w: Window = lastHours(24);
  const filters = { outcome: "", amount: "" };
  let rows: HookRow[] = [];
  let cursor: string | null = null;

  host.innerHTML = `<p class="empty">Loading…</p>`;

  const rowHtml = (r: HookRow): string => {
    const o = OUTCOME[r.outcome] ?? { label: r.outcome, kind: "" as const, blurb: "" };
    return `<tr data-row="${r.id}">
      <td class="muted">${when(r.createdAt)}</td>
      <td>${pill(o.label, o.kind)}</td>
      <td class="num">${r.amountPaise === null ? '<span class="muted">—</span>' : `<strong>₹${rupees(r.amountPaise)}</strong>`}</td>
      <td>
        ${esc(r.detail)}
        ${
          r.uid
            ? `<div class="muted mono click" data-uid="${esc(r.uid)}" style="font-size:11px;cursor:pointer">${esc(r.uid)}</div>`
            : ""
        }
        ${
          r.outcome === "unmatched"
            ? `<div style="margin-top:5px"><button class="btn ghost btn-tiny" data-who="${r.id}">Who could this be?</button></div>
               <div class="cands" data-cands="${r.id}"></div>`
            : ""
        }
      </td>
      <td class="muted mono" style="font-size:11px">${r.upiRef ? esc(r.upiRef) : "—"}</td>
      <td class="muted mono" style="font-size:11px">${r.ip ? esc(r.ip) : "—"}</td>
      <td>${
        r.body
          ? `<button class="btn ghost btn-tiny" data-body="${r.id}">Message</button>
             <pre class="hookbody" data-bodyfor="${r.id}" hidden>${esc(r.body)}</pre>`
          : '<span class="muted">—</span>'
      }</td>
    </tr>`;
  };

  const draw = () => {
    host.innerHTML = `
      <div class="card">
        <header><h2>Payment log</h2><span class="spacer"></span><span class="count" id="n">${rows.length}</span></header>
        ${windowBar(w, {
          extra: `
            <select data-f="outcome">
              <option value="">everything</option>
              <option value="verified">verified</option>
              <option value="unmatched">not verified</option>
              <option value="duplicate">already counted</option>
              <option value="ignored">not a payment</option>
              <option value="rejected">refused</option>
              <option value="malformed">unreadable</option>
            </select>
            <input type="text" data-f="amount" placeholder="an amount, e.g. 100.02" size="14" />`,
          note: "Every request the webhook received, payment or not.",
        })}
        <div id="tbl">${table(
          ["When", "Outcome", "<th class='num'>Amount</th>", "What happened", "Bank ref", "From", ""].map((h) =>
            h.startsWith("<th") ? h : `<th>${h}</th>`
          ),
          rows.map(rowHtml),
          "Nothing reached the webhook in this window."
        )}</div>
        <div class="pad"><button class="btn ghost" id="more" ${cursor ? "" : "hidden"}>Load more</button></div>
      </div>

      <div class="card">
        <header><h2>What the outcomes mean</h2></header>
        <div class="wrap"><table class="tbl"><tbody>
          ${(Object.keys(OUTCOME) as Outcome[])
            .map(
              (k) =>
                `<tr><td style="width:150px">${pill(OUTCOME[k].label, OUTCOME[k].kind)}</td>
                     <td class="muted">${esc(OUTCOME[k].blurb)}</td></tr>`
            )
            .join("")}
        </tbody></table></div>
        <div class="pad muted" style="font-size:12.5px">
          The message body is stored as text and shown escaped — nothing here is ever run, parsed as
          anything but a bank SMS, or put into a query. A scanner's payload is a row like any other.
        </div>
      </div>`;

    (host.querySelector('[data-f="outcome"]') as HTMLSelectElement).value = filters.outcome;
    (host.querySelector('[data-f="amount"]') as HTMLInputElement).value = filters.amount;
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
    host.querySelector<HTMLButtonElement>("#more")!.onclick = () => void load(true);
    wireRows();
  };

  const wireRows = () => {
    host.querySelectorAll<HTMLElement>("[data-uid]").forEach((el) => {
      el.onclick = () => go(`#/players/${encodeURIComponent(el.dataset.uid!)}`);
    });
    host.querySelectorAll<HTMLButtonElement>("[data-body]").forEach((btn) => {
      btn.onclick = () => {
        const pre = host.querySelector<HTMLElement>(`[data-bodyfor="${btn.dataset.body}"]`);
        if (pre) pre.hidden = !pre.hidden;
      };
    });
    host.querySelectorAll<HTMLButtonElement>("[data-who]").forEach((btn) => {
      btn.onclick = async () => {
        const slot = host.querySelector<HTMLElement>(`[data-cands="${btn.dataset.who}"]`);
        if (!slot) return;
        btn.disabled = true;
        slot.innerHTML = `<p class="muted" style="font-size:12px">Looking…</p>`;
        try {
          const { candidates } = await call<{ candidates: Candidate[] }>(
            `/payments/hooks/${btn.dataset.who}/candidates`
          );
          slot.innerHTML = candidates.length
            ? `<div class="muted" style="font-size:11.5px;margin:4px 0">
                 Sessions open near that moment for a similar amount. This is a shortlist, not an answer —
                 check your UPI history and ask the player before crediting anybody.
               </div>` +
              candidates
                .map(
                  (c) => `<div style="font-size:12px;padding:3px 0">
                    <span class="click" data-uid="${esc(c.uid)}" style="cursor:pointer"><strong>${esc(
                      c.username
                    )}</strong></span>
                    <span class="muted mono"> ${esc(c.uid)}</span> ·
                    ₹${rupees(c.amountPaise)} · ${esc(c.packId)} ·
                    <span class="muted">${esc(c.status)}, ${new Date(c.createdAt).toLocaleTimeString()}</span>
                  </div>`
                )
                .join("")
            : `<p class="muted" style="font-size:12px">No session was opened anywhere near that amount or that moment.</p>`;
          wireRows();
        } catch (e) {
          slot.innerHTML = `<p class="muted" style="font-size:12px">${esc(
            e instanceof ApiFailure ? e.info.error : "Could not look that up"
          )}</p>`;
        } finally {
          btn.disabled = false;
        }
      };
    });
  };

  const load = async (append = false) => {
    const params = windowParams(w);
    if (filters.outcome) params.set("outcome", filters.outcome);
    if (filters.amount) params.set("amount", filters.amount);
    if (append && cursor) params.set("cursor", cursor);
    try {
      const page = await call<{ rows: HookRow[]; cursor: string | null }>(`/payments/hooks?${params}`);
      if (cancelled) return;
      cursor = page.cursor;
      rows = append ? [...rows, ...page.rows] : page.rows;
      if (append) {
        host.querySelector("#tbl tbody")?.insertAdjacentHTML("beforeend", page.rows.map(rowHtml).join(""));
        host.querySelector<HTMLElement>("#n")!.textContent = String(rows.length);
        host.querySelector<HTMLButtonElement>("#more")!.hidden = !cursor;
        wireRows();
      } else {
        draw();
      }
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read the payment log."
        )}</p></div>`;
      }
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
