// The console shell: a rail on the left, a header with the search box, and one
// screen at a time in the middle.
//
// Routing is on the URL hash. That is not laziness — it means the console can
// be deployed as plain static files to any host, with no rewrite rules, and a
// deep link to a player still survives a refresh. A path-based router would
// need the host configured to serve index.html for unknown paths, which is one
// more thing to get wrong on deployment day.
//
// On load it tries to resume: the refresh token is an httpOnly cookie, so the
// only way to learn whether a session is still alive is to ask the server.
// Nothing about the session is written where a script could read it, which
// means a reload is a question rather than a lookup.
import "./style.css";
import { call, hasToken, refresh, setSessionLostHandler, setToken, signOut } from "./api";
import { showLogin, type SignedIn } from "./login";
import { esc, icon } from "./ui";
import { mountOverview } from "./screens/overview";
import { mountPlayers, searchBox } from "./screens/players";
import { mountPlayer } from "./screens/player";
import { mountSanctions } from "./screens/sanctions";
import { mountGames } from "./screens/games";
import { mountNotices } from "./screens/notices";
import { mountEvents } from "./screens/events";
import { mountPlatform } from "./screens/platform";
import { mountMatches } from "./screens/matches";
import { mountStudio } from "./screens/studio";
import { mountVoice } from "./screens/voice";
import { mountParty } from "./screens/party";
import { mountParties } from "./screens/parties";
import { mountHistory } from "./screens/history";

const root = document.getElementById("root")!;
let stopScreen: (() => void) | null = null;
let me: SignedIn | null = null;

const go = (hash: string) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

interface Route {
  nav: "overview" | "history" | "players" | "matches" | "parties" | "sanctions" | "voice" | "games" | "notices" | "events" | "platform";
  title: string;
  crumb?: string;
  /** What the header box should be showing — a search you navigated to by URL
   *  must be visible in the box, or refining it means retyping it. */
  query?: string;
  mount(host: HTMLElement): () => void;
}

function parse(): Route {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, queryString] = raw.split("?");
  const q = new URLSearchParams(queryString ?? "").get("q") ?? "";
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "players" && parts[1]) {
    const uid = decodeURIComponent(parts[1]);
    return { nav: "players", title: "Player", crumb: uid, mount: (h) => mountPlayer(h, uid, go) };
  }
  if (parts[0] === "players") {
    return { nav: "players", title: "Players", crumb: q || undefined, query: q, mount: (h) => mountPlayers(h, q, go) };
  }
  if (parts[0] === "matches" && parts[1]) {
    const key = decodeURIComponent(parts[1]);
    return { nav: "matches", title: "Studio", crumb: key, mount: (h) => mountStudio(h, key, go) };
  }
  if (parts[0] === "matches") {
    return { nav: "matches", title: "Matches", crumb: q || undefined, mount: (h) => mountMatches(h, q, go) };
  }
  if (parts[0] === "sanctions") {
    return { nav: "sanctions", title: "Sanctions", mount: (h) => mountSanctions(h, go) };
  }
  if (parts[0] === "history") {
    return { nav: "history", title: "History", mount: (h) => mountHistory(h, go) };
  }
  if (parts[0] === "parties" && !parts[1]) {
    return { nav: "parties", title: "Parties", mount: (h) => mountParties(h, go) };
  }
  if (parts[0] === "parties" && parts[1]) {
    // "#/parties/<key>?at=<ms>" opens the party AT a moment — used by a
    // player's history so it lands where they walked in.
    const [key, query] = decodeURIComponent(parts[1]).split("?");
    const at = Number(new URLSearchParams(query ?? "").get("at") ?? 0);
    return { nav: "parties", title: "Party", mount: (h) => mountParty(h, key, go, at) };
  }
  if (parts[0] === "voice") {
    return { nav: "voice", title: "Voice", mount: (h) => mountVoice(h, me?.role ?? "", go) };
  }
  if (parts[0] === "events") {
    return { nav: "events", title: "Events", mount: (h) => mountEvents(h, me?.role ?? "") };
  }
  if (parts[0] === "notices") {
    return { nav: "notices", title: "Notices", mount: (h) => mountNotices(h, me?.role ?? "") };
  }
  if (parts[0] === "games") {
    return { nav: "games", title: "Games", mount: (h) => mountGames(h, me?.role ?? "") };
  }
  if (parts[0] === "platform") {
    return { nav: "platform", title: "Platform", mount: (h) => mountPlatform(h, me?.role ?? "") };
  }
  return { nav: "overview", title: "Overview", mount: mountOverview };
}

function shell(who: SignedIn): void {
  root.innerHTML = `
    <div class="app">
      <aside class="rail">
        <div class="brand">TOFO<i>·</i>CONSOLE</div>
        <nav>
          <div class="heading">Platform</div>
          <a href="#/" data-nav="overview">${icon("gauge")} Overview</a>
          <a href="#/players" data-nav="players">${icon("users")} Players</a>
          <a href="#/matches" data-nav="matches">${icon("play")} Matches</a>
          <div class="heading">Moderation</div>
          <a href="#/sanctions" data-nav="sanctions">${icon("shield")} Sanctions</a>
          <a href="#/history" data-nav="history">${icon("clock")} History</a>
          <a href="#/parties" data-nav="parties">${icon("users")} Parties</a>
          <a href="#/voice" data-nav="voice">${icon("mic")} Voice</a>
          <a href="#/games" data-nav="games">${icon("play")} Games</a>
          <a href="#/notices" data-nav="notices">${icon("mail")} Notices</a>
          <a href="#/events" data-nav="events">${icon("box")} Events</a>
          <a href="#/platform" data-nav="platform">${icon("power")} Platform</a>
        </nav>
        <div class="who">
          <div class="mail">${esc(who.email)}</div>
          <div class="row">
            <span class="pill">${esc(who.role)}</span>
            <span class="spacer" style="flex:1"></span>
            <button class="out" id="out">Sign out</button>
          </div>
        </div>
      </aside>
      <div class="main">
        <div class="head">
          <h1 id="title"></h1>
          <span class="crumb" id="crumb"></span>
          <span class="spacer"></span>
          <span id="searchslot"></span>
        </div>
        <div class="body" id="screen"></div>
      </div>
    </div>`;

  document.getElementById("out")!.onclick = async () => {
    await signOut();
    toLogin();
  };
  const slot = document.getElementById("searchslot")!;
  slot.replaceWith(searchBox("", (q) => go(q ? `#/players?q=${encodeURIComponent(q)}` : "#/players")));
}

function route(): void {
  if (!me) return;
  const r = parse();
  document.getElementById("title")!.textContent = r.title;
  const crumb = document.getElementById("crumb")!;
  crumb.textContent = r.crumb ? `/ ${r.crumb}` : "";
  document.querySelectorAll<HTMLAnchorElement>(".rail nav a").forEach((a) => {
    a.classList.toggle("on", a.dataset.nav === r.nav);
  });
  const box = document.querySelector<HTMLInputElement>(".search input");
  if (box && document.activeElement !== box) box.value = r.query ?? "";
  stopScreen?.();
  stopScreen = r.mount(document.getElementById("screen")!);
}

function showConsole(who: SignedIn): void {
  stopScreen?.();
  stopScreen = null;
  me = who;
  shell(who);
  route();
}

function toLogin(): void {
  stopScreen?.();
  stopScreen = null;
  me = null;
  setToken(null);
  showLogin(root, showConsole);
}
setSessionLostHandler(toLogin);
window.addEventListener("hashchange", route);

async function boot(): Promise<void> {
  root.innerHTML = `<div class="gate"><div class="box"><p class="lead" style="margin:0">Checking your session…</p></div></div>`;
  if (await refresh()) {
    try {
      showConsole((await call<{ admin: SignedIn }>("/session/me")).admin);
      return;
    } catch {
      /* fall through to the sign-in screen */
    }
  }
  if (!hasToken()) toLogin();
}

void boot();
