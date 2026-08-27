#!/usr/bin/env python3
"""Look at the island.

Everything else about Social Space is checked by arithmetic (`npm run
check:social`) or over a socket (`npm run e2e:social`). This is the part that
can only be checked by LOOKING: whether the ground textures tile, whether a
bench faces the way it was placed to face, whether a generated model came out
of the pipeline standing on its feet, and whether the whole thing reads as a
park rather than as a field with objects on it.

    # test backend + test frontend first (see tools/e2e/README.md), then:
    python3 tools/checks/social-look.py

RUN IT ON ITS OWN. The dev server hot-reloads the page whenever `shared/` is
re-synced, and every `npm run check:*`, `typecheck` and `pack:build` re-syncs
it — so a check in another terminal reloads the page under this one and the
whole run starts again. It looks exactly like a stalled CDN.

Writes numbered PNGs to tools/checks/.out/social/. This box has no GPU — it
renders at about 1.5 fps — so nothing here says anything about frame rate. It
says what the island LOOKS like, which is the only question it can answer.
"""
import asyncio
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "e2e"))

BASE = os.environ.get("E2E_BASE", "http://localhost:5175")
OUT = os.path.join(HERE, ".out", "social")
GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]

from playwright.async_api import async_playwright  # noqa: E402


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


async def allow_cdn(ctx):
    async def handler(route):
        r = await route.fetch()
        h = dict(r.headers)
        h["access-control-allow-origin"] = "*"
        h.pop("content-encoding", None)
        h.pop("content-length", None)
        await route.fulfill(response=r, headers=h, body=await r.body())
    await ctx.route("https://cdn.tofo.in/**", handler)


async def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(os.path.dirname(HERE), "e2e", ".state", "users.json")) as f:
        user = json.load(f)[0]

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            os.path.join(OUT, "profile"), headless=True, args=GL,
            viewport={"width": 820, "height": 462})
        await allow_cdn(ctx)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        # SwiftShader with no GPU: the sea alone is a full-screen translucent
        # surface, so ONE frame of the island can take many seconds here. Every
        # wait below is sized for that, and none of it says anything about a
        # real phone.
        page.set_default_timeout(150000)
        page.on("pageerror", lambda e: log("  [pageerror]", str(e)[:240]))
        page.on("console", lambda m: log("  [console]", m.type, m.text[:200])
                if m.type == "error" else None)

        await page.add_init_script(
            f"localStorage.setItem('tofo_token', {json.dumps(user['token'])});")
        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_selector(".hud .game-pick-btn", timeout=90000)
        log("lobby up")

        # The "what's on" card is fetched on idle, so it can appear AFTER the
        # lobby is interactive and swallow the click meant for the picker. It
        # is cleared just before every click rather than once at the start.
        async def clear():
            """Anything the platform has thrown over the lobby. The "what's on"
            card and the event popups are pushed on a socket, so one can land
            between a clear and the click it was clearing for — which is why
            every click below goes through `press`."""
            for _ in range(5):
                shut = False
                for sel in (".ev-close", ".pn-close", ".mc-close"):
                    if await page.is_visible(sel):
                        await page.click(sel, force=True)
                        await page.wait_for_timeout(600)
                        shut = True
                if not shut:
                    return

        async def press(selector: str, until: str, tries: int = 8) -> bool:
            for _ in range(tries):
                await clear()
                if await page.is_visible(until):
                    return True
                try:
                    await page.click(selector, force=True, timeout=4000)
                except Exception:
                    pass
                await page.wait_for_timeout(1800)
            return await page.is_visible(until)

        # LEAVE WHATEVER IS ALREADY RUNNING.
        #
        # The profile is persistent so the pack downloads once, which means a
        # previous run's island RESUMES on sign-in and takes over the screen —
        # correct behaviour, and never what this wants. Leaving is also slow,
        # because the scene has to be torn down on a box drawing a frame every
        # twenty seconds, so this waits for the picker to actually come back
        # rather than assuming one click did it.
        for _ in range(10):
            if await page.evaluate(
                    "() => !!document.querySelector('.game-pick-btn')?.offsetParent"):
                break
            for sel in (".mx-leave", ".mr-lobby"):
                if await page.is_visible(sel):
                    log(f"  leaving what was already running ({sel})")
                    try:
                        await page.click(sel, force=True, timeout=10000)
                    except Exception:
                        pass
                    await page.wait_for_timeout(5000)
            await clear()
            await page.wait_for_timeout(2000)

        await press(".game-pick-btn", ".gs-backdrop")
        await page.screenshot(path=os.path.join(OUT, "00-sheet.png"))
        await page.wait_for_selector(".gs-card[data-id='social']", state="attached", timeout=30000)
        await page.eval_on_selector(".gs-card[data-id='social']", "e => e.scrollIntoView()")
        await page.wait_for_timeout(400)
        # Through the DOM: the card is below the fold in a scrolling sheet and
        # what this check is about is the island, not the picker.
        await page.eval_on_selector(".gs-card[data-id='social']", "e => e.click()")
        log("picked Social Space — downloading the pack")

        end = time.time() + 480
        while time.time() < end:
            if await page.evaluate(
                "() => { const b = document.querySelector('.game-start-btn');"
                "        return !!b && !b.hasAttribute('disabled'); }"):
                break
            await page.wait_for_timeout(1500)
        else:
            log("the pack never finished downloading")
            await page.screenshot(path=os.path.join(OUT, "00-stuck.png"))
            await ctx.close()
            return 1

        await page.screenshot(path=os.path.join(OUT, "00-lobby.png"))
        await press(".game-start-btn", ".match-layer:not(.hidden)")
        try:
            await page.wait_for_selector(".sx-run", timeout=180000)
        except Exception:
            # Whatever went wrong, a picture of it is worth more than the
            # stack trace of the thing that was waiting.
            await page.screenshot(path=os.path.join(OUT, "99-never-arrived.png"))
            log("the island never opened — see 99-never-arrived.png")
            await ctx.close()
            return 1
        log("on the island — letting the scene settle")
        # No GPU: the first frames are shader compiles, and models load
        # nearest-first over the next few seconds.
        async def shot(name: str) -> bool:
            """One screenshot, and never fatal.

            A single frame of this scene takes tens of seconds on SwiftShader —
            most of it PBR shader compilation rather than drawing — so a shot
            can time out while everything is perfectly healthy. Losing the other
            eight over one of them would be the wrong trade."""
            try:
                await page.screenshot(path=os.path.join(OUT, name), timeout=180000)
                log(f"  {name}")
                return True
            except Exception as e:
                log(f"  {name} — no frame in time ({type(e).__name__})")
                return False

        async def budget(label: str):
            """What the island is COSTING. Triangles and meshes, never a frame
            rate — the number is the same on every machine, and a frame rate
            measured on a box with no GPU is not."""
            d = await page.evaluate("() => window.__tofoSocial?.debug?.() ?? null")
            if d:
                log(f"  {label}: {d['activeIndices'] // 3} triangles drawn · "
                    f"{d['activeMeshes']} active meshes of {d['totalMeshes']} · "
                    f"{d['people']} people ({d.get('rigs', '?')} with models) · "
                    f"{d['near']} in earshot · "
                    f"{d.get('lit', '?')} legendary effect(s), glow {'on' if d.get('glow') else 'off'}")

        await page.wait_for_timeout(22000)
        await budget("budget")
        await shot("01-arrival.png")

        canvas = await page.query_selector("canvas")
        box = await canvas.bounding_box()
        cx, cy = box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2

        async def look(dx, dy, name, settle=7000):
            """Drag on the right-hand side of the canvas to swing the camera."""
            await page.mouse.move(cx, cy)
            await page.mouse.down()
            steps = 12
            for i in range(steps):
                await page.mouse.move(cx + dx * (i + 1) / steps, cy + dy * (i + 1) / steps)
                await page.wait_for_timeout(40)
            await page.mouse.up()
            await page.wait_for_timeout(settle)
            await shot(name)

        await look(-380, 0, "02-turn-left.png")
        await look(-380, 0, "03-turn-more.png")
        await look(-380, -60, "04-look-down.png")

        # Walk towards the middle: hold W for a few seconds. The stick is for
        # thumbs; the keyboard is what a headless browser has.
        await page.keyboard.down("w")
        await page.wait_for_timeout(9000)
        await page.keyboard.up("w")
        await page.wait_for_timeout(6000)
        await budget("after walking")
        await shot("05-walked.png")

        # The emote sheet and the nearby list — the two pieces of chrome.
        await page.click(".sx-emote", force=True)
        await page.wait_for_timeout(1500)
        await shot("06-emotes.png")
        await page.click(".sx-close", force=True)
        await page.wait_for_timeout(600)
        await page.click(".sx-people", force=True)
        await page.wait_for_timeout(1500)
        await shot("07-people.png")
        await page.click(".sx-close", force=True)
        await page.wait_for_timeout(600)
        await page.click(".sx-run", force=True)
        await page.wait_for_timeout(900)
        await shot("08-run-on.png")
        # THE ARROW HAS TO TURN. Walk in three directions and read the angle
        # the map draws it at each time — the dial is 124 pixels across and a
        # screenshot of it is not evidence that it moved.
        angles = []
        for key, way in (("w", "forward"), ("d", "right"), ("s", "back")):
            await page.keyboard.down(key)
            await page.wait_for_timeout(2600)
            await page.keyboard.up(key)
            await page.wait_for_timeout(1200)
            d = await page.evaluate("() => window.__tofoSocial?.debug?.() ?? null")
            if d:
                angles.append((way, d.get("heading"), d.get("arrow")))
                log(f"  walked {way}: heading {d.get('heading')}° · arrow {d.get('arrow')}°")
        if len(angles) == 3:
            distinct = len({a[2] for a in angles})
            log(f"  arrow angles seen: {distinct} of 3 {'— it turns' if distinct >= 2 else '— STUCK'}")
        await shot("08b-turned.png")

        # DOES THE CAMERA COME ROUND? Turning is the one thing a player does
        # constantly, and the difference between "like Free Fire" and "wrong"
        # is whether the camera eases in behind the character afterwards. A
        # screenshot cannot show that — the frame after a turn looks identical
        # whether the camera took a frame or a second to get there — so it is
        # two numbers, taken while turning and again after standing still.
        await page.click(".sx-run", force=True)  # walk, not run, for this bit
        await page.wait_for_timeout(1400)

        def gap(d):
            return abs((d["heading"] - d["yaw"] + 180) % 360 - 180)

        # Hold LEFT and keep holding it. Two things have to happen, and the
        # arithmetic version of this is in `npm run check:social` — this is the
        # same claim made against the real controls, the real clock and the
        # real frame times: the camera closes on the character, and the
        # character stops turning once it has gone left. A player who keeps
        # turning is walking in a circle with their thumb held still, which is
        # what this used to do.
        await page.keyboard.down("a")
        await page.wait_for_timeout(1500)
        d1 = await page.evaluate("() => window.__tofoSocial?.debug?.() ?? null")
        await page.wait_for_timeout(4000)
        d2 = await page.evaluate("() => window.__tofoSocial?.debug?.() ?? null")
        await page.keyboard.up("a")
        if d1 and d2:
            drift = abs((d2["heading"] - d1["heading"] + 180) % 360 - 180)
            log(f"  turning: heading {d1['heading']}° camera {d1['yaw']}° — {gap(d1)}° apart")
            log(f"  four seconds later: heading {d2['heading']}° camera {d2['yaw']}° "
                f"— {gap(d2)}° apart, heading moved {drift}°")
            log("  the camera comes round behind the turn"
                if gap(d2) <= max(8, gap(d1)) else "  THE CAMERA IS NOT FOLLOWING")
            log("  and a stick held still keeps going one way"
                if drift < 25 else "  THE PLAYER IS WALKING IN CIRCLES")
        await page.wait_for_timeout(1500)
        await shot("08c-camera.png")

        # The whole island, which is the other half of "where am I".
        await page.click(".sx-minimap", force=True)
        await page.wait_for_timeout(2500)
        await shot("09-map.png")

        # A TAP ON IT MARKS A SPOT. Solo, so there is nobody to send it to —
        # what is being looked at is the marker and the line to it, which is
        # what a teammate would see.
        mc = await page.query_selector(".sx-map-wrap canvas")
        if mc:
            mb = await mc.bounding_box()
            await page.mouse.click(mb["x"] + mb["width"] * 0.34,
                                   mb["y"] + mb["height"] * 0.32)
            await page.wait_for_timeout(2500)
            d = await page.evaluate("() => window.__tofoSocial?.debug?.() ?? null")
            log(f"  pin after tapping the map: {'set' if d and d.get('pin') else 'NOT SET'}")
            await shot("09b-pinned.png")
        await page.click(".sx-close", force=True)
        await page.wait_for_timeout(900)
        await shot("09c-route.png")  # the dial, with the route line on it

        await page.click(".mx-leave", force=True)
        await page.wait_for_timeout(3000)
        await ctx.close()
    log(f"screenshots in {OUT}")
    return 0


sys.exit(asyncio.run(main()))
