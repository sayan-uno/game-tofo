// A from/to window, in the admin's own timezone, that remembers itself.
//
// Two screens need the same control and they need it to behave identically,
// because the whole point of having both is to line one up against the other:
// "seven payment sessions were opened at 17:05, and here is what the webhook
// received at 17:05". A window that means something slightly different on each
// screen makes that comparison quietly wrong.
//
// `datetime-local` holds MINUTES, so reading "now" back out of one loses up to
// fifty-nine seconds — and a row written in those seconds falls outside the
// window and never appears, however often you refresh. So when the end of the
// window means "now" it is not sent at all, and the server closes it with the
// database's clock rather than this laptop's.
export interface Window {
  from: string;
  to: string;
  /** True while the end means "now" rather than a moment somebody typed. */
  followNow: boolean;
}

/** A datetime-local value for a moment, in local time. */
export const localValue = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const lastHours = (hours: number): Window => ({
  from: localValue(Date.now() - hours * 3600_000),
  to: localValue(Date.now()),
  followNow: true,
});

/** The query parameters for a window. `to` is omitted while it means now. */
export function windowParams(w: Window): URLSearchParams {
  const p = new URLSearchParams();
  const from = new Date(w.from);
  if (!Number.isNaN(from.getTime())) p.set("from", from.toISOString());
  if (!w.followNow) {
    const to = new Date(w.to);
    if (!Number.isNaN(to.getTime())) p.set("to", to.toISOString());
  }
  return p;
}

export interface WindowBarOptions {
  /** Extra controls, rendered after the date inputs. */
  extra?: string;
  /** Shown on the right of the bar. */
  note?: string;
}

export const windowBar = (w: Window, o: WindowBarOptions = {}): string => `
  <div class="pad logfilters">
    <label class="muted" style="font-size:12px">From</label>
    <input type="datetime-local" data-win="from" value="${w.from}" />
    <label class="muted" style="font-size:12px">to</label>
    <input type="datetime-local" data-win="to" value="${w.to}" />
    <button class="btn ghost btn-tiny" data-hours="1">1h</button>
    <button class="btn ghost btn-tiny" data-hours="24">24h</button>
    <button class="btn ghost btn-tiny" data-hours="168">7d</button>
    <button class="btn ghost btn-tiny" data-hours="720">30d</button>
    ${o.extra ?? ""}
    <button class="btn ghost" data-win="go">Show</button>
    <span class="spacer" style="flex:1"></span>
    <span class="muted" style="font-size:12px">${o.note ?? ""}</span>
  </div>`;

/** Wire a rendered bar to a window object. Returns nothing — the caller reads
 *  the same object back, which is what keeps the filter across a redraw. */
export function bindWindowBar(host: HTMLElement, w: Window, onChange: () => void): void {
  const from = host.querySelector<HTMLInputElement>('[data-win="from"]');
  const to = host.querySelector<HTMLInputElement>('[data-win="to"]');
  from?.addEventListener("change", () => {
    w.from = from.value;
  });
  // The moment somebody types an end time, it stops meaning "now".
  to?.addEventListener("change", () => {
    w.to = to.value;
    w.followNow = false;
  });
  host.querySelectorAll<HTMLButtonElement>("[data-hours]").forEach((b) => {
    b.onclick = () => {
      const next = lastHours(Number(b.dataset.hours));
      w.from = next.from;
      w.to = next.to;
      w.followNow = true;
      onChange();
    };
  });
  host.querySelector<HTMLButtonElement>('[data-win="go"]')?.addEventListener("click", onChange);
}
