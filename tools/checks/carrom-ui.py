#!/usr/bin/env python3
"""Carrom's CLIENT, in a real browser.

    npm run check:carromui

`check:carrom` proves the simulation. This proves the half of the game that
lives in a browser and that no amount of Node can reach: that the board is
actually DRAWN, and — the thing the user asked for and the thing the admin
console cannot tell you itself — that a recorded match played back through the
console's own path produces exactly the board the server says it produced.

Four things are checked, and each one exists because its absence is invisible:

  it draws        A canvas that is present, sized and blank passes every
                  selector-based test there is. The console's own suite learned
                  this the hard way (a solid colour compresses to almost
                  nothing), so the test is the SIZE of a PNG of the canvas: a
                  board with nineteen coins on it cannot compress small.

  it replays      The studio's path exactly — spectator, a clock the page owns,
                  dispose → seed the inputs up to the playhead → go → deliver
                  the rest as the clock passes them — run twice: once from tick
                  zero to the end of a whole board, and once seeking into the
                  middle. Both boards are compared BIT FOR BIT against the
                  server's own cold replay of the same log. This is the check
                  that would have caught all three of the replay-fidelity bugs
                  Trackline shipped.

  it is playable  The three controls, driven with real pointer events: the aim
                  really does go all the way round (it used to stop dead at each
                  end, which is the complaint that produced this section), the
                  striker bar and the power bar each move their own thing and
                  nothing else, and NOTHING is sent until SHOOT is pressed.

  it is quiet     No page errors, no unhandled rejections.

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
        if line:
            if re.search(r"ready in", line) or f":{port}" in line:
                # Vite prints "ready" before the first request is served; one
                # connect attempt settles it.
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
    base = f"http://127.0.0.1:{port}/carrom-preview.html"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox"])

            # ---- it draws ---------------------------------------------------
            print("\nthe board draws")
            page = browser.new_page(viewport={"width": 900, "height": 460}, device_scale_factor=2)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{base}?w=900&h=460&p=4&shots=24", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=60000)
            state = page.evaluate("window.__state")
            ok(state is not None, "the runtime came up and answered")
            ok(state and state["phase"] in ("aim", "shoot", "beat"), "…on a board still being played", str(state and state["phase"]))
            ok(state and sum(state["coins"]) > 0, "with coins already pocketed", str(state and state["coins"]))

            # THE BLACK CANVAS TEST. A blank canvas passes every other check
            # there is; a solid colour compresses to almost nothing, so the
            # weight of the PNG is the only honest evidence that anything was
            # painted. Both layers are checked: the felt is one canvas and the
            # coins are another, and either one going missing is a broken game.
            # The two layers are the same size and stacked, so each has to be
            # photographed with the other one hidden — otherwise both pictures
            # are the same picture and one of the two checks proves nothing.
            def layer(keep: str, hide: str) -> int:
                page.evaluate(f"document.querySelector('{hide}').style.visibility = 'hidden'")
                shot = page.locator(keep).screenshot()
                page.evaluate(f"document.querySelector('{hide}').style.visibility = ''")
                return len(shot)

            felt = layer(".cr-board", ".cr-live")
            coins = layer(".cr-live", ".cr-board")
            ok(felt > 8_000, "the felt, the frame and the pockets are painted", f"{felt // 1024} kB of PNG")
            ok(coins > 6_000, "and so are the coins on top of them", f"{coins // 1024} kB of PNG")
            ok(felt != coins, "…they really are two different pictures")

            ok(page.locator(".cr-card").count() == 4, "four player cards, one a side of each rail")
            ok(page.locator(".cr-ours .cr-card").count() == 2, "…two of them on the local player's side")
            ok("/9" in page.locator(".cr-score").inner_text(), "the coin score is on screen")
            ok(not errors, "nothing threw", "; ".join(errors[:3]))
            page.close()

            # ---- it is playable ---------------------------------------------
            print("\nthe controls")
            page = browser.new_page(viewport={"width": 900, "height": 460})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"{base}?w=900&h=460&p=4&shots=24", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=60000)
            # Watch what the runtime puts on the wire, rather than trusting it.
            page.evaluate("() => { window.__sent = []; window.__rt.ctx.sendInput = (i) => { window.__sent.push(i); }; }")
            lay = page.evaluate("window.__rt.layout")
            R = lay["r"]

            def at(bx: float, by: float):
                return lay["cx"] + bx * R, lay["cy"] - by * R

            def aim_at(bx: float, by: float):
                x, y = at(bx, by)
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.move(x, y)
                page.mouse.up()
                return page.evaluate("window.__rt.aimDir")

            ok(page.locator(".cr-strip .cr-bar").count() == 2, "there are two bars and a button")
            ok(page.locator(".cr-shoot").count() == 1, "…and the button is SHOOT")

            # ALL THE WAY ROUND. Four quarters, including straight back at the
            # shooter's own frame, which used to be refused outright.
            up = aim_at(0, 0.5)
            right = aim_at(0.6, -0.7)
            back = aim_at(0.05, -0.93)
            left = aim_at(-0.6, -0.7)
            ok(up["y"] > 0.9, f"the aim points up the board when asked ({up['y']:.2f})")
            ok(right["x"] > 0.9, f"…and across it ({right['x']:.2f})")
            ok(back["y"] < -0.8, f"…and BACKWARDS, which is the whole 360 ({back['y']:.2f})")
            ok(left["x"] < -0.9, f"…and the other way across ({left['x']:.2f})")
            # AIMING IS BROADCAST, BUT IT IS NEVER A SHOT. The other three
            # players watch you line up (that is what `m…` is for), so packets
            # do go out — and every one of them has to be an aim. One `a…` in
            # among them would fire the striker under the player's thumb.
            sent = page.evaluate("window.__sent")
            ok(len(sent) > 0, f"lining up is broadcast, so the table can watch ({len(sent)} aims)")
            ok(all(i["kind"].startswith("m") for i in sent), "…and every one of them is an aim, not a request")

            # The bars move their own thing and nothing else.
            before_aim = page.evaluate("JSON.stringify(window.__rt.aimDir)")
            slide = page.locator(".cr-slide .cr-bar-track").bounding_box()
            page.mouse.click(slide["x"] + slide["width"] * 0.1, slide["y"] + slide["height"] / 2)
            low = page.evaluate("window.__rt.aimT")
            page.mouse.click(slide["x"] + slide["width"] * 0.9, slide["y"] + slide["height"] / 2)
            high = page.evaluate("window.__rt.aimT")
            ok(low < -0.6 and high > 0.6, f"the striker bar walks the striker across its line ({low:.2f} → {high:.2f})")
            power = page.locator(".cr-power .cr-bar-track").bounding_box()
            page.mouse.click(power["x"] + power["width"] * 0.95, power["y"] + power["height"] / 2)
            ok(page.evaluate("window.__rt.aimPower") > 0.85, "the power bar sets the weight")
            ok(page.evaluate("JSON.stringify(window.__rt.aimDir)") == before_aim, "…and neither bar disturbs the aim")

            # Grabbing the disc itself still works, and still only moves it.
            page.evaluate("window.__rt.aimT = 0; window.__rt.lastSig = ''; window.__rt.render();")
            sx, sy = at(0, -0.755)
            tx, _ = at(-0.45, -0.755)
            page.mouse.move(sx, sy)
            page.mouse.down()
            page.mouse.move(tx, sy, steps=5)
            page.mouse.up()
            ok(page.evaluate("window.__rt.aimT") < -0.6, "the striker can also just be dragged")
            ok(page.evaluate("JSON.stringify(window.__rt.aimDir)") == before_aim, "…without losing the aim either")

            # SHOOT is the only thing that COMMITS.
            asks = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a').length")
            ok(asks == 0, f"nothing has been committed yet ({asks})")
            page.locator(".cr-shoot").click()
            sent = page.evaluate("window.__sent")
            asks = [i for i in sent if i["kind"].startswith("a")]
            ok(len(asks) == 1, f"SHOOT sends exactly one request ({len(asks)})")
            ok(sent[-1]["kind"].startswith("a"), f"…and it is the last thing said ({sent[-1]['kind']})")

            # And none of it is live on somebody else's turn.
            page.evaluate("window.__rt.asked = null; window.__rt.sim.state.turn = 2; window.__rt.lastSig = ''; window.__rt.render();")
            ok(page.locator(".cr-shoot").is_disabled(), "on another player's turn the button is off")
            page.locator(".cr-shoot").click(force=True)
            ok(
                page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a').length") == 1,
                "…and forcing a click through it commits nothing",
            )
            # WATCHING SOMEBODY ELSE. An aim from another seat, delivered the
            # way the relay delivers one, has to change the picture — that is
            # the whole feature, and a runtime that quietly ignored it would
            # look identical to one that had nothing to show.
            page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  // Hand the turn to somebody else, then let them line up.
                  s.turn = (rt.mySeat + 1) % s.players;
                  s.phase = 'aim';
                  s.since = Math.max(0, s.tick - 5);
                  rt.lastSig = '';
                  rt.render();
                }"""
            )
            quiet = page.locator(".cr-live").screenshot()
            page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  rt.onRemoteInput({ uid: rt.ctx.roster[s.turn].uid, tick: s.since + 1, kind: 'm-380,240,960,720' });
                  rt.lastSig = '';
                  rt.render();
                }"""
            )
            lining = page.locator(".cr-live").screenshot()
            ok(len(lining) != len(quiet), "an opponent's aim actually changes what is drawn")
            held = page.evaluate("window.__rt.intent.get(window.__rt.sim.state.turn) || null")
            ok(held is not None and held["p"] == 720, f"…and their weight came with it ({held and held['p']})")
            banner = page.locator(".cr-banner").inner_text().lower()
            ok("lining up" in banner, f"the banner says who is thinking ({banner!r})")

            ok(not errors, "nothing threw while playing", "; ".join(errors[:3]))

            # ---- what the studio is told -------------------------------------
            print("\nwhat the replay studio is told")
            hooks = page.evaluate("window.__hooks")
            ok(hooks is not None, "the game exposes the studio hooks")
            if hooks:
                ok("power" in (hooks["shot"] or ""), f"a flick reads as words ({hooks['shot']!r})")
                ok("lining up" in (hooks["aim"] or ""), f"…and so does an aim ({hooks['aim']!r})")
                ok(hooks["quit"] is not None, "…and leaving the table")
                ok(hooks["junk"] is None, "nonsense is described as nothing rather than guessed at")
                ok(abs((hooks["weightShot"] or 0) - 0.72) < 1e-9, f"a flick carries its power as its weight ({hooks['weightShot']})")
                ok(hooks["weightAim"] is None, "an aim carries none — it is a thought, not a shot")
                summary = {x["label"]: x["value"] for x in (hooks["summary"] or [])}
                ok(summary.get("Shots") == "3", f"the summary counts shots and not aims ({summary.get('Shots')})")
                ok(summary.get("Avg power") == "65%", f"…averages the power ({summary.get('Avg power')})")
                ok(summary.get("Softest") == "20%" and summary.get("Hardest") == "90%", "…and knows the range")
                ok(summary.get("Full-blooded") == "2 of 3", f"…and how often they wound it right up ({summary.get('Full-blooded')})")
            page.close()

            # ---- it replays -------------------------------------------------
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
                ok(r["inputs"] > 20, "a whole board was played and archived", f"{r['inputs']} inputs over {r['endTick']} ticks")
                ok(r["aims"] > 0, f"the log carries live aims as well as flicks ({r['aims']} aims, {r['inputs'] - r['aims']} flicks)")
                ok(r["topMatches"], "played from tick zero, the watched board is the server's board — bit for bit")
                ok(r["seekMatches"], "and so is a scrub into the middle", f"tick {r['seekTick']}")
            # A REPLAY IS NOT A GAME. The controls must not merely be disabled
            # for a watcher — they must not be there. One that looks pressable
            # is one somebody will press, and then argue about.
            ok(page.locator(".cr-strip.watch").count() == 1, "a watcher gets no controls at all")
            ok(not page.locator(".cr-shoot").is_visible(), "…the SHOOT button is not even on the screen")
            ok(not errors, "nothing threw during playback", "; ".join(errors[:3]))
            page.close()
            browser.close()
    finally:
        stop(vite)

    print("\nALL CHECKS PASSED" if FAILS == 0 else f"\n{FAILS} CHECK(S) FAILED")
    return 0 if FAILS == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
