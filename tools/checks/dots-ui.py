#!/usr/bin/env python3
"""Dots & Boxes' CLIENT, in a real browser.

    npm run check:dotsui

`check:dots` proves the simulation. This proves the half of the game that lives
in a browser and that no amount of Node can reach.

Four things are checked, and each one exists because its absence is invisible:

  it draws        A canvas that is present, sized and blank passes every
                  selector-based test there is (the console's own suite learned
                  that the hard way), so the test is the WEIGHT of a PNG of each
                  layer: a grid with forty lines and a dozen filled boxes on it
                  cannot compress small.

  it is playable  The control, driven with real pointer events. A line is two
                  pixels wide and a finger is forty, so the whole design rests
                  on "nearest free line to the touch" — and on a first touch
                  never drawing anything, because on a board where one line
                  decides a chain of six, a finger landing somewhere unintended
                  is the difference between a game and an argument.

  it is watchable A hover arriving off the wire from another seat has to change
                  the picture. Without that the first anyone knew of a move was
                  the move.

  it replays      The studio's path exactly — spectator, a clock the harness
                  owns, dispose → seed → go → deliver — run twice, once from
                  tick zero and once seeking into the middle, and both compared
                  BIT FOR BIT against the server's own cold replay. Plus the
                  three optional hooks the console reads from the game.

Self-contained: it starts the frontend dev server itself on a port of its own
and shuts it down again, so it needs nothing running and collides with nothing.
"""
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FAILS = 0


def ok(cond, label, detail=""):
    global FAILS
    if cond:
        print(f"  ok  {label}{(' — ' + detail) if detail else ''}")
    else:
        FAILS += 1
        print(f"  FAIL {label}{(' — ' + detail) if detail else ''}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_vite(port: int):
    env = {**os.environ, "BROWSER": "none"}
    proc = subprocess.Popen(
        ["npm", "--prefix", "frontend", "run", "dev", "--", "--port", str(port), "--strictPort"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            print(proc.stdout.read() if proc.stdout else "")
            raise SystemExit("the dev server exited before it was ready")
        line = proc.stdout.readline() if proc.stdout else ""
        if line and (re.search(r"ready in", line) or f":{port}" in line):
            for _ in range(60):
                try:
                    with socket.create_connection(("127.0.0.1", port), 0.5):
                        return proc
                except OSError:
                    time.sleep(0.25)
        time.sleep(0.05)
    raise SystemExit("the dev server never came up")


def stop(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=15)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright is not installed — `pip install playwright && playwright install chromium`")
        return 2

    port = free_port()
    print(f"starting the frontend dev server on {port}…")
    vite = start_vite(port)
    base = f"http://127.0.0.1:{port}/dots-preview.html"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox"])

            # ---- it draws ---------------------------------------------------
            print("\nthe grid draws")
            page = browser.new_page(viewport={"width": 900, "height": 460}, device_scale_factor=2)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{base}?w=900&h=460&p=4&moves=44", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=60000)
            state = page.evaluate("window.__state")
            ok(state is not None, "the runtime came up and answered")
            ok(state and state["drawn"] > 20, "…on a grid well into a game", f"{state and state['drawn']} lines")
            ok(state and state["claimed"] > 0, "with boxes already taken", str(state and state["score"]))

            # THE BLANK CANVAS TEST. Each layer photographed with the other
            # hidden — stacked, they are the same box, and one picture proving
            # two things proves neither.
            def layer(keep: str, hide: str) -> int:
                page.evaluate(f"document.querySelector('{hide}').style.visibility = 'hidden'")
                shot = page.locator(keep).screenshot()
                page.evaluate(f"document.querySelector('{hide}').style.visibility = ''")
                return len(shot)

            paper = layer(".dt-grid", ".dt-live")
            play = layer(".dt-live", ".dt-grid")
            ok(paper > 6_000, "the paper and the dots are painted", f"{paper // 1024} kB of PNG")
            ok(play > 6_000, "and so are the lines and boxes on top", f"{play // 1024} kB of PNG")
            ok(paper != play, "…they really are two different pictures")

            ok(page.locator(".dt-card").count() == 4, "four player cards")
            ok(page.locator(".dt-left .dt-card").count() == 2, "…split across both rails")
            ok("boxes taken" in page.inner_text(".dt-tally"), "the tally says how much board is gone")
            ok(page.locator(".dt-card.lead").count() >= 1, "and somebody is marked as leading")
            ok(not errors, "nothing threw", "; ".join(errors[:3]))
            page.close()

            # ---- it is playable ---------------------------------------------
            print("\nthe control")
            page = browser.new_page(viewport={"width": 900, "height": 460})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{base}?w=900&h=460&p=4&moves=30", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=60000)
            page.evaluate("() => { window.__sent = []; window.__rt.ctx.sendInput = (i) => { window.__sent.push(i); }; }")
            lay = page.evaluate("window.__rt.layout")

            def dot(col: float, row: float):
                return lay["gx"] + col * lay["cell"], lay["gy"] + row * lay["cell"]

            # The midpoint of a line, nudged off it, is still nearest to it —
            # which is the whole point of the control.
            def touch_near(col: float, row: float):
                x, y = dot(col, row)
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.up()
                return page.evaluate("window.__rt.pick")

            first = touch_near(2.5, 1.0)  # a little below the across line at r1c3
            ok(first >= 0, f"a touch near a line chooses it ({first})")
            ok(page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a').length") == 0, "…and draws nothing")
            hovers = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'm').length")
            ok(hovers > 0, f"but the table is told what we are looking at ({hovers})")

            # Moving the finger moves the choice; a first touch anywhere else
            # never commits.
            second = touch_near(4.0, 3.5)
            ok(second >= 0 and second != first, f"touching elsewhere chooses that line instead ({second})")
            ok(page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a').length") == 0, "still nothing drawn")

            # THE SECOND TOUCH on the SAME line is the confirm.
            again = touch_near(4.0, 3.5)
            ok(again == second, "touching it again keeps the same line")
            asks = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a')")
            ok(len(asks) == 1, f"…and that second touch asks for it ({len(asks)})")
            ok(asks and asks[0]["kind"] == f"a{second}", f"for exactly the line that was chosen ({asks and asks[0]['kind']})")

            # And the button does the same job for anybody who would rather
            # press one.
            page.evaluate("() => { window.__rt.asked = null; window.__sent.length = 0; window.__rt.lastSig = ''; window.__rt.render(); }")
            picked = touch_near(1.0, 5.5)
            ok(picked >= 0, "a fresh choice")
            ok(page.locator(".dt-draw").is_enabled(), "the DRAW button lights up with something chosen")
            page.locator(".dt-draw").click()
            asks = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a')")
            ok(len(asks) == 1 and asks[0]["kind"] == f"a{picked}", f"pressing it asks for the chosen line ({asks and asks[0]['kind']})")

            # Not this player's turn: nothing is live.
            page.evaluate(
                """() => {
                  const rt = window.__rt;
                  rt.asked = null;
                  rt.sim.state.turn = (rt.mySeat + 1) % rt.sim.state.players;
                  rt.lastSig = '';
                  rt.render();
                }"""
            )
            ok(page.locator(".dt-draw").is_disabled(), "on another player's turn the button is off")
            before = page.evaluate("window.__sent.length")
            page.locator(".dt-draw").click(force=True)
            ok(page.evaluate("window.__sent.length") == before, "…and forcing a click through it asks for nothing")

            # ---- it is watchable ---------------------------------------------
            print("\nwatching the others")
            quiet = page.locator(".dt-live").screenshot()
            held = page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  s.phase = 'turn';
                  s.since = Math.max(0, s.tick - 5);
                  const free = [];
                  for (let l = 0; l < s.line.length; l++) if (s.line[l] < 0) free.push(l);
                  const line = free[Math.floor(free.length / 2)];
                  rt.onRemoteInput({ uid: rt.ctx.roster[s.turn].uid, tick: s.since + 1, kind: 'm' + line });
                  rt.lastSig = '';
                  rt.render();
                  return { line, seat: s.turn, held: rt.hovers.get(s.turn) || null };
                }"""
            )
            lining = page.locator(".dt-live").screenshot()
            ok(held and held["held"] and held["held"]["line"] == held["line"], "a hover off the wire is remembered")
            ok(len(lining) != len(quiet), "…and it actually changes what is drawn")
            banner = page.inner_text(".dt-banner").lower()
            ok("choosing" in banner, f"the banner says who is thinking ({banner!r})")
            ok(not errors, "nothing threw while playing", "; ".join(errors[:3]))

            # ---- what the studio is told -------------------------------------
            print("\nwhat the replay studio is told")
            hooks = page.evaluate("window.__hooks")
            ok(hooks is not None, "the game exposes the studio hooks")
            if hooks:
                ok("drew the line" in (hooks["draw"] or ""), f"a move reads as words ({hooks['draw']!r})")
                ok("looking at" in (hooks["hover"] or ""), f"…and so does a hover ({hooks['hover']!r})")
                ok(hooks["quit"] is not None, "…and leaving the table")
                ok(hooks["junk"] is None, "nonsense is described as nothing rather than guessed at")
                ok(hooks["weightDraw"] == 1, f"a move carries full weight ({hooks['weightDraw']})")
                ok(hooks["weightHover"] is None, "a hover carries none — it is a thought, not a move")
                summary = {x["label"]: x["value"] for x in (hooks["summary"] or [])}
                ok("Boxes" in summary, f"the summary knows how many boxes they took ({summary.get('Boxes')})")
                ok("Given away" in summary, f"…and how many they handed over ({summary.get('Given away')})")
                ok(int(summary.get("Lines", "0")) > 0, f"…and how many lines they drew ({summary.get('Lines')})")
            page.close()

            # ---- it replays ---------------------------------------------------
            print("\nthe admin console's replay path")
            page = browser.new_page(viewport={"width": 900, "height": 460})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{base}?w=900&h=460&p=4&replay=1", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=180000)
            r = page.evaluate("window.__replay")
            ok(r is not None, "the replay harness finished")
            if r:
                ok(r["inputs"] > 40, "a whole grid was played and archived", f"{r['inputs']} inputs over {r['endTick']} ticks")
                ok(r["hovers"] > 0, f"the log carries hovers as well as moves ({r['hovers']} of {r['inputs']})")
                ok(r["topMatches"], "played from tick zero, the watched grid is the server's grid — bit for bit")
                ok(r["seekMatches"], "and so is a scrub into the middle", f"tick {r['seekTick']}")
            # A REPLAY IS NOT A GAME.
            ok(page.locator(".dt-strip.watch").count() == 1, "a watcher gets no control at all")
            ok(not page.locator(".dt-draw").is_visible(), "…the DRAW button is not even on the screen")
            ok(not errors, "nothing threw during playback", "; ".join(errors[:3]))
            page.close()
            browser.close()
    finally:
        stop(vite)

    print("\nALL CHECKS PASSED" if FAILS == 0 else f"\n{FAILS} CHECK(S) FAILED")
    return 0 if FAILS == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
