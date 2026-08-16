"""M5 — walking out of a match.

A player who leaves mid-run forfeits. What that has to mean, for everyone:

  * FOR THE LEAVER: out immediately, back in the lobby, and unable to wander
    back into the run they abandoned.
  * FOR EVERYONE ELSE: the match carries on. One person quitting must never
    end a match that other people are still playing.
  * IN THE RESULT: ranked below anyone who stayed, however good their score
    was when they left, and scored only up to the moment they left rather than
    credited with the rest of the clock they did not play.

The last one is the reason the sort key has three tiers instead of just using
score: a leaver who quits while leading would otherwise win.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.async_api import async_playwright
from harness import (Check, context, dbg, log, pick_game, play, run_until, sign_in, users,
                     wait_downloaded)


async def party_of_two(pw, c):
    """Two real players in one squad — so the match has a human left in it
    after the other one walks out."""
    ctx_a, a = await context(pw, profile="a", w=900, h=520)
    ctx_b, b = await context(pw, profile="b", w=900, h=520)
    await sign_in(a, users()[0])
    await sign_in(b, users()[1])
    await a.click(".mode-card")
    await a.click('.mode-opt[data-mode="squad"]')
    await a.wait_for_selector(".tc-show-btn:not(.hidden)")
    await a.click(".tc-show-btn")
    await a.wait_for_function("document.querySelector('.tc-value')?.textContent?.trim().length === 6")
    code = (await a.text_content(".tc-value")).strip()
    await b.click(".tc-join-btn")
    await b.fill(".tc-input", code)
    await b.click(".tc-go")
    await a.wait_for_function("document.querySelector('.mode-count')?.textContent === '2/4'")
    c.ok(True, "party of two formed")
    await pick_game(a)
    if not c.ok(await wait_downloaded(a), "both members have the pack"):
        return None
    await a.click(".game-start-btn")
    for p in (a, b):
        await p.wait_for_selector(".tl-hud", timeout=120000)
        await p.wait_for_function("window.__tofoMatch?.debug()?.game?.local?.tick > 3", timeout=60000)
    return ctx_a, a, ctx_b, b


async def main():
    c = Check("M5 forfeits")
    async with async_playwright() as pw:
        made = await party_of_two(pw, c)
        if not made:
            return c.done()
        ctx_a, a, ctx_b, b = made
        match_id = (await a.evaluate("window.__tofoMatch.debug()"))["matchId"]
        log(f"match {match_id}")

        # Walk out while still ALIVE and scoring — a leader quitting is the
        # case the ranking has to get right.
        #
        # Read and click in ONE evaluate, atomically. Polling the state and
        # then clicking is two round trips, and on this box the sim can advance
        # sixty metres between them — far enough to cross the first obstacle at
        # EMPTY_START_METRES and die, turning "a leader quits" into "a corpse
        # quits" about half the time. Inside a single JS task nothing can move.
        quitter = None
        for _ in range(60):
            got = await a.evaluate("""() => {
              const g = window.__tofoMatch?.debug()?.game;
              if (!g) return null;
              const me = g.local;
              if (!me.alive) return { left: false, me };
              if (me.distance < 12) return { left: false, me, waiting: true };
              document.querySelector('.mx-leave')?.click();
              return { left: true, me };
            }""")
            if got and (got["left"] or not got.get("waiting")):
                quitter = got
                break
            await a.wait_for_timeout(120)
        c.ok(quitter is not None and quitter["left"], "walked out mid-run, while still alive",
             f"score={quitter and quitter['me']['score']} d={quitter and quitter['me']['distance']}m")
        quit_uid = quitter["me"]["uid"]
        quit_score = quitter["me"]["score"]
        await a.wait_for_timeout(3000)
        c.ok(await a.evaluate(
            "() => !!document.querySelector('.game-pick-btn')?.offsetParent && !document.querySelector('.tl-hud')"),
            "the leaver is back in the lobby at once")
        c.ok((await a.evaluate("window.__tofoMatch.debug()"))["matchId"] is None,
             "and is no longer bound to the match")

        # ---- B plays on ----------------------------------------------------
        # Checked here, immediately, and not after the reload below: that takes
        # the best part of a minute on this box, and B standing unattended in
        # traffic all that time would end the match for reasons that have
        # nothing to do with the forfeit.
        after = await dbg(b)
        c.ok(after is not None and not after["ended"],
             "the match carries on for the player who stayed",
             f"ended={after and after['ended']} alive={after and after['local']['alive']}")
        gone = [g for g in after["ghosts"] if g["uid"] == quit_uid]
        c.ok(len(gone) == 1 and gone[0]["left"],
             "who sees the leaver marked as gone, not frozen mid-stride")

        # Rejoining is the interesting half: a reload must not sneak them back
        # into a run they forfeited. Generous timeout — two Chromium instances
        # are software-rendering a 3D lobby on a box with no GPU.
        await a.reload(wait_until="domcontentloaded", timeout=120000)
        await a.wait_for_timeout(12000)
        back = await a.evaluate("window.__tofoMatch?.debug() ?? null")
        c.ok(back is None or back["matchId"] != match_id,
             "and a reload does not put them back into the run they left",
             f"matchId={back and back['matchId']}")

        # ---- the result ----------------------------------------------------
        log("playing out the clock…")
        await play(b, 150)
        await b.wait_for_selector(".match-results", timeout=170000)
        rows = await b.evaluate("""() => [...document.querySelectorAll('.mr-table tbody tr')].map(tr => ({
            place: tr.children[0]?.textContent?.trim(),
            name: tr.querySelector('.mr-name')?.textContent?.trim(),
            score: tr.children[2]?.textContent?.trim(),
            run: tr.children[3]?.textContent?.trim(),
        }))""")
        log("standings: " + "; ".join(f"{r['place']} {r['name']} {r['score']} ({r['run']})" for r in rows))
        c.ok(len(rows) >= 2, "the results list everyone, including the leaver")
        # The results table writes "left" in the run column for a forfeit.
        leaver_row = next((r for r in rows if (r["run"] or "").strip().lower() == "left"), None)
        c.ok(leaver_row is not None, "the leaver is shown as a forfeit",
             f"run={leaver_row and leaver_row['run']}")
        stayer = next((r for r in rows if r["name"] == users()[1]["name"]), None)
        if leaver_row and stayer:
            c.ok(int(stayer["place"]) < int(leaver_row["place"]),
                 "and is placed below the player who stayed",
                 f"{stayer['place']} vs {leaver_row['place']}")
            # Sampled a beat before the click lands, so a few seconds of
            # running sit between the two numbers. What matters is that the
            # leaver was frozen near the door rather than credited with the
            # whole clock — which the player who stayed shows the size of.
            left_score = int(leaver_row["score"].replace(",", ""))
            c.ok(quit_score - 50 <= left_score <= quit_score + 250,
                 "scored only up to the moment they left",
                 f"{left_score} vs {quit_score} at the door")
            # Measured against the best run in the match, not against the
            # other human — who may well have crashed earlier than the leaver
            # left, which makes them no evidence at all.
            best = max(int(r["score"].replace(",", "")) for r in rows)
            c.ok(left_score < best / 2,
                 "and nowhere near a run that played the whole clock",
                 f"leaver {left_score} vs best {best}")

        await ctx_a.close()
        await ctx_b.close()
    return c.done()


ok = asyncio.run(main())
sys.exit(0 if ok else 1)
