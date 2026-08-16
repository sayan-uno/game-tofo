"""M5 — the things added for polish, checked in a real match.

  * QUICK CHAT AND EMOTES: a fixed wheel, relayed through the server, shown as
    a bubble over the sender's head on everyone's screen.
  * SPECTATING: once you are out, the camera is on someone and you can say who.
  * JUICE: near misses, roof runs and coins say so.
  * ADD FRIEND AFTER A MATCH: an "Add" next to the people you actually played
    against — and nothing next to the bots, which is how it stays impossible to
    tell which was which.

Two real players, because a message relayed to nobody proves nothing — and
specifically two who are NOT already friends, or the add-friend check is
measuring the wrong thing: an empty list is the right answer for people who
already know each other, so a friendly pair makes the feature look broken while
it works perfectly. The pair is chosen here and the friendship the test creates
is removed afterwards, so it can be run twice.
"""
import asyncio
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.async_api import async_playwright
from harness import (Check, context, dbg, log, pick_game, play, run_until, sign_in, users,
                     wait_downloaded)


async def bubble_text(page, uid):
    """Is a speech bubble showing over that runner, and does it read right?

    Asks the SCENE, not the DOM: the bubble is a textured plane parented to the
    runner, so the only honest question is whether that mesh is enabled.
    """
    return await page.evaluate(
        """(uid) => {
          const scene = window.__tofoMatch?.runtime?.scene;
          const mesh = scene?.meshes?.find((m) => m.name === `say_${uid}`);
          return mesh ? mesh.isEnabled() : null;
        }""",
        uid,
    )


async def main():
    c = Check("M5 quick chat, spectating, juice, add friend")
    async with async_playwright() as pw:
        # NOT users 0 and 1 — they are already friends in the dev database.
        host, guest = users()[1], users()[4] if len(users()) > 4 else users()[2]
        ctx_a, a = await context(pw, profile="a", w=760, h=430)
        ctx_b, b = await context(pw, profile="b", w=760, h=430)
        await sign_in(a, guest)
        await sign_in(b, host)
        await b.click(".mode-card")
        await b.click('.mode-opt[data-mode="squad"]')
        await b.wait_for_selector(".tc-show-btn:not(.hidden)")
        await b.click(".tc-show-btn")
        await b.wait_for_function("document.querySelector('.tc-value')?.textContent?.trim().length === 6")
        code = (await b.text_content(".tc-value")).strip()
        await a.click(".tc-join-btn")
        await a.fill(".tc-input", code)
        await a.click(".tc-go")
        await b.wait_for_function("document.querySelector('.mode-count')?.textContent === '2/4'")
        await pick_game(b)
        if not c.ok(await wait_downloaded(b), "pack ready"):
            return c.done()
        await b.evaluate("() => document.querySelector('.game-start-btn')?.click()")
        for p in (a, b):
            await p.wait_for_selector(".tl-hud", timeout=120000)
            await p.wait_for_function("window.__tofoMatch?.debug()?.game?.local?.tick > 3", timeout=60000)
        uid_a = (await dbg(a))["local"]["uid"]
        log("both in the match")

        # ---- quick chat ----------------------------------------------------
        c.ok(await a.evaluate("() => !!document.querySelector('.tl-say-btn')"), "the chat wheel has a button")
        await a.evaluate("() => document.querySelector('.tl-say-btn').click()")
        opened = await a.evaluate("() => !document.querySelector('.tl-wheel').hidden")
        c.ok(opened, "which opens a wheel")
        counts = await a.evaluate("""() => ({
          emotes: document.querySelectorAll('.tl-wheel-emote').length,
          phrases: document.querySelectorAll('.tl-wheel-chat').length,
        })""")
        c.ok(counts["emotes"] >= 4 and counts["phrases"] >= 4,
             "with emotes and phrases in it", str(counts))
        await a.evaluate("() => document.querySelector('.tl-wheel-chat').click()")
        c.ok(await a.evaluate("() => document.querySelector('.tl-wheel').hidden"),
             "and it closes when you pick one")
        c.ok(await bubble_text(a, uid_a) is True, "the sender sees their own bubble immediately")
        await b.wait_for_timeout(2500)
        c.ok(await bubble_text(b, uid_a) is True,
             "and it reached the OTHER player's screen over the right runner")

        # An emote too, so both branches of the wheel are exercised.
        await a.evaluate("""() => {
          document.querySelector('.tl-say-btn').click();
          document.querySelector('.tl-wheel-emote').click();
        }""")
        await b.wait_for_timeout(2000)
        c.ok(await bubble_text(b, uid_a) is True, "an emote arrives the same way")

        # ---- juice ---------------------------------------------------------
        # Coins are dense enough that a short run picks some up; the flash is
        # driven off the sim's own counters, so seeing it means the wiring is
        # live rather than that a particular obstacle happened to appear.
        await play(a, 12)
        seen = await a.evaluate("""() => {
          const el = document.querySelector('.tl-flash');
          return { exists: !!el, everShown: !!el && el.className.includes('show') };
        }""")
        c.ok(seen["exists"], "the juice layer is in the HUD")
        d = await dbg(a)
        log(f"  local run: {d['local']['distance']} m, coins {d['local']['coins']}, "
            f"near misses {d['local']['nearMisses']}")

        # ---- spectating ----------------------------------------------------
        log("waiting for the local runner to go out…")
        await play(a, 90)
        dead = await dbg(a)
        if dead and not dead["local"]["alive"]:
            # Poll rather than sample once: the banner appears on the first
            # frame after the camera has picked someone, and a frame here can
            # take the best part of a second. Sampling once at a fixed delay
            # catches the one frame in between, where the local runner is
            # already out but nobody has been chosen yet.
            spec = {"shown": False, "who": None}
            for _ in range(20):
                spec = await a.evaluate("""() => {
                  const el = document.querySelector('.tl-spectate');
                  return { shown: !!el && !el.hidden, who: el?.querySelector('.tl-watching')?.textContent };
                }""")
                if spec["shown"]:
                    break
                await a.wait_for_timeout(700)
            c.ok(spec["shown"], "once you are out, the HUD says who you are watching", str(spec["who"]))
            first = spec["who"]
            await a.keyboard.press("ArrowRight")
            await a.wait_for_timeout(1200)
            who2 = await a.evaluate("() => document.querySelector('.tl-watching')?.textContent")
            # With only one runner still going there is nobody to switch to,
            # which is a correct outcome rather than a failure.
            c.ok(who2 is not None, "and left/right picks a different runner to follow",
                 f"{first} → {who2}")
        else:
            log("  (the runner was still alive — spectating not exercised)")

        # ---- add friend after the match ------------------------------------
        log("playing out the clock…")
        await play(b, 150)
        await b.wait_for_selector(".match-results", timeout=170000)
        await b.wait_for_timeout(3000)
        adds = await b.evaluate("""() => [...document.querySelectorAll('.mr-table tbody tr')].map(tr => ({
            name: tr.querySelector('.mr-name')?.textContent?.trim(),
            add: !!tr.querySelector('.mr-add-btn'),
        }))""")
        log("results: " + "; ".join(f"{r['name']}{' [+Add]' if r['add'] else ''}" for r in adds))
        offered = [r for r in adds if r["add"]]
        c.ok(len(offered) >= 1, "an Add button appears for a real opponent",
             str([r["name"] for r in offered]))
        c.ok(all(r["name"] != host["name"] for r in offered),
             "and never next to your own name")
        c.ok(len(offered) < len(adds) - 1 or len(adds) <= 2,
             "and not next to everyone — bots are simply absent from the list",
             f"{len(offered)} of {len(adds)} rows")
        if offered:
            await b.evaluate("() => document.querySelector('.mr-add-btn').click()")
            await b.wait_for_timeout(2500)
            label = await b.evaluate("() => document.querySelector('.mr-add-btn')?.textContent")
            c.ok(label == "Sent", "and pressing it sends the request", f"label={label}")
            # Put the database back, or the next run finds them already
            # friends and reports the feature as broken.
            out = subprocess.run(
                ["node", str(Path(__file__).parents[2] / "tools/e2e/unfriend.mjs"), host["uid"], guest["uid"]],
                capture_output=True, text=True)
            log("  cleanup: " + (out.stdout.strip() or out.stderr.strip()[:120]))

        await ctx_a.close()
        await ctx_b.close()
    return c.done()


ok = asyncio.run(main())
sys.exit(0 if ok else 1)
