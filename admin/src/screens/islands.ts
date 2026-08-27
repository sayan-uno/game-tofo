// Islands: the live map of a drop-in world.
//
// The question a moderator arrives with is never "how many people are in
// there" — it is "what is THIS person doing", usually with a report open in
// another tab. A list of names cannot answer that. A map can: who is standing
// with whom, who has been alone in the corner for twenty minutes, who is
// walking laps of the island, and who is inside somebody else's earshot at the
// moment something was said.
//
// The map is drawn from the SAME module the game draws the island from
// (@game/shared/games/social) — the props, the paths and the shoreline are the
// real ones, not an artist's impression that will drift the first time a bench
// moves.
//
// It costs the game server nothing: every position on it was already in memory
// because proximity voice needed it, and it reaches the console through the
// ordinary two-second ops snapshot.
import { call } from "../api";
import { esc, num, pill, table } from "../ui";
import {
  BEACH_IN,
  PLAZA_R,
  RING_R,
  WALK_R,
  islandProps,
  type PropKind,
} from "@game/shared/games/social/index";

interface Who {
  uid: string;
  name: string;
  seat: number;
  isBot: boolean;
  connected: boolean;
  x: number;
  z: number;
  ry: number;
  anim: number;
  y: number;
  mins: number;
  near: number;
  met: number;
  joinedAt: number;
  rejects: Record<string, number>;
}

interface IslandRow {
  id: string;
  gameId: string;
  phase: string;
  openedAt: number;
  endsAt: number;
  humans: number;
  bots: number;
  recording: boolean;
  instanceId: string;
  who: Who[];
}

const REFRESH_MS = 2000;
const ANIM = ["standing", "walking", "running"];

const left = (endsAt: number): string => {
  const s = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function mountIslands(host: HTMLElement, go: (hash: string) => void): () => void {
  let cancelled = false;
  host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;

  const load = async () => {
    const data = await call<{ islands: IslandRow[] }>("/islands").catch(() => null);
    if (cancelled) return;
    if (!data) {
      host.innerHTML = `<div class="card"><p class="empty">Could not read the live islands.</p></div>`;
      return;
    }
    const rows = data.islands.map(
      (i) => `<tr data-id="${esc(i.id)}" class="clickable">
        <td><code>${esc(i.id)}</code></td>
        <td>${i.humans}<span class="muted"> / ${i.humans + i.bots}</span></td>
        <td>${Math.round((Date.now() - i.openedAt) / 60000)} min</td>
        <td>${left(i.endsAt)}</td>
        <td>${i.phase === "closing" ? pill("closing", "warn") : pill("open", "on")}</td>
        <td>${i.recording ? pill("recording", "bad") : ""}</td>
        <td class="muted">${esc(i.instanceId.slice(0, 8))}</td>
      </tr>`
    );
    host.innerHTML = `
      <div class="card">
        <h2>Live islands</h2>
        <p class="muted">A drop-in world holds twenty. Seats nobody real is standing in are held by the
          server population — the split below is the one thing players are never told.</p>
        ${table(
          ["Island", "People", "Open for", "Closes in", "Phase", "Voice", "Instance"],
          rows,
          "No islands are running."
        )}
      </div>`;
    host.querySelectorAll<HTMLElement>("tr[data-id]").forEach((tr) => {
      tr.onclick = () => go(`#/islands/${tr.dataset.id}`);
    });
  };

  void load();
  const timer = window.setInterval(() => void load(), REFRESH_MS);
  return () => {
    cancelled = true;
    window.clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// One island
// ---------------------------------------------------------------------------

/** Props drawn as dots, with a size and a colour per kind. Built once: the
 *  layout is a constant, so this is the same string on every refresh and the
 *  only thing that changes between frames is the people. */
let propLayer: string | null = null;
function props(): string {
  if (propLayer !== null) return propLayer;
  const style: Partial<Record<PropKind, { r: number; c: string }>> = {
    tree: { r: 1.8, c: "#2f6b3a" },
    pine: { r: 1.6, c: "#27563a" },
    palm: { r: 1.6, c: "#3d7f4a" },
    bush: { r: 1.0, c: "#3f7a45" },
    rock: { r: 1.1, c: "#7a7a80" },
    bench: { r: 0.9, c: "#8a6a3a" },
    lamp: { r: 0.6, c: "#6a6a72" },
    planter: { r: 0.9, c: "#a4536b" },
    picnic: { r: 1.3, c: "#8a6a3a" },
    kiosk: { r: 2.0, c: "#b4553c" },
    fountain: { r: 3.5, c: "#5f8fb0" },
    gazebo: { r: 3.4, c: "#9a7a4a" },
    statue: { r: 1.4, c: "#8f8f98" },
    arch: { r: 1.6, c: "#a08b62" },
  };
  propLayer = islandProps()
    .map((p) => {
      const s = style[p.k];
      if (!s) return "";
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.z.toFixed(1)}" r="${(s.r * p.s).toFixed(2)}" fill="${s.c}" opacity="0.75"/>`;
    })
    .join("");
  return propLayer;
}

/** The island, with everybody on it. The 20 m circle round each person is
 *  their earshot — which is what makes "who could have heard that" a thing you
 *  can see rather than a thing you have to work out. */
function map(who: Who[], focus: string | null): string {
  const R = WALK_R + 8;
  const people = who
    .map((p) => {
      const cls = p.uid === focus ? "isle-me" : p.isBot ? "isle-bot" : "isle-person";
      const dead = p.connected ? "" : ` opacity="0.35"`;
      // Which way they are facing, as a short spur.
      const fx = p.x + Math.sin(p.ry) * 3.4;
      const fz = p.z + Math.cos(p.ry) * 3.4;
      return `<g class="${cls}"${dead}>
        ${p.isBot ? "" : `<circle cx="${p.x}" cy="${p.z}" r="20" class="isle-ear"/>`}
        <line x1="${p.x}" y1="${p.z}" x2="${fx.toFixed(1)}" y2="${fz.toFixed(1)}" class="isle-face"/>
        <circle cx="${p.x}" cy="${p.z}" r="${p.isBot ? 1.6 : 2.4}" class="isle-dot"/>
        ${p.isBot ? "" : `<text x="${p.x}" y="${p.z - 4}" class="isle-name">${esc(p.name)}</text>`}
      </g>`;
    })
    .join("");
  return `<svg class="isle-map" viewBox="${-R} ${-R} ${R * 2} ${R * 2}" role="img" aria-label="Island map">
      <circle cx="0" cy="0" r="${R}" fill="#123a4d"/>
      <circle cx="0" cy="0" r="${WALK_R}" fill="#c9b487"/>
      <circle cx="0" cy="0" r="${BEACH_IN}" fill="#3d6b3f"/>
      <circle cx="0" cy="0" r="${RING_R}" fill="none" stroke="#b9a582" stroke-width="4.6"/>
      <line x1="${PLAZA_R}" y1="0" x2="66" y2="0" stroke="#b9a582" stroke-width="5.2"/>
      <line x1="${-PLAZA_R}" y1="0" x2="-66" y2="0" stroke="#b9a582" stroke-width="5.2"/>
      <line x1="0" y1="${PLAZA_R}" x2="0" y2="66" stroke="#b9a582" stroke-width="5.2"/>
      <line x1="0" y1="${-PLAZA_R}" x2="0" y2="-66" stroke="#b9a582" stroke-width="5.2"/>
      <circle cx="0" cy="0" r="${PLAZA_R + 0.8}" fill="#c3b492"/>
      ${props()}
      ${people}
    </svg>`;
}

export function mountIsland(host: HTMLElement, id: string, go: (hash: string) => void): () => void {
  let cancelled = false;
  let focus: string | null = null;
  host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;

  const load = async () => {
    const data = await call<IslandRow & { at: number }>(`/islands/${encodeURIComponent(id)}`).catch(() => null);
    if (cancelled) return;
    if (!data) {
      host.innerHTML = `<div class="card"><p class="empty">That island is not running any more.</p>
        <p><a href="#/islands">Back to the list</a></p></div>`;
      return;
    }
    const people = data.who.filter((p) => !p.isBot);
    const rows = people
      .slice()
      .sort((a, b) => b.near - a.near || a.mins - b.mins)
      .map((p) => {
        const rejects = Object.entries(p.rejects ?? {});
        return `<tr data-uid="${esc(p.uid)}" class="clickable${p.uid === focus ? " on" : ""}">
        <td><b>${esc(p.name)}</b><br><code class="muted">${esc(p.uid)}</code></td>
        <td>${ANIM[p.anim] ?? "?"}${p.connected ? "" : ` ${pill("offline", "bad")}`}</td>
        <td class="muted">${p.x.toFixed(0)}, ${p.z.toFixed(0)}${p.y > 0.4 ? ` ↑${p.y.toFixed(1)}m` : ""}</td>
        <td>${p.near}</td>
        <td>${p.met}</td>
        <td>${p.mins} min</td>
        <td>${rejects.length ? pill(rejects.map(([k, v]) => `${k}×${v}`).join(" "), "warn") : ""}</td>
      </tr>`;
      });
    host.innerHTML = `
      <div class="card">
        <h2>Island <code>${esc(data.id)}</code></h2>
        <p class="muted">
          ${num(data.humans)} player${data.humans === 1 ? "" : "s"} and ${num(data.bots)} from the server population ·
          open ${Math.round((Date.now() - data.openedAt) / 60000)} min · closes in ${left(data.endsAt)}
          ${data.recording ? ` · ${pill("voice recording", "bad")}` : ""}
        </p>
        <div class="isle-wrap">${map(data.who, focus)}</div>
        <p class="muted isle-key">
          <span class="isle-swatch person"></span> player ·
          <span class="isle-swatch bot"></span> server population ·
          the faint circle is their 20 m earshot
        </p>
      </div>
      <div class="card">
        <h2>Who is here</h2>
        ${table(["Player", "Doing", "Where", "In earshot", "Met", "Here for", "Refused"], rows, "Nobody real is on this island.")}
        <p class="muted">"In earshot" is how many other players are inside their twenty metres right now —
          i.e. who could hear them speak. Tap a row to highlight them on the map; shift-click to open their
          player page. "Refused" counts position reports the server would not take, which is what a client
          walking through walls looks like from here.</p>
      </div>`;
    host.querySelectorAll<HTMLElement>("tr[data-uid]").forEach((tr) => {
      tr.onclick = (e) => {
        if ((e as MouseEvent).shiftKey) return go(`#/players/${tr.dataset.uid}`);
        focus = focus === tr.dataset.uid ? null : (tr.dataset.uid ?? null);
        void load();
      };
    });
  };

  void load();
  const timer = window.setInterval(() => void load(), REFRESH_MS);
  return () => {
    cancelled = true;
    window.clearInterval(timer);
  };
}
