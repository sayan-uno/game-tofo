// Everything the console knows about one player, on one page.
//
// Ordered by how often it answers a question: who they are, how they have been
// playing, what they have played, what has been done to them — and then, for
// admins only, where they have connected from and who else is on the same
// device. That last panel is the one that turns "a new player" into "the
// person you removed last week", which is why it is role-gated and audited.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { duration, esc, num, pill, sanctionLabel, table, toast, when } from "../ui";

interface Player {
  uid: string; username: string | null; name: string; email: string; avatarUrl: string | null;
  createdAt: string; lastLoginAt: string; equippedCharacter: string | null; equippedWeapon: string | null;
  online: boolean; lobbyId: string | null; matchId: string | null;
}
interface Stats {
  matches: number; wins: number; losses: number; draws: number; bestPlacement: number | null;
  totalScore: number; coins: number; distanceMetres: number; playtimeSeconds: number; xp: number;
}
interface MatchRow {
  matchKey: string; gameId: string; createdAt: string; reason: string; playerCount: number;
  placement: number; score: number; forfeit: boolean; detail: Record<string, number>;
}
interface Sanction {
  id: string; type: string; reason: string; note: string | null;
  createdAt: string; expiresAt: string | null; revokedAt: string | null;
}
interface Session {
  at: string; type: string; ip: string | null; country: string | null; ua: string | null; deviceHash: string | null;
  data: Record<string, unknown>;
}
interface Device { deviceHash: string; firstSeenAt: string; lastSeenAt: string; seenCount: number; ua: string | null }
interface Linked { uid: string; username: string | null; via: string; how: "device" | "ip" }
interface Profile {
  player: Player; stats: Stats | null; matches: MatchRow[]; sanctions: Sanction[];
  activeSanctions: Record<string, { reason: string; until: number | null }>;
  friends: number; canSeeAddresses: boolean;
  sessions?: Session[]; devices?: Device[]; linked?: Linked[];
}

const card = (title: string, inner: string, count?: string | number) =>
  `<div class="card"><header><h2>${esc(title)}</h2><span class="spacer"></span>${
    count !== undefined ? `<span class="count">${esc(String(count))}</span>` : ""
  }</header>${inner}</div>`;

const th = (labels: string[], rightFrom = 99) =>
  labels.map((h, i) => `<th${i >= rightFrom ? ' style="text-align:right"' : ""}>${h}</th>`);

/** A user-agent trimmed to the part a person actually reads. */
function device(ua: string | null): string {
  if (!ua) return "—";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows"
    : /Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "unknown";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox" : "";
  return `${os}${br ? ` · ${br}` : ""}`;
}

/** What a moderator can hand out, worded as the console words it rather than
 *  as the database keys it. */
const ACTIONS: { type: string; verb: string; blurb: string }[] = [
  { type: "ban", verb: "Ban", blurb: "cannot connect at all" },
  { type: "match", verb: "Bar from matches", blurb: "lobby and friends still work" },
  { type: "voice", verb: "Mute voice", blurb: "can hear, cannot speak" },
  { type: "chat", verb: "Mute chat", blurb: "messages are refused, and they are told" },
  { type: "shadow-chat", verb: "Shadow mute", blurb: "messages go nowhere, and they are not told" },
];

const DURATIONS = [
  { value: "60", label: "1 hour" },
  { value: "1440", label: "1 day" },
  { value: "10080", label: "7 days" },
  { value: "43200", label: "30 days" },
  { value: "", label: "Permanent (admins only)" },
];

async function applyTo(uid: string, who: string, action: (typeof ACTIONS)[number], reload: () => void): Promise<void> {
  const answer = await ask({
    title: `${action.verb} ${who}`,
    intro: `${action.blurb[0].toUpperCase()}${action.blurb.slice(1)}. The reason is shown to the player and recorded against your name.`,
    confirm: action.verb,
    fields: [
      { name: "reason", label: "Reason — the player sees this", placeholder: "e.g. abusive voice chat" },
      { name: "minutes", label: "For how long", type: "select", value: "1440", options: DURATIONS },
      { name: "note", label: "Internal note (optional)", type: "textarea", placeholder: "Only the console sees this." },
    ],
    async onSubmit(v) {
      if (v.reason.trim().length < 3) return "Give a reason — the player is shown it.";
      try {
        const done = await withSudo(() =>
          call<{ ok: boolean }>(`/players/${encodeURIComponent(uid)}/sanctions`, {
            method: "POST",
            body: JSON.stringify({
              type: action.type,
              reason: v.reason.trim(),
              note: v.note || null,
              minutes: v.minutes ? Number(v.minutes) : null,
            }),
          })
        );
        // Backed out of the confirmation — not an error, just nothing done.
        return done === null ? "Cancelled." : null;
      } catch (e) {
        return e instanceof ApiFailure ? e.info.error : "That did not work";
      }
    },
  });
  if (answer) {
    toast(`${action.verb} applied to ${who}.`);
    reload();
  }
}

async function lift(id: string, what: string, reload: () => void): Promise<void> {
  const answer = await ask({
    title: `Lift the ${what}?`,
    intro: "It stops applying immediately. The record stays, marked as lifted.",
    confirm: "Lift it",
    fields: [{ name: "reason", label: "Why (optional)", placeholder: "e.g. appeal upheld" }],
    async onSubmit(v) {
      try {
        const done = await withSudo(() =>
          call(`/sanctions/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ reason: v.reason }) })
        );
        return done === null ? "Cancelled." : null;
      } catch (e) {
        return e instanceof ApiFailure ? e.info.error : "That did not work";
      }
    },
  });
  if (answer) {
    toast(`${what} lifted.`);
    reload();
  }
}

function render(host: HTMLElement, p: Profile, go: (h: string) => void, reload: () => void): void {
  const { player: u, stats: s } = p;
  const active = Object.entries(p.activeSanctions);

  const tags = [
    u.online ? pill("online", "on") : pill("offline", "off"),
    ...active.map(([t]) => pill(sanctionLabel(t), "bad")),
    u.matchId ? pill("in a match", "warn") : "",
  ].filter(Boolean).join(" ");

  const identity = `<div class="pad"><dl class="kv">
    <dt>UID</dt><dd class="mono">${esc(u.uid)}</dd>
    <dt>Username</dt><dd>${esc(u.username ?? "—")}</dd>
    <dt>Google name</dt><dd class="muted">${esc(u.name)}</dd>
    <dt>Email</dt><dd class="mono">${esc(u.email)}</dd>
    <dt>Joined</dt><dd>${when(u.createdAt)}</dd>
    <dt>Last login</dt><dd>${when(u.lastLoginAt)}</dd>
    <dt>Friends</dt><dd class="mono">${num(p.friends)}</dd>
    <dt>Wearing</dt><dd class="mono muted">${esc(u.equippedCharacter ?? "default")}${
      u.equippedWeapon ? ` · ${esc(u.equippedWeapon)}` : ""
    }</dd>
    <dt>Right now</dt><dd class="muted">${
      u.matchId ? `in match <span class="mono">${esc(u.matchId)}</span>`
      : u.lobbyId ? `in lobby <span class="mono">${esc(u.lobbyId)}</span>`
      : u.online ? "online, not in a match" : "offline"
    }</dd>
  </dl></div>`;

  const career = s
    ? `<div class="pad"><dl class="kv">
        <dt>Matches</dt><dd class="mono">${num(s.matches)}</dd>
        <dt>Record</dt><dd class="mono">${num(s.wins)}W · ${num(s.losses)}L · ${num(s.draws)}D</dd>
        <dt>Best place</dt><dd class="mono">${s.bestPlacement ?? "—"}</dd>
        <dt>XP</dt><dd class="mono">${num(s.xp)}</dd>
        <dt>Coins</dt><dd class="mono">${num(s.coins)}</dd>
        <dt>Distance</dt><dd class="mono">${num(s.distanceMetres)} m</dd>
        <dt>Playtime</dt><dd class="mono">${duration(s.playtimeSeconds)}</dd>
      </dl></div>`
    : `<p class="empty">No finished matches yet.</p>`;

  const matchRows = p.matches.map((m) => `<tr class="watch" data-key="${esc(m.matchKey)}" title="Watch this match">
      <td class="mono">${esc(m.gameId)}</td>
      <td class="muted">${when(m.createdAt)}</td>
      <td class="num">${m.placement === 1 ? `<strong>1st</strong>` : `${m.placement}`} / ${m.playerCount}</td>
      <td class="num">${num(m.score)}</td>
      <td>${m.forfeit ? pill("left early", "warn") : `<span class="muted">${esc(m.reason)}</span>`}</td>
      <td class="mono muted">${esc(m.matchKey)}</td>
    </tr>`);

  const sanctionRows = p.sanctions.map((x) => {
    const live = !x.revokedAt && (!x.expiresAt || new Date(x.expiresAt).getTime() > Date.now());
    const state = x.revokedAt ? pill("lifted", "off")
      : !live ? pill("expired", "off")
      : pill("active", "bad");
    return `<tr>
      <td>${pill(sanctionLabel(x.type), live ? "bad" : "off")}</td>
      <td>${esc(x.reason)}</td>
      <td class="muted">${when(x.createdAt)}</td>
      <td class="muted">${x.expiresAt ? when(x.expiresAt) : "permanent"}</td>
      <td>${state}</td>
      <td>${live ? `<button class="btn ghost lift" data-id="${esc(x.id)}" data-what="${esc(sanctionLabel(x.type))}">Lift</button>` : ""}</td>
    </tr>`;
  });

  // ---- admin-only panels --------------------------------------------------
  let privileged = "";
  if (p.canSeeAddresses) {
    const sessionRows = (p.sessions ?? []).map((x) => `<tr>
        <td class="muted">${when(x.at)}</td>
        <td class="mono">${esc(x.type)}</td>
        <td class="mono">${esc(x.ip ?? "—")}</td>
        <td class="mono muted">${esc(x.country ?? "—")}</td>
        <td class="muted">${esc(device(x.ua))}</td>
        <td class="mono muted">${x.deviceHash ? esc(x.deviceHash.slice(0, 10)) : "—"}</td>
      </tr>`);

    const deviceRows = (p.devices ?? []).map((d) => `<tr>
        <td class="mono">${esc(d.deviceHash.slice(0, 16))}</td>
        <td class="muted">${esc(device(d.ua))}</td>
        <td class="muted">${when(d.firstSeenAt)}</td>
        <td class="muted">${when(d.lastSeenAt)}</td>
        <td class="num">${num(d.seenCount)}</td>
      </tr>`);

    const linkedRows = (p.linked ?? []).map((l) => `<tr class="click" data-uid="${esc(l.uid)}">
        <td><strong>${esc(l.username ?? l.uid)}</strong></td>
        <td class="mono">${esc(l.uid)}</td>
        <td>${pill(l.how === "device" ? "same device" : "same address", "warn")}</td>
        <td class="mono muted">${esc(l.via)}</td>
      </tr>`);

    privileged = `
      ${card(
        "Linked accounts",
        table(
          th(["Player", "UID", "How", "Shared"]),
          linkedRows,
          "No other account has been seen on this player's devices or addresses."
        ),
        (p.linked ?? []).length
      )}
      ${card(
        "Activity trail",
        table(th(["When", "Event", "Address", "Country", "Device", "Fingerprint"]), sessionRows,
          "Nothing recorded yet. The activity trail starts when a player next connects.", true),
        (p.sessions ?? []).length
      )}
      ${card(
        "Devices",
        table(th(["Fingerprint", "Looks like", "First seen", "Last seen", "Sessions"], 4), deviceRows,
          "No device has reported a fingerprint for this player yet."),
        (p.devices ?? []).length
      )}`;
  } else {
    privileged = card(
      "Activity trail",
      `<p class="empty">Addresses, devices and linked accounts are visible to admins and owners only.</p>`
    );
  }

  host.innerHTML = `
    <div class="phead">
      ${u.avatarUrl ? `<img class="av" src="${esc(u.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : `<div class="av"></div>`}
      <div class="who">
        <h1>${esc(u.username ?? u.name)}</h1>
        <div class="sub">${esc(u.uid)} · ${esc(u.email)}</div>
        <div class="tags">${tags}</div>
      </div>
    </div>

    <div class="grid2">
      <div>${card("Account", identity)}</div>
      <div>${card("Career", career)}</div>
    </div>

    ${card("Recent matches", table(th(["Game", "When", "Place", "Score", "Ended", "Match"], 2), matchRows,
      "This player has not finished a match yet.", true), p.matches.length)}

    ${card(
      "Sanctions",
      `<div class="actions">${ACTIONS.map(
        (a) => `<button class="btn ${a.type === "ban" ? "" : "ghost"} act" data-type="${a.type}" title="${esc(a.blurb)}">${esc(a.verb)}</button>`
      ).join("")}</div>` +
        table(th(["Type", "Reason", "Applied", "Until", "State", ""]), sanctionRows,
          "Nothing has ever been applied to this account."),
      p.sanctions.length
    )}

    ${privileged}`;

  host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
    tr.onclick = () => go(`#/players/${tr.dataset.uid}`);
  });
  // A match row opens the studio. If no replay was archived the studio says
  // so, which is better than a row that silently does nothing.
  host.querySelectorAll<HTMLElement>("tr.watch").forEach((tr) => {
    tr.classList.add("click");
    tr.onclick = () => go(`#/matches/${tr.dataset.key}`);
  });
  const who = u.username ?? u.name;
  host.querySelectorAll<HTMLElement>("button.act").forEach((b) => {
    const action = ACTIONS.find((a) => a.type === b.dataset.type)!;
    b.onclick = () => void applyTo(u.uid, who, action, reload);
  });
  host.querySelectorAll<HTMLElement>("button.lift").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      void lift(b.dataset.id!, b.dataset.what!, reload);
    };
  });
}

export function mountPlayer(host: HTMLElement, uid: string, go: (h: string) => void): () => void {
  let cancelled = false;
  const load = () => {
    void (async () => {
      try {
        const p = await call<Profile>(`/players/${encodeURIComponent(uid)}`);
        if (!cancelled) render(host, p, go, load);
      } catch (e) {
        if (cancelled) return;
        const why = e instanceof ApiFailure ? e.info.error : "Could not load that player";
        host.innerHTML = `<div class="card"><p class="empty">${esc(why)}</p></div>`;
      }
    })();
  };
  host.innerHTML = `<p class="empty">Loading…</p>`;
  load();
  return () => {
    cancelled = true;
  };
}
