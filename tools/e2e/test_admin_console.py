#!/usr/bin/env python3
"""Browser test for the admin console shell (A1).

    ADMIN_PORT=4031 python3 tools/e2e/test_admin_console.py

Needs the ROLE=admin backend and the console's Vite dev server both running.
It proves the parts that only exist in a real browser: that the sign-in screen
renders and mounts Google's button, that a returning admin's httpOnly cookie
resumes the session across an origin boundary (CORS with credentials), that the
overview paints real numbers, and that signing out actually ends it.

The Google stage is not automated — doing so would mean a bypass in production
code. Everything on either side of it is exercised for real.
"""
import base64
import hmac
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
TSX = ROOT / "backend" / "node_modules" / ".bin" / "tsx"
PROVISION = ROOT / "tools" / "e2e" / "admin-provision.mts"
SEED_REPLAY = ROOT / "tools" / "e2e" / "seed-replay.mts"
UI = os.environ.get("ADMIN_UI", "http://localhost:5174")
API_PORT = os.environ.get("ADMIN_PORT", "4031")

fails = 0


def totp(secret_b32: str, at: float | None = None) -> str:
    """The six digits an authenticator app would be showing.

    Standard TOTP — SHA-1, six digits, thirty-second steps — written out here
    rather than pulled in as a dependency, so the browser test can answer a
    sudo prompt exactly as a person does.
    """
    padded = secret_b32.upper() + "=" * ((8 - len(secret_b32) % 8) % 8)
    key = base64.b32decode(padded)
    counter = int((at or time.time()) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000
    return f"{code:06d}"


def ok(cond, msg):
    global fails
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        fails += 1


def node(*args, script=PROVISION):
    out = subprocess.run([str(TSX), str(script), *args], capture_output=True, text=True,
                         cwd=ROOT, env={**os.environ, "ADMIN_PORT": API_PORT})
    if out.returncode != 0:
        print(out.stdout, out.stderr, file=sys.stderr)
        raise SystemExit(f"{script.name} failed: {out.returncode}")
    return out.stdout.strip()


print("\nprovisioning a real session")
session = json.loads(node("provision").splitlines()[-1])
ok(bool(session["cookieValue"]), "the sign-in endpoint issued a refresh cookie")

# A real archived match for the studio to open — played through the game's own
# server definition and put through the same encoder the match runtime uses.
# Trackline on purpose: it is the game whose runtime distinguishes "my own
# input" from "somebody else's", which is exactly the distinction a replay has
# to get right — and got wrong the first time.
seeded = json.loads(node("seed", "trackline", script=SEED_REPLAY).splitlines()[-1])
ok(seeded["inputs"] > 100, f"seeded a replay to watch ({seeded['inputs']} inputs, {seeded['bytes']} bytes)")

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context()
        errors = []
        warnings = []
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        # A model that will not parse only WARNS — the simulation is unaffected,
        # so every other check still passes while the replay shows name plates
        # running down an empty street. That is what happened when the console
        # was missing the meshopt decoder, so it is watched for explicitly.
        page.on("console", lambda m: warnings.append(m.text[:120])
                if m.type in ("warning", "error") and "failed to load" in m.text else None)

        print("\nthe sign-in screen")
        page.goto(UI, wait_until="domcontentloaded")
        page.wait_for_selector(".box h1", timeout=15000)
        ok(page.inner_text(".box h1") == "TOFO Console", "the console names itself")
        ok("recorded and alerted" in page.inner_text(".box .lead"), "and says sign-ins are recorded")
        # Google renders into an iframe inside our container — attached rather
        # than visible, because it keeps a hidden one of its own alongside.
        page.wait_for_selector("#google-btn iframe", state="attached", timeout=15000)
        ok(page.locator("#google-btn iframe").count() >= 1, "Google's sign-in button mounted")
        ok("client_id=" in (page.locator("#google-btn iframe").first.get_attribute("src") or ""),
           "carrying the OAuth client id, so the config reached it")
        ok(page.locator("#screen").count() == 0, "and nothing of the console itself is on the page yet")
        ok(errors == [], f"no JavaScript errors on load ({errors})")

        print("\nresuming a session")
        context.add_cookies([{
            "name": session["cookieName"],
            "value": session["cookieValue"],
            "domain": "localhost",
            "path": session["cookiePath"],
            "httpOnly": True,
            "sameSite": "Lax",
        }])
        page.goto(UI, wait_until="domcontentloaded")
        page.wait_for_selector(".rail", timeout=15000)
        ok("CONSOLE" in page.inner_text(".brand"), "the shell loads for a returning admin")
        # inner_text returns RENDERED text, so anything the stylesheet
        # uppercases comes back uppercased — compare in one case.
        ok(session["email"] in page.inner_text(".rail .who"), "showing which admin is signed in, not shouted in caps")
        ok("owner" in page.inner_text(".rail .who .pill").lower(), "and their role")
        nav = [t.strip().lower() for t in page.locator(".rail nav a").all_inner_texts()]
        for want in ["overview", "players", "sanctions", "platform"]:
            ok(want in nav, f"the rail offers {want.title()}")

        print("\nthe overview")
        page.wait_for_selector(".tile", timeout=15000)
        tiles = [t.lower() for t in page.locator(".tile .k").all_inner_texts()]
        for want in ["Players online", "Matches running", "Total players", "Game servers"]:
            ok(want.lower() in tiles, f"the {want.lower()} tile is there")
        total = page.locator(".tile", has=page.locator(".k", has_text="Total players")).locator(".v").inner_text()
        ok(total.strip() not in ("", "0"), f"the player total is a real number ({total.strip()})")
        ok(errors == [], f"still no JavaScript errors ({errors})")

        print("\nfinding a player")
        uid, label = session.get("samplePlayerUid"), session.get("samplePlayerLabel")
        if uid:
            page.fill(".search input", label[:4])
            page.press(".search input", "Enter")
            # Wait for the SCREEN, not for a table: the overview has a table of
            # its own, so waiting for one passes instantly on the old screen
            # whenever a game server happens to be publishing.
            page.wait_for_function("() => document.getElementById('title')?.textContent === 'Players'", timeout=15000)
            page.wait_for_selector("#how:not(:empty)", timeout=15000)
            page.wait_for_selector("table.tbl tbody tr", timeout=15000)
            ok(page.locator("table.tbl tbody tr").count() >= 1, f"searching “{label[:4]}” finds somebody")
            ok(uid in page.inner_text("table.tbl"), "and the right UID is in the results")
            ok("by username" in page.inner_text("#how"), "the console says HOW it read the query")

            print("\nthe player page")
            page.click("table.tbl tbody tr")
            page.wait_for_selector(".phead h1", timeout=15000)
            ok(uid in page.inner_text(".phead"), "the profile opens on the player that was clicked")
            cards = [c.lower() for c in page.locator(".card > header h2").all_inner_texts()]
            for want in ["account", "career", "recent matches", "sanctions", "linked accounts"]:
                ok(want in cards, f"the {want} panel is there")
            ok("activity trail" in cards, "and an owner sees the activity trail with its addresses")
            ok(page.url.endswith(f"#/players/{uid}"), "the URL is a deep link that survives a refresh")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".phead h1", timeout=15000)
            ok(uid in page.inner_text(".phead"), "…and it does survive one")
        else:
            print("  (no players in the database — skipped)")

        print("\nthe other screens")
        # Wait on the page TITLE, not on a card: cards exist on the screen we
        # are leaving too, so waiting for one passes instantly on stale content.
        page.click('.rail a[data-nav="sanctions"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Sanctions'", timeout=15000)
        page.wait_for_selector(".card header h2", timeout=15000)
        ok("in force" in page.inner_text(".card header h2").lower(), "the sanctions screen lists what is in force")
        page.click('.rail a[data-nav="platform"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Platform'", timeout=15000)
        page.wait_for_selector(".switch", timeout=15000)
        switches = page.inner_text(".card").lower()
        ok("maintenance mode" in switches, "the platform screen offers maintenance mode")
        ok("notice to everyone online" in switches, "and a notice to everyone online")

        if uid:
            print("\nbanning somebody, by clicking the buttons")
            page.goto(f"{UI}#/players/{uid}", wait_until="domcontentloaded")
            page.wait_for_selector(".phead h1", timeout=15000)
            page.wait_for_selector("button.act", timeout=15000)
            ok(page.locator("button.act").count() == 5, "the profile offers all five sanctions")

            page.click('button.act[data-type="chat"]')
            page.wait_for_selector(".modal", timeout=10000)
            ok("mute chat" in page.inner_text(".modal header h3").lower(), "clicking one opens a form naming the action")
            page.fill("#f_reason", "e2e — clicked through the console")
            page.select_option("#f_minutes", "60")
            page.locator(".overlay").last.locator("#ok").click()

            # Sudo: the console asks for a code only now, and only because the
            # server demanded one. The enrolment code is already spent, so this
            # has to be the NEXT one.
            page.wait_for_selector(".modal header h3:has-text('Confirm it is you')", timeout=10000)
            ok(True, "and then asks for a fresh authenticator code")
            page.fill("#f_code", totp(session["totpSecret"], time.time() + 30))
            page.locator(".overlay").last.locator("#ok").click()

            page.wait_for_selector(".toast", timeout=15000)
            ok("applied" in page.inner_text(".toast").lower(), "the console confirms it was applied")
            page.wait_for_selector("button.lift", timeout=15000)
            body = page.inner_text(".card:has(button.lift)")
            ok("clicked through the console" in body, "the sanction appears on the player with its reason")
            ok("chat muted" in body.lower(), "worded as the console words it, not as the database keys it")

            print("\nlifting it again")
            page.click("button.lift")
            page.wait_for_selector(".modal", timeout=10000)
            page.fill("#f_reason", "e2e cleanup")
            page.locator(".overlay").last.locator("#ok").click()
            # Sudo is still live from a moment ago, so no second prompt.
            page.wait_for_selector(".toast:has-text('lifted')", timeout=15000)
            ok(True, "lifting it works, and does not ask to confirm again inside the sudo window")
            # Wait for the CONDITION, not for a guessed number of milliseconds.
            # The page refetches the profile after lifting; how long that takes
            # depends on the machine, and a fixed sleep is how a suite starts
            # failing for reasons that have nothing to do with the code.
            gone = True
            try:
                page.wait_for_function("() => document.querySelectorAll('button.lift').length === 0", timeout=15000)
            except Exception:
                gone = False
            ok(gone, "and nothing is left in force")

        print("\nthe studio")
        page.click('.rail a[data-nav="matches"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Matches'", timeout=15000)
        page.wait_for_selector("table.tbl tbody tr", timeout=15000)
        ok(seeded["matchKey"] in page.inner_text("table.tbl"), "the archived match is listed")

        page.goto(f"{UI}#/matches/{seeded['matchKey']}", wait_until="domcontentloaded")
        page.wait_for_selector(".studio", timeout=20000)
        # The studio loads the game's real client code and rebuilds the first
        # frame from the input log; on this box that takes a moment.
        page.wait_for_selector(".stage.ready", timeout=90000)
        ok(True, "the game's own code loaded and drew the match")
        ok(page.locator("#studio-canvas").count() == 1, "onto a canvas")
        ok(page.locator(".lane").count() == 4, "with an input lane per player")

        before = page.inner_text("#clock")
        page.click("#play")
        page.wait_for_timeout(2500)
        ok(page.inner_text("#clock") != before, f"play advances the clock ({before} → {page.inner_text('#clock')})")
        page.click("#play")           # pause FIRST
        page.wait_for_timeout(400)     # let the frame loop settle
        paused = page.inner_text("#clock")
        page.wait_for_timeout(1500)
        ok(page.inner_text("#clock") == paused, f"pause stops it ({paused})")

        # Seeking is the reconnect path: throw the runtime away, replay every
        # input up to the target at once, start the clock in the past.
        page.eval_on_selector("#scrub", "el => { el.value = String(Math.floor(Number(el.max) * 0.6)); el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(4000)
        ok(page.inner_text("#clock") != paused, f"scrubbing seeks ({paused} → {page.inner_text('#clock')})")
        ok(errors == [], f"and it does all that without a JavaScript error ({errors})")
        ok(warnings == [], f"every model and character loaded — nothing failed to parse ({warnings[:2]})")

        print("\nis the replay TRUE?")
        # The question that matters. Play the whole match through at speed and
        # ask the game what the watched runner scored. If the studio dropped or
        # invented a single input, the number will not be the one the server
        # recorded — and a replay that disagrees with the record is worse than
        # no replay, because it would be quoted as evidence.
        expected = next((s["score"] for s in seeded["standings"] if s["uid"] == seeded["watch"]["uid"]), None)
        ok(expected is not None and expected > 0, f"the server recorded a real score for the watched runner ({expected})")

        page.eval_on_selector("#scrub", "el => { el.value = '0'; el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(3000)
        page.click("[data-speed='8']")
        page.click("#play")
        # 2 minutes of match at 8x, plus room for a slow box.
        page.wait_for_function(
            "() => { const c = document.getElementById('clock'); return c && c.textContent.split('/')[0].trim() === c.textContent.split('/')[1].trim(); }",
            timeout=120000,
        )
        page.wait_for_timeout(1500)
        shown = page.inner_text(".tl-score-n").replace(",", "").strip()
        ok(
            shown.isdigit() and int(shown) == expected,
            f"the game scores the watched runner exactly as the server did ({shown} vs {expected})",
        )

        print("\nand can a viewer change it?")
        # Arrow keys are the studio's own seek shortcuts. In live play they are
        # also how a Trackline player changes lane and jumps — so if the game
        # were still listening, simply scrubbing with the keyboard would author
        # inputs nobody ever made and rewrite the evidence.
        page.eval_on_selector("#scrub", "el => { el.value = '0'; el.dispatchEvent(new Event('input')); }")
        page.wait_for_function("() => document.getElementById('clock')?.textContent.startsWith('0:00')", timeout=60000)
        page.wait_for_timeout(1500)
        for _ in range(15):
            page.keyboard.press("ArrowLeft")
            page.keyboard.press("ArrowUp")
            page.keyboard.press("ArrowDown")
        page.mouse.click(700, 400)
        page.wait_for_timeout(500)
        page.click("[data-speed='8']")
        page.click("#play")
        page.wait_for_function(
            "() => { const c = document.getElementById('clock'); return c && c.textContent.split('/')[0].trim() === c.textContent.split('/')[1].trim(); }",
            timeout=120000,
        )
        page.wait_for_timeout(1500)
        after = page.inner_text(".tl-score-n").replace(",", "").strip()
        ok(
            after.isdigit() and int(after) == expected,
            f"a viewer hammering the keyboard changes nothing — the replay is read-only ({after} vs {expected})",
        )

        print("\nsigning out")
        page.click("#out")
        page.wait_for_selector("#google-btn", timeout=15000)
        ok(page.locator(".rail").count() == 0, "the console is gone")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".box h1", timeout=15000)
        ok(page.locator("#screen").count() == 0, "and a reload does NOT bring it back — the session really ended")

        browser.close()
finally:
    node("cleanup", session["email"])
    node("clean", seeded["matchKey"], script=SEED_REPLAY)

print("\nCONSOLE PROVEN" if fails == 0 else f"\n{fails} CHECK(S) FAILED")
sys.exit(0 if fails == 0 else 1)
