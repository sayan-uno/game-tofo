import { api } from "../api/http";
import { setAvatar } from "./avatar";
import { setNameView } from "./nameview";
import type { Profile, ProfileAchievement, User } from "../types";

/** The player's career page, opened from the top-left chip.
 *
 *  Ships as its own lazy chunk (main.ts warms it on idle), so none of this
 *  costs the lobby a byte on the critical path. It draws a fully opaque
 *  full-screen page — the caller parks the Babylon render loop while it's up,
 *  because rendering a lobby nobody can see is pure wasted GPU and battery.
 *
 *  Two-pass render: the identity block (avatar, tag, UID) paints instantly
 *  from the session's user, and only the career data waits on the request.
 *  That payload is cached for the session and re-shown stale-while-revalidate,
 *  so every open after the first is immediate.
 */

export interface ProfileHooks {
  /** Fired once the page covers the screen. */
  onShow?: () => void;
  /** Fired after it's gone — always paired with onShow, errors included. */
  onHide?: () => void;
}

export interface OpenProfileOptions extends ProfileHooks {
  /** True for the signed-in player's own card (owner-only rows, /me route). */
  self?: boolean;
}

/** Per-player cache, shared with the lobby's member card: tapping a squadmate
 *  fetches their card once, and "View full profile" then opens on data that's
 *  already in hand. Entries younger than FRESH_MS are served as-is, so the
 *  two views never fire the same request twice in a row. */
const cache = new Map<string, { profile: Profile; at: number }>();
const FRESH_MS = 30_000;
const CACHE_MAX = 20;

/** The cached payload for a player, however old — for painting before the
 *  network answers. */
export function peekProfile(uid: string): Profile | null {
  return cache.get(uid)?.profile ?? null;
}

export async function fetchProfile(uid: string, self: boolean): Promise<Profile> {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.profile;
  const profile = await api.get<Profile>(self ? "/api/profile/me" : `/api/profile/${encodeURIComponent(uid)}`);
  cache.set(uid, { profile, at: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!); // oldest out
  return profile;
}

/** The mounted page, if any — a double tap must never stack two. */
let screen: HTMLElement | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (n: number) => n.toLocaleString();

const RING_LENGTH = 2 * Math.PI * 54; // r=54 in the 120×120 ring viewBox

/** Inline icons (Lucide-style 24×24 strokes) — no network, no icon font. */
const ICONS: Record<string, string> = {
  flag: `<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>`,
  userCheck: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>`,
  userPlus: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>`,
  users: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  target: `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`,
  crosshair: `<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>`,
  shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`,
  crown: `<path d="M3 18h18"/><path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 8H5z"/>`,
  lock: `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
  check: `<path d="m5 12 5 5L20 6"/>`,
  swords: `<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M9.5 17.5 21 6V3h-3L6.5 14.5"/>`,
  // Runner achievements: distance run, coins collected, a top-three finish.
  route: `<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h5a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h5"/>`,
  coin: `<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M9.5 9.5h4a2 2 0 0 1 0 4h-3a2 2 0 0 0 0 4h4"/>`,
  medal: `<circle cx="12" cy="15" r="6"/><path d="m8.2 10.6-3-6.1h4l2.3 4.6"/><path d="m15.8 10.6 3-6.1h-4l-2.3 4.6"/>`,
  back: `<path d="m15 18-6-6 6-6"/>`,
  alert: `<path d="M12 9v5"/><path d="M12 17.5h.01"/><path d="M10.3 3.9 2.4 17.4A2 2 0 0 0 4.1 20.4h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`,
};

const icon = (key: string, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    ICONS[key] ?? ICONS.shield
  }</svg>`;

/** Career area while the request is out: eight stat tiles and a card, pulsing.
 *  Same shape as the real content, so nothing jumps when the data lands. */
const SKELETON = `
  <div class="pf-skel pf-skel-grid">${'<div class="pf-skel-tile"></div>'.repeat(8)}</div>
  <div class="pf-skel pf-skel-block"></div>
`;

function frag(html: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}

const date = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

function playtime(minutes: number): string {
  if (minutes <= 0) return "0h";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** ------------------------------------------------------------------ open */

export function openProfile(user: User, opts: OpenProfileOptions = {}) {
  if (screen) return;
  const self = opts.self === true;
  const hooks: ProfileHooks = opts;

  const page = document.createElement("div");
  page.className = "pf-screen";
  page.innerHTML = `
    <div class="pf-bg" aria-hidden="true">
      <div class="pf-glow"></div>
      <div class="pf-grid"></div>
      <div class="pf-vignette"></div>
    </div>

    <header class="pf-head">
      <button class="pf-back" type="button" aria-label="Close profile">${icon("back")}</button>
      <div class="pf-head-text">
        <span class="pf-kicker">// ${self ? "Player card" : "Squadmate"}</span>
        <h2 class="pf-head-title">PROFILE</h2>
      </div>
      <img class="pf-head-logo" src="/logo-red.png" alt="" width="36" height="36" />
    </header>

    <div class="pf-scroll">
      <section class="pf-hero">
        <div class="pf-id pf-card">
          <div class="pf-av-wrap">
            <svg class="pf-ring" viewBox="0 0 120 120" aria-hidden="true">
              <circle class="pf-ring-bg" cx="60" cy="60" r="54"></circle>
              <circle class="pf-ring-fill" cx="60" cy="60" r="54"
                stroke-dasharray="${RING_LENGTH.toFixed(2)}" stroke-dashoffset="${RING_LENGTH.toFixed(2)}"></circle>
            </svg>
            <span class="pf-av"></span>
            <span class="pf-lvl"><i>LVL</i><b>—</b></span>
          </div>
          <div class="pf-id-text">
            <div class="pf-name"></div>
            <div class="pf-uid">UID <b></b><button class="pf-copy" type="button">COPY</button></div>
            <div class="pf-tags">
              <span class="pf-tag pf-tag-live pf-wait"><i></i>Online</span>
              <span class="pf-tag pf-wait pf-tag-friends">— Friends</span>
              ${self ? "" : '<button class="pf-report" type="button">⚑ Report</button>'}
            </div>
            <div class="pf-xp">
              <div class="pf-xp-bar"><i></i></div>
              <span class="pf-xp-text pf-wait">Loading career…</span>
            </div>
          </div>
        </div>
        <div class="pf-rank-slot"><div class="pf-skel pf-skel-rank"></div></div>
      </section>

      <nav class="pf-tabs">
        <button class="pf-tab active" type="button" data-pane="overview">Overview</button>
        <button class="pf-tab" type="button" data-pane="awards">Achievements<span class="pf-tab-count hidden"></span></button>
        <button class="pf-tab" type="button" data-pane="account">${self ? "Account" : "Info"}</button>
      </nav>

      <div class="pf-panes">${SKELETON}</div>
    </div>
  `;

  const scroll = page.querySelector<HTMLElement>(".pf-scroll")!;
  const tabsNav = page.querySelector<HTMLElement>(".pf-tabs")!;
  const panes = page.querySelector<HTMLElement>(".pf-panes")!;
  const rankSlot = page.querySelector<HTMLElement>(".pf-rank-slot")!;

  // Instant pass — everything the session already knows.
  setNameView(page.querySelector<HTMLElement>(".pf-name")!, user.name);
  page.querySelector<HTMLElement>(".pf-uid b")!.textContent = user.uid;
  setAvatar(page.querySelector<HTMLElement>(".pf-av")!, user.name, user.avatarUrl);

  // Reporting from here rather than only from a results screen: an offensive
  // name is not about a match, and neither is somebody you met a week ago.
  // Loaded on demand — the sheet costs the lobby nothing until it is wanted.
  page.querySelector<HTMLButtonElement>(".pf-report")?.addEventListener("click", () => {
    void import("./report").then(({ openReport }) => openReport({ uid: user.uid, name: user.name }));
  });

  const copyBtn = page.querySelector<HTMLButtonElement>(".pf-copy")!;
  copyBtn.onclick = () => {
    void navigator.clipboard?.writeText(user.uid).catch(() => {});
    copyBtn.textContent = "COPIED";
    copyBtn.classList.add("done");
    setTimeout(() => {
      copyBtn.textContent = "COPY";
      copyBtn.classList.remove("done");
    }, 1200);
  };

  // Tabs: the three panes are built once and toggled — switching never
  // re-renders or touches the network.
  page.querySelectorAll<HTMLButtonElement>(".pf-tab").forEach((tab) => {
    tab.onclick = () => {
      page.querySelectorAll<HTMLElement>(".pf-tab").forEach((t) => t.classList.toggle("active", t === tab));
      panes.querySelectorAll<HTMLElement>(".pf-pane").forEach((p) => {
        p.classList.toggle("hidden", p.dataset.pane !== tab.dataset.pane);
      });
      scroll.scrollTop = 0;
    };
  });

  const close = () => {
    if (screen !== page) return;
    screen = null;
    document.removeEventListener("keydown", onKey);
    page.remove();
    hooks.onHide?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  // Back sits exactly where the chip that opened this page was: a double tap
  // there would open and instantly close. Nobody closes a page they opened
  // 300 ms ago on purpose, so that window is simply ignored.
  const openedAt = performance.now();
  page.querySelector<HTMLButtonElement>(".pf-back")!.onclick = () => {
    if (performance.now() - openedAt > 300) close();
  };
  document.addEventListener("keydown", onKey);

  screen = page;
  document.getElementById("ui-root")!.appendChild(page);
  hooks.onShow?.();

  const paint = (profile: Profile) => {
    tabsNav.classList.remove("hidden");
    fillHero(page, profile);
    rankSlot.replaceChildren(frag(rankCard(profile)));
    buildPanes(page, panes, profile);
  };

  const failed = (message: string) => {
    rankSlot.replaceChildren();
    tabsNav.classList.add("hidden");
    page.querySelectorAll<HTMLElement>(".pf-wait").forEach((el) => el.classList.remove("pf-wait"));
    page.querySelector<HTMLElement>(".pf-xp-text")!.textContent = "Career stats unavailable";
    page.querySelector<HTMLElement>(".pf-tag-friends")!.textContent = "— Friends";
    panes.replaceChildren(
      frag(`
        <div class="pf-card pf-empty">
          ${icon("alert", "pf-empty-icon")}
          <strong>Couldn't load your career</strong>
          <p>${esc(message)}</p>
          <button class="btn btn-red pf-retry" type="button">Try again</button>
        </div>
      `)
    );
    panes.querySelector<HTMLButtonElement>(".pf-retry")!.onclick = () => {
      panes.replaceChildren(frag(SKELETON));
      rankSlot.replaceChildren(frag(`<div class="pf-skel pf-skel-rank"></div>`));
      load();
    };
  };

  // Stale-while-revalidate: a cached payload paints now, the fresh one only
  // repaints if something actually moved (no flicker on every open).
  const shown = peekProfile(user.uid);
  const load = () => {
    void fetchProfile(user.uid, self)
      .then((profile) => {
        if (screen !== page) return;
        if (!shown || JSON.stringify(shown) !== JSON.stringify(profile)) paint(profile);
      })
      .catch((err: unknown) => {
        if (screen !== page || shown) return; // already showing something usable
        failed(err instanceof Error ? err.message : "Something went wrong.");
      });
  };

  if (shown) paint(shown);
  load();
}

/** ---------------------------------------------------------------- sections */

function fillHero(page: HTMLElement, p: Profile) {
  // The server row wins over the session copy — a tag claimed on another
  // device shows up here without a reload.
  setNameView(page.querySelector<HTMLElement>(".pf-name")!, p.user.name);
  page.querySelector<HTMLElement>(".pf-uid b")!.textContent = p.user.uid;
  page.querySelector<HTMLElement>(".pf-lvl b")!.textContent = String(p.level);

  const friendTag = page.querySelector<HTMLElement>(".pf-tag-friends")!;
  friendTag.textContent = `${num(p.friends)} ${p.friends === 1 ? "Friend" : "Friends"}`;
  friendTag.classList.remove("pf-wait");

  const liveTag = page.querySelector<HTMLElement>(".pf-tag-live")!;
  liveTag.className = `pf-tag pf-tag-live${p.online ? "" : " off"}`;
  liveTag.replaceChildren(document.createElement("i"), document.createTextNode(p.online ? "Online" : "Offline"));

  const pct = p.xpForLevel > 0 ? Math.min(1, p.xpInLevel / p.xpForLevel) : 0;
  const xpText = page.querySelector<HTMLElement>(".pf-xp-text")!;
  xpText.textContent = `${num(p.xpInLevel)} / ${num(p.xpForLevel)} XP to Level ${p.level + 1}`;
  xpText.classList.remove("pf-wait");
  // transform on an inner fill (never width) — the bar animates on the
  // compositor and can't trigger layout behind the page.
  page.querySelector<HTMLElement>(".pf-xp-bar i")!.style.setProperty("--p", String(pct));
  // One frame later, so the ring sweeps up from empty instead of snapping.
  const ring = page.querySelector<SVGCircleElement>(".pf-ring-fill")!;
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = String(RING_LENGTH * (1 - pct));
  });
}

function rankCard(p: Profile): string {
  const { rank } = p;
  const pct = rank.placementsNeeded > 0 ? Math.min(1, rank.placementsDone / rank.placementsNeeded) : 0;
  const glyph =
    rank.tier === "unranked"
      ? `<text class="pf-shield-q" x="32" y="47" text-anchor="middle">?</text>`
      : `<path class="pf-shield-mark" d="M20 38 32 27l12 11"/><path class="pf-shield-mark" d="M20 50 32 39l12 11"/>`;
  return `
    <div class="pf-card pf-rank" data-tier="${esc(rank.tier)}">
      <svg class="pf-shield" viewBox="0 0 64 72" aria-hidden="true">
        <path class="pf-shield-body" d="M32 3 60 13v25c0 17-13 27-28 32C17 65 4 55 4 38V13z"/>
        ${glyph}
      </svg>
      <div class="pf-rank-text">
        <span class="pf-rank-label">Current rank</span>
        <strong class="pf-rank-tier">${esc(rank.label)}</strong>
        <p class="pf-rank-note">${esc(rank.note)}</p>
        <div class="pf-bar"><i style="--p:${pct}"></i></div>
        <div class="pf-rank-foot">
          <span class="pf-rank-count">${rank.placementsDone}/${rank.placementsNeeded} placements</span>
          <span class="pf-season">Season 0 · Preseason</span>
        </div>
      </div>
    </div>
  `;
}

function buildPanes(page: HTMLElement, panes: HTMLElement, p: Profile) {
  const s = p.stats;
  const tiles: { label: string; value: string }[] = [
    { label: "Matches", value: num(s.matches) },
    { label: "Wins", value: num(s.wins) },
    { label: "Losses", value: num(s.losses) },
    { label: "Win rate", value: s.winRate === null ? "—" : `${s.winRate.toFixed(1)}%` },
    // A runner has no eliminations. These are the two numbers its matches
    // actually produce, and both come straight off the career totals.
    { label: "Distance", value: s.distanceMetres >= 1000 ? `${(s.distanceMetres / 1000).toFixed(1)} km` : `${num(s.distanceMetres)} m` },
    { label: "Coins", value: num(s.coins) },
    { label: "Playtime", value: playtime(s.playtimeMinutes) },
    { label: "Best place", value: s.bestPlacement === null ? "—" : `#${s.bestPlacement}` },
  ];
  const active = page.querySelector<HTMLElement>(".pf-tab.active")?.dataset.pane ?? "overview";
  const pane = (id: string) => (id === active ? "pf-pane" : "pf-pane hidden");

  panes.replaceChildren(
    frag(`
      <div class="${pane("overview")}" data-pane="overview">
        <div class="pf-stats">
          ${tiles
            .map(
              (t) => `
            <div class="pf-tile">
              <span class="pf-tile-value">${esc(t.value)}</span>
              <span class="pf-tile-label">${esc(t.label)}</span>
            </div>`
            )
            .join("")}
        </div>
        <div class="pf-card pf-empty">
          ${icon("swords", "pf-empty-icon")}
          <strong>No matches yet</strong>
          <p>TOFO's first game is on the way. Match history, rank progress and every stat above start filling in the moment you drop in.</p>
        </div>
      </div>

      <div class="${pane("awards")}" data-pane="awards">
        <div class="pf-awards">${p.achievements.map(badge).join("")}</div>
      </div>

      <div class="${pane("account")}" data-pane="account">
        <div class="pf-card pf-rows">
          <div class="pf-row"><span>Gamer tag</span><b class="pf-row-name"></b></div>
          <div class="pf-row"><span>Player UID</span><b>${esc(p.user.uid)}</b></div>
          <div class="pf-row"><span>Member since</span><b>${esc(date(p.memberSince))}</b></div>
          ${
            p.isSelf && p.lastLoginAt
              ? `<div class="pf-row"><span>Last sign-in</span><b>${esc(date(p.lastLoginAt))}</b></div>`
              : ""
          }
          <div class="pf-row"><span>Friends</span><b>${num(p.friends)}</b></div>
          ${
            p.isSelf
              ? `<div class="pf-row"><span>Sign-in method</span><b>Google</b></div>`
              : `<div class="pf-row"><span>Status</span><b>${p.online ? "Online" : "Offline"}</b></div>`
          }
        </div>
        ${
          p.isSelf
            ? `<p class="pf-fineprint">Your gamer tag is what every rival and squadmate sees — your Google name and email never leave your account.</p>`
            : `<p class="pf-fineprint">Add them with their UID from Friends → Add to squad up any time.</p>`
        }
      </div>
    `)
  );

  setNameView(panes.querySelector<HTMLElement>(".pf-row-name")!, p.user.name);

  const count = page.querySelector<HTMLElement>(".pf-tab-count")!;
  count.textContent = `${p.achievements.filter((a) => a.unlocked).length}/${p.achievements.length}`;
  count.classList.remove("hidden");
}

function badge(a: ProfileAchievement): string {
  const pct = a.progress && a.progress.need > 0 ? Math.min(1, a.progress.have / a.progress.need) : 0;
  const track =
    !a.unlocked && a.progress
      ? `<div class="pf-bar pf-bar-sm"><i style="--p:${pct}"></i></div>
         <span class="pf-badge-count">${num(a.progress.have)} / ${num(a.progress.need)}</span>`
      : "";
  return `
    <div class="pf-badge ${a.unlocked ? "on" : "off"}">
      <span class="pf-badge-icon">${icon(a.icon)}</span>
      <div class="pf-badge-text">
        <strong>${esc(a.name)}</strong>
        <span class="pf-badge-desc">${esc(a.desc)}</span>
        ${track}
      </div>
      <span class="pf-badge-state">${icon(a.unlocked ? "check" : "lock")}</span>
    </div>
  `;
}
