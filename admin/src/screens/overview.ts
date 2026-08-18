// Is anything on fire, and how big is this thing.
//
// Everything here comes from the snapshot the game process publishes to Redis
// every two seconds, plus a briefly-cached set of totals. Leaving this screen
// open costs the game server nothing — the console never calls it.
import { call } from "../api";
import { duration, esc, num, table } from "../ui";

interface Instance {
  instanceId: string; role: string; uptimeSec: number; rssMb: number;
  sockets: number; online: number; matches: number; queue: Record<string, number>;
  eventLog: { buffered: number; written: number; dropped: number; failures: number };
  evidence: "r2" | "disk";
  replay: { archived: number; failed: number; dropped: number };
  ageMs: number;
}
interface Overview {
  totals: { players: number; newToday: number; matchesToday: number; matchesByGameToday: Record<string, number> };
  live: { online: number; matches: number; matchPlayers: number; matchBots: number; queued: number; instancesUp: number };
  instances: Instance[];
}

const REFRESH_MS = 5000;

const tile = (k: string, v: string | number, note = "", kind = "") =>
  `<div class="tile ${kind}"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div>${
    note ? `<div class="n">${esc(note)}</div>` : ""
  }</div>`;

function render(host: HTMLElement, o: Overview): void {
  const byGame = Object.entries(o.totals.matchesByGameToday).map(([g, n]) => `${g} ${n}`).join(" · ");
  // "No game server is publishing" is the most important thing this screen can
  // say, so it gets a tile of its own rather than an empty table below.
  const serversKind = o.live.instancesUp === 0 ? "down" : "live";

  const rows = o.instances.map((i) => {
    const queued = Object.values(i.queue).reduce((a, b) => a + b, 0);
    const stale = i.ageMs > 6000;
    const log = i.eventLog;
    return `<tr>
      <td class="mono">${esc(i.instanceId)}</td>
      <td class="mono">${esc(i.role)}</td>
      <td class="num">${duration(i.uptimeSec)}</td>
      <td class="num">${num(i.sockets)}</td>
      <td class="num">${num(i.matches)}</td>
      <td class="num">${num(queued)}</td>
      <td class="num">${num(i.rssMb)} MB</td>
      <td class="${log.dropped || log.failures ? "stale" : "muted"}">${num(log.written)} written${
        log.dropped ? ` · ${num(log.dropped)} dropped` : ""
      }${log.buffered ? ` · ${num(log.buffered)} pending` : ""}</td>
      <td class="${stale ? "stale" : "muted"}">${stale ? `${Math.round(i.ageMs / 1000)}s old` : "live"}</td>
    </tr>`;
  });

  // Replays landing on a container's temporary disk look fine right up until
  // somebody needs one, so it is a banner rather than a column.
  const onDisk = o.instances.some((i) => i.role === "game" && i.evidence === "disk");
  const archived = o.instances.reduce((n, i) => n + (i.replay?.archived ?? 0), 0);
  const lost = o.instances.reduce((n, i) => n + (i.replay?.dropped ?? 0), 0);

  host.innerHTML = `
    ${
      onDisk
        ? `<div class="card" style="border-color:var(--amber)"><div class="pad" style="color:var(--amber);font-size:13.5px">
             <strong>Replays are being written to local disk, not to the evidence bucket.</strong>
             Fine on a development machine. On a server it means they disappear with the container —
             set the <code>R2_EVIDENCE_*</code> variables.
           </div></div>`
        : ""
    }
    <div class="tiles">
      ${tile("Players online", num(o.live.online), "right now", "live")}
      ${tile("Matches running", num(o.live.matches), `${o.live.matchPlayers} people · ${o.live.matchBots} bots`, "live")}
      ${tile("In the queue", num(o.live.queued), "parties waiting", o.live.queued > 0 ? "warn" : "")}
      ${tile("Game servers", num(o.live.instancesUp), o.live.instancesUp === 0 ? "NONE PUBLISHING" : "publishing", serversKind)}
      ${tile("Total players", num(o.totals.players), `${o.totals.newToday} new today`)}
      ${tile("Matches today", num(o.totals.matchesToday), byGame || "none yet")}
      ${tile("Replays archived", num(archived), lost > 0 ? `${lost} could not be stored` : "since this server started", lost > 0 ? "down" : "")}
    </div>

    <div class="card">
      <header><h2>Servers</h2><span class="spacer"></span><span class="count">${o.instances.length}</span></header>
      ${table(
        ["Instance", "Role", "Up", "Sockets", "Matches", "Queue", "Memory", "Activity log", "Snapshot"]
          .map((h, i) => `<th${i >= 2 && i <= 6 ? ' style="text-align:right"' : ""}>${h}</th>`),
        rows,
        "Nothing is publishing a snapshot. Either no game server is running, or it cannot reach Redis."
      )}
    </div>`;
}

export function mountOverview(host: HTMLElement): () => void {
  let timer: number | undefined;
  let stopped = false;
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const tick = async () => {
    try {
      const data = await call<Overview>("/overview");
      if (!stopped) render(host, data);
    } catch {
      // The api layer already handles a lost session; one failed poll is not
      // worth blanking a screen somebody may be reading.
    }
    if (!stopped) timer = window.setTimeout(() => void tick(), REFRESH_MS);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
