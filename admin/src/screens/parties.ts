// Every recorded party, newest first.
//
// Its own screen rather than a section under Voice, because it is not about
// voice: EVERY group is replayed for ten days whether or not anybody in it is
// flagged. Voice is the rarer thing that is sometimes added on top.
import { call } from "../api";
import { esc, table } from "../ui";
import { loadParties, partyRow } from "./party";

export function mountParties(host: HTMLElement, go: (h: string) => void): () => void {
  let cancelled = false;
  /** A party id to narrow to — the one the activity log prints when a group
   *  is created, so an admin can go straight from "who started this" to the
   *  recording of it. */
  let query = "";
  host.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`;

  const load = async () => {
    const [parties, status] = await Promise.all([
      loadParties(undefined, query).catch(() => []),
      call<{ partyRetentionDays: number }>("/voice/status").catch(() => null),
    ]);
    if (cancelled) return;
    const live = parties.filter((p) => p.live).length;
    host.innerHTML = `
      <div class="card"><div class="pad" style="font-size:13.5px">
        Every group is replayed — who was in it, what they were wearing, who came and
        went, and what was said — for ${status?.partyRetentionDays ?? 10} days, then deleted.
        It is a few kilobytes per party and costs the players nothing.
        ${live > 0 ? `<strong>${live} happening right now.</strong>` : ""}
      </div></div>
      <div class="card">
        <header><h2>Parties</h2><span class="spacer"></span>
          <input type="search" id="pq" placeholder="Party id…" value="${esc(query)}"
                 style="width:190px;margin-right:10px" />
          <span class="count">${parties.length}</span></header>
        ${table(
          // THE ID FIRST. A group is not its member list: people join and
          // leave all the way through, and the same three names can be two
          // different parties on the same evening. The id is the one thing
          // that is true of the whole recording from beginning to end, and it
          // is what the activity log prints when the party is created.
          ["Party", "Who was in it", "Started", "", "People", "Length", ""].map(
            (h, i) => `<th${i === 4 || i === 5 ? ' style="text-align:right"' : ""}>${h}</th>`
          ),
          parties.map(partyRow),
          "No party has been recorded yet."
        )}
      </div>`;
    host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
      tr.onclick = () => go(`#/parties/${tr.dataset.key}`);
    });
    const box = host.querySelector<HTMLInputElement>("#pq")!;
    // Refocus after every redraw: this list reloads itself every fifteen
    // seconds, and a search box that loses the caret mid-word is unusable.
    if (document.activeElement !== box && query) box.focus();
    box.onkeydown = (e) => {
      if (e.key === "Enter") {
        query = box.value.trim();
        void load();
      }
      if (e.key === "Escape") {
        query = "";
        box.value = "";
        void load();
      }
    };
  };

  void load();
  // A live party grows while you are looking at the list.
  const timer = window.setInterval(() => void load(), 15_000);
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
