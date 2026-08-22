// What was happening at three in the morning.
//
// The overview answers "now" and the live snapshot expires in seconds, so the
// one question it can never answer is the one asked at breakfast: the server
// was unreachable for six minutes overnight — how many people were on, who
// were they, and what were they doing?
//
// Two charts over one shared clock, and a scrubber. The charts are small
// multiples rather than two lines on one grid, because "players online" and
// "matches running" are different scales and putting them on one axis makes a
// picture that is easy to misread.
//
// The GAPS are the point. A minute with no row is a minute nothing was able to
// write one, so those minutes are drawn as a labelled outage band and the line
// BREAKS across them. Filling them with zero would turn "the server was down"
// into "nobody was playing", which is the same picture and a different fact.
import { ApiFailure, call } from "../api";
import { esc, pill, when } from "../ui";
import { renderLog, type LogRow } from "../log";

interface Point {
  at: number;
  online: number;
  matches: number;
  players: number;
  queued: number;
  rssMb: number;
}
interface Gap {
  from: number;
  to: number;
  minutes: number;
}
interface Series {
  from: string;
  to: string;
  points: Point[];
  gaps: Gap[];
}
interface Moment {
  at: string;
  snapshot: { at: string; online: number; matches: number; rssMb: number } | null;
  online: { uid: string; username: string | null; since: string }[];
  events: {
    at: string;
    type: string;
    uid: string | null;
    matchKey: string | null;
    gameId: string | null;
    data: unknown;
    ip: string | null;
  }[];
  canSeeAddresses: boolean;
}

const W = 900;
const H = 120;
const PAD = { l: 44, r: 12, t: 10, b: 20 };

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** One small multiple: an area under a 2px line, hairline grid, no legend —
 *  a single series is named by its own title. */
function chart(id: string, title: string, points: Point[], gaps: Gap[], pick: (p: Point) => number, from: number, to: number): string {
  const inner = { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };
  const span = Math.max(1, to - from);
  const max = Math.max(1, ...points.map(pick));
  const x = (t: number) => PAD.l + ((t - from) / span) * inner.w;
  const y = (v: number) => PAD.t + inner.h - (v / max) * inner.h;

  // The line breaks across a gap: one path per run of consecutive minutes.
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].at - points[i - 1].at > 2 * 60_000) {
      runs.push(run);
      run = [];
    }
    run.push(points[i]);
  }
  if (run.length) runs.push(run);

  const paths = runs
    .filter((r) => r.length > 0)
    .map((r) => {
      const line = r.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(pick(p)).toFixed(1)}`).join("");
      const area =
        `M${x(r[0].at).toFixed(1)},${(PAD.t + inner.h).toFixed(1)}` +
        r.map((p) => `L${x(p.at).toFixed(1)},${y(pick(p)).toFixed(1)}`).join("") +
        `L${x(r[r.length - 1].at).toFixed(1)},${(PAD.t + inner.h).toFixed(1)}Z`;
      return `<path class="ch-area" d="${area}"/><path class="ch-line" d="${line}"/>`;
    })
    .join("");

  // Outages, drawn and NAMED — a status colour never carries meaning alone.
  const bands = gaps
    .map(
      (g) =>
        `<rect class="ch-gap" x="${x(g.from).toFixed(1)}" y="${PAD.t}" width="${Math.max(2, x(g.to) - x(g.from)).toFixed(1)}" height="${inner.h}"/>`
    )
    .join("");

  const ticks = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * (1 - f));
    const yy = PAD.t + inner.h * f;
    return `<line class="ch-grid" x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}"/>
            <text class="ch-tick" x="${PAD.l - 8}" y="${yy + 3}" text-anchor="end">${v}</text>`;
  }).join("");

  return `<div class="ch" data-chart="${id}">
    <div class="ch-head"><h3>${esc(title)}</h3><span class="ch-read" id="read-${id}"></span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)} over time">
      ${ticks}${bands}${paths}
      <line class="ch-cross" id="cross-${id}" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + inner.h}" style="display:none"/>
    </svg>
  </div>`;
}

export function mountHistory(host: HTMLElement, go: (h: string) => void): () => void {
  let cancelled = false;
  let hours = 12;
  let series: Series | null = null;
  let live = false;
  let liveTimer = 0;
  /** Kept across redraws so refreshing does not throw away what you typed. */
  const filters = { from: "", to: "", kind: "", uid: "", party: "", match: "" };
  /** Where the scrubber was, so a refresh does not jump you back to "now".
   *  Null means "follow now", which is what Live wants. */
  let scrubAt: number | null = null;
  /** True while the end of the window means "now" rather than a fixed moment.
   *
   *  This is the bug that made Refresh and Live look broken: the window's end
   *  was stamped when the screen drew, so anything logged AFTERWARDS fell
   *  outside it and could never appear, however many times you refreshed. An
   *  end time only stops meaning "now" when somebody types one in. */
  let followNow = true;
  /** Set by draw(): refetches and updates the parts that hold data, WITHOUT
   *  rebuilding the screen. A refresh that blanks everything and puts it back
   *  is a page reload with extra steps. */
  let refreshInPlace: (() => Promise<void>) | null = null;

  const load = async (quiet = false) => {
    // A live refresh must not blank the screen every five seconds.
    if (!quiet) host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;
    try {
      series = await call<Series>(`/history/series?hours=${hours}`);
    } catch (e) {
      host.innerHTML = `<div class="card"><p class="empty">${esc(
        e instanceof ApiFailure ? e.info.error : "Could not load history"
      )}</p></div>`;
      return;
    }
    if (cancelled) return;
    draw();
  };

  function draw(): void {
    const s = series!;
    const from = new Date(s.from).getTime();
    const to = new Date(s.to).getTime();
    const downMinutes = s.gaps.reduce((n, g) => n + g.minutes, 0);
    const peak = s.points.reduce((m, p) => Math.max(m, p.online), 0);

    host.innerHTML = `
      <div class="card">
        <div class="pad" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <span class="ranges">${[3, 12, 24, 72]
            .map((h) => `<button data-hours="${h}" class="${h === hours ? "on" : ""}">${h}h</button>`)
            .join("")}</span>
          <button class="btn ghost" id="refresh" title="Fetch the latest">↻ Refresh</button>
          <button class="btn ghost${live ? " on" : ""}" id="live" title="Refresh every 5 seconds">
            ${live ? "● LIVE" : "○ Live"}
          </button>
          <span class="spacer"></span>
          <span class="muted" style="font-size:12.5px">${s.points.length} minute(s) on record · peak ${peak} online</span>
          ${
            downMinutes > 0
              ? pill(`⚠ ${downMinutes} minute(s) with nothing recorded`, "bad")
              : pill("no gaps — the server was up throughout", "on")
          }
        </div>
      </div>

      <div class="card">
        <header><h2>Back in time</h2><span class="spacer"></span>
          <span class="muted" id="atlabel" style="font-size:12.5px"></span>
        </header>
        <div class="pad">
          ${chart("online", "Players online", s.points, s.gaps, (p) => p.online, from, to)}
          ${chart("matches", "Matches running", s.points, s.gaps, (p) => p.matches, from, to)}
          <input type="range" id="scrub" min="${from}" max="${to}" value="${Math.min(
            to,
            Math.max(from, scrubAt ?? to)
          )}" step="60000" />
          <p class="muted" style="font-size:11.5px;margin-top:6px">
            Drag to any moment. A shaded band is time when nothing was written — the server was not
            running or could not reach the database; the line breaks rather than pretending it was zero.
          </p>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <header><h2>Who was online</h2><span class="spacer"></span><span class="count" id="onlinecount">—</span></header>
          <div class="pad" id="whowas"><p class="muted">Pick a moment.</p></div>
        </div>
        <div class="card">
          <header><h2>What was happening</h2></header>
          <div class="feed pad" id="whathappened"><p class="muted">Pick a moment.</p></div>
        </div>
      </div>

      <div class="card">
        <header><h2>Everything, between two moments</h2><span class="spacer"></span>
          <span class="muted" id="logcount" style="font-size:12.5px"></span></header>
        <div class="pad logfilters">
          <label class="muted" style="font-size:12px">From</label>
          <input type="datetime-local" id="lfrom" />
          <label class="muted" style="font-size:12px">to</label>
          <input type="datetime-local" id="lto" />
          <select id="lkind"><option value="">every kind</option></select>
          <input type="text" id="luid" placeholder="a UID, or leave blank" size="12" />
          <input type="text" id="lparty" placeholder="a party id" size="12" title="Everything one group ever did" />
          <input type="text" id="lmatch" placeholder="a match id" size="12" title="Everything about one match" />
          <button class="btn ghost" id="lgo">Show</button>
        </div>
        <div class="pad" id="loglist"><p class="muted">Pick a window and press Show.</p></div>
        <div class="pad"><button class="btn ghost" id="lmore" hidden>Load more</button></div>
      </div>`;

    const scrub = host.querySelector<HTMLInputElement>("#scrub")!;
    const atLabel = host.querySelector<HTMLElement>("#atlabel")!;

    host.querySelectorAll<HTMLButtonElement>("[data-hours]").forEach((b) => {
      b.onclick = () => {
        hours = Number(b.dataset.hours);
        void load();
      };
    });

    const liveBtn = host.querySelector<HTMLButtonElement>("#live")!;
    host.querySelector<HTMLButtonElement>("#refresh")!.onclick = () => void refreshInPlace?.();
    liveBtn.onclick = () => {
      live = !live;
      liveBtn.textContent = live ? "● LIVE" : "○ Live";
      liveBtn.classList.toggle("on", live);
      clearInterval(liveTimer);
      if (live) {
        // Watching live means watching NOW — both ends of it.
        scrubAt = null;
        followNow = true;
        void refreshInPlace?.();
        // Five seconds: often enough to feel live, rare enough that nobody
        // notices the request.
        liveTimer = window.setInterval(() => void refreshInPlace?.(), 5000);
      }
    };
    clearInterval(liveTimer);
    if (live) liveTimer = window.setInterval(() => void refreshInPlace?.(), 5000);

    // The crosshair follows the scrubber across BOTH charts, because they
    // share one clock — that is the whole reason they are stacked.
    const showAt = (ms: number) => {
      atLabel.textContent = new Date(ms).toLocaleString();
      const p = nearest(s.points, ms);
      for (const [id, value] of [
        ["online", p ? `${p.online} online` : "nothing recorded"],
        ["matches", p ? `${p.matches} running` : "nothing recorded"],
      ] as const) {
        const cross = host.querySelector<SVGLineElement>(`#cross-${id}`)!;
        const xx = PAD.l + ((ms - from) / Math.max(1, to - from)) * (W - PAD.l - PAD.r);
        cross.setAttribute("x1", String(xx));
        cross.setAttribute("x2", String(xx));
        cross.style.display = "";
        host.querySelector<HTMLElement>(`#read-${id}`)!.textContent = value;
      }
    };

    let timer = 0;
    const loadMoment = (ms: number) => {
      clearTimeout(timer);
      // Debounced: dragging a scrubber must not become a request per pixel.
      timer = window.setTimeout(() => void moment(ms), 250);
    };
    scrub.oninput = () => {
      const ms = Number(scrub.value);
      // Touching the scrubber means looking at a MOMENT, which is the opposite
      // of watching live — so live lets go rather than dragging you forward.
      scrubAt = ms;
      if (live) {
        live = false;
        clearInterval(liveTimer);
        const btn = host.querySelector<HTMLButtonElement>("#live");
        if (btn) {
          btn.textContent = "○ Live";
          btn.classList.remove("on");
        }
      }
      showAt(ms);
      loadMoment(ms);
    };

    async function moment(ms: number): Promise<void> {
      let m: Moment;
      try {
        m = await call<Moment>(`/history/at?ts=${ms}`);
      } catch {
        return;
      }
      if (cancelled) return;
      const who = host.querySelector<HTMLElement>("#whowas")!;
      host.querySelector<HTMLElement>("#onlinecount")!.textContent = String(m.online.length);
      who.innerHTML = m.snapshot
        ? m.online.length > 0
          ? m.online
              .map(
                (o) =>
                  `<div class="vrow"><div class="vwho click" data-open="${esc(o.uid)}">${esc(
                    o.username ?? o.uid
                  )}</div><div class="muted mono" style="font-size:11px">${esc(o.uid)}</div>
                   <div class="muted" style="font-size:11.5px">since ${when(o.since)}</div></div>`
              )
              .join("")
          : `<p class="muted">Nobody was online.</p>`
        : `<p class="empty">Nothing was recorded at this moment — the server was not writing.</p>`;
      who.querySelectorAll<HTMLElement>(".vwho.click").forEach((el) => {
        el.style.cursor = "pointer";
        el.onclick = () => go(`#/players/${el.dataset.open}`);
      });

      host.querySelector<HTMLElement>("#whathappened")!.innerHTML =
        m.events.length > 0
          ? m.events
              .map(
                (e) =>
                  `<div class="ev"><span class="mono">${hhmm(new Date(e.at).getTime())}</span>
                   ${pill(esc(e.type), e.type.startsWith("sanction") ? "warn" : "")}
                   ${e.uid ? `<strong>${esc(e.uid)}</strong>` : ""}
                   ${e.gameId ? `<span class="muted">${esc(e.gameId)}</span>` : ""}
                   ${e.ip ? `<span class="muted mono" style="font-size:11px">${esc(e.ip)}</span>` : ""}</div>`
              )
              .join("")
          : `<p class="muted">Nothing was logged in the five minutes either side.</p>`;
    }

    // ---- the log underneath ---------------------------------------------
    const localValue = (ms: number) => new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const lfrom = host.querySelector<HTMLInputElement>("#lfrom")!;
    const lto = host.querySelector<HTMLInputElement>("#lto")!;
    const lkind = host.querySelector<HTMLSelectElement>("#lkind")!;
    const luid = host.querySelector<HTMLInputElement>("#luid")!;
    const lparty = host.querySelector<HTMLInputElement>("#lparty")!;
    const lmatch = host.querySelector<HTMLInputElement>("#lmatch")!;
    const list = host.querySelector<HTMLElement>("#loglist")!;
    const more = host.querySelector<HTMLButtonElement>("#lmore")!;
    lfrom.value = filters.from || localValue(to - 3600_000);
    lto.value = filters.to || localValue(to);
    luid.value = filters.uid;
    lparty.value = filters.party ?? "";
    lmatch.value = filters.match ?? "";
    // The moment somebody types an end time, it stops meaning "now".
    lto.onchange = () => {
      followNow = false;
    };
    let cursor: string | null = null;

    const window_ = () => {
      filters.from = lfrom.value;
      filters.to = lto.value;
      filters.uid = luid.value;
      filters.party = lparty.value;
      filters.match = lmatch.value;
      filters.kind = lkind.value;
      return {
        from: new Date(lfrom.value).toISOString(),
        // A datetime-local input holds MINUTES, so reading "now" back out of
        // it loses up to fifty-nine seconds — and a row written in those
        // seconds falls outside the window and never appears, however often
        // you refresh. So while the end means "now", it is not sent at all:
        // this machine's clock is not the one the rows were stamped by, and
        // the server closes the window with the database's.
        to: followNow ? "" : new Date(lto.value).toISOString(),
      };
    };

    // Responses can land out of order: Live fires every five seconds, and a
    // slow query issued first would otherwise overwrite the fresher list that
    // came back while it was still waiting. Only the newest request may write.
    let issued = 0;

    const query = async (append: boolean) => {
      const mine = ++issued;
      const w = window_();
      const params = new URLSearchParams({ from: w.from });
      if (w.to) params.set("to", w.to);
      if (lkind.value) params.set("type", lkind.value);
      if (luid.value.trim()) params.set("uid", luid.value.trim());
      if (lparty.value.trim()) params.set("lobby", lparty.value.trim());
      if (lmatch.value.trim()) params.set("match", lmatch.value.trim());
      if (append && cursor) params.set("cursor", cursor);
      try {
        const r = await call<{ events: LogRow[]; cursor: string | null }>(`/log?${params}`);
        if (mine !== issued) return;
        cursor = r.cursor;
        const html = renderLog(r.events);
        if (append) list.insertAdjacentHTML("beforeend", html);
        else list.innerHTML = html;
        more.hidden = !cursor;
        host.querySelector<HTMLElement>("#logcount")!.textContent = `${
          list.querySelectorAll(".logrow").length
        } shown${cursor ? " (more available)" : ""}`;
        list.querySelectorAll<HTMLElement>(".click").forEach((el) => {
          el.onclick = () => go(`#/players/${el.dataset.open}`);
        });
      } catch (e) {
        if (mine !== issued) return;
        list.innerHTML = `<p class="empty">${esc(e instanceof ApiFailure ? e.info.error : "Could not load the log")}</p>`;
      }
    };

    const refreshKinds = async () => {
      // What is selected RIGHT NOW, not what was last queried. Restoring the
      // last-queried value put the old kind back after somebody chose "every
      // kind", so clearing the filter silently did not stick.
      const chosen = lkind.value;
      const w = window_();
      try {
        const { kinds } = await call<{ kinds: { type: string; n: number }[] }>(
          `/log/kinds?from=${w.from}${w.to ? `&to=${w.to}` : ""}`
        );
        lkind.innerHTML =
          `<option value="">every kind (${kinds.reduce((n, k) => n + k.n, 0)})</option>` +
          kinds.map((k) => `<option value="${esc(k.type)}">${esc(k.type)} (${k.n})</option>`).join("");
        // The chosen kind survives the rebuild — including "every kind", which
        // is a choice like any other. Losing it every five seconds would make
        // Live unusable with a filter on.
        lkind.value = chosen;
        filters.kind = chosen;
      } catch {
        /* the filter is a convenience; the log works without it */
      }
    };

    host.querySelector<HTMLButtonElement>("#lgo")!.onclick = () => {
      cursor = null;
      if (followNow) lto.value = localValue(Date.now());
      void refreshKinds();
      void query(false);
    };
    more.onclick = () => void query(true);

    // ---- refreshing without rebuilding ----------------------------------
    //
    // Everything that holds data is replaced in place: the two charts, the
    // scrubber's range, and the log. Nothing else is touched, so what you
    // typed, what you selected and where you scrolled all survive — and the
    // screen does not blink.
    refreshInPlace = async () => {
      if (cancelled) return;
      if (followNow) lto.value = localValue(Date.now());
      try {
        const fresh = await call<Series>(`/history/series?hours=${hours}`);
        if (cancelled) return;
        series = fresh;
        const f = new Date(fresh.from).getTime();
        const t = new Date(fresh.to).getTime();
        const specs: [string, string, (p: Point) => number][] = [
          ["online", "Players online", (p) => p.online],
          ["matches", "Matches running", (p) => p.matches],
        ];
        for (const [id, title, pick] of specs) {
          const el = host.querySelector<HTMLElement>(`[data-chart="${id}"]`);
          if (el) el.outerHTML = chart(id, title, fresh.points, fresh.gaps, pick, f, t);
        }
        // The axis moved, so the scrubber's range moves with it — but not the
        // moment somebody parked it on.
        const at = scrubAt ?? t;
        scrub.min = String(f);
        scrub.max = String(t);
        scrub.value = String(Math.min(t, Math.max(f, at)));
        showAt(Number(scrub.value));
      } catch {
        /* a failed refresh leaves what is on screen alone */
      }
      await refreshKinds();
      await query(false);
    };

    showAt(to);
    void moment(to);
    void refreshKinds();
    void query(false);
  }

  void load();
  return () => {
    cancelled = true;
    clearInterval(liveTimer);
  };
}

const nearest = (points: Point[], ms: number): Point | null => {
  let best: Point | null = null;
  for (const p of points) {
    if (Math.abs(p.at - ms) <= 90_000 && (!best || Math.abs(p.at - ms) < Math.abs(best.at - ms))) best = p;
  }
  return best;
};
