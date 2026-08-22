// The dashboard.
//
// EVERY NUMBER HERE COMES FROM THE NIGHTLY TABLE, never from the raw log. That
// is not a performance detail, it is the reason this screen can exist at all: a
// dashboard that scans the activity log competes for the database with the
// thing it is measuring, and gets slower every week it succeeds.
//
// It is also the one screen an ANALYST can open, which is why nothing on it
// names a person. Aggregates only — no uid, no username, no row that is about
// somebody. A dashboard is exactly where "just this once" starts.
//
// The charts follow the house rules: one axis per chart (never two scales), a
// legend whenever there is more than one series, direct labels on the last
// point so identity is never colour alone, and a table underneath so the
// numbers are readable without seeing colour at all. The palettes are checked
// rather than chosen — see the note by SERIES below.
import { ApiFailure, call } from "../api";
import { esc, num, toast } from "../ui";

interface Daily {
  day: string;
  dau: number;
  mau: number;
  newAccounts: number;
  matches: number;
  matchesByGame: Record<string, number>;
  avgSessionSec: number;
  funnelSignedIn: number;
  funnelNamed: number;
  funnelPlayed: number;
  reports: number;
  sanctions: number;
}

interface Cohort {
  day: string;
  size: number;
  d1: number;
  d7: number;
  d30: number;
}

/** Categorical, in FIXED ORDER — never cycled, never reassigned when a filter
 *  changes which games are present, because colour follows the game and not
 *  its rank. Stepped for this console's dark surface (#15131b) and checked:
 *  worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.7, all ≥ 3:1 on surface.
 *  A ninth game does not get a generated hue — it folds into "other". */
const SERIES = ["#199e70", "#c98500", "#3987e5", "#d55181", "#9085e9"] as const;
const OTHER = "#6d6678";

/** One hue, light→dark, for the retention grid — magnitude, so a ramp rather
 *  than categories. Low end clears the surface at 2.42:1, so an empty-looking
 *  cell is genuinely empty rather than merely dark. */
const RAMP = ["#8a3a42", "#ad4550", "#cc5763", "#e66e7a", "#ff8a96"] as const;

const PAD = { l: 42, r: 14, t: 12, b: 20 };
const W = 760;
const H = 170;

const short = (day: string) => day.slice(5).replace("-", "/");
const mins = (sec: number) => (sec >= 60 ? `${Math.round(sec / 60)}m` : `${sec}s`);

/** Nice round numbers on the axis, so the reader is not doing arithmetic. */
function ceilNice(n: number): number {
  if (n <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / mag) * mag;
}

/** A line chart of one or more series over the same days. ONE axis, always —
 *  two measures on two scales in one frame is the single most misleading thing
 *  a chart can do. */
function lines(rows: Daily[], series: { key: string; label: string; get: (d: Daily) => number }[]): string {
  const top = ceilNice(Math.max(1, ...rows.flatMap((r) => series.map((s) => s.get(r)))));
  const inner = { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };
  const x = (i: number) => PAD.l + (rows.length < 2 ? inner.w / 2 : (i / (rows.length - 1)) * inner.w);
  const y = (v: number) => PAD.t + inner.h - (v / top) * inner.h;

  const grid = [0, 0.5, 1]
    .map((f) => {
      const gy = PAD.t + inner.h - f * inner.h;
      return `<line class="ch-grid" x1="${PAD.l}" y1="${gy.toFixed(1)}" x2="${W - PAD.r}" y2="${gy.toFixed(1)}"/>
              <text class="ch-tick" x="${PAD.l - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${num(
                Math.round(top * f)
              )}</text>`;
    })
    .join("");

  const paths = series
    .map((s, si) => {
      const colour = SERIES[si % SERIES.length];
      const d = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(s.get(r)).toFixed(1)}`).join(" ");
      const last = rows[rows.length - 1];
      // Direct label on the last point: identity must never be colour alone.
      const label = last
        ? `<text class="ch-dl" x="${(x(rows.length - 1) + 4).toFixed(1)}" y="${(y(s.get(last)) - 5).toFixed(
            1
          )}" fill="${colour}">${esc(s.label)}</text>`
        : "";
      return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${label}`;
    })
    .join("");

  // One hit target per day, wider than the mark, for the crosshair.
  const hits = rows
    .map(
      (r, i) =>
        `<rect class="ch-hit" x="${(x(i) - inner.w / Math.max(1, rows.length) / 2).toFixed(1)}" y="${PAD.t}"
           width="${(inner.w / Math.max(1, rows.length)).toFixed(1)}" height="${inner.h}"
           data-i="${i}" data-x="${x(i).toFixed(1)}"
           data-read="${esc(`${r.day} — ${series.map((s) => `${s.label} ${num(s.get(r))}`).join(" · ")}`)}"/>`
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="ch" preserveAspectRatio="none" role="img">
    ${grid}${paths}
    <line class="ch-cross" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + inner.h}" style="display:none"/>
    ${hits}
    <text class="ch-tick" x="${PAD.l}" y="${H - 6}">${rows[0] ? short(rows[0].day) : ""}</text>
    <text class="ch-tick" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${
      rows[rows.length - 1] ? short(rows[rows.length - 1].day) : ""
    }</text>
  </svg>`;
}

/** Matches a day, stacked by game. A 2px surface gap between segments, so two
 *  games do not read as one taller bar. */
function stacked(rows: Daily[], games: string[]): string {
  const totals = rows.map((r) => games.reduce((n, g) => n + (r.matchesByGame[g] ?? 0), 0));
  const top = ceilNice(Math.max(1, ...totals));
  const inner = { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };
  const bw = Math.max(2, Math.min(22, inner.w / Math.max(1, rows.length) - 3));

  const bars = rows
    .map((r, i) => {
      const cx = PAD.l + ((i + 0.5) / rows.length) * inner.w;
      let acc = 0;
      const segs = games
        .map((g, gi) => {
          const v = r.matchesByGame[g] ?? 0;
          if (v <= 0) return "";
          const h = (v / top) * inner.h;
          const yTop = PAD.t + inner.h - acc - h;
          acc += h;
          return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}"
                    height="${Math.max(1, h - 2).toFixed(1)}" rx="2" fill="${
                      gi < SERIES.length ? SERIES[gi] : OTHER
                    }"/>`;
        })
        .join("");
      const read = games
        .map((g) => `${g} ${num(r.matchesByGame[g] ?? 0)}`)
        .concat(`total ${num(totals[i])}`)
        .join(" · ");
      return `${segs}<rect class="ch-hit" x="${(cx - bw / 2 - 2).toFixed(1)}" y="${PAD.t}" width="${(bw + 4).toFixed(
        1
      )}" height="${inner.h}" data-read="${esc(`${r.day} — ${read}`)}"/>`;
    })
    .join("");

  const grid = [0, 1]
    .map((f) => {
      const gy = PAD.t + inner.h - f * inner.h;
      return `<line class="ch-grid" x1="${PAD.l}" y1="${gy}" x2="${W - PAD.r}" y2="${gy}"/>
              <text class="ch-tick" x="${PAD.l - 6}" y="${gy + 3}" text-anchor="end">${num(Math.round(top * f))}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="ch" preserveAspectRatio="none" role="img">${grid}${bars}</svg>`;
}

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

/** A retention cell: the ramp carries magnitude, the number carries the fact.
 *  Never colour alone. */
function cell(v: number, of: number): string {
  if (of === 0) return `<td class="rt-cell muted">—</td>`;
  const p = pct(v, of);
  const step = p === 0 ? -1 : Math.min(RAMP.length - 1, Math.floor((p / 100) * RAMP.length));
  const bg = step < 0 ? "transparent" : RAMP[step];
  return `<td class="rt-cell" style="background:${bg}"><b>${p}%</b><i>${v}</i></td>`;
}

export function mountAnalytics(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  let days = 30;
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (daily: Daily[], cohorts: Cohort[]) => {
    if (cancelled) return;
    const last = daily[daily.length - 1];
    const games = [...new Set(daily.flatMap((d) => Object.keys(d.matchesByGame)))].sort();
    const totalMatches = daily.reduce((n, d) => n + d.matches, 0);
    const anyData = daily.some((d) => d.dau > 0 || d.matches > 0);

    // The funnel is about the people who ARRIVED in the window, followed
    // forwards — three stages, so bars rather than a chart.
    const f = daily.reduce(
      (a, d) => ({
        signedIn: a.signedIn + d.funnelSignedIn,
        named: a.named + d.funnelNamed,
        played: a.played + d.funnelPlayed,
      }),
      { signedIn: 0, named: 0, played: 0 }
    );

    host.innerHTML = `
      <div class="card"><div class="pad" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:13.5px">
          Written by the console's own hourly job, three days at a time — never read from the raw
          activity log, which is what stops this screen competing with the game for the database.
        </span>
        <span class="spacer" style="flex:1"></span>
        <select id="range">
          <option value="14"${days === 14 ? " selected" : ""}>14 days</option>
          <option value="30"${days === 30 ? " selected" : ""}>30 days</option>
          <option value="90"${days === 90 ? " selected" : ""}>90 days</option>
        </select>
        ${senior ? `<button class="btn ghost" id="rebuild">Rebuild now</button>` : ""}
      </div></div>

      ${
        anyData
          ? ""
          : `<div class="card"><p class="empty">
               Nothing has been aggregated yet. The job runs hourly${
                 senior ? ` — or press <b>Rebuild now</b>` : ""
               }.</p></div>`
      }

      <div class="tiles">
        ${tile("Players today", last ? num(last.dau) : "—", last ? `${num(last.mau)} in the last 30 days` : "")}
        ${tile("New accounts", num(daily.reduce((n, d) => n + d.newAccounts, 0)), `over ${daily.length} day(s)`)}
        ${tile("Matches", num(totalMatches), games.length ? games.join(" · ") : "no games played")}
        ${tile("Session", last ? mins(last.avgSessionSec) : "—", "average, most recent day")}
      </div>

      <div class="card">
        <header><h2>Who was here</h2><span class="spacer"></span>
          <span class="legend">${legend([
            { label: "Players a day", colour: SERIES[0] },
            { label: "Over 30 days", colour: SERIES[1] },
          ])}</span>
        </header>
        <div class="pad">${
          anyData
            ? lines(daily, [
                { key: "dau", label: "DAU", get: (d) => d.dau },
                { key: "mau", label: "MAU", get: (d) => d.mau },
              ])
            : `<p class="empty">No days with anybody on them yet.</p>`
        }</div>
      </div>

      <div class="card">
        <header><h2>Matches a day</h2><span class="spacer"></span>
          <span class="legend">${legend(
            games.map((g, i) => ({ label: g, colour: i < SERIES.length ? SERIES[i] : OTHER }))
          )}</span>
        </header>
        <div class="pad">${
          totalMatches > 0 ? stacked(daily, games) : `<p class="empty">No match has been played in this window.</p>`
        }</div>
      </div>

      <div class="card">
        <header><h2>Signing up</h2><span class="spacer"></span><span class="count">${num(f.signedIn)}</span></header>
        <div class="pad">
          ${
            f.signedIn > 0
              ? `<div class="funnel">
                   ${stage("Signed in", f.signedIn, f.signedIn)}
                   ${stage("Claimed a name", f.named, f.signedIn)}
                   ${stage("Played a match", f.played, f.signedIn)}
                 </div>
                 <p class="muted" style="font-size:12.5px;margin:8px 0 0">
                   Of the accounts created in this window. Where people stop is the one thing a
                   total cannot tell you.</p>`
              : `<p class="empty">Nobody signed up in this window.</p>`
          }
        </div>
      </div>

      <div class="card">
        <header><h2>Coming back</h2><span class="spacer"></span>
          <span class="muted" style="font-size:12px">exactly that day, not "within"</span></header>
        <div class="pad" style="overflow-x:auto">
          ${
            cohorts.some((c) => c.size > 0)
              ? `<table class="tbl rt">
                   <thead><tr><th>Arrived</th><th>People</th><th>Day 1</th><th>Day 7</th><th>Day 30</th></tr></thead>
                   <tbody>${cohorts
                     .filter((c) => c.size > 0)
                     .map(
                       (c) => `<tr>
                         <td class="muted">${esc(c.day)}</td>
                         <td>${num(c.size)}</td>
                         ${cell(c.d1, c.size)}${cell(c.d7, c.size)}${cell(c.d30, c.size)}
                       </tr>`
                     )
                     .join("")}</tbody>
                 </table>`
              : `<p class="empty">No cohort has been measured yet.</p>`
          }
        </div>
      </div>

      <div class="card">
        <header><h2>The numbers</h2><span class="spacer"></span>
          <span class="muted" style="font-size:12px">the same data, readable without colour</span></header>
        <div class="pad" style="overflow-x:auto">
          <table class="tbl">
            <thead><tr><th>Day</th><th>Players</th><th>New</th><th>Matches</th><th>Session</th><th>Reports</th><th>Sanctions</th></tr></thead>
            <tbody>${
              daily.length
                ? [...daily]
                    .reverse()
                    .map(
                      (d) => `<tr>
                        <td class="muted">${esc(d.day)}</td>
                        <td>${num(d.dau)}</td>
                        <td>${num(d.newAccounts)}</td>
                        <td>${num(d.matches)}</td>
                        <td class="muted">${mins(d.avgSessionSec)}</td>
                        <td>${num(d.reports)}</td>
                        <td>${num(d.sanctions)}</td>
                      </tr>`
                    )
                    .join("")
                : `<tr><td colspan="7" class="empty">Nothing yet.</td></tr>`
            }</tbody>
          </table>
        </div>
      </div>`;

    host.querySelector<HTMLSelectElement>("#range")!.onchange = (e) => {
      days = Number((e.target as HTMLSelectElement).value);
      void load();
    };
    host.querySelector<HTMLButtonElement>("#rebuild")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Rebuilding…";
      try {
        await call("/analytics/rebuild", { method: "POST" });
        toast("Rebuilt.");
        void load();
      } catch (err) {
        toast(err instanceof ApiFailure ? err.info.error : "Could not rebuild");
        btn.disabled = false;
        btn.textContent = "Rebuild now";
      }
    });
    wireHover(host);
  };

  const load = async () => {
    try {
      const r = await call<{ daily: Daily[]; cohorts: Cohort[] }>(`/analytics?days=${days}`);
      if (!cancelled) draw(r.daily, r.cohorts);
    } catch (e) {
      if (!cancelled) {
        host.innerHTML = `<div class="card"><p class="empty">${esc(
          e instanceof ApiFailure ? e.info.error : "Could not read the numbers"
        )}</p></div>`;
      }
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}

const tile = (label: string, value: string, sub: string) =>
  `<div class="tile"><span class="t-label">${esc(label)}</span><span class="t-value">${esc(
    value
  )}</span><span class="t-sub">${esc(sub)}</span></div>`;

const legend = (items: { label: string; colour: string }[]) =>
  items.length < 2
    ? ""
    : items
        .map(
          (i) =>
            `<span class="lg"><i style="background:${i.colour}"></i>${esc(i.label)}</span>`
        )
        .join("");

const stage = (label: string, n: number, of: number) =>
  `<div class="fn-row">
     <span class="fn-label">${esc(label)}</span>
     <span class="fn-bar"><i style="width:${of > 0 ? Math.round((n / of) * 100) : 0}%"></i></span>
     <span class="fn-num">${num(n)} <em>${pct(n, of)}%</em></span>
   </div>`;

/** One tooltip for the screen, moved rather than rebuilt. A chart in a browser
 *  IS interactive; a static picture of numbers you cannot interrogate is a
 *  screenshot. */
function wireHover(host: HTMLElement): void {
  let tip = host.querySelector<HTMLElement>(".ch-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "ch-tip";
    tip.hidden = true;
    host.appendChild(tip);
  }
  host.querySelectorAll<SVGRectElement>(".ch-hit").forEach((hit) => {
    hit.addEventListener("pointerenter", () => {
      const svg = hit.ownerSVGElement!;
      const box = svg.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const r = hit.getBoundingClientRect();
      tip!.textContent = hit.dataset.read ?? "";
      tip!.hidden = false;
      tip!.style.left = `${Math.min(hostBox.width - 220, r.left - hostBox.left)}px`;
      tip!.style.top = `${box.top - hostBox.top - 6}px`;
      const cross = svg.querySelector<SVGLineElement>(".ch-cross");
      if (cross && hit.dataset.x) {
        cross.setAttribute("x1", hit.dataset.x);
        cross.setAttribute("x2", hit.dataset.x);
        cross.style.display = "";
      }
    });
    hit.addEventListener("pointerleave", () => {
      tip!.hidden = true;
      const cross = hit.ownerSVGElement?.querySelector<SVGLineElement>(".ch-cross");
      if (cross) cross.style.display = "none";
    });
  });
}
