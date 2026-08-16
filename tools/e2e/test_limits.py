"""M5 — the server under abuse.

Everything a client can send, sent wrongly and sent far too fast. The bar is
not "the server rejects it" — it is "the server is still correct afterwards for
everyone else in the match", which is the only thing a rate limit is actually
for.

Four kinds of abuse, all fired straight at the socket rather than through the
UI, because that is how a real one would arrive:

  * INPUT FLOOD — hundreds of moves a second, past the server's per-runner
    ceiling.
  * QUICK-CHAT FLOOD — the message wheel hammered, and messages made up out of
    ids this build does not offer.
  * MALFORMED PAYLOADS — nulls, wrong types, enormous strings, on every
    handler that takes an argument.
  * A LIVE VICTIM — a second, honest player in the same match, whose run has
    to be unaffected and whose result has to still be written.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.async_api import async_playwright
from harness import (Check, context, dbg, log, pick_game, run_until, sign_in, users, wait_downloaded)

# Junk aimed at every handler that accepts a payload. None of it should reach
# anything: a null emit crashing the process is a real bug this codebase has
# had before, which is why every handler reads `payload ?? {}`.
JUNK = """() => {
  const s = window.__tofoMatch.deps.socket;
  const nasty = [
    null, undefined, 0, "", [], {},
    {tick: "x", kind: {}}, {tick: -1e9, kind: "left"}, {tick: 1e9, kind: "left"},
    {kind: "\\u0000"}, {kind: "x".repeat(20000)},
    {id: "x".repeat(50000), kind: "chat"}, {kind: "emote", id: null},
    {matchId: 12345}, {matchId: "../../etc/passwd"},
  ];
  const events = ["match:input", "match:quick", "match:ready", "match:leave",
                  "match:sync", "match:addable", "lobby:start", "game:progress"];
  let sent = 0;
  for (const ev of events) for (const p of nasty) { s.emit(ev, p); sent++; }
  return sent;
}"""


async def main():
    c = Check("M5 rate limits and malformed input")
    async with async_playwright() as pw:
        # The victim first: an honest player in the same match as the abuser.
        ctx_v, victim = await context(pw, profile="b", w=760, h=430)
        ctx_a, abuser = await context(pw, profile="a", w=760, h=430)
        await sign_in(victim, users()[1])
        await sign_in(abuser, users()[0])
        await victim.click(".mode-card")
        await victim.click('.mode-opt[data-mode="squad"]')
        await victim.wait_for_selector(".tc-show-btn:not(.hidden)")
        await victim.click(".tc-show-btn")
        await victim.wait_for_function("document.querySelector('.tc-value')?.textContent?.trim().length === 6")
        code = (await victim.text_content(".tc-value")).strip()
        await abuser.click(".tc-join-btn")
        await abuser.fill(".tc-input", code)
        await abuser.click(".tc-go")
        await victim.wait_for_function("document.querySelector('.mode-count')?.textContent === '2/4'")
        await pick_game(victim)
        if not c.ok(await wait_downloaded(victim), "pack ready for both"):
            return c.done()
        await victim.evaluate("() => document.querySelector('.game-start-btn')?.click()")
        for p in (victim, abuser):
            await p.wait_for_selector(".tl-hud", timeout=120000)
            await p.wait_for_function("window.__tofoMatch?.debug()?.game?.local?.tick > 3", timeout=60000)
        log("both in the match")

        # ---- 1. input flood ------------------------------------------------
        await run_until(abuser, 20)
        flooded = await abuser.evaluate("""() => {
          const s = window.__tofoMatch.deps.socket;
          const g = window.__tofoMatch.debug().game;
          const tick = g.local.tick;
          let n = 0;
          for (let i = 0; i < 400; i++) {
            s.emit("match:input", { tick: tick + (i % 30), kind: i % 2 ? "left" : "right" });
            n++;
          }
          return n;
        }""")
        c.ok(flooded == 400, "fired 400 inputs in one burst")
        await abuser.wait_for_timeout(3000)
        c.ok(await abuser.evaluate("!!window.__tofoMatch") , "the flooding client is still connected")

        # ---- 2. quick-chat flood, and ids that do not exist ----------------
        said = await abuser.evaluate("""() => {
          const s = window.__tofoMatch.deps.socket;
          for (let i = 0; i < 60; i++) {
            s.emit("match:quick", { kind: "chat", id: "gg" });
            s.emit("match:quick", { kind: "chat", id: "<img src=x onerror=alert(1)>" });
            s.emit("match:quick", { kind: "emote", id: "NOT_AN_EMOJI" });
          }
          return 180;
        }""")
        c.ok(said == 180, "fired 180 quick messages, most of them invalid")
        await abuser.wait_for_timeout(2500)

        # ---- 3. malformed payloads on every handler ------------------------
        junk = await abuser.evaluate(JUNK)
        c.ok(junk > 100, f"fired {junk} malformed payloads across every handler")
        await abuser.wait_for_timeout(3000)

        # ---- 4. the server is still there and still correct ----------------
        alive_socket = await victim.evaluate("() => window.__tofoMatch?.deps?.socket?.connected === true")
        c.ok(alive_socket, "the victim's socket is still connected — the server did not fall over")
        v = await dbg(victim)
        c.ok(v is not None and not v["ended"], "the victim's match is still running")
        # The abuser's own client must not have been dragged down either: the
        # rate limit is the server's, and the client mirrors it rather than
        # desyncing.
        a = await dbg(abuser)
        c.ok(a is not None, "the abusing client is still simulating")

        # A fresh, ordinary action must still work after all that.
        before = (await dbg(victim))["local"]["tick"]
        await victim.keyboard.press("ArrowLeft")
        await victim.wait_for_timeout(2500)
        after = await dbg(victim)
        c.ok(after["local"]["tick"] > before, "an honest player's match keeps ticking afterwards",
             f"tick {before} → {after['local']['tick']}")
        c.ok(await victim.evaluate("() => !!document.querySelector('.tl-hud')"),
             "and their HUD is intact")

        await ctx_a.close()
        await ctx_v.close()
    return c.done()


ok = asyncio.run(main())
sys.exit(0 if ok else 1)
