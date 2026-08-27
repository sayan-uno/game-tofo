# End-to-end tests

Real browsers, a real backend, the real CDN. Everything these check — a socket
dropping, two clients agreeing on a crash, a message crossing a match, a pack
landing in IndexedDB — only exists once all three are running at once, so
nothing here is a unit test and nothing here is fast.

For the parts that *can* be checked without a browser, use `npm run check:sim`
instead. It covers the simulation, the course, the ranking and bot difficulty
in about a second, and it is the one to run after touching anything under
`shared/games/trackline/`.

## Running them

Two servers, on their own ports **and their own Redis database**:

```bash
# terminal 1 — test backend (note the /3: its own Redis db)
cd backend
PORT=4100 FRONTEND_URL=http://localhost:5174 \
  REDIS_URL="$(grep '^REDIS_URL=' .env | cut -d= -f2-)/3" \
  ./node_modules/.bin/tsx src/index.ts

# terminal 2 — test frontend
cd frontend
VITE_API_URL=http://localhost:4100 ./node_modules/.bin/vite --port 5174 --strictPort

# terminal 3 — mint logins, then run
node tools/e2e/mint.mjs > tools/e2e/.state/users.json
python3 tools/e2e/test_reconnect.py
```

**The `/3` is not optional.** Two backends sharing one Redis both run
matchmakers, either may claim a party from the pool, and when the wrong one
wins it creates the match in *its* memory and emits to *its* sockets — so the
client waits on FINDING PLAYERS forever while the other server's log cheerfully
reports a match starting. It costs an hour to diagnose and a second to avoid.

Tokens last two hours. `TokenExpiredError`, or a run that hangs on a blank
lobby, means mint again.

## The tests

| File | What it proves |
|---|---|
| `test_reconnect.py` | A drop inside the grace resumes the same run; a reload rebuilds the scene and fast-forwards the sim; a signal loss past the grace forfeits the seat and returns the player to the lobby. |
| `test_forfeit.py` | A leaver is out at once and cannot sneak back; the match carries on for everyone else; the result ranks them below anyone who stayed and scores them only up to the door. |
| `test_limits.py` | Input floods, quick-chat floods, invented message ids and malformed payloads on every handler — and an honest player in the same match who is unaffected. |
| `test_features.py` | Quick chat and emotes crossing between two real clients; the spectator banner; the add-friend offer, which appears for real opponents and not for bots. |
| `test_clock.py` | The match length is the server's to change: run it with `EXPECT_MATCH_SECONDS` matching the backend's `TRACKLINE_MATCH_SECONDS`. |
| `admin-signin.mts` | The console's sign-in over HTTP: enrolment, the authenticator, recovery codes, sudo, refresh rotation and reuse detection, and that a player's token is refused. `npm run e2e:admin`. |
| `test_admin_console.py` | The console in a real browser: the sign-in screen, an httpOnly cookie resuming a session across origins, the overview painting real numbers, and signing out actually ending it. `npm run e2e:console`. |
| `world-chat.mts` | A world exists and talks; a team-up card puts a group together within ten seconds whether or not anybody real answers; a bot's card is one a person can walk into; a real player takes a seat from a bot when the thousand is full; and the teammates who come out of it own the careers they earn, read back out of `bot_stats` after a real match. No browser — `PORT=4100 npm run e2e:world`, with `TRACKLINE_MATCH_SECONDS=30` on the backend to keep the last leg short. Pass `E2E_REDIS_URL` when the backend is on its own Redis database. |
| `social-island.mts` | A drop-in world: START goes straight in with nineteen of the population already on it, a second player joins the SAME island and a bot stands down, positions are batched and range-filtered, a teleport is clamped and a walk into the fountain ends on its rim, emotes and emoji relay, leaving hands the seat back, and the console can see all of it. No browser — `PORT=4100 npm run e2e:social`, with `E2E_REDIS_URL` when the backend is on its own Redis database. |
| `enforcement.mts` | A banned player is refused at the API *and* at the socket handshake, lifting the ban lets them back in at once, an ordinary session leaves the trail the admin console reads, two accounts on one device are linked, and nobody is left marked online afterwards. No browser — run it with `npm run e2e:enforcement`. |

### One more, if a browser test hangs on "downloading"

The dev server **hot-reloads the page whenever `shared/` is re-synced** — and
every `npm run check:*` and every `typecheck` re-syncs it. So running a check in
one terminal while a browser test is downloading a pack in another reloads the
page under it and the download starts again, for as long as you keep editing.
It looks exactly like a stalled CDN. Let the code settle, then run the browser.

## Two facts that shape every test here

**This box renders at about 1.5 fps.** There is no GPU; SwiftShader is CPU-bound
on geometry rather than pixels, so no amount of resolution scaling helps and no
frame rate measured here says anything about a phone. Concretely: the client sim
advances in ~15 m jumps, an autopilot cannot reliably clear obstacles, and any
test needing a *live* runner must act inside the course's empty opening
(`EMPTY_START_METRES`) — that is what `run_until` is for. It is also why clicks
that must land promptly are dispatched with `page.evaluate(... .click())` rather
than Playwright's `click`, whose actionability polling can take seconds.

**The CDN does not allow localhost.** `cdn.tofo.in` names the forwarded
Codespaces origin in its CORS policy, so a browser on `localhost:5174` is
refused every pack file. `harness.allow_cdn` re-fetches the same bytes from the
test process, where no browser policy applies, and hands them back with a
permissive header — the real client code against the real CDN, without touching
the bucket's production config.

## Writing another one

`harness.py` has the pieces: `context` (persistent profile, so the pack
downloads once), `sign_in` (lands in a clean lobby, walking out of any match a
previous test left running), `pick_game`, `wait_downloaded`, `enter_match`,
`play` / `run_until`, and `Check` for the assertions.

One rule worth keeping: **a helper timing out is not evidence of absence.**
`wait_for` returning `None` means it never saw what it was waiting for, which
is not the same as the thing being gone — reading one as the other is how the
signal-loss check first came to pass while proving nothing at all.

`.state/` holds minted tokens and browser profiles and is gitignored.
