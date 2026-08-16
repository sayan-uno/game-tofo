"""M5 — raising the match clock without touching a client.

The plan's promise was "one server constant, raised later without a client
change". That is only true if the number reaches the SIMULATION on both sides,
not merely the countdown on the HUD: a client that draws a three-minute clock
while still refusing to score past two minutes has not had its clock raised, it
has had it broken.

So this checks all three places the number has to land:

  * what the server advertises in /api/games,
  * what the HUD counts down from,
  * what the client's own simulation stops scoring at.

Run it twice — once as the server is, once with TRACKLINE_MATCH_SECONDS set —
and the second run is the proof.
"""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.async_api import async_playwright
from harness import Check, context, enter_match, leave_match, log, pick_game, sign_in, users, wait_downloaded

# What we expect the server to be running. Set it to match the env var you
# started the backend with; unset means the built-in two minutes.
EXPECT_SEC = int(os.environ.get("EXPECT_MATCH_SECONDS", "120"))


async def main():
    c = Check(f"M5 match clock (expecting {EXPECT_SEC}s)")
    async with async_playwright() as pw:
        ctx, page = await context(pw, profile="a", w=760, h=430)
        await sign_in(page, users()[0])

        advertised = await page.evaluate("""async () => {
          const r = await fetch(`${window.location.origin.replace('5174','4100')}/api/games`, {
            headers: { authorization: `Bearer ${localStorage.getItem('tofo_token')}` } });
          const j = await r.json();
          return (j.games ?? []).find((x) => x.id === 'trackline') ?? null;
        }""")
        c.ok(advertised is not None, "the server advertises trackline in the game list")
        if advertised:
            c.ok(advertised.get("durationSec") == EXPECT_SEC,
                 "and the advertised clock is the configured one",
                 f"durationSec={advertised.get('durationSec')}")

        await pick_game(page)
        if not c.ok(await wait_downloaded(page), "pack ready"):
            return c.done()
        await enter_match(page)
        d = await page.evaluate("window.__tofoMatch.debug().game")
        c.ok(d["durationTicks"] == EXPECT_SEC * d["tickRate"],
             "the client's SIMULATION runs on the server's clock",
             f"{d['durationTicks']} ticks at {d['tickRate']} Hz")
        shown = await page.evaluate("() => document.querySelector('.tl-timer')?.textContent")
        mins, secs = (int(x) for x in (shown or "0:00").split(":"))
        c.ok(abs(mins * 60 + secs - EXPECT_SEC) <= 4,
             "and the HUD counts down from it", f"showing {shown}")
        await leave_match(page)
        await ctx.close()
    return c.done()


ok = asyncio.run(main())
sys.exit(0 if ok else 1)
