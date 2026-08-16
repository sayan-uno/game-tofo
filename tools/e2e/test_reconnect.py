"""M5 — a phone with flaky Wi-Fi drops and comes back into the same run.

Three cases, in rising severity:

  1. THE SOCKET DROPS and comes back inside the grace period. The runner keeps
     their seat and the sim they return to is the one that kept running.
  2. THE PAGE RELOADS mid-match. The client rebuilds the whole scene from
     nothing and fast-forwards the deterministic sim to the current tick, with
     every input anyone made in the meantime replayed into it.
  3. THE SIGNAL GOES AWAY ENTIRELY for longer than the grace. The seat is
     forfeited, the match carries on for everyone else, and coming back must
     NOT drop them into a run they have already lost.

The thing being proved in all three is the same: the match lives on the server,
and a client is only ever a view of it.

Each case gets its own fresh match and acts inside the opening stretch of the
course, which is deliberately empty (EMPTY_START_METRES) precisely so a runner
who is away for a few seconds is not killed by an obstacle nobody was there to
steer around. Sharing one match between cases means the later ones run on a
corpse — which is exactly how the drop case came to be skipped every run.
"""
import asyncio
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.async_api import async_playwright
from harness import (Check, context, dbg, enter_match, leave_match, log, pick_game, play, sign_in,
                     users, wait_downloaded)

# Read the grace out of the server source rather than restating it: a change
# there should fail this test loudly, not silently make it meaningless.
_match_ts = (Path(__file__).parents[2] / "backend/src/platform/match.ts").read_text()
GRACE_MS = int(re.search(r"DISCONNECT_GRACE_MS\s*=\s*([\d_]+)", _match_ts).group(1).replace("_", ""))


async def cut_socket(page):
    """Kill the transport the way a lost signal does — no leave, no goodbye.

    socket.io reconnects on its own afterwards, which is the point: this is the
    brief drop, not the outage.
    """
    return await page.evaluate("""() => {
      const s = window.__tofoMatch?.deps?.socket;
      if (s?.io?.engine) { s.io.engine.close(); return 'engine'; }
      if (s) { s.disconnect(); return 'disconnect'; }
      return 'none';
    }""")


async def signal(page, on):
    """Lose the signal, or get it back.

    NOT Playwright's offline mode: that only affects new requests, and an
    already-open WebSocket sails straight through it — the socket never drops,
    the server never starts its grace timer, and a test written on top of it
    proves nothing while appearing to pass. Turning off socket.io's own
    reconnection and then closing the transport is the faithful version: from
    the server's side it is indistinguishable from a phone in a tunnel.
    """
    return await page.evaluate(
        """(on) => {
          const s = window.__tofoMatch?.deps?.socket;
          if (!s) return 'none';
          if (on) { s.io.reconnection(true); s.connect(); return 'up'; }
          s.io.reconnection(false);
          s.io.engine?.close();
          s.disconnect();
          return 'down';
        }""",
        on,
    )


async def state(page):
    return await page.evaluate("window.__tofoMatch?.debug() ?? null")


async def wait_for(page, pred, seconds=45, step=1000):
    """Returns the matching snapshot, or None if it never matched in time.

    None means TIMED OUT — never that something is gone. __tofoMatch lives for
    the whole session, so reading a timeout as evidence of absence is how the
    signal-loss check first came to pass while proving nothing.
    """
    end = time.time() + seconds
    while time.time() < end:
        d = await state(page)
        if pred(d):
            return d
        await page.wait_for_timeout(step)
    return None


async def fresh_match(pw, c, profile="a", who=0):
    """A brand-new match, at the start line, with the pack already local."""
    ctx, page = await context(pw, profile=profile)
    await sign_in(page, users()[who])
    await pick_game(page)
    if not c.ok(await wait_downloaded(page), "pack ready"):
        await ctx.close()
        return None, None, None
    await enter_match(page)
    return ctx, page, (await state(page))["matchId"]


async def main():
    c = Check("M5 reconnect / resume")

    # ---- 1. transport drop, back inside the grace period -------------------
    async with async_playwright() as pw:
        ctx, page, match_id = await fresh_match(pw, c)
        if not page:
            return c.done()
        before = await play(page, 4)
        c.ok(before["local"]["alive"], "alive before the drop",
             f"d={before['local']['distance']}m tick={before['local']['tick']}")
        c.ok(await cut_socket(page) != "none", "socket cut")
        await page.wait_for_timeout(4000)  # well inside the grace
        d = await wait_for(page, lambda d: d and d["matchId"] == match_id and d["phase"] == "running", 30)
        if c.ok(d is not None, "back in the SAME match after a transport drop", f"matchId={match_id}"):
            after = await dbg(page)
            c.ok(after["local"]["tick"] > before["local"]["tick"],
                 "the clock kept running while we were away",
                 f"tick {before['local']['tick']} \u2192 {after['local']['tick']}")
            c.ok(after["local"]["distance"] >= before["local"]["distance"],
                 "and we are further down the track, not reset")
            c.ok(len(after["ghosts"]) == len(before["ghosts"]) and len(after["ghosts"]) > 0,
                 "every other runner is still there", f"{len(after['ghosts'])} ghosts")
        await leave_match(page)
        await ctx.close()

    # ---- 2. full page reload, mid-match ------------------------------------
    async with async_playwright() as pw:
        ctx, page, match_id = await fresh_match(pw, c)
        if not page:
            return c.done()
        pre = await play(page, 3)
        c.ok(pre["local"]["alive"], "alive before the reload",
             f"d={pre['local']['distance']}m tick={pre['local']['tick']}")
        await page.reload(wait_until="domcontentloaded")
        # Wait for the resume to be APPLIED, not merely begun: the runtime
        # object exists before prepare() has loaded the characters and before
        # go() has set the clock, and sampling in that window sees tick 0
        # behind the curtain the player never sees.
        d = await wait_for(
            page,
            lambda d: d and d["matchId"] == match_id and d["game"] and d["game"]["startAt"] is not None,
            90,
        )
        if c.ok(d is not None, "a page reload lands back in the SAME run", f"matchId={match_id}"):
            c.ok(d["game"]["local"]["tick"] >= pre["local"]["tick"],
                 "the rebuilt sim is fast-forwarded to now",
                 f"tick {pre['local']['tick']} \u2192 {d['game']['local']['tick']}")
            # The whole point of replaying the input log: the ghosts must be
            # where the others actually are, not back at the start line.
            ghosts = d["game"]["ghosts"]
            moved = [g for g in ghosts if g["distance"] > 1]
            c.ok(len(moved) == len(ghosts) and len(ghosts) > 0,
                 "the other runners resumed at their real positions, not the start line",
                 f"{len(moved)}/{len(ghosts)}")
        await leave_match(page)
        await ctx.close()

    # ---- 3. no signal at all, for longer than the grace --------------------
    async with async_playwright() as pw:
        ctx, page, match_id = await fresh_match(pw, c)
        if not page:
            return c.done()
        await play(page, 4)
        c.ok(await signal(page, False) == "down", "signal lost")
        log(f"  holding for {GRACE_MS / 1000 + 8:.0f} s (grace is {GRACE_MS / 1000:.0f} s)")
        await page.wait_for_timeout(GRACE_MS + 8000)
        await signal(page, True)
        log("  signal back")
        d = await wait_for(page, lambda d: d and d["matchId"] != match_id, 40)
        c.ok(d is not None, "a signal loss past the grace forfeits the seat rather than resuming",
             f"matchId={(await state(page))['matchId']}")
        c.ok(await page.evaluate(
            "() => !!document.querySelector('.game-pick-btn')?.offsetParent && !document.querySelector('.tl-hud')"),
            "and the client is back in the lobby, not stuck on a dead match")
        await leave_match(page)
        await ctx.close()

    return c.done()


ok = asyncio.run(main())
sys.exit(0 if ok else 1)
