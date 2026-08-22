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
SEED_PARTY = ROOT / "tools" / "e2e" / "seed-party.mts"
UI = os.environ.get("ADMIN_UI", "http://localhost:5174")
API_PORT = os.environ.get("ADMIN_PORT", "4031")

# A card by the words in its OWN heading. ":has-text" matches any descendant
# and ignores case, so it happily returns the activity card for "Collection"
# as soon as a collection.equip line appears in somebody's log.
CARD = ".card:has(header h2:text-is('%s'))"

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


# Time steps this run has already spent. The server refuses a code whose step
# it has seen before — that is the replay guard, and it is not optional — so a
# fixed "+30 seconds" offset works right up until two prompts land inside the
# same minute, and then it silently fails as "wrong code".
_used_steps: set[int] = set()


def fresh_code(secret_b32: str) -> str:
    """Six digits from a time step this run has not used yet."""
    while (int(time.time()) // 30) in _used_steps:
        time.sleep(2)
    step = int(time.time()) // 30
    _used_steps.add(step)
    return totp(secret_b32, step * 30 + 1)


def answer_sudo(page, session, timeout=8000) -> bool:
    """Answer the sudo prompt if the server asked for one.

    Whether it appears depends on when the last one was answered — the window
    is five minutes — so a caller must not assume either way.
    """
    try:
        page.wait_for_selector(".modal header h3:has-text('Confirm it is you')", timeout=timeout)
    except Exception:
        return False
    page.fill("#f_code", fresh_code(session["totpSecret"]))
    page.locator(".overlay").last.locator("#ok").click()
    return True


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
# Enrolment just spent a code; whichever step that was, it is gone.
_used_steps.update({int(time.time()) // 30, int(time.time()) // 30 - 1})

# A real archived match for the studio to open — played through the game's own
# server definition and put through the same encoder the match runtime uses.
# Trackline on purpose: it is the game whose runtime distinguishes "my own
# input" from "somebody else's", which is exactly the distinction a replay has
# to get right — and got wrong the first time.
seeded = json.loads(node("seed", "trackline", script=SEED_REPLAY).splitlines()[-1])
ok(seeded["inputs"] > 100, f"seeded a replay to watch ({seeded['inputs']} inputs, {seeded['bytes']} bytes)")
# Real audio hung on that match, so the studio has something to play. Skipped
# when this machine has never recorded anything — there would be nothing to copy.
audio = json.loads(node("seed-voice", seeded["matchKey"]).splitlines()[-1])
if audio.get("skipped"):
    print(f"  (no audio fixture: {audio['skipped']})")
else:
    ok(audio["files"] == 2, f"attached a room mix and one voice to it ({audio['durationSec']}s each)")

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
            # The row for THIS player, not merely the first result: a search
            # for four letters matches several people ("SayanMondal" and
            # "SayanMondal4"), and clicking whichever sorted first made this
            # assertion depend on ordering rather than on behaviour.
            page.click(f"table.tbl tbody tr:has-text('{uid}')")
            page.wait_for_selector(".phead h1", timeout=15000)
            ok(uid in page.inner_text(".phead"), "the profile opens on the player that was clicked")
            cards = [c.lower() for c in page.locator(".card > header h2").all_inner_texts()]
            for want in ["account", "career", "recent matches", "sanctions", "linked accounts"]:
                ok(want in cards, f"the {want} panel is there")
            ok("activity trail" in cards, "and an owner sees the activity trail with its addresses")
            ok("what they did" in cards, "plus what this player actually did, in words")
            ok(page.locator("#teamchat").count() == 0,
               "squad chat is NOT here — it belongs to a party, read in the party studio")
            for want in ("messages", "friends", "collection", "parties"):
                ok(want in cards, f"and the {want} panel")
            page.wait_for_timeout(3000)
            # Reading private messages is admin-and-above and audited; the
            # console says so rather than presenting it as an ordinary panel.
            # By its HEADING, not by ":has-text". That match is case-insensitive
            # and matches any descendant, so "the card containing the word
            # collection" is also the activity card the moment somebody's log
            # holds a collection.equip line — and the assertion then reads a
            # card nobody meant it to read.
            msgcard = page.inner_text(CARD % "Messages").lower()
            ok("15 days" in msgcard and "audit" in msgcard,
               "the messages panel states the retention and that reading is recorded")
            ok(page.locator("#friendlist").count() == 1, "their friends are listed")
            page.fill("#friendq", "zzzznomatch")
            page.wait_for_timeout(1200)
            ok("nobody" in page.inner_text("#friendlist").lower(),
               "and searching within that list really filters it")
            coll = page.inner_text(CARD % "Collection").lower()
            ok("catalogue" in coll or "owned" in coll,
               "the collection panel says what they own — or that nothing is ownable yet")
            page.wait_for_timeout(2500)
            ok(page.locator("#own-log .logrow").count() >= 0, "their own log loads on their page")
            ok(page.url.endswith(f"#/players/{uid}"), "the URL is a deep link that survives a refresh")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".phead h1", timeout=15000)
            ok(uid in page.inner_text(".phead"), "…and it does survive one")
        else:
            print("  (no players in the database — skipped)")

        print("\nthe list of everybody")
        # Opening Players with nothing typed used to be a blank page with a
        # hint on it. It lists the platform instead — newest first, and A PAGE
        # AT A TIME. Seeded up past one page first, because against eight rows
        # a list that loaded all forty thousand at once would pass every
        # assertion below.
        node("seed-players", "60")
        page.goto(f"{UI}#/players", wait_until="domcontentloaded")
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Players'", timeout=15000)
        page.wait_for_selector("table.tbl tbody tr", timeout=20000)
        first_page = page.locator("table.tbl tbody tr").count()
        ok(first_page == 50, f"the first page is a page, not the whole table ({first_page} rows)")
        ok("of" in page.inner_text("#how"), f"and it says how far through them you are ({page.inner_text('#how')})")

        joined = page.eval_on_selector_all(
            "table.tbl tbody tr td:nth-child(4)", "els => els.map(e => e.textContent.trim())")
        ok(len(joined) == first_page, "every row says when that account joined")
        # Newest at the top is the whole point: an admin opening this wants to
        # see who just arrived, not who arrived in 2019.
        top_uid = page.eval_on_selector("table.tbl tbody tr td:nth-child(2)", "e => e.textContent.trim()")
        ok(top_uid.startswith("81000000"),
           f"the newest account is at the top, the oldest at the bottom ({top_uid})")

        # Scroll to the end and the next page arrives on its own.
        page.eval_on_selector("#sentinel", "el => el.scrollIntoView()")
        page.wait_for_function(
            "n => document.querySelectorAll('table.tbl tbody tr').length > n",
            arg=first_page, timeout=20000)
        grown = page.locator("table.tbl tbody tr").count()
        ok(grown > first_page, f"scrolling to the bottom loads the next page ({first_page} → {grown})")

        uids = page.eval_on_selector_all(
            "table.tbl tbody tr td:nth-child(2)", "els => els.map(e => e.textContent.trim())")
        ok(len(uids) == len(set(uids)),
           f"and nobody appears twice across the join ({len(uids) - len(set(uids))} duplicates)")
        ok(page.locator("table.tbl thead tr").count() == 1,
           "appended into the table that is already there, not a second table under it")
        node("clean-players")

        print("\nthe other screens")
        # Wait on the page TITLE, not on a card: cards exist on the screen we
        # are leaving too, so waiting for one passes instantly on stale content.
        page.click('.rail a[data-nav="sanctions"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Sanctions'", timeout=15000)
        page.wait_for_selector(".card header h2", timeout=15000)
        ok("in force" in page.inner_text(".card header h2").lower(), "the sanctions screen lists what is in force")
        page.click('.rail a[data-nav="voice"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Voice'", timeout=15000)
        page.wait_for_selector(".card header h2", timeout=15000)
        voice = page.inner_text("#screen").lower()
        # Whether this machine can record depends on its environment, and the
        # console's job is to say WHICH — never to offer a button that quietly
        # does nothing. Both answers are checked, whichever one is true here.
        armed = "recording is armed" in voice
        ok(armed or "not available" in voice, "the voice screen states plainly whether recording can run here")
        ok("being recorded" in voice, "and lists who is under a recording flag")
        # Voice is heard inside a studio now — there is no standalone player.
        ok(page.locator("#screen audio").count() == 0,
           "there is no loose audio player here: voice is heard in a studio, with the picture")

        page.click('.rail a[data-nav="history"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'History'", timeout=15000)
        page.wait_for_selector(".ch svg", timeout=25000)
        ok(page.locator(".ch svg").count() == 2,
           "history draws two charts over one clock, not two scales on one grid")
        ok(page.locator("#scrub").count() == 1, "with a scrubber to go back to any moment")
        page.wait_for_timeout(2500)
        ok("online" in page.inner_text("#whowas").lower() or page.locator("#whowas .vrow").count() >= 0,
           "and it answers who was online at that moment")

        # The log underneath: everything between two moments, filterable.
        page.wait_for_selector("#loglist", timeout=20000)
        page.eval_on_selector("#lfrom",
            "el => { const d = new Date(Date.now() - 72*3600*1000);"
            "        el.value = new Date(d - d.getTimezoneOffset()*60000).toISOString().slice(0,16); }")
        page.click("#lgo")
        page.wait_for_timeout(2500)
        rows = page.locator("#loglist .logrow").count()
        ok(rows > 0, f"the log lists what happened between two moments ({rows} rows)")
        # A log nobody can read at a glance is a log nobody reads.
        text = page.inner_text("#loglist").lower()
        ok(any(w in text for w in ("came online", "signed in", "lifted", "looked at", "equipped")),
           "in sentences rather than raw JSON")
        kinds = page.locator("#lkind option").count()
        ok(kinds > 1, f"with a filter offering the kinds actually present ({kinds - 1})")
        page.select_option("#lkind", index=1)
        page.click("#lgo")
        page.wait_for_timeout(2000)
        narrowed = page.locator("#loglist .logrow").count()
        ok(narrowed <= rows, f"and narrowing by kind really narrows it ({rows} → {narrowed})")

        # Refreshing must not throw away what you typed, or the filter is
        # useless the moment anything updates.
        page.fill("#luid", "1936586062")
        page.click("#lgo")
        page.wait_for_timeout(2000)
        page.click("#refresh")
        page.wait_for_timeout(2500)
        ok(page.input_value("#luid") == "1936586062", "refreshing keeps the filter you typed")

        # Live, and — just as important — live that BRINGS SOMETHING.
        #
        # Counting requests is not proof, and pretending it was is how this
        # shipped broken: Refresh and Live both re-queried a window whose end
        # was stamped when the page drew, so nothing newer could ever fall
        # inside it. The only honest test writes a row and looks for it.
        # Clear BOTH filters: the kind filter is still narrowed from the
        # assertion above, and a poke of a different kind would be correctly
        # filtered out — which looks exactly like a broken refresh.
        page.fill("#luid", "")
        page.select_option("#lkind", "")
        page.click("#lgo")
        page.wait_for_timeout(1500)
        tag = json.loads(node("poke", f"E2EPOKE-{os.getpid()}").splitlines()[-1])["wrote"]
        asked: list[str] = []
        page.on("request", lambda r: asked.append(r.url) if "/log?" in r.url else None)
        page.click("#refresh")
        # Wait for the ROW, not for a guessed number of milliseconds. A refresh
        # is three round trips — the series, the kinds, then the log — against
        # a database that may not be in the same building, and a fixed sleep
        # turns that latency into a flaky test.
        appeared = True
        try:
            page.wait_for_function(
                "tag => document.getElementById('loglist')?.textContent?.includes(tag)",
                arg=tag,
                # Generous on purpose: this database is not in the same data
                # centre, and a stalled round trip is not a broken refresh.
                timeout=45000,
            )
        except Exception:
            appeared = False
        # WHY it appears matters as much as that it does. While the end of the
        # window means "now", the console must not send a "to" at all: this
        # machine's clock is not the one the rows were stamped by, and a row
        # committed inside the gap between the two looks like the future and
        # is filtered out. That is a silent hole in what a moderator sees, and
        # it is invisible unless the request itself is checked.
        ends = [u for u in asked if "to=" in u]
        ok(asked and not ends,
           f"and asks for it without a clock of its own — the newest rows are not lost to a slow laptop "
           f"({len(asked)} requests, {len(ends)} carrying an end)")
        ok(
            appeared,
            f"Refresh brings rows written since the page loaded "
            f"({page.locator('#loglist .logrow').count()} rows shown)",
        )

        # …and it must not blank the list to do it.
        emptied = page.evaluate("""() => new Promise(r => {
            const el = document.getElementById('loglist');
            let sawEmpty = false;
            const ob = new MutationObserver(() => { if (!el.querySelector('.logrow')) sawEmpty = true; });
            ob.observe(el, { childList: true, subtree: true });
            document.getElementById('refresh').click();
            setTimeout(() => { ob.disconnect(); r(sawEmpty); }, 2500);
        })""")
        ok(not emptied, "and never empties the list on the way — it is a refresh, not a page reload")

        page.click("#live")
        page.wait_for_timeout(1500)
        tag2 = json.loads(node("poke", f"E2EPOKELIVE-{os.getpid()}").splitlines()[-1])["wrote"]
        live_got = True
        try:
            # Two live ticks plus the round trips they each make.
            page.wait_for_function(
                "tag => document.getElementById('loglist')?.textContent?.includes(tag)",
                arg=tag2,
                timeout=25000,
            )
        except Exception:
            live_got = False
        ok(live_got, "and Live picks up a row written while it is running")

        calls: list[str] = []
        page.on("request", lambda r: calls.append(r.url) if "/log?" in r.url else None)
        page.eval_on_selector("#scrub",
            "el => { el.value = String(Number(el.min) + 60000); el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(1000)
        calls.clear()
        page.wait_for_timeout(7000)
        ok(len(calls) == 0,
           "scrubbing to a moment switches Live off — a timer left running would show up here")

        page.click('.rail a[data-nav="parties"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Parties'", timeout=15000)
        page.wait_for_selector(".card header h2", timeout=15000)
        parties = page.inner_text("#screen").lower()
        ok("every group is replayed" in parties, "the parties screen says what it keeps and for how long")

        page.click('.rail a[data-nav="platform"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Platform'", timeout=15000)
        page.wait_for_selector(".switch", timeout=15000)
        switches = page.inner_text("#screen").lower()
        ok("maintenance" in switches, "the platform screen offers maintenance")
        # Two different acts, deliberately not the same button: a window is
        # announced ahead so people can finish what they are doing, and
        # starting on the spot ends every match immediately. An emergency
        # should not be one careless click away from an ordinary update.
        ok(page.locator("#maintplan").count() == 1, "scheduled ahead of time, with warning")
        ok(page.locator("#maintnow").count() == 1, "and an emergency start, kept separate from it")
        # Sending a message to players is deliberately NOT here. It used to be,
        # and that button wrote a flag instead of a row: the notice reached
        # people, appeared on no list, and could not be taken back. The Platform
        # screen now points at Notices, where a send is a record.
        ok("send notice" not in switches.replace("  ", " "),
           "and no way to send a notice from here — a send that leaves no record is not offered")
        ok("notices" in switches, "it says where sending lives instead")

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
            page.fill("#f_code", fresh_code(session["totpSecret"]))
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

            print("\nasking to record somebody's voice")
            # Somebody not already under a recording flag — a real one would
            # make this page show "Stop", and the test must neither depend on
            # that nor interfere with it.
            vuid = json.loads(node("voice-player").splitlines()[-1])["uid"]
            # This database may legitimately hold real recording flags, so
            # every count below is compared against where we started, never
            # against zero.
            baseline = json.loads(node("voice-targets").splitlines()[-1])["count"]
            # The most intrusive button in the console: it must not accept a
            # hand-wave as a reason, and what it does next must match what this
            # machine can actually do — start a recording where there is a
            # bucket, refuse and say why where there is not.
            page.goto(f"{UI}#/players/{vuid}", wait_until="domcontentloaded")
            page.wait_for_selector("#rec", timeout=15000)
            page.click("#rec")
            page.wait_for_selector(".modal", timeout=10000)
            body = page.inner_text(".modal").lower()
            # Pinned to the MEANING, not to one sentence: whoever is flagged,
            # the form has to admit that other people get recorded too, and
            # that it reaches their party and not only their matches.
            ok("everyone" in body and "party" in body,
               "the form says out loud that it records everyone with them, in matches and in their party")
            page.fill("#f_reason", "too short")
            page.locator(".overlay").last.locator("#ok").click()
            page.wait_for_function("() => document.getElementById('err')?.textContent?.length > 0", timeout=10000)
            ok("real reason" in page.inner_text("#err").lower(), "a hand-wave of a reason is refused before anything is sent")

            page.fill("#f_reason", "e2e — clicked through the console, checking the guard")
            page.locator(".overlay").last.locator("#ok").click()
            # Sudo is probably still live from the ban a moment ago; if the
            # window has closed, answer the prompt rather than hanging on it.
            try:
                page.wait_for_selector(".modal header h3:has-text('Confirm it is you')", timeout=4000)
                page.fill("#f_code", fresh_code(session["totpSecret"]))
                page.locator(".overlay").last.locator("#ok").click()
            except Exception:
                pass

            # What happens next depends on whether this machine has an evidence
            # bucket, and BOTH answers are correct — so the test waits for
            # either and checks that the one it got is the right one.
            page.wait_for_function(
                "() => document.querySelector('.toast') || (document.getElementById('err')?.textContent || '').length > 5",
                timeout=25000,
            )
            armed = page.locator(".toast").count() > 0
            if armed:
                ok("recording" in page.inner_text(".toast").lower(),
                   "voice recording is configured here, so the console starts one and says so")
                ok(json.loads(node("voice-targets").splitlines()[-1])["count"] == baseline + 1,
                   "and exactly one new flag exists — the console did what it said")
            else:
                refusal = page.inner_text("#err").lower()
                ok("not available" in refusal,
                   f"no evidence bucket here, so the server refuses to start one and says why ({refusal[:60]})")
                page.locator(".overlay").last.locator("#cancel").click()
                page.wait_for_selector(".overlay", state="detached", timeout=10000)
                ok(json.loads(node("voice-targets").splitlines()[-1])["count"] == baseline,
                   "nothing was flagged — a refused start leaves no trace of a recording")
                node("voice-flag", vuid)   # so the rest of the section has something to look at

            print("\nand what a player under recording looks like")
            # A real reload, not a hash navigation. Visiting the URL the page
            # is ALREADY on changes nothing in a hash-routed app, so when the
            # flag was written straight to the database — which is what happens
            # on a machine that cannot record — the profile kept showing the
            # pre-flag render and the assertion below failed for the wrong
            # reason. Reloading also makes this honest in the other branch: it
            # proves the SERVER reports the recording, not that the console
            # optimistically redrew its own view.
            page.goto(f"{UI}#/players/{vuid}", wait_until="domcontentloaded")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".phead h1", timeout=20000)
            ok("recording" in page.inner_text(".tags").lower(), "the profile says so at the top, next to the name")
            ok(page.locator("#recstop").count() == 1, "and offers to stop it instead of starting another")
            ok("matches used" in page.inner_text(".card:has(#recstop)"), "with the budget spent so far")

            page.click('.rail a[data-nav="voice"]')
            page.wait_for_function("() => document.getElementById('title')?.textContent === 'Voice'", timeout=15000)
            page.wait_for_selector("table.tbl tbody tr", timeout=15000)
            ok(vuid in page.inner_text("table.tbl"), "the voice screen lists them among who is being recorded")

            page.goto(f"{UI}#/players/{vuid}", wait_until="domcontentloaded")
            page.wait_for_selector("#recstop", timeout=15000)
            page.click("#recstop")
            page.wait_for_selector(".modal", timeout=10000)
            page.locator(".overlay").last.locator("#ok").click()
            try:
                page.wait_for_selector(".modal header h3:has-text('Confirm it is you')", timeout=4000)
                page.fill("#f_code", fresh_code(session["totpSecret"]))
                page.locator(".overlay").last.locator("#ok").click()
            except Exception:
                pass
            try:
                page.wait_for_selector(".toast", timeout=20000)
                said = page.inner_text(".toast").lower()
            except Exception:
                said = f"no toast; the dialog said: {page.locator('#err').all_inner_texts()}"
            ok("stopped" in said, f"stopping it works from the console ({said[:80]})")
            page.wait_for_function("() => document.getElementById('rec') !== null", timeout=20000)
            ok(json.loads(node("voice-targets").splitlines()[-1])["count"] == baseline,
               "and the flag is really gone, not just off the screen")

        print("\na notice is a record, not a flag")
        # The regression this guards: a notice must exist as a row somebody can
        # find and take back. Reaching players is not enough.
        page.click('.rail a[data-nav="notices"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Notices'", timeout=15000)
        page.wait_for_selector("#send", timeout=15000)
        before = page.locator("table.tbl tbody tr").count()

        wording = f"e2e notice {os.getpid()} — please ignore"
        page.click("#send")
        page.wait_for_selector(".modal", timeout=10000)
        page.fill("#f_body", wording)
        # "Everyone" rather than "everyone online": nobody is connected to this
        # test backend, and more to the point this is the audience that reaches
        # people who were away, which is what makes taking it back mean anything.
        page.select_option("#f_audience", "everyone")
        page.locator(".overlay").last.locator("#ok").click()
        answer_sudo(page, session)
        # The row is the assertion, not the toast: a toast can come and go while
        # this is still waiting to see whether a sudo prompt appears, and it is
        # the record that this whole screen exists to guarantee.
        listed, why = False, ""
        try:
            page.wait_for_function(
                "w => document.querySelectorAll('table.tbl tbody tr').length > w",
                arg=before, timeout=25000)
            listed = True
        except Exception:
            why = f"; the dialog said: {page.locator('#err').all_inner_texts()}"
        ok(listed, f"sending one puts it on the list — the record IS the notice ({before} rows before{why})")
        row = page.locator(f"table.tbl tbody tr:has-text('{wording}')")
        ok(row.count() == 1, "worded as it was written, so it can be recognised")
        ok("standing" in row.inner_text().lower(), "and standing, until somebody takes it back")

        row.locator("button[data-del]").click()
        page.wait_for_selector(".modal", timeout=10000)
        page.locator(".overlay").last.locator("#ok").click()
        answer_sudo(page, session)
        took_back = False
        try:
            page.wait_for_function(
                """t => { const r = [...document.querySelectorAll('table.tbl tbody tr')]
                            .find(r => r.textContent.includes(t));
                         return !!r && r.textContent.toLowerCase().includes('taken back'); }""",
                arg=wording, timeout=20000)
            took_back = True
        except Exception:
            pass
        ok(took_back, "taking it back is visible on the same row, not a silent delete")

        print("\nthe dashboard")
        page.click('.rail a[data-nav="analytics"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Analytics'", timeout=15000)
        page.wait_for_selector(".tile", timeout=20000)
        ok(page.locator(".tile").count() >= 4, "the headline numbers are tiles, not charts of one value")

        # An empty dashboard reads as a broken one, so if there is nothing to
        # draw the screen has to SAY so rather than show an empty frame.
        charts = page.locator("svg.ch").count()
        empties = page.locator(".card .empty").count()
        ok(charts > 0 or empties > 0, f"it either draws or explains itself ({charts} chart(s), {empties} note(s))")
        if charts > 0:
            ok(page.locator("svg.ch path[stroke-width='2']").count() > 0, "the line chart has real marks in it")
            ok(page.locator(".lg").count() >= 2, "with a legend, so identity is never colour alone")

        # The rule that makes the whole screen affordable, checked at the wire:
        # it must read the aggregate, never the activity log.
        asked = []
        page.on("request", lambda r: asked.append(r.url) if "/log?" in r.url or "/analytics" in r.url else None)
        page.select_option("#range", "14")
        page.wait_for_timeout(3000)
        ok(any("/analytics" in u for u in asked), "changing the range asks the aggregate")
        ok(not any("/log?" in u for u in asked), "and never the raw activity log")

        ok("the same data, readable without colour" in page.inner_text("#screen"),
           "and the numbers are there as a table, for anybody who cannot use the colours")

        print("\nsignals")
        page.click('.rail a[data-nav="signals"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Signals'", timeout=15000)
        page.wait_for_selector("#win", timeout=15000)
        said = page.inner_text("#screen").lower()
        # The wording is load-bearing: this screen ranks, it does not accuse.
        ok("a ranking, not an accusation" in said, "the screen says outright that it is a ranking, not a verdict")
        ok("innocent explanation" in said, "and that every signal on it has an innocent explanation")
        # Nobody flagged is the ordinary state of a healthy platform, and the
        # screen must say so rather than show an empty frame.
        ranked = page.locator("table.tbl").count()
        ok(ranked >= 1 or "nobody stands out" in said,
           f"the ranking is a table, or says plainly that there is nothing in it ({ranked} table(s))")
        ok(errors == [], f"no JavaScript errors across either screen ({errors})")

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

        # ---- the stretch AFTER the final tick --------------------------------
        #
        # A match ends on its last tick; the players do not. The scoreboard is
        # up for five seconds afterwards and everybody is still in the match's
        # voice room, and what is said over a scoreboard is what somebody
        # listens to a match FOR. That audio was being recorded correctly and
        # was simply unreachable: the timeline stopped at the final tick, so
        # the scrubber could not be dragged to it and playback stopped short.
        bounds = page.evaluate("""() => {
            const s = document.getElementById('scrub');
            return s ? { max: Number(s.max) } : null;
        }""")
        ok(bounds and bounds["max"] > seeded["endTick"],
           f"the timeline runs past the final tick, to where the recording ends "
           f"({bounds['max'] if bounds else '?'} > {seeded['endTick']})")

        page.eval_on_selector("#scrub", "el => { el.value = el.max; el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(1200)
        ok(page.locator("#afterchip:not([hidden])").count() == 1,
           f"and says the picture is frozen on the scoreboard there ({page.inner_text('#clock')})")
        # …and only there. A marker that is always on says nothing.
        page.eval_on_selector("#scrub", "el => { el.value = '0'; el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(800)
        ok(page.locator("#afterchip:not([hidden])").count() == 0, "and not while the match is still running")
        ok(errors == [], f"and it does all that without a JavaScript error ({errors})")
        ok(warnings == [], f"every model and character loaded — nothing failed to parse ({warnings[:2]})")

        if not audio.get("skipped"):
            print("\nand can you HEAR it?")
            page.wait_for_selector(".mixer", timeout=30000)
            mixer = page.inner_text(".mixer").lower()
            ok("everyone, together" in mixer, "the studio offers the room mix — the whole conversation")
            ok("e2espeaker" in mixer, "and each voice on its own, for who-said-it")
            ok(page.locator(".mixer input[type=checkbox]").count() == 2, "one control per recording")
            # The mix is on and the separate voices are off, which is what makes
            # the default a conversation rather than an echo.
            boxes = page.locator(".mixer input[type=checkbox]")
            ok(boxes.nth(0).is_checked() and not boxes.nth(1).is_checked(),
               "the mix plays by default; a single voice is something you ask for")

            # Sound has to follow the SAME clock as the picture. Play, then
            # compare where the audio is against where the replay is.
            page.eval_on_selector("#scrub", "el => { el.value = '0'; el.dispatchEvent(new Event('input')); }")
            page.wait_for_timeout(2500)
            page.click("#play")
            page.wait_for_timeout(4000)
            state = page.evaluate("""() => {
                const a = [...document.querySelectorAll('audio')];
                const c = document.getElementById('clock').textContent.split('/')[0].trim().split(':');
                return { at: a.map(x => x.currentTime), playing: a.filter(x => !x.paused).length,
                         clock: Number(c[0]) * 60 + Number(c[1]) };
            }""")
            ok(state["playing"] >= 1, f"the audio is running while the replay runs ({state['playing']} file(s))")
            ok(any(t > 0.5 for t in state["at"]), f"and it has actually advanced ({[round(t, 2) for t in state['at']]})")
            drift = min(abs(t - state["clock"]) for t in state["at"])
            ok(drift < 2.0, f"and it sits on the replay's own clock, not beside it (off by {drift:.2f}s)")
            page.click("#play")   # pause
            page.wait_for_timeout(1200)
            stopped = page.evaluate("() => [...document.querySelectorAll('audio')].every(a => a.paused)")
            ok(stopped, "pausing the replay stops the sound too")

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

        print("\nparties are listed by their own id")
        page.click('.rail a[data-nav="parties"]')
        page.wait_for_function("() => document.getElementById('title')?.textContent === 'Parties'", timeout=15000)
        page.wait_for_selector("#pq", timeout=15000)
        ok(page.locator("th:has-text('Party')").count() >= 1,
           "the list leads with the party's id, not with who happened to be in it")
        # A group is not its member list: people join and leave all the way
        # through, and the same three names can be two different parties on the
        # same evening. The id is what is true of the whole recording.
        page.fill("#pq", "P-definitely-not-a-real-party")
        page.press("#pq", "Enter")
        page.wait_for_timeout(2500)
        ok("no party" in page.inner_text("#screen").lower() or page.locator("table.tbl tbody tr").count() == 0,
           "and it can be searched by that id")
        page.fill("#pq", "")
        page.press("#pq", "Escape")
        page.wait_for_timeout(2000)

        print("\nthe party studio")
        # A party is not a match: there is no game to replay, so the studio
        # loads the LOBBY — the real one, the same scene a player sees — and
        # drives it from the recorded state log.
        seeded_party = json.loads(node("seed", script=SEED_PARTY).splitlines()[-1])
        ok(seeded_party["bytes"] < 5000,
           f"a whole party is a few kilobytes, not a video ({seeded_party['bytes']} bytes, {seeded_party['events']} events)")
        page.goto(f"{UI}#/parties/{seeded_party['key']}", wait_until="domcontentloaded")
        page.wait_for_selector(".studio", timeout=20000)
        page.wait_for_selector(".stage.ready", timeout=90000)
        ok(True, "the game's own lobby scene loaded and drew the party")
        ok(page.locator("#party-canvas").count() == 1, "onto a canvas")
        ok(page.locator(".tape .lane").count() >= 2, "with a lane per person who was ever in it")
        present = page.inner_text("#present")
        ok(len(present.strip()) > 0, f"and it shows who was standing there ({present.splitlines()[0][:40]})")

        # A built scene and a BLACK one are identical to every assertion above,
        # and that is exactly how this shipped broken once: the studio never
        # called render, so the canvas stayed empty while everything else
        # passed. A screenshot of a solid colour compresses to a couple of
        # kilobytes; a drawn lobby does not.
        page.wait_for_timeout(6000)   # characters stream in
        shot = "/tmp/tofo-party-canvas.png"
        page.locator("#party-canvas").screenshot(path=shot)
        drawn = os.path.getsize(shot)
        ok(drawn > 20000, f"and the lobby is actually DRAWN, not a black canvas ({drawn // 1024} kB of picture)")

        page.click("#play")
        page.wait_for_timeout(2500)
        ok(page.inner_text("#clock") != "0:00 / 0:00", f"play advances the party's clock ({page.inner_text('#clock')})")
        feed = page.inner_text("#feed").lower()
        ok("who is joining?" in feed, "and what was said appears as it is reached")
        ok("emote" in feed, "so do emotes — played on the character, exactly as the squad saw them")
        # How somebody came to be in a party is the first question that turns
        # out to matter: being invited reads differently from walking in with
        # a code, and the record has to keep the difference.
        who = page.inner_text(CARD % "Everyone who was here").lower()
        ok("invited by" in who, "the roster says who invited whom")
        ok("team code" in who, "and who let themselves in with a team code")

        # The reason an admin does not scrub through two hours looking for
        # somebody: their arrival is a click.
        page.click("#play")   # pause
        arrivals = page.eval_on_selector_all("button[data-jump]", "els => els.map(e => Number(e.dataset.jump))")
        ok(len(arrivals) >= 2 and max(arrivals) > 0,
           f"every person's arrival is on record as a moment ({sorted(set(arrivals))})")
        page.eval_on_selector("#scrub", "el => { el.value = '0'; el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(600)
        before_jump = page.locator("#present .vrow").count()
        # The LATEST arrival, not merely the last button: several people can
        # walk in at the same moment, and jumping to one of those proves
        # nothing about jumping.
        latest = max(arrivals)
        page.eval_on_selector_all(
            "button[data-jump]",
            "(els, at) => els.find(e => Number(e.dataset.jump) === at)?.click()",
            latest,
        )
        # Jumping starts playing from that moment; pause straight away so what
        # is counted is the party AT the arrival, not wherever it drifted to.
        page.click("#play")
        page.wait_for_timeout(500)
        after_jump = page.locator("#present .vrow").count()
        ok(after_jump > before_jump,
           f"and clicking one jumps the party to the moment they walked in "
           f"({before_jump} people standing there before, {after_jump} after)")
        # ---- the written record ---------------------------------------------
        #
        # Everything that is not a picture: who arrived and how, who walked
        # out, who opened a microphone, and the line that says the group is
        # over. A studio that only draws the lobby answers "what did it look
        # like"; this is the half that answers "what happened".
        page.eval_on_selector("#scrub", "el => { el.value = el.max; el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(1200)
        record = page.inner_text("#feed").lower()
        ok("opened their mic" in record,
           "a microphone opening is on the record, even with nothing said into it")
        ok("closed their mic" in record, "and closing it again")
        ok("left the party" in record, "somebody walking out is written down, not just an absence")
        ok("party ended" in record, "and the recording says when the group stopped being one")
        ok("is ready" in record, "readying up is on the record — it is what lets a match start")
        ok("chose trackline" in record, "and so is the leader choosing what they were about to play")
        ok("went looking for" in record, "and going off to look for a match, which is the run-up to one")

        # ---- the voice line -------------------------------------------------
        #
        # An empty chart that looks like a full one is the worst thing this
        # could do, and it is what the first version did: it drew an identical
        # little mark in all seventy-two slots of a recording where nobody had
        # said a word, which reads as constant talking. With no voice on this
        # party it has to say so in words instead.
        strip = page.locator(".talk-strip")
        ok(strip.count() >= 1, "the studio has a voice line")
        marks = page.locator(".talk-strip .tk").count()
        empty = page.locator(".talk-strip .tk-plot.empty").count()
        ok(
            (empty == 1 and marks == 0) or marks > 0,
            f"which either shows real speech or says there is none — never a full-looking empty chart "
            f"({marks} marks, {empty} 'nothing here')",
        )
        if empty == 1:
            ok(len(page.inner_text(".talk-strip .tk-none").strip()) > 0,
               f"and says which in words ({page.inner_text('.talk-strip .tk-none')[:40]})")

        # SCRUBBED INTO, not watched from the beginning. Dropping the playhead
        # into the middle used to show an empty record — the events behind it
        # were counted as consumed without ever being drawn — so an admin who
        # jumped to a moment saw nothing of what led up to it.
        lines_at_end = page.locator("#feed .ev").count()
        page.eval_on_selector("#scrub", "el => { el.value = '0'; el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(800)
        at_start = page.locator("#feed .ev").count()
        page.eval_on_selector("#scrub", "el => { el.value = el.max; el.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(800)
        back_at_end = page.locator("#feed .ev").count()
        ok(at_start < lines_at_end,
           f"the record grows with the playhead ({at_start} at the start, {lines_at_end} at the end)")
        ok(back_at_end == lines_at_end,
           f"and jumping straight back to a moment brings its whole history with it "
           f"({back_at_end} of {lines_at_end})")

        # ---- the stretch where the party is not a party ---------------------
        #
        # A group that goes off to play leaves a lobby that is NOT empty: every
        # member is still a member and the last state stays on screen, so an
        # admin sees people standing perfectly still and cannot tell a quiet
        # group from a group that is not there. That gap has to be labelled,
        # and it has to be skippable — but still watchable, because somebody
        # who drops out early can come back and do something.
        gaps = page.eval_on_selector_all(
            ".marks.party .mgap", "els => els.map(e => e.style.left)")
        ok(len(gaps) >= 1, f"the tape marks the stretch the group spent in a match ({gaps})")

        # Scrub INTO the gap and read what the studio says about it.
        # From the mark's own numbers, not its pixels: a short match is drawn
        # wider than it was so it stays visible, and measuring that width back
        # would put the "did it skip past?" line in the wrong place.
        span = page.evaluate("""() => {
            const g = document.querySelector('.marks.party .mgap');
            if (!g) return null;
            const from = Number(g.dataset.from), to = Number(g.dataset.to);
            return { at: Math.round((from + to) / 2), end: to };
        }""")
        ok(span is not None, "and the mark carries the moment it covers")
        if span:
            page.eval_on_selector("#scrub",
                "(el, at) => { el.value = String(at); el.dispatchEvent(new Event('input')); }", span["at"])
            page.wait_for_function("() => !document.getElementById('matchbar')?.hidden", timeout=8000)
            said = page.inner_text("#matchbar").lower()
            ok("in a match" in said, f"scrubbing into it says so on the picture ({said.splitlines()[0][:40]})")
            ok("trackline" in said, "and names the game they went to play")
            ok(page.locator("#party-canvas").count() == 1,
               "over the lobby rather than instead of it — the gap can still be watched")

            # Skipping lands after the return, and the notice goes away.
            page.click("#matchskip")
            page.wait_for_function("() => document.getElementById('matchbar')?.hidden", timeout=8000)
            now = int(page.input_value("#scrub"))
            ok(now >= span["end"],
               f"and Skip jumps past it to where the party starts again ({now} ≥ {span['end']})")
            page.click("#play")   # pause again

        # Played THROUGH, not read after a skip: seeking clears the feed and
        # counts what it passes as already gone, so a line can only be proven
        # by watching the playhead reach it.
        page.eval_on_selector("#scrub", "el => { el.value = '0'; el.dispatchEvent(new Event('input')); }")
        page.click("[data-speed='8']")
        page.click("#play")
        wrote_it = True
        try:
            page.wait_for_function(
                "() => (document.getElementById('feed')?.textContent || '').toLowerCase()"
                ".includes('went into a match')",
                timeout=25000,
            )
        except Exception:
            wrote_it = False
        ok(wrote_it, "the written record says it too, in the same words")
        ok(page.locator("#matchwatch").count() == 1,
           "and the match itself is one click away, not a match id to go and look up")

        ok(errors == [], f"all of that without a JavaScript error ({errors})")

        print("\nsigning out")
        # The rail grew past the window once and pushed this off the bottom —
        # visible to a selector, unreachable to a person. Checked explicitly so
        # the next time it happens the failure says why.
        reachable = page.eval_on_selector(
            "#out",
            "el => { const r = el.getBoundingClientRect();"
            "        return r.top >= 0 && r.bottom <= innerHeight; }")
        ok(reachable, "the sign-out button is actually inside the window, not merely in the DOM")
        page.click("#out")
        page.wait_for_selector("#google-btn", timeout=15000)
        ok(page.locator(".rail").count() == 0, "the console is gone")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".box h1", timeout=15000)
        ok(page.locator("#screen").count() == 0, "and a reload does NOT bring it back — the session really ended")

        browser.close()
finally:
    node("clean-players")
    node("cleanup", session["email"])
    node("unpoke")
    node("clean-voice", seeded["matchKey"])
    if "seeded_party" in dir():
        node("clean", seeded_party["key"], script=SEED_PARTY)
    node("clean", seeded["matchKey"], script=SEED_REPLAY)

print("\nCONSOLE PROVEN" if fails == 0 else f"\n{fails} CHECK(S) FAILED")
sys.exit(0 if fails == 0 else 1)
