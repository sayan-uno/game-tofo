// Payment management — where the money goes, and the secret that lets a phone
// tell us it arrived.
//
// Two fields and one button, and every one of them is a live wire:
//
//   THE UPI ID is what every QR pays. Get it wrong and players' money goes to
//   a stranger, so it is validated on both sides and shown back in full.
//   THE KEY is the entire authentication on an open route. It is GENERATED,
//   never typed, shown once when it is made, and thereafter only to somebody
//   holding their authenticator — because whoever has it can tell this
//   platform a payment arrived.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, pill, rupees, toast } from "../ui";

interface Pack {
  id: string;
  gems: number;
  pricePaise: number;
  art: string;
  tag: string | null;
  sort: number;
  active: boolean;
}

interface Settings {
  upiId: string;
  payeeName: string;
  hasKey: boolean;
  keyLength: number;
  ready: boolean;
  windowMs: number;
  graceMs: number;
  packs: Pack[];
}

/** The one place in the console that shows a secret. Deliberately awkward to
 *  dismiss by accident and deliberately not written anywhere else. */
function showKey(key: string, hookUrl: string): void {
  document.querySelector(".keybox")?.remove();
  const box = document.createElement("div");
  box.className = "overlay keybox";
  box.innerHTML = `
    <div class="modal">
      <header>
        <h3>The webhook key</h3>
        <p>Paste this into the forwarding app on your phone. It is shown now and only
           on request afterwards — it is the whole authentication on an open route.</p>
      </header>
      <div class="content">
        <div class="field"><label>Key</label><input class="code" id="k" readonly /></div>
        <div class="field"><label>Send the SMS to</label><input id="u" readonly /></div>
        <div class="note" style="margin-top:8px">
          POST a JSON body of
          <code>{"sender":"«the whole SMS»","key":"«this key»"}</code>.
          Anything else is logged and refused.
        </div>
      </div>
      <footer>
        <button class="btn ghost" id="copy">Copy the key</button>
        <button class="btn" id="done">Done</button>
      </footer>
    </div>`;
  document.body.append(box);
  box.querySelector<HTMLInputElement>("#k")!.value = key;
  box.querySelector<HTMLInputElement>("#u")!.value = hookUrl;
  box.querySelector<HTMLButtonElement>("#copy")!.onclick = () => {
    void navigator.clipboard.writeText(key).then(() => toast("Key copied."));
  };
  box.querySelector<HTMLButtonElement>("#done")!.onclick = () => box.remove();
}

export function mountPayments(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  host.innerHTML = `<p class="empty">Loading…</p>`;

  if (!senior) {
    host.innerHTML = `<div class="card"><p class="empty">Payment management is an admin and owner screen.</p></div>`;
    return () => undefined;
  }

  /** Where the phone should POST.
   *
   *  The GAME backend, not this one. Worth stating on the screen rather than
   *  leaving to be worked out: the console and the game are separate
   *  deployments on separate hosts, and forwarding bank messages to the
   *  console's host is the commonest way to set this up wrongly — the requests
   *  simply 404 and no payment is ever verified, with nothing in the log to
   *  say why, because they never reached the process that keeps the log. */
  const gameApi = (import.meta.env.VITE_GAME_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
  const hookUrl = gameApi ? `${gameApi}/pay/sms` : "«your game backend»/pay/sms";

  const draw = (s: Settings) => {
    host.innerHTML = `
      <div class="card">
        <div class="pad" style="font-size:13.5px">
          Players buy gems with a UPI QR that pays the id below. Nothing tells this platform a
          payment landed except a bank SMS forwarded to the webhook — so both of these have to be
          right, and the screen says plainly when they are not.
        </div>
      </div>

      <div class="card">
        <header><h2>Where the money goes</h2><span class="spacer"></span>
          <span class="pill ${s.ready ? "on" : "bad"}">${s.ready ? "taking payments" : "not set up"}</span>
        </header>
        <div class="switch">
          <div class="txt">
            <b>UPI id ${s.upiId ? "" : "— not set"}</b>
            <span>${
              s.upiId
                ? `Every QR pays <strong class="mono">${esc(s.upiId)}</strong>, shown to the payer as
                   <strong>${esc(s.payeeName)}</strong>.`
                : "Until this is set, pressing Buy tells the player payments are unavailable — which is right, and better than a QR that pays nobody."
            }</span>
          </div>
          <button class="btn" id="upi">${s.upiId ? "Change it" : "Set it"}</button>
        </div>
        <div class="switch">
          <div class="txt">
            <b>Webhook key ${s.hasKey ? `— ${s.keyLength} characters` : "— not set"}</b>
            <span>${
              s.hasKey
                ? "The forwarding app must send this with every message. Rotating it means updating the phone."
                : "With no key the webhook refuses everything, which is the right way for an unconfigured gateway to fail."
            }<br>Forward bank messages to <strong class="mono">${esc(hookUrl)}</strong>${
              gameApi ? "" : " — set VITE_GAME_API_URL in admin/.env and this will say the real address"
            }</span>
          </div>
          <span>
            ${s.hasKey ? `<button class="btn ghost" id="reveal">Show it</button>` : ""}
            <button class="btn ${s.hasKey ? "ghost" : ""}" id="rotate">${s.hasKey ? "Rotate" : "Generate"}</button>
          </span>
        </div>
      </div>

      <div class="card">
        <header><h2>How a payment is recognised</h2></header>
        <div class="pad" style="font-size:13.5px;line-height:1.65">
          A bank SMS says how much arrived and nothing about who sent it, so <strong>the amount is the
          identity</strong>. While one player is paying ₹100.00 for a pack, the next is quoted
          ₹100.01, the one after ₹100.02 — no two live payments can share an amount, so an arriving
          credit belongs to exactly one of them.
          <br><br>
          The QR is offered for <strong>${Math.round(s.windowMs / 1000)} seconds</strong>. The amount stays
          reserved for <strong>${Math.round(s.graceMs / 1000)} seconds longer</strong>, so somebody who paid in
          the last moment — or whose bank was slow — is still credited rather than having their money
          handed to whoever bought next. Past that it lands in
          <strong>Payment log</strong> as unmatched, and it is yours to approve by hand.
        </div>
      </div>

      <div class="card">
        <header><h2>The shelf</h2><span class="spacer"></span>
          <span class="count">${s.packs.filter((p) => p.active).length} of ${s.packs.length} on sale</span></header>
        <div class="wrap"><table class="tbl">
          <thead><tr>
            <th>Pack</th><th class="num">Gems</th><th class="num">Price</th>
            <th class="num">Per gem</th><th>Ribbon</th><th>On the shelf</th><th></th>
          </tr></thead>
          <tbody>${s.packs
            .map(
              (p) => `<tr class="${p.active ? "" : "forfeit"}">
                <td class="mono">${esc(p.id)}</td>
                <td class="num">${p.gems.toLocaleString()}</td>
                <td class="num"><strong>₹${rupees(p.pricePaise)}</strong></td>
                <td class="num muted" title="What one gem works out at — the base rate is ₹1.00">
                  ₹${rupees(Math.round(p.pricePaise / Math.max(1, p.gems)))}
                </td>
                <td>${p.tag ? `<span class="pill warn">${esc(p.tag)}</span>` : `<span class="muted">—</span>`}</td>
                <td>${p.active ? pill("on sale", "on") : pill("hidden", "off")}</td>
                <td>
                  <button class="btn ghost btn-tiny" data-pack="${esc(p.id)}">Edit</button>
                  <button class="btn ghost btn-tiny" data-toggle="${esc(p.id)}" data-on="${p.active ? "0" : "1"}">${
                    p.active ? "Hide" : "Show"
                  }</button>
                </td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>
        <div class="pad muted" style="font-size:12.5px">
          A change here affects the NEXT payment somebody opens. Anyone already looking at a QR keeps
          the deal they were quoted — a session writes down its gems and its price when it opens, so
          neither a price change nor hiding a pack can strand money already in the air.
        </div>
      </div>`;

    host.querySelectorAll<HTMLButtonElement>("[data-pack]").forEach((btn) => {
      btn.onclick = async () => {
        const pack = s.packs.find((p) => p.id === btn.dataset.pack)!;
        const answer = await ask({
          title: `Edit ${pack.id}`,
          intro:
            "What this pack gives and what it costs. The base rate is 1 gem = ₹1 — price it under that " +
            "and you are running a discount, over it and you are not.",
          confirm: "Save it",
          fields: [
            { name: "gems", label: "Gems it gives", value: String(pack.gems) },
            {
              name: "price",
              label: "Price in rupees",
              value: rupees(pack.pricePaise),
              note: "Paise are allowed — 99.50 is a real price.",
            },
            {
              name: "tag",
              label: "Ribbon on the tile",
              value: pack.tag ?? "",
              note: "Leave empty for none. e.g. POPULAR, BEST VALUE, +20% FREE",
            },
          ],
          async onSubmit(v) {
            const gems = Number(v.gems);
            if (!Number.isInteger(gems) || gems < 1) return "Gems must be a whole number, at least 1.";
            if (!/^\d{1,7}(\.\d{1,2})?$/.test(v.price.trim())) return "A price looks like 500 or 499.50.";
            try {
              const done = await withSudo(() =>
                call(`/payments/packs/${encodeURIComponent(pack.id)}`, {
                  method: "POST",
                  body: JSON.stringify({ gems, pricePaise: v.price.trim(), tag: v.tag }),
                })
              );
              return done === null ? "Cancelled." : null;
            } catch (e) {
              return e instanceof ApiFailure ? e.info.error : "That did not work";
            }
          },
        });
        if (answer) {
          toast("Saved — the next payment opened uses it.");
          void load();
        }
      };
    });

    host.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((btn) => {
      btn.onclick = async () => {
        const on = btn.dataset.on === "1";
        const answer = await ask({
          title: on ? "Put this pack back on the shelf?" : "Take this pack off the shelf?",
          intro: on
            ? "Players will see it again the next time they open the store."
            : "It disappears from the store. Anyone mid-payment for it still completes — their session already " +
              "wrote down what they were buying.",
          confirm: on ? "Show it" : "Hide it",
          danger: !on,
          async onSubmit() {
            try {
              const done = await withSudo(() =>
                call(`/payments/packs/${encodeURIComponent(btn.dataset.toggle!)}`, {
                  method: "POST",
                  body: JSON.stringify({ active: on }),
                })
              );
              return done === null ? "Cancelled." : null;
            } catch (e) {
              return e instanceof ApiFailure ? e.info.error : "That did not work";
            }
          },
        });
        if (answer) {
          toast(on ? "Back on the shelf." : "Hidden.");
          void load();
        }
      };
    });

    host.querySelector<HTMLButtonElement>("#upi")!.onclick = async () => {
      const answer = await ask({
        title: "Where should payments go?",
        intro: "This is the UPI id every QR will pay. Check it character by character.",
        confirm: "Save it",
        fields: [
          { name: "upiId", label: "UPI id", value: s.upiId, placeholder: "yourname@bank" },
          {
            name: "payeeName",
            label: "Name shown to the payer",
            value: s.payeeName,
            note: "What their UPI app displays before they confirm.",
          },
        ],
        async onSubmit(v) {
          if (!/^[A-Za-z0-9.\-_]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,32}$/.test(v.upiId)) {
            return "That does not look like a UPI id — it should read name@bank.";
          }
          try {
            const done = await withSudo(() =>
              call("/payments/settings", {
                method: "POST",
                body: JSON.stringify({ upiId: v.upiId, payeeName: v.payeeName }),
              })
            );
            return done === null ? "Cancelled." : null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) {
        toast("Saved — new QR codes pay that id.");
        void load();
      }
    };

    host.querySelector<HTMLButtonElement>("#reveal")?.addEventListener("click", async () => {
      try {
        const done = await withSudo(() =>
          call<{ hookKey: string }>("/payments/settings/reveal", { method: "POST" })
        );
        if (done) showKey(done.hookKey, hookUrl);
      } catch (e) {
        toast(e instanceof ApiFailure ? e.info.error : "That did not work");
      }
    });

    host.querySelector<HTMLButtonElement>("#rotate")!.onclick = async () => {
      const answer = await ask({
        title: s.hasKey ? "Rotate the webhook key?" : "Generate a webhook key",
        intro: s.hasKey
          ? "The old key stops working the instant this is done. Every SMS forwarded with it will be refused until you update the phone."
          : "A new random key. Paste it into the forwarding app on your phone.",
        confirm: s.hasKey ? "Rotate it" : "Generate it",
        danger: s.hasKey,
        async onSubmit() {
          try {
            const done = await withSudo(() =>
              call<{ newKey: string | null }>("/payments/settings", {
                method: "POST",
                body: JSON.stringify({ rotateKey: true }),
              })
            );
            if (done === null) return "Cancelled.";
            if (done.newKey) showKey(done.newKey, hookUrl);
            return null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) void load();
    };
  };

  const load = async () => {
    try {
      const s = await call<Settings>("/payments/settings");
      if (!cancelled) draw(s);
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read the payment settings."
        )}</p></div>`;
      }
    }
  };

  void load();
  return () => {
    cancelled = true;
    document.querySelector(".keybox")?.remove();
  };
}
