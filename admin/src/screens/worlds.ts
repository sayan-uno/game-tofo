// Worlds: who is in the public rooms, and what is being said in them.
//
// The one screen that draws the line the players never see. Everywhere else on
// the platform a bot is deliberately indistinguishable from a person; here it
// is labelled, because a moderator reading a room has to know which half of it
// can be moderated at all — and because "is this world actually full of
// people" is the only way to tell whether the population is doing its job or
// covering for the fact that nobody is here.
import { call } from "../api";
import { esc, num, table, when } from "../ui";

interface WorldRow {
  id: string;
  humans: number;
  bots: number;
  total: number;
  capacity: number;
  requests: number;
  requestsByPlayers: number;
  messages24h: number;
}

interface Member {
  kind: "player" | "server";
  uid: string;
  name: string;
  seenAt: number;
}

interface Card {
  id: string;
  uid: string;
  name: string;
  mode: string;
  need: number;
  kind: "player" | "server";
  lobbyId: string | null;
  at: number;
  expiresAt: number;
}

interface Line {
  id: string;
  uid: string;
  name: string;
  body: string;
  at: number | string;
  kind: "player" | "server";
}

interface WorldDetail {
  id: string;
  humans: number;
  bots: number;
  total: number;
  capacity: number;
  members: Member[];
  requests: Card[];
  live: Line[];
}

interface BotPool {
  total: number;
  active: number;
  recent: number;
  top: {
    uid: string;
    name: string;
    skill: number;
    persona: string;
    createdAt: string;
    lastSeenAt: string;
    matches: number;
    wins: number;
    xp: number;
  }[];
}

const REFRESH_MS = 5000;

/** How full a world is, and of what. The bar is the point of the screen: a
 *  world that is 90% server population looks completely different from one
 *  that is 90% people, and no column of numbers makes that as obvious. */
function fill(w: { humans: number; bots: number; capacity: number }): string {
  const h = Math.round((w.humans / w.capacity) * 100);
  const b = Math.round((w.bots / w.capacity) * 100);
  return `<div class="worldbar" title="${w.humans} player(s), ${w.bots} from the server population">
    <span class="worldbar-h" style="width:${h}%"></span><span class="worldbar-b" style="width:${b}%"></span>
  </div>`;
}

const kindTag = (kind: "player" | "server") =>
  kind === "player"
    ? `<span class="pill on">player</span>`
    : `<span class="pill">server</span>`;

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function mountWorlds(host: HTMLElement, go: (h: string) => void): () => void {
  let cancelled = false;
  host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;

  const load = async () => {
    const [data, pool] = await Promise.all([
      call<{ capacity: number; worlds: WorldRow[] }>("/worlds").catch(() => null),
      call<BotPool>("/bots").catch(() => null),
    ]);
    if (cancelled || !data) return;
    const players = data.worlds.reduce((n, w) => n + w.humans, 0);
    const population = data.worlds.reduce((n, w) => n + w.bots, 0);

    const rows = data.worlds.map(
      (w) => `<tr class="click" data-id="${esc(w.id)}">
        <td class="mono">${esc(w.id)}</td>
        <td style="min-width:170px">${fill(w)}</td>
        <td class="num">${num(w.humans)}</td>
        <td class="num muted">${num(w.bots)}</td>
        <td class="num">${num(w.total)} / ${num(w.capacity)}</td>
        <td class="num">${num(w.requests)}${
          w.requests > 0 ? `<span class="muted"> (${num(w.requestsByPlayers)} real)</span>` : ""
        }</td>
        <td class="num">${num(w.messages24h)}</td>
      </tr>`
    );

    host.innerHTML = `
      <div class="card"><div class="pad" style="font-size:13.5px">
        A world holds ${num(data.capacity)} people who can all hear each other. When one fills with
        real players the next opens by itself. The rest of the room is server population —
        the same accounts that fill empty match seats, with the same names and the same records.
        <strong>Players never see this split; you do.</strong>
      </div></div>

      <div class="card">
        <header><h2>Worlds</h2><span class="spacer"></span>
          <span class="count">${num(players)} player${players === 1 ? "" : "s"} · ${num(population)} population</span>
        </header>
        ${table(
          ["World", "", "Players", "Population", "Total", "Team-up cards", "Messages 24h"].map(
            (h, i) => `<th${i >= 2 ? ' style="text-align:right"' : ""}>${h}</th>`
          ),
          rows,
          "No world has opened yet — the first one opens when somebody signs in."
        )}
      </div>

      ${pool ? poolCard(pool) : ""}`;

    host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
      tr.onclick = () => go(`#/worlds/${tr.dataset.id}`);
    });
  };

  void load();
  const timer = window.setInterval(() => void load(), REFRESH_MS);
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

function poolCard(pool: BotPool): string {
  const rows = pool.top.map(
    (b) => `<tr>
      <td>${esc(b.name)}</td>
      <td class="mono muted">${esc(b.uid)}</td>
      <td class="muted">${esc(b.persona)}</td>
      <td class="num">${b.skill}</td>
      <td class="num">${num(b.matches)}</td>
      <td class="num">${num(b.wins)}</td>
      <td class="num">${b.matches ? Math.round((b.wins / b.matches) * 100) : 0}%</td>
      <td class="num">${num(b.xp)}</td>
      <td>${when(b.lastSeenAt)}</td>
    </tr>`
  );
  return `<div class="card">
    <header><h2>Server population</h2><span class="spacer"></span>
      <span class="count">${num(pool.total)} accounts · ${num(pool.recent)} active today</span></header>
    <div class="pad" style="font-size:13.5px;padding-bottom:0">
      Every one of these is a real account with a real record: the matches, wins and XP below were
      earned by playing, in the same transaction that writes a player's. Nothing is pre-filled.
      More are minted automatically as demand grows.
    </div>
    ${table(
      ["Name", "UID", "Talks", "Skill", "Matches", "Wins", "Win rate", "XP", "Last seen"].map(
        (h, i) => `<th${i >= 3 && i <= 7 ? ' style="text-align:right"' : ""}>${h}</th>`
      ),
      rows,
      "Nobody in the population has finished a match yet."
    )}
  </div>`;
}

// ---------------------------------------------------------------------------
// One world
// ---------------------------------------------------------------------------

export function mountWorld(host: HTMLElement, id: string, go: (h: string) => void): () => void {
  let cancelled = false;
  let live = true;
  let showing: "members" | "chat" | "cards" = "members";
  host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;

  const load = async () => {
    const data = await call<WorldDetail>(`/worlds/${encodeURIComponent(id)}`).catch(() => null);
    if (cancelled || !data) return;
    render(data);
  };

  const render = (w: WorldDetail) => {
    // This screen redraws itself every five seconds while Live is on, and the
    // chat view is the one place where that is felt: a log that jumps back to
    // the bottom every time you scroll up to read something is a log you
    // cannot read. So where the reader was is carried across the redraw, and
    // only a reader who was already AT the bottom is kept there.
    const log = host.querySelector<HTMLElement>(".worldchat");
    const keep = log
      ? { top: log.scrollTop, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 30 }
      : null;
    const members = w.members.map(
      (m) => `<tr>
        <td>${kindTag(m.kind)}</td>
        <td>${esc(m.name)}</td>
        <td class="mono muted">${esc(m.uid)}</td>
        <td>${when(new Date(m.seenAt).toISOString())}</td>
        <td>${
          m.kind === "player" && m.uid
            ? `<a class="btn ghost btn-tiny" href="#/players/${encodeURIComponent(m.uid)}">Open</a>`
            : ""
        }</td>
      </tr>`
    );

    const cards = w.requests.map(
      (c) => `<tr>
        <td>${kindTag(c.kind)}</td>
        <td>${esc(c.name)}</td>
        <td class="mono muted">${esc(c.uid)}</td>
        <td>${esc(c.mode)}</td>
        <td class="num">${c.need}</td>
        <td class="mono muted">${esc(c.lobbyId ?? "—")}</td>
        <td>${when(new Date(c.at).toISOString())}</td>
      </tr>`
    );

    const lines = w.live.map(
      (l) => `<div class="worldline ${l.kind}">
        <span class="worldline-who">${esc(l.name)}</span>
        <span class="worldline-body">${esc(l.body)}</span>
        <span class="worldline-at">${new Date(l.at).toLocaleTimeString()}</span>
      </div>`
    );

    host.innerHTML = `
      <div class="card">
        <header>
          <h2>${esc(w.id)}</h2>
          <span class="spacer"></span>
          <span class="count">${num(w.humans)} player${w.humans === 1 ? "" : "s"} ·
            ${num(w.bots)} population · ${num(w.total)} / ${num(w.capacity)}</span>
        </header>
        <div class="pad">${fill(w)}</div>
      </div>

      <div class="card">
        <header>
          <h2>In this world</h2>
          <span class="spacer"></span>
          <button class="btn ghost btn-tiny" data-tab="members">Members</button>
          <button class="btn ghost btn-tiny" data-tab="chat">Chat</button>
          <button class="btn ghost btn-tiny" data-tab="cards">Team-up cards</button>
          <label class="muted" style="margin-left:12px;font-size:13px">
            <input type="checkbox" id="wlive" ${live ? "checked" : ""} /> Live
          </label>
        </header>
        ${
          showing === "members"
            ? table(
                ["", "Name", "UID", "Last seen", ""].map((h) => `<th>${h}</th>`),
                members,
                "Nobody is in this world.",
                true
              )
            : showing === "cards"
              ? table(
                  ["", "Who", "UID", "Mode", "Needs", "Party", "Posted"].map(
                    (h, i) => `<th${i === 4 ? ' style="text-align:right"' : ""}>${h}</th>`
                  ),
                  cards,
                  "Nobody is looking for a group right now."
                )
              : `<div class="worldchat">${
                  lines.length > 0 ? lines.join("") : `<p class="empty">Nothing has been said yet.</p>`
                }</div>
                 <div class="pad muted" style="font-size:12.5px">
                   The last ${w.live.length} line(s) still in the live room. The full fifteen-day archive is
                   below and reading it is written into the audit trail.
                 </div>`
        }
      </div>

      ${showing === "chat" ? `<div class="card" id="archive"><header><h2>Archive</h2><span class="spacer"></span>
        <button class="btn ghost btn-tiny" id="loadArchive">Load 15-day archive</button></header>
        <p class="empty">Not loaded. Reading it is audited by name.</p></div>` : ""}

      <p class="pad"><a class="btn ghost btn-tiny" href="#/worlds">‹ All worlds</a></p>`;

    host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
      b.classList.toggle("on", b.dataset.tab === showing);
      b.onclick = () => {
        showing = b.dataset.tab as typeof showing;
        render(w);
      };
    });
    const liveBox = host.querySelector<HTMLInputElement>("#wlive");
    if (liveBox) liveBox.onchange = () => (live = liveBox.checked);

    const newLog = host.querySelector<HTMLElement>(".worldchat");
    if (newLog) newLog.scrollTop = keep === null || keep.atEnd ? newLog.scrollHeight : keep.top;

    const archiveBtn = host.querySelector<HTMLButtonElement>("#loadArchive");
    if (archiveBtn) {
      archiveBtn.onclick = () => {
        archiveBtn.disabled = true;
        void (async () => {
          const data = await call<{ messages: Line[] }>(
            `/worlds/${encodeURIComponent(w.id)}/archive?limit=300`
          ).catch(() => null);
          const card = host.querySelector<HTMLElement>("#archive");
          if (!card) return;
          if (!data) {
            card.querySelector(".empty")?.replaceWith(
              Object.assign(document.createElement("p"), {
                className: "empty",
                textContent: "Could not load the archive.",
              })
            );
            return;
          }
          card.innerHTML = `<header><h2>Archive</h2><span class="spacer"></span>
            <span class="count">${num(data.messages.length)} line(s)</span></header>
            ${table(
              ["", "Who", "UID", "Said", "When"].map((h) => `<th>${h}</th>`),
              data.messages.map(
                (m) => `<tr>
                  <td>${kindTag(m.kind)}</td>
                  <td>${esc(m.name)}</td>
                  <td class="mono muted">${esc(m.uid)}</td>
                  <td>${esc(m.body)}</td>
                  <td>${when(String(m.at))}</td>
                </tr>`
              ),
              "Nothing in the window.",
              true
            )}`;
        })();
      };
    }
    void go;
  };

  void load();
  const timer = window.setInterval(() => {
    if (live) void load();
  }, REFRESH_MS);
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
