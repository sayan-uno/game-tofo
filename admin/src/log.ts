// The activity log, rendered.
//
// One renderer, two places: the whole platform between two moments, and the
// same rows narrowed to one player on their profile. They are the same
// question asked with a different filter, so they are the same code.
import { esc, pill } from "./ui";

export interface LogRow {
  id: string;
  at: string;
  type: string;
  uid: string | null;
  matchKey: string | null;
  gameId: string | null;
  lobbyId: string | null;
  data: Record<string, unknown> | null;
  ip: string | null;
  country: string | null;
}

const TONE: Record<string, "" | "on" | "off" | "bad" | "warn"> = {
  "lobby.party": "on",
  "lobby.search": "warn",
  "lobby.cancel": "",
  "lobby.leave": "",
  "lobby.mode": "",
  "match.created": "warn",
  "game.hold": "bad",
  "platform.maintenance": "bad",
  "game.ban": "bad",
  "game.release": "on",
  "game.unban": "on",
  "voice.mic": "warn",
  "session.start": "on",
  "session.end": "off",
  "session.back": "on",
  "session.away": "off",
  "session.rejected": "bad",
  "sanction.applied": "bad",
  "sanction.lifted": "warn",
  "admin.login": "warn",
  "ops.command": "warn",
  "lobby.kick": "warn",
};

/** What the row MEANS, in a sentence. A log nobody can read at a glance is a
 *  log nobody reads. */
function phrase(r: LogRow): string {
  const d = (r.data ?? {}) as Record<string, string>;
  switch (r.type) {
    case "profile.view":
      return `looked at <strong>${esc(d.viewed ?? "?")}</strong>'s profile`;
    case "collection.equip":
      return `equipped ${[d.character && `character <strong>${esc(d.character)}</strong>`, d.weapon !== undefined && (d.weapon ? `weapon <strong>${esc(d.weapon)}</strong>` : "empty hands")]
        .filter(Boolean)
        .join(" and ")}`;
    case "lobby.invite":
      return `invited <strong>${esc(d.to ?? "?")}</strong>`;
    case "lobby.join":
      return d.via === "code"
        ? "joined a party with a team code"
        : d.via === "invite"
          ? `joined <strong>${esc(d.by ?? "?")}</strong>'s party after an invite`
          : "joined a friend's party";
    case "lobby.party":
      // The id, spelled out: it is what an admin copies into the search box to
      // pull up the group's whole recording.
      return `started a party <strong class="mono">${esc(String(d.party ?? r.lobbyId ?? "?"))}</strong>`;
    case "lobby.kick":
      return `removed <strong>${esc(d.target ?? "?")}</strong> from the party`;
    case "lobby.leader":
      return `handed the party to <strong>${esc(d.to ?? "?")}</strong>`;
    case "lobby.search":
      // Pressing START, whatever came of it. The match line that may follow is
      // a different fact: this one is the ask.
      return `looked for a ${esc(r.gameId ?? "match")} ${
        d.solo ? "on their own" : `with ${Number(d.party ?? 0)} of ${Number(d.size ?? 0)}`
      }`;
    case "lobby.cancel":
      return `stopped the search${d.leader ? "" : " — not the leader"}`;
    case "lobby.leave":
      return "left the party";
    case "lobby.mode":
      return `set the party to ${esc(String(d.mode ?? "?"))}`;
    case "lobby.pick":
      return `picked ${esc(r.gameId ?? "no game")}`;
    case "session.start":
      return "came online";
    case "session.end":
      return `went offline${d.seconds ? ` after ${Math.round(Number(d.seconds) / 60)} min` : ""}`;
    case "platform.maintenance":
      return d.at
        ? `scheduled maintenance for ${new Date(Number(d.at)).toLocaleString()} — ${esc(String(d.message ?? ""))}`
        : "called off the maintenance window";
    case "game.hold":
      return `put <strong>${esc(r.gameId ?? "a game")}</strong> on hold — ${esc(String(d.reason ?? "no reason given"))}`;
    case "game.release":
      return `let everyone play <strong>${esc(r.gameId ?? "a game")}</strong> again`;
    case "game.ban":
      // Named as something done TO this player, because that is how it will be
      // read: from their page, by somebody asking why they cannot start it.
      return `was barred from <strong>${esc(r.gameId ?? "a game")}</strong> — ${esc(
        String(d.reason ?? "no reason given")
      )}`;
    case "game.unban":
      return `can play <strong>${esc(r.gameId ?? "a game")}</strong> again`;
    case "voice.mic":
      return d.on ? "opened their microphone" : "closed their microphone";
    case "session.away":
      return "went quiet — minimised or switched away";
    case "session.back":
      return `came back${d.awaySeconds ? ` after ${Number(d.awaySeconds)}s away` : ""}`;
    case "session.rejected":
      return `was turned away — ${esc(String(d.why ?? "?"))}`;
    case "auth.login":
      return "signed in";
    case "match.created": {
      // Named by what it was BUILT FROM: whole parties by their own id, and
      // players who came on their own by theirs. Afterwards the roster is a
      // flat list of four people and cannot answer which of them arrived
      // together — which is usually the question.
      const from = (d.from as unknown as { party?: string | null; uids?: string[] }[] | undefined) ?? [];
      const parts = from.map((f) =>
        f.party
          ? `party <strong class="mono">${esc(f.party)}</strong>${
              f.uids && f.uids.length > 1 ? ` (${f.uids.length})` : ""
            }`
          : `<strong class="mono">${esc((f.uids ?? []).join(", "))}</strong>`
      );
      const bots = Number(d.bots ?? 0);
      // The match's own id, spelled out. It is the handle: paste it into the
      // filter and this line, every mic opened during it and every party that
      // walked into it come back together.
      return `made ${esc(r.gameId ?? "match")} <strong class="mono">${esc(r.matchKey ?? "?")}</strong> from ${
        parts.length ? parts.join(" + ") : "nobody"
      }${bots > 0 ? ` + ${bots} bot${bots === 1 ? "" : "s"}` : ""}`;
    }
    case "match.ended":
      return "finished a match";
    case "sanction.applied":
      return `was <strong>${esc(String(d.sanctionType ?? d.type ?? "sanctioned"))}</strong>${
        d.reason ? ` — ${esc(String(d.reason))}` : ""
      }${d.until ? ` until ${new Date(String(d.until)).toLocaleDateString()}` : ""}`;
    case "sanction.lifted":
      return `had their <strong>${esc(String(d.sanctionType ?? "sanction"))}</strong> lifted`;
    case "admin.login":
      return `console sign-in — <strong>${esc(String(d.email ?? "?"))}</strong> (${esc(String(d.role ?? "?"))})`;
    case "ops.command":
      return d.voice
        ? `voice recording ${esc(String(d.voice))}${d.detail ? ` — ${esc(String(d.detail))}` : ""}`
        : `admin command <strong>${esc(String(d.kind ?? d.command ?? "?"))}</strong>`;
    case "auth.username":
      return `claimed the name <strong>${esc(String(d.username ?? "?"))}</strong>`;
    case "match.joined":
      return "joined a match";
    case "match.left":
      return "left a match";
    default:
      return Object.keys(d).length ? `<span class="mono">${esc(JSON.stringify(d).slice(0, 90))}</span>` : "";
  }
}

const stamp = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: "2-digit", month: "short" })} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })}`;
};

export function renderLog(rows: LogRow[], opts: { showWho: boolean } = { showWho: true }): string {
  if (rows.length === 0) return `<p class="empty">Nothing happened in this window.</p>`;
  return rows
    .map(
      (r) => `<div class="ev logrow">
        <span class="mono when">${stamp(r.at)}</span>
        ${pill(r.type, TONE[r.type] ?? "")}
        ${opts.showWho && r.uid ? `<strong class="click" data-open="${esc(r.uid)}">${esc(r.uid)}</strong>` : ""}
        <span class="what">${phrase(r)}</span>
        ${r.ip ? `<span class="muted mono addr">${esc(r.ip)}${r.country ? ` ${esc(r.country)}` : ""}</span>` : ""}
      </div>`
    )
    .join("");
}
