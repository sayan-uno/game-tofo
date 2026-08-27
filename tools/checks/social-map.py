#!/usr/bin/env python3
"""Look at the MAP, without the island under it.

The dial and the full map are canvas drawing, and the things that go wrong with
them — a squad number drawn under its own dot, a heading spur pointing the
wrong way, a route line invisible against a paved avenue — are all things that
only a picture shows. Opening a real island to look at them costs six minutes
and gives you one player with no squad and nobody nearby, which is the one case
that proves least.

So this loads the map module straight off the dev server and draws a made-up
island full of people into it: a squad of four, a friend across the park, a
stranger in earshot, and a marker with a route to it.

    # a test frontend (see tools/e2e/README.md), then:
    python3 tools/checks/social-map.py

Writes tools/checks/.out/social-map/*.png. No backend, no pack, no sign-in —
about ten seconds.
"""
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("E2E_BASE", "http://localhost:5175")
OUT = os.path.join(HERE, ".out", "social-map")

from playwright.async_api import async_playwright  # noqa: E402

# One island's worth of people, made up but plausible: a squad of three besides
# the player, a friend out at the bandstand, and strangers.
PEOPLE = [
    {"uid": "a", "name": "Ravi", "x": 12, "z": -6, "ry": 2.2, "friend": True, "squad": 1, "near": True},
    {"uid": "b", "name": "Meera", "x": -9, "z": 14, "ry": -1.1, "friend": False, "squad": 2, "near": True},
    {"uid": "c", "name": "Arjun", "x": 26, "z": 22, "ry": 0.4, "friend": False, "squad": 3, "near": False},
    {"uid": "d", "name": "Kabir", "x": -31, "z": 29, "ry": 3.0, "friend": True, "squad": 0, "near": False},
    {"uid": "e", "name": "Stranger", "x": 4, "z": 9, "ry": 1.6, "friend": False, "squad": 0, "near": True},
    {"uid": "f", "name": "Somebody", "x": -44, "z": -8, "ry": 0.9, "friend": False, "squad": 0, "near": False},
]
ME = {"x": 6, "z": 4, "ry": 0.8}
PIN = {"x": -30, "z": -34, "mine": True}


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 900, "height": 520})
        page.on("pageerror", lambda e: print("  [pageerror]", str(e)[:300]))
        await page.goto(BASE, wait_until="domcontentloaded")
        drew = await page.evaluate(
            """async ([people, me, pin]) => {
                const m = await import('/src/games/social/minimap.ts');
                const box = document.createElement('div');
                box.style.cssText =
                  'position:fixed;inset:0;z-index:99999;background:#0b0507;display:flex;'
                  + 'gap:18px;align-items:center;justify-content:center';
                const big = document.createElement('canvas');
                big.id = 'big';
                big.style.cssText = 'width:420px;height:420px;border-radius:14px';
                const dial = document.createElement('canvas');
                dial.id = 'dial';
                dial.style.cssText = 'width:220px;height:220px;border-radius:50%';
                box.append(big, dial);
                document.body.appendChild(box);
                // A frame for the layout to settle, or clientWidth is 0 and
                // both draws return without doing anything.
                await new Promise(r => requestAnimationFrame(() => r(null)));
                m.drawFullMap(big, me, people, pin);
                new m.MiniMap(dial).draw(performance.now() + 1e6, me, people, pin);
                return { where: m.whereIs(me.x, me.z) };
            }""",
            [PEOPLE, ME, PIN],
        )
        print(f"  standing at {json.dumps(drew['where'])}")
        await page.wait_for_timeout(400)
        await page.screenshot(path=os.path.join(OUT, "01-both.png"))
        for name, sel in (("02-full.png", "#big"), ("03-dial.png", "#dial")):
            el = await page.query_selector(sel)
            await el.screenshot(path=os.path.join(OUT, name))
            print(f"  {name}")
        await browser.close()
    print(f"pictures in {OUT}")
    return 0


sys.exit(asyncio.run(main()))
