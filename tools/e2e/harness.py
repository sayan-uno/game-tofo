"""Shared plumbing for the end-to-end tests.

These drive REAL browsers against a REAL backend, because everything worth
checking here — a socket dropping, two clients agreeing on a crash, a pack
downloading into IndexedDB — only exists once all three are running at once.

Three things make that possible in this Codespace and each is a trap if you
forget it:

  * TEST SERVERS, NOT THE DEV PAIR. The suite talks to :4100/:5174, and that
    backend must be on its own Redis database. Two backends sharing one Redis
    both run matchmakers, either may claim a party from the pool, and if the
    wrong one wins the client waits on FINDING PLAYERS forever with no error
    anywhere. See tools/e2e/README.md for the exact command.

  * THE CDN SHIM. cdn.tofo.in only allows the forwarded Codespaces origin, so a
    browser on localhost is refused every pack file. `allow_cdn` re-fetches the
    same bytes from the test process, where no browser policy applies, and
    hands them back with a permissive header — the real client code against
    the real CDN, without touching the bucket's production config.

  * A PERSISTENT PROFILE. `profile=` keeps IndexedDB between runs so the pack
    downloads once (~13 s) instead of every time. Pass profile=None for a cold
    client — which is itself worth testing.

And one hard limit to design around: THIS BOX RENDERS AT ABOUT 1.5 FPS. There
is no GPU, SwiftShader is CPU-bound on geometry rather than pixels, so no
amount of resolution scaling helps and no frame rate measured here means
anything about a real phone. The consequence for tests is concrete: the client
sim advances in ~15 m jumps, so an autopilot cannot reliably clear obstacles,
and any test that needs a LIVE runner must act inside the opening stretch of
the course, which is empty by design (EMPTY_START_METRES). `run_until` is there
for exactly that.
"""
import json
import os
import time

BASE = "http://localhost:5174"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, ".state")
# SwiftShader: this box has no GPU. Everything renders, nothing is fast, and no
# frame rate measured here means anything.
GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def users():
    with open(os.path.join(STATE, "users.json")) as f:
        return json.load(f)


async def allow_cdn(ctx):
    async def handler(route):
        r = await route.fetch()
        h = dict(r.headers)
        h["access-control-allow-origin"] = "*"
        h.pop("content-encoding", None)
        h.pop("content-length", None)
        await route.fulfill(response=r, headers=h, body=await r.body())

    await ctx.route("https://cdn.tofo.in/**", handler)


async def context(pw, browser=None, profile="a", w=1100, h=620, noisy=False):
    """A browser context wired for the suite. Returns (ctx, page)."""
    if profile is None:
        b = browser or await pw.chromium.launch(args=GL_ARGS)
        ctx = await b.new_context(viewport={"width": w, "height": h})
    else:
        ctx = await pw.chromium.launch_persistent_context(
            os.path.join(STATE, f"prof_{profile}"), headless=True, args=GL_ARGS,
            viewport={"width": w, "height": h})
    await allow_cdn(ctx)
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    page.on("pageerror", lambda e: log("  [pageerror]", str(e)[:220]))
    if noisy:
        page.on("console", lambda m: log("  [console]", m.type, m.text[:200])
                if m.type in ("error", "warning") else None)
    return ctx, page


async def sign_in(page, user, settle=40):
    """Land in a clean, interactive lobby.

    A match left running by an earlier test RESUMES on sign-in and takes over
    the screen — correct behaviour, and never what the next test wants. Resume
    is not instant either (the scene has to be rebuilt), so this waits for the
    client to settle rather than sampling once and guessing.
    """
    await page.add_init_script(f"localStorage.setItem('tofo_token', {json.dumps(user['token'])});")
    await page.goto(BASE, wait_until="domcontentloaded")
    await page.wait_for_selector(".hud .game-pick-btn", timeout=90000)
    end = time.time() + settle
    while time.time() < end:
        await page.wait_for_timeout(1500)
        if await page.is_visible(".tl-hud"):
            await leave_match(page)
            continue
        if await page.is_visible(".match-search"):
            if await page.is_visible(".ms-cancel"):
                await page.click(".ms-cancel")
            continue
        # `offsetParent` is the honest test: the button exists in the DOM the
        # whole time, and only stops being clickable when a layer covers it.
        if await page.evaluate("() => !!document.querySelector('.game-pick-btn')?.offsetParent"):
            break
    if await page.is_visible(".leave-btn"):
        await page.click(".leave-btn")
        await page.wait_for_timeout(1000)


async def leave_match(page):
    """Walk out of a running match and back to the lobby."""
    if await page.is_visible(".mx-leave"):
        await page.click(".mx-leave")
        await page.wait_for_timeout(2500)
    if await page.is_visible(".mr-lobby"):
        await page.click(".mr-lobby")
        await page.wait_for_timeout(1500)


async def pick_game(page, game="trackline", name="Trackline"):
    if (await page.text_content(".gp-name")) != name:
        await page.click(".game-pick-btn")
        await page.wait_for_selector(f".gs-card[data-id='{game}']")
        await page.click(f".gs-card[data-id='{game}']")


async def wait_downloaded(page, budget=420):
    """START lights only once every party member has the whole pack."""
    end = time.time() + budget
    while time.time() < end:
        if await page.evaluate(
            "() => { const b = document.querySelector('.game-start-btn'); return !!b && !b.hasAttribute('disabled'); }"
        ):
            return True
        await page.wait_for_timeout(1200)
    return False


async def enter_match(page, budget=120000):
    await page.click(".game-start-btn")
    await page.wait_for_selector(".tl-hud", timeout=budget)
    await page.wait_for_function("window.__tofoMatch?.debug()?.game?.local?.tick > 3", timeout=60000)


async def dbg(page):
    """The running game's own view of itself (DEV-only hook)."""
    return await page.evaluate("window.__tofoMatch?.debug()?.game ?? null")


async def play(page, seconds, steer=True):
    """Autopilot: hold the safe lane, jump the low barriers, roll under the
    high ones. Returns the last debug snapshot.

    It has to clear obstacles, not merely steer — steering alone dies at the
    first barrier a few seconds in, and a test that wanted a live runner ten
    seconds later gets a corpse and a confusing failure.

    JUMP IS TRIGGERED EARLIER THAN ROLL because the arc lasts longer than a
    roll does, so it has to be started further out. Both windows are in metres
    ahead, and both are deliberately wide: this box renders slowly enough that
    a narrow window is missed between samples.
    """
    end = time.time() + seconds
    d = None
    armed = None
    while time.time() < end:
        d = await dbg(page)
        if not d:
            break
        me, up = d["local"], d["upcoming"]
        if not steer or not me["alive"]:
            await page.wait_for_timeout(120)
            continue
        if me["lane"] != up["safeLane"] and up["ahead"] > 6:
            await page.keyboard.press("ArrowRight" if me["lane"] < up["safeLane"] else "ArrowLeft")
        elif armed != up["z"]:
            mine = [o for o in up["obstacles"] if o["lane"] == me["lane"]]
            kind = mine[0]["kind"] if mine else None
            if kind == "low" and 4 < up["ahead"] < 10:
                await page.keyboard.press("ArrowUp")
                armed = up["z"]
            elif kind == "high" and 2.5 < up["ahead"] < 7:
                await page.keyboard.press("ArrowDown")
                armed = up["z"]
        await page.wait_for_timeout(110)
    return d


async def run_until(page, metres, budget=25):
    """Play until the runner passes `metres`, or give up after `budget`.

    Use this instead of `play(page, seconds)` when a test needs the runner to
    be at a known point — at 1.5 fps a fixed number of seconds lands anywhere
    between 20 m and 200 m, which is the difference between "safely inside the
    empty opening" and "dead at the first barrier".
    """
    end = time.time() + budget
    d = None
    while time.time() < end:
        d = await dbg(page)
        if not d or not d["local"]["alive"] or d["local"]["distance"] >= metres:
            break
        await page.wait_for_timeout(90)
    return d


class Check:
    """Tiny assertion tally so a test reads as a list of claims."""

    def __init__(self, title):
        self.title = title
        self.failed = 0
        self.passed = 0
        log(f"── {title}")

    def ok(self, cond, label, detail=""):
        if cond:
            self.passed += 1
            log(f"  ✓ {label}" + (f"  {detail}" if detail else ""))
        else:
            self.failed += 1
            log(f"  ✗ {label}" + (f"  {detail}" if detail else ""))
        return bool(cond)

    def done(self):
        log(f"── {self.title}: {self.passed} passed, {self.failed} failed")
        return self.failed == 0
