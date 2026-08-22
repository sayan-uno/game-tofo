// Finding a player — and, with nothing typed, seeing who is here at all.
//
// SEARCH. One box, and it works out what you gave it: a UID, an email, part of
// a username, an address, a device hash. Guessing beats making somebody choose
// a category from a dropdown before they can type — and the answer says which
// way it read the query, so a surprising result explains itself.
//
// BROWSE. Opening the screen with an empty box lists everybody, newest first.
// A page at a time, fetched as the bottom of the list comes into view: an
// account table is the one thing here that grows without limit, and a console
// that renders forty thousand rows to answer "who joined this week" locks up
// the browser it is supposed to help somebody work in.
import { call, ApiFailure } from "../api";
import { esc, table, when, pill, icon } from "../ui";

interface Result {
  uid: string; username: string | null; name: string; email: string;
  avatarUrl: string | null; createdAt: string; lastLoginAt: string;
  online: boolean; sanctions: string[];
}

const HEAD = ["Player", "UID", "Email", "Joined", "Last seen", ""].map((h) => `<th>${h}</th>`);

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
  let cancelled = false;
  let watcher: IntersectionObserver | null = null;

  const draw = (inner: string) => {
    host.innerHTML = `<div class="card">
      <header><h2>Players</h2><span class="spacer"></span><span class="count" id="how"></span></header>
      ${inner}
    </div>`;
    wireRows();
  };

  /** Rows are clickable wherever they came from, and newly appended ones have
   *  to be wired too — so this runs after every draw AND after every page. */
  const wireRows = () => {
    host.querySelectorAll<HTMLElement>("tr.click").forEach((tr) => {
      tr.onclick = () => go(`#/players/${tr.dataset.uid}`);
    });
  };

  // ---- browse ------------------------------------------------------------
  if (!query) {
    draw(`<p class="empty">Loading the newest accounts…</p>`);

    let cursor: string | null = null;
    let done = false;
    let loading = false;
    let shown = 0;
    let total: number | null = null;

    const setCount = () => {
      const how = host.querySelector<HTMLElement>("#how");
      if (how) {
        how.textContent =
          total === null
            ? `${shown} shown`
            : shown >= total
              ? `all ${total}`
              : `${shown} of ${total}`;
      }
    };

    const page = async (): Promise<void> => {
      if (loading || done || cancelled) return;
      loading = true;
      try {
        const r = await call<{ players: Result[]; cursor: string | null; total: number | null }>(
          `/players${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        if (cancelled) return;
        if (r.total !== null) total = r.total;

        if (shown === 0) {
          // The first page builds the table; every one after it only adds to
          // the body, so nothing already on screen is redrawn and the place
          // somebody has scrolled to does not move under them.
          draw(
            table(HEAD, rows(r.players), "There are no accounts yet.") +
              `<div id="sentinel" class="pad muted" style="font-size:12.5px"></div>`
          );
        } else {
          const body = host.querySelector("table.tbl tbody");
          body?.insertAdjacentHTML("beforeend", rows(r.players).join(""));
          wireRows();
        }
        shown += r.players.length;
        cursor = r.cursor;
        done = !r.cursor;
        setCount();

        const sentinel = host.querySelector<HTMLElement>("#sentinel");
        if (sentinel) sentinel.textContent = done ? (shown > 0 ? "That is everybody." : "") : "Loading more…";
        if (done) {
          watcher?.disconnect();
          watcher = null;
        } else if (sentinel && !watcher) {
          // Watched rather than polled on scroll: the browser tells us when the
          // end of the list comes into view instead of us asking on every one
          // of the hundreds of scroll events a flick of a finger produces.
          // rootMargin starts the next page while it is still off screen, so
          // the list feels continuous rather than stopping to fetch.
          watcher = new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) void page();
            },
            { rootMargin: "600px" }
          );
          watcher.observe(sentinel);
        } else if (sentinel && watcher) {
          // The sentinel is a fresh element after the first draw.
          watcher.disconnect();
          watcher.observe(sentinel);
        }
      } catch (e) {
        if (cancelled) return;
        const why = e instanceof ApiFailure ? e.info.error : "Could not load the players";
        if (shown === 0) draw(`<p class="empty">${esc(why)}</p>`);
        else {
          const sentinel = host.querySelector<HTMLElement>("#sentinel");
          if (sentinel) sentinel.textContent = why;
        }
      } finally {
        loading = false;
      }
    };

    void page();

    return () => {
      cancelled = true;
      watcher?.disconnect();
      watcher = null;
    };
  }

  // ---- search ------------------------------------------------------------
  draw(`<p class="empty">Searching…</p>`);

  void (async () => {
    try {
      const r = await call<{ results: Result[]; matchedOn: string }>(`/players/search?q=${encodeURIComponent(query)}`);
      if (cancelled) return;
      draw(table(HEAD, rows(r.results), `Nothing matched “${query}”.`));
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
