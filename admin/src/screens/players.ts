// Finding a player.
//
// One box, and it works out what you gave it: a UID, an email, part of a
// username, an address, a device hash. Guessing beats making somebody choose a
// category from a dropdown before they can type — and the answer says which
// way it read the query, so a surprising result explains itself.
import { call, ApiFailure } from "../api";
import { esc, table, when, pill, icon } from "../ui";

interface Result {
  uid: string; username: string | null; name: string; email: string;
  avatarUrl: string | null; createdAt: string; lastLoginAt: string;
  online: boolean; sanctions: string[];
}

const HINT = `Search by UID, email address, or part of a username. Addresses and device
hashes work too, for admins and owners.`;

function rows(results: Result[]): string[] {
  return results.map((r) => {
    const tags = [
      r.online ? pill("online", "on") : "",
      ...r.sanctions.map((s) => pill(s === "ban" ? "banned" : s, "bad")),
    ].filter(Boolean).join(" ");
    return `<tr class="click" data-uid="${esc(r.uid)}">
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="dot ${r.online ? "on" : ""}"></span>
          <strong>${esc(r.username ?? r.name)}</strong>
        </div>
      </td>
      <td class="mono">${esc(r.uid)}</td>
      <td class="mono muted">${esc(r.email)}</td>
      <td class="muted">${when(r.createdAt)}</td>
      <td class="muted">${when(r.lastLoginAt)}</td>
      <td>${tags}</td>
    </tr>`;
  });
}

export function mountPlayers(host: HTMLElement, query: string, go: (hash: string) => void): () => void {
  const draw = (inner: string) => {
    host.innerHTML = `<div class="card">
      <header><h2>Players</h2><span class="spacer"></span><span class="count" id="how"></span></header>
      ${inner}
    </div>`;
    host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
      tr.onclick = () => go(`#/players/${tr.dataset.uid}`);
    });
  };

  if (!query) {
    draw(`<p class="empty">${esc(HINT)}</p>`);
    return () => undefined;
  }

  draw(`<p class="empty">Searching…</p>`);
  let cancelled = false;

  void (async () => {
    try {
      const r = await call<{ results: Result[]; matchedOn: string }>(`/players/search?q=${encodeURIComponent(query)}`);
      if (cancelled) return;
      draw(
        table(
          ["Player", "UID", "Email", "Joined", "Last seen", ""].map((h) => `<th>${h}</th>`),
          rows(r.results),
          `Nothing matched “${query}”.`
        )
      );
      const how = host.querySelector("#how");
      if (how) how.textContent = r.results.length ? `${r.results.length} by ${r.matchedOn}` : "";
    } catch (e) {
      if (cancelled) return;
      const why = e instanceof ApiFailure ? e.info.error : "Search failed";
      draw(`<p class="empty">${esc(why)}</p>`);
    }
  })();

  return () => {
    cancelled = true;
  };
}

/** The global search box that lives in the header on every screen. */
export function searchBox(initial: string, onSubmit: (q: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "search";
  wrap.innerHTML = `${icon("search")}
    <input type="search" id="q" placeholder="Search players…" autocomplete="off" spellcheck="false" value="${esc(initial)}" />
    <kbd>${navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>`;
  const input = wrap.querySelector<HTMLInputElement>("#q")!;
  input.onkeydown = (e) => {
    if (e.key === "Enter") onSubmit(input.value.trim());
    if (e.key === "Escape") input.blur();
  };
  // A console is used with the hands on the keyboard; a search you have to
  // reach for the mouse to use is a search you stop using.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  return wrap;
}
