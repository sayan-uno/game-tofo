#!/usr/bin/env python3
"""8 Ball Pool's CLIENT, in a real browser.

    npm run check:poolui

`check:pool` proves the simulation. This proves the half of the game that lives
in a browser and that no amount of Node can reach.

Six things are checked, and each one exists because its absence is invisible:

  it draws        A canvas that is present, sized and blank passes every
                  selector-based test there is (the console's own suite learned
                  that the hard way), so the test is the WEIGHT of a PNG of each
                  layer: sixteen numbered balls on green cloth cannot compress
                  small, and neither can a rail with six pockets cut into it.

  it is aimable   The control, driven with real pointer events. Pool needs a
                  finer aim than any other game here — a pot is a quarter of a
                  degree wide — so three things are proved: a drag on the cloth
                  points the cue at the finger, the FINE bar moves the aim by a
                  little and folds what it did into the aim when released, and
                  NOTHING is ever committed until SHOOT is pressed. The last is
                  the one that matters: carrom shipped with aim and fire on one
                  gesture and there was no way to change your mind.

  ball in hand    After a foul the cue ball is dragged rather than aimed, and
                  where it lands is decided by the SHARED `nearestSpot` — so the
                  ghost under the thumb has to be exactly where the server will
                  put it, on the same call, or the shot the player lines up is
                  not the shot they get.

  it is watchable An aim arriving off the wire from the other seat has to change
                  the picture. Without it the first anyone knew of a shot was
                  the shot.

  the stroke      How HARD, which is most of a pool shot and was the one thing
                  nobody but the shooter could see. The cue draws back in
                  proportion to the weight and drives through the ball, timed by
                  the simulation rather than by an animation — so the swing is
                  proved to MOVE, to differ between a smash and a touch, and to
                  be named in words on the banner. A live aim never enters a
                  log; this does, which is why a replay finally has a cue in it.

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
    base = f"http://127.0.0.1:{port}/pool-preview.html"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox"])

            # ---- it draws ---------------------------------------------------
            print("\nthe table draws")
            page = browser.new_page(viewport={"width": 900, "height": 460}, device_scale_factor=2)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{base}?w=900&h=460&p=4&shots=12", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=60000)
            state = page.evaluate("window.__state")
            ok(state is not None, "the runtime came up and answered")
            ok(state and state["shots"] > 6, "…on a table well into a rack", f"{state and state['shots']} shots")
            ok(state and not state["open"], "the groups have been decided", str(state and state["groups"]))

            # THE BLANK CANVAS TEST. Each layer photographed with the other
            # hidden — stacked, they are the same box, and one picture proving
            # two things proves neither.
            def layer(keep: str, hide: str) -> int:
                page.evaluate(f"document.querySelector('{hide}').style.visibility = 'hidden'")
                shot = page.locator(keep).screenshot()
                page.evaluate(f"document.querySelector('{hide}').style.visibility = ''")
                return len(shot)

            cloth = layer(".pl-table", ".pl-live")
            balls = layer(".pl-live", ".pl-table")
            ok(cloth > 6_000, "the cloth, the rail and the pockets are painted", f"{cloth // 1024} kB of PNG")
            ok(balls > 6_000, "and so are the balls on top of it", f"{balls // 1024} kB of PNG")
            ok(cloth != balls, "…they really are two different pictures")

            ok(page.locator(".pl-card").count() == 4, "four player cards")
            ok(page.locator(".pl-rack").count() == 2, "…and a rack of balls for each side")
            ok(page.locator(".pl-chip.down").count() > 0, "with the balls that are down greyed out")
            ok(page.locator(".pl-rack.open").count() == 0, "and neither rack still reads as open")
            ok(page.locator(".pl-eight").count() == 1, "the black sits between the two")
            ok(not errors, "nothing threw", "; ".join(errors[:3]))
            page.close()

            # ---- it is aimable -----------------------------------------------
            print("\nthe controls")
            page = browser.new_page(viewport={"width": 900, "height": 460})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{base}?w=900&h=460&p=2&shots=6", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=60000)
            # The recorder, and a reset of the aim throttle with it. The preview
            # freezes its clock so the staged frame stays staged, which also
            # freezes the "one aim every quarter second" limiter at whatever it
            # was when the page last drew — so without this every aim below
            # would be correctly, and uselessly, throttled away.
            page.evaluate(
                """() => {
                  window.__sent = [];
                  window.__rt.ctx.sendInput = (i) => { window.__sent.push(i); };
                  window.__rt.sentAimAt = 0;
                  window.__rt.sentAim = null;
                }"""
            )

            # Where the cue ball is, in CSS pixels.
            cue = page.evaluate(
                """() => {
                  const rt = window.__rt, l = rt.layout, s = rt.sim.state;
                  return { x: l.cx + s.x[0] * l.r, y: l.cy + s.y[0] * l.r, r: l.r };
                }"""
            )

            def drag_to(dx, dy):
                page.mouse.move(cue["x"], cue["y"])
                page.mouse.move(cue["x"] + dx, cue["y"] + dy)
                page.mouse.down()
                page.mouse.move(cue["x"] + dx, cue["y"] + dy)
                page.mouse.up()
                return page.evaluate("window.__rt.aimDir")

            right = drag_to(140, 0)
            ok(right["x"] > 0.9, f"dragging to the right points the cue right ({right['x']:.3f})")
            down = drag_to(0, 120)
            ok(down["y"] > 0.9, f"…and dragging down points it down ({down['y']:.3f})")
            up = drag_to(0, -120)
            ok(up["y"] < -0.9, "…and up, so the aim goes all the way round")
            back = drag_to(-140, 0)
            ok(back["x"] < -0.9, "…including straight back at the player")

            # NOTHING IS COMMITTED BY A DRAG. The aim goes out so the table can
            # watch, but the shot does not.
            asks = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a').length")
            ok(asks == 0, "four drags and not one shot was committed")
            aims = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'm').length")
            ok(aims > 0, f"but the table was told what we are lining up ({aims})")

            # THE FINE BAR. A small change, and it folds into the aim on release
            # so it can be used again — the control that makes a pot reachable
            # with a thumb.
            before = page.evaluate("({ ...window.__rt.aimDir })")
            box = page.locator(".pl-trim .pl-bar-track").bounding_box()
            page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2)
            page.mouse.down()
            page.mouse.move(box["x"] + box["width"] * 0.95, box["y"] + box["height"] / 2)
            held = page.evaluate("({ trim: window.__rt.trim, aim: { ...window.__rt.aimDir }, shown: window.__rt.trimmed() })")
            ok(held["trim"] > 0.5, f"the fine bar moves ({held['trim']:.2f})")
            ok(
                abs(held["aim"]["x"] - before["x"]) < 1e-9 and abs(held["aim"]["y"] - before["y"]) < 1e-9,
                "…without touching the aim underneath it while it is held",
            )
            moved = abs(held["shown"]["x"] - before["x"]) + abs(held["shown"]["y"] - before["y"])
            ok(moved > 1e-5, f"but the aim it SHOWS has moved ({moved:.5f})")
            ok(moved < 0.06, "…by a little, which is the whole point of a fine control")
            page.mouse.up()
            after = page.evaluate("({ trim: window.__rt.trim, aim: { ...window.__rt.aimDir } })")
            ok(abs(after["trim"]) < 1e-9, "letting go re-centres the bar")
            folded = abs(after["aim"]["x"] - before["x"]) + abs(after["aim"]["y"] - before["y"])
            ok(folded > 1e-5, "…having folded what it did into the aim, so it can be used again")

            # THE POWER BAR keeps its value, which is what makes a weight you
            # like a weight you get.
            pbox = page.locator(".pl-power .pl-bar-track").bounding_box()
            page.mouse.click(pbox["x"] + pbox["width"] * 0.8, pbox["y"] + pbox["height"] / 2)
            power = page.evaluate("window.__rt.aimPower")
            ok(power > 0.7, f"the power bar sets the weight ({power:.2f})")

            # AND THE ONLY THING THAT COMMITS IS THE BUTTON.
            page.evaluate("() => { window.__sent.length = 0; }")
            ok(page.locator(".pl-shoot").is_enabled(), "the SHOOT button is live on your own turn")
            page.locator(".pl-shoot").click()
            asks = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a')")
            ok(len(asks) == 1, f"pressing it asks for exactly one shot ({len(asks)})")
            if asks:
                parts = asks[0]["kind"][1:].split(",")
                ok(len(parts) == 5, f"…as five integers ({asks[0]['kind']})")
                ok(abs(int(parts[4]) / 1000 - power) < 0.02, f"…carrying the weight that was set ({parts[4]})")

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
            ok(page.locator(".pl-shoot").is_disabled(), "on another player's turn the button is off")
            before_n = page.evaluate("window.__sent.length")
            page.locator(".pl-shoot").click(force=True)
            ok(page.evaluate("window.__sent.length") == before_n, "…and forcing a click through it asks for nothing")

            # ---- ball in hand -------------------------------------------------
            print("\nball in hand")
            hand = page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  s.turn = rt.mySeat;
                  s.phase = 'aim';
                  s.since = s.tick;
                  s.deadline = s.tick + 600;
                  s.ballInHand = true;
                  s.behindLine = false;
                  rt.asked = null;
                  rt.lastSig = '';
                  rt.render();
                  return { x: rt.layout.cx + s.x[0] * rt.layout.r, y: rt.layout.cy + s.y[0] * rt.layout.r };
                }"""
            )
            page.evaluate("() => { window.__sent.length = 0; }")
            page.mouse.move(hand["x"], hand["y"])
            page.mouse.down()
            page.mouse.move(hand["x"] - 90, hand["y"] + 40)
            page.mouse.up()
            placed = page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  const mine = rt.cueSpot();
                  const theirs = window.__nearestSpot(rt.spot.x, rt.spot.y, s.x, s.y, s.alive, s.behindLine);
                  return { mine, theirs, spot: { ...rt.spot } };
                }"""
            )
            ok(placed["spot"]["x"] < 0.98, "dragging the cue ball moves where it will be put down")
            ok(
                abs(placed["mine"]["x"] - placed["theirs"]["x"]) < 1e-12
                and abs(placed["mine"]["y"] - placed["theirs"]["y"]) < 1e-12,
                "and the ghost the player sees is EXACTLY the shared nearestSpot the server will use",
            )
            sent = page.evaluate("window.__sent.filter((i) => i.kind[0] === 'a').length")
            ok(sent == 0, "moving the ball commits nothing")

            # ---- it is watchable ----------------------------------------------
            print("\nwatching the others")
            quiet = page.locator(".pl-live").screenshot()
            held2 = page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  s.ballInHand = false;
                  s.turn = (rt.mySeat + 1) % s.players;
                  s.phase = 'aim';
                  s.since = Math.max(0, s.tick - 5);
                  rt.lastSig = '';
                  rt.render();
                  const kind = 'm' + Math.round(s.x[0] * 1000) + ',' + Math.round(s.y[0] * 1000) + ',1000,-300,700';
                  rt.onRemoteInput({ uid: rt.ctx.roster[s.turn].uid, tick: s.since + 1, kind });
                  rt.lastSig = '';
                  rt.render();
                  return { seat: s.turn, held: rt.intent.get(s.turn) || null };
                }"""
            )
            lining = page.locator(".pl-live").screenshot()
            ok(held2 and held2["held"] and held2["held"]["p"] == 700, "an aim off the wire is remembered")
            ok(len(lining) != len(quiet), "…and it actually changes what is drawn")
            banner = page.inner_text(".pl-banner").lower()
            ok("lining up" in banner, f"the banner says who is thinking ({banner!r})")
            ok(not errors, "nothing threw while playing", "; ".join(errors[:3]))

            # ---- the stroke ----------------------------------------------------
            #
            # THE ONE THING A TABLE COULD NOT SEE WAS WEIGHT. The cue now draws
            # back in proportion to it and drives through the ball, and because
            # the SIMULATION times that swing it is the same picture for the
            # shooter, for everyone watching, and for a console replaying the
            # log — which is where the whole thing was invisible.
            print("\nthe stroke")
            page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  s.turn = (rt.mySeat + 1) % s.players;
                  s.ballInHand = false;
                  s.alive[0] = 1;
                  window.__stage = (power, at) => {
                    const span = power >= 500 ? rt.ctx.rules.strokeMaxTicks : rt.ctx.rules.strokeMinTicks;
                    const ft = rt.fineTick();
                    s.phase = 'stroke';
                    s.since = ft - span * at;
                    s.deadline = s.since + span;
                    s.shot = {
                      x: Math.round(s.x[0] * 1000), y: Math.round(s.y[0] * 1000),
                      dx: 1000, dy: 0, p: power, seat: s.turn,
                      from: { x: s.x[0], y: s.y[0] },
                    };
                    rt.lastSig = '';
                    rt.render();
                    return { span, banner: document.querySelector('.pl-banner').textContent };
                  };
                }"""
            )
            rules = page.evaluate("({ ...window.__rt.ctx.rules })")
            ok(
                isinstance(rules.get("strokeMaxTicks"), int) and rules["strokeMaxTicks"] > rules["strokeMinTicks"],
                f"the server tells the client how long a swing is ({rules.get('strokeMinTicks')}–{rules.get('strokeMaxTicks')} ticks)",
            )

            back = page.evaluate("window.__stage(1000, 0.5)")
            hard_back = page.locator(".pl-live").screenshot()
            through = page.evaluate("window.__stage(1000, 0.97)")
            hard_through = page.locator(".pl-live").screenshot()
            soft = page.evaluate("window.__stage(80, 0.5)")
            soft_back = page.locator(".pl-live").screenshot()

            ok(hard_back != lining, "a cue PLAYING the shot is not the same picture as one being lined up")
            ok(hard_back != hard_through, "…and the cue MOVES through the swing — back, then through")
            ok(hard_back != soft_back, "a hard shot and a soft one are drawn differently at the same point of the swing")
            ok("at full pace" in (back["banner"] or ""), f"the banner names the weight ({back['banner']!r})")
            ok("a touch" in (soft["banner"] or ""), f"…and names a soft one differently ({soft['banner']!r})")
            ok(
                (back["banner"] or "").split(" plays it")[0] == page.evaluate("window.__rt.ctx.roster[window.__rt.sim.state.turn].name"),
                "…and says whose stroke it is, not 'yours'",
            )

            # The follow-through: the ball has gone, the stick has not stopped.
            page.evaluate(
                """() => {
                  const rt = window.__rt;
                  const s = rt.sim.state;
                  s.phase = 'shoot';
                  s.since = rt.fineTick() - 1;
                  s.deadline = s.since + 600;
                  rt.lastSig = '';
                  rt.render();
                }"""
            )
            just_hit = page.locator(".pl-live").screenshot()
            page.evaluate(
                """() => {
                  const rt = window.__rt;
                  rt.sim.state.since = rt.fineTick() - 120;
                  rt.lastSig = '';
                  rt.render();
                }"""
            )
            long_gone = page.locator(".pl-live").screenshot()
            ok(just_hit != long_gone, "the cue follows through after contact and is gone a second later")
            ok(not errors, "nothing threw while the cue was swinging", "; ".join(errors[:3]))

            # ---- what the studio is told ---------------------------------------
            print("\nwhat the replay studio is told")
            hooks = page.evaluate("window.__hooks")
            ok(hooks is not None, "the game exposes the studio hooks")
            if hooks:
                ok("played the shot" in (hooks["shotHard"] or ""), f"a shot reads as words ({hooks['shotHard']!r})")
                ok(
                    (hooks["shotHard"] or "") != (hooks["shotSoft"] or ""),
                    f"…and how hard it was struck is part of them ({hooks['shotSoft']!r})",
                )
                ok("lining up" in (hooks["aim"] or ""), f"an aim reads as a thought ({hooks['aim']!r})")
                ok(hooks["quit"] is not None, "…and leaving the table")
                ok(hooks["junk"] is None, "nonsense is described as nothing rather than guessed at")
                ok(hooks["weightHard"] == 1, f"the hardest shot carries full weight ({hooks['weightHard']})")
                ok(
                    hooks["weightSoft"] is not None and hooks["weightSoft"] < 0.3,
                    f"a touch barely marks the tape ({hooks['weightSoft']})",
                )
                ok(hooks["weightAim"] is None, "and an aim carries none — it is a thought, not a shot")
                summary = {x["label"]: x["value"] for x in (hooks["summary"] or [])}
                ok("Balls potted" in summary, f"the summary knows how many they potted ({summary.get('Balls potted')})")
                ok("Best run" in summary, f"…and their longest run at the table ({summary.get('Best run')})")
                ok("Fouls" in summary, f"…and what it cost them ({summary.get('Fouls')})")
                ok("Side left" in summary, f"…and how much of their side was left ({summary.get('Side left')})")
            page.close()

            # ---- it replays -----------------------------------------------------
            print("\nthe admin console's replay path")
            page = browser.new_page(viewport={"width": 900, "height": 460})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{base}?w=900&h=460&p=2&replay=1", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=240000)
            r = page.evaluate("window.__replay")
            ok(r is not None, "the replay harness finished")
            if r:
                ok(r["inputs"] > 20, "a whole rack was played and archived", f"{r['inputs']} inputs over {r['endTick']} ticks")
                ok(r["aims"] > 0, f"the log carries aims as well as shots ({r['aims']} of {r['inputs']})")
                ok(r["topMatches"], "played from tick zero, the watched table is the server's table — bit for bit")
                ok(r["seekMatches"], "and so is a scrub into the middle", f"tick {r['seekTick']}")
            # A REPLAY IS NOT A GAME.
            ok(page.locator(".pl-strip.watch").count() == 1, "a watcher gets no control at all")
            ok(not page.locator(".pl-shoot").is_visible(), "…the SHOOT button is not even on the screen")
            ok(not errors, "nothing threw during playback", "; ".join(errors[:3]))
            page.close()
            browser.close()
    finally:
        stop(vite)

    print("\nALL CHECKS PASSED" if FAILS == 0 else f"\n{FAILS} CHECK(S) FAILED")
    return 0 if FAILS == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
