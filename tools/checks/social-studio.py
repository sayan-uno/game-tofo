#!/usr/bin/env python3
"""Watch a recorded island back in the console's replay studio.

Social Space has no inputs — positions ride their own channel and are relayed
and forgotten — so on the face of it there is nothing to archive and nothing to
play. What it archives instead is a TRACK: everybody's position a couple of
times a second, written as ordinary {tick, kind} inputs, precisely so the
studio can play it with no change to the studio at all.

This is the check that says so out loud, because the claim is exactly the kind
that types cannot make: the file decodes, the studio opens it, the island draws
and the tape advances.

    # the console API and UI must be running (npm run dev:admin), then:
    python3 tools/checks/social-studio.py [matchKey]

With no key it takes the most recent archived island. Screenshots go to
tools/checks/.out/social-studio/.
"""
import json
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TSX = os.path.join(ROOT, "backend", "node_modules", ".bin", "tsx")
PROVISION = os.path.join(ROOT, "tools", "e2e", "admin-provision.mts")
UI = os.environ.get("ADMIN_UI", "http://localhost:5174")
API_PORT = os.environ.get("ADMIN_PORT", "4031")
OUT = os.path.join(HERE, ".out", "social-studio")
GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]

fails = 0


def ok(cond, msg):
    global fails
    print(("  ok  " if cond else "  FAIL ") + msg, flush=True)
    if not cond:
        fails += 1


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def latest_island_key() -> str:
    """The most recent archived island, straight out of Postgres."""
    script = """
import { config } from "dotenv";
config({ path: "./.env" });
const pg = (await import("pg")).default;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows } = await db.query(
  "select match_key from match_replays where game_id = 'social' order by created_at desc limit 1"
);
console.log(rows[0]?.match_key ?? "");
await db.end();
"""
    path = os.path.join(ROOT, "backend", "tmp-latest-island.mjs")
    with open(path, "w") as f:
        f.write(script)
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True,
                             cwd=os.path.join(ROOT, "backend"))
        return out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
    finally:
        os.remove(path)


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    key = sys.argv[1] if len(sys.argv) > 1 else latest_island_key()
    if not key:
        print("no archived island to watch — run `npm run e2e:social` first")
        return 2
    log(f"watching {key}")

    prov = subprocess.run([TSX, PROVISION, "provision"], capture_output=True, text=True,
                          cwd=ROOT, env={**os.environ, "ADMIN_PORT": API_PORT})
    if prov.returncode != 0:
        print(prov.stdout, prov.stderr, file=sys.stderr)
        return 2
    session = json.loads(prov.stdout.strip().splitlines()[-1])

    with sync_playwright() as p:
        browser = p.chromium.launch(args=GL)
        context = browser.new_context(viewport={"width": 1280, "height": 760})
        errors: list[str] = []
        page = context.new_page()
        page.set_default_timeout(120000)
        page.on("pageerror", lambda e: errors.append(str(e)[:220]))
        # The console fetches the pack from the CDN through its own dev-server
        # proxy, so nothing needs intercepting here.
        context.add_cookies([{
            "name": session["cookieName"],
            "value": session["cookieValue"],
            "domain": "localhost",
            "path": session["cookiePath"],
            "httpOnly": True,
            "sameSite": "Lax",
        }])
        page.goto(f"{UI}/#/matches/{key}", wait_until="domcontentloaded")
        page.wait_for_selector(".rail", timeout=60000)
        log("signed in")

        print("\nThe studio opens an island")
        page.wait_for_selector(".tape", timeout=120000)
        ok(True, "the tape drew")
        # The roster is one row per OCCUPANCY — a person who left and came back
        # is two, which is the whole reason the format needed arrival ticks.
        rows = page.locator(".tape .lane").count()
        ok(rows > 1, f"with a lane per occupancy ({rows})")
        page.wait_for_timeout(4000)
        page.screenshot(path=os.path.join(OUT, "01-open.png"))

        print("\nAnd plays it")
        page.click("#play", force=True)
        page.wait_for_timeout(20000)
        state = page.evaluate("() => ({ text: document.querySelector('#clock')?.textContent ?? '' })")
        ok(bool(state["text"]), f"the clock is running ({state['text']})")
        page.screenshot(path=os.path.join(OUT, "02-playing.png"))
        page.wait_for_timeout(25000)
        page.screenshot(path=os.path.join(OUT, "03-later.png"))
        ok(errors == [], f"no JavaScript errors while it played ({errors[:2]})")
        context.close()
        browser.close()
    log(f"screenshots in {OUT}")
    return 0 if fails == 0 else 1


code = main()
print("\nALL CHECKS PASSED" if fails == 0 and code == 0 else f"\n{fails} CHECK(S) FAILED")
sys.exit(code)
