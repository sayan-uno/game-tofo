import { setAvatar } from "./avatar";
import { setNameView } from "./nameview";
import { fetchProfile, openProfile, peekProfile, type ProfileHooks } from "./profile";
import type { LobbyMember, Profile } from "../types";

/** Tap a squadmate's character → their card.
 *
 *  Everyone in the group gets it: a snapshot of who they are (tag, UID, level,
 *  rank, headline stats) and a way through to their full career page. The
 *  leader gets the same card plus the group controls that used to be the only
 *  thing a tap did.
 *
 *  Built on demand and removed on any action — no persistent DOM or listeners
 *  while closed. The snapshot paints instantly from the lobby's own member
 *  data and fills in the career numbers when the request lands; that payload
 *  is cached per player, so "View full profile" opens on data already in hand.
 */
export interface MemberCardOptions {
  /** Leader-only group controls. Omitted for everyone else. */
  manage?: { onTransfer: () => void; onKick: () => void };
  /** Handed to the full page so it can park the lobby's render loop. */
  profileHooks?: ProfileHooks;
}

const CROWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18h18"/><path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 8H5z"/></svg>`;

export function showMemberCard(member: LobbyMember, opts: MemberCardOptions = {}) {
  document.querySelector(".mc-backdrop")?.remove(); // one at a time

  const backdrop = document.createElement("div");
  backdrop.className = "mc-backdrop";
  backdrop.innerHTML = `
    <div class="mc-card" role="dialog" aria-label="Player card">
      <button class="mc-close" type="button" aria-label="Close">✕</button>
      <div class="mc-top">
        <span class="mc-av"></span>
        <div class="mc-id">
          <div class="mc-name"></div>
          <div class="mc-uid">UID <b></b></div>
          <div class="mc-chips">
            <span class="mc-chip mc-lvl pf-wait">LVL —</span>
            <span class="mc-chip mc-rank pf-wait">Unranked</span>
            ${member.isLeader ? `<span class="mc-chip mc-leader">${CROWN}Leader</span>` : ""}
          </div>
        </div>
      </div>
      <div class="mc-stats">
        <div class="mc-stat"><b class="pf-wait">—</b><span>Matches</span></div>
        <div class="mc-stat"><b class="pf-wait">—</b><span>Wins</span></div>
        <div class="mc-stat"><b class="pf-wait">—</b><span>K/D</span></div>
      </div>
      <div class="mc-actions"></div>
    </div>
  `;

  setNameView(backdrop.querySelector<HTMLElement>(".mc-name")!, member.name);
  backdrop.querySelector<HTMLElement>(".mc-uid b")!.textContent = member.uid;
  setAvatar(backdrop.querySelector<HTMLElement>(".mc-av")!, member.name, member.avatarUrl);

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.querySelector<HTMLButtonElement>(".mc-close")!.onclick = close;
  // Tap outside the card closes it.
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };

  const actions = backdrop.querySelector<HTMLElement>(".mc-actions")!;
  const button = (label: string, className: string, onClick: () => void) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.innerHTML = label;
    btn.onclick = () => {
      close();
      onClick();
    };
    actions.appendChild(btn);
  };

  button("View full profile", "btn btn-red mc-go", () => {
    openProfile(member, { self: false, ...opts.profileHooks });
  });
  // Leader controls act immediately — opening the card is the deliberate step,
  // a second accept/decline prompt was dropped on purpose.
  if (opts.manage) {
    button(`${CROWN}Make leader`, "btn btn-ghost mc-lead", opts.manage.onTransfer);
    button("Kick from group", "btn btn-ghost btn-danger", opts.manage.onKick);
  }

  document.getElementById("ui-root")!.appendChild(backdrop);

  const fill = (p: Profile) => {
    if (!backdrop.isConnected) return; // closed while the request was in flight
    const set = (selector: string, text: string) => {
      const el = backdrop.querySelector<HTMLElement>(selector)!;
      el.textContent = text;
      el.classList.remove("pf-wait");
    };
    set(".mc-lvl", `LVL ${p.level}`);
    set(".mc-rank", p.rank.label);
    const tiles = backdrop.querySelectorAll<HTMLElement>(".mc-stat b");
    const values = [p.stats.matches.toLocaleString(), p.stats.wins.toLocaleString(), p.stats.kd === null ? "—" : p.stats.kd.toFixed(2)];
    tiles.forEach((el, i) => {
      el.textContent = values[i];
      el.classList.remove("pf-wait");
    });
  };

  const known = peekProfile(member.uid);
  if (known) fill(known);
  // A failed snapshot leaves the placeholders in place — the card is still
  // useful, and the full page reports the problem properly if they go there.
  void fetchProfile(member.uid, false).then(fill).catch(() => {});
}
