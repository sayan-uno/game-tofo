#!/usr/bin/env python3
"""Does the recorder turn real audio into a real file?

    npm run check:recorder

check:voice proves the DECIDING — who is flagged, budgets, parties, leases. It
never touches audio. This proves the other half, the only way that means
anything: a real LiveKit room, real microphones publishing real Opus, and a
real recorder process. Nothing is mocked, because every bug this feature has
actually had lived in the gap between what an SDK implies and what the service
does — including one where the output file stayed at zero bytes for the whole
recording and nobody would have known until a crash lost somebody's evidence.

Needs LiveKit credentials, an evidence bucket, and Chromium. Without them it
says so and skips, rather than passing on nothing.
"""
import functools
import http.server
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TSX = ROOT / "backend" / "node_modules" / ".bin" / "tsx"
HELPER = ROOT / "tools" / "checks" / "recorder-helper.mts"
KEY = f"check-rec-{os.getpid()}"

fails = 0


def ok(cond, msg):
    global fails
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        fails += 1


def helper(*args):
    out = subprocess.run([str(TSX), str(HELPER), *args], capture_output=True, text=True, cwd=ROOT)
    if out.returncode != 0:
        print(out.stdout, out.stderr, file=sys.stderr)
        raise SystemExit(f"helper {args[0]} failed")
    return json.loads(out.stdout.strip().splitlines()[-1])


state = helper("ready", KEY)
if not state["ready"]:
    print(f"\nSKIPPED — this check needs {' and '.join(state['why'])}.")
    print("It is the one part that cannot be proved without them, and pretending")
    print("otherwise would be worse than saying so.")
    sys.exit(0)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("\nSKIPPED — Playwright is not installed (pip install playwright && playwright install chromium).")
    sys.exit(0)

# A page that joins a room and opens a fake microphone. Written next to the
# client bundle so the module import resolves without a server.
CLIENT = ROOT / "frontend" / "node_modules" / "livekit-client" / "dist" / "livekit-client.esm.mjs"
if not CLIENT.exists():
    print("\nSKIPPED — the LiveKit browser client is not installed (npm --prefix frontend install).")
    sys.exit(0)
PAGE = CLIENT.parent / "__rec_check.html"
PAGE.write_text(
    """<!doctype html><meta charset="utf-8"><title>joining</title>
<script type="module">
import { Room } from "./livekit-client.esm.mjs";
const q = new URLSearchParams(location.search);
const room = new Room();
try {
  await room.connect(q.get("url"), q.get("token"));
  await room.localParticipant.setMicrophoneEnabled(true);
  document.title = "live";
} catch (e) { document.title = "error:" + e.message; }
</script>"""
)

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# Served over localhost, not opened as a file: a file:// page is not a secure
# context, and Chromium refuses it a microphone — which looks exactly like the
# page hanging.
PORT = free_port()
httpd = http.server.ThreadingHTTPServer(
    ("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(CLIENT.parent))
)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

recorder = None
try:
    print("\n— a recorder, a room, and two microphones —")
    helper("setup", KEY)
    # Reuse a recorder that is already up rather than starting a rival: two of
    # them race for the session lease and only one wins, so which one does the
    # recording — and therefore what this check measures — would be luck.
    existing = helper("alive", KEY)
    if existing.get("alive"):
        ok(True, f"a recorder is already running ({existing['sessions']} session(s)) — using it")
        recorder = None
    else:
        recorder = subprocess.Popen(
            [str(TSX), str(ROOT / "backend" / "src" / "index.ts")],
            cwd=ROOT,
            env={**os.environ, "ROLE": "recorder", "RECORDER_FLUSH_SECONDS": "5"},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            preexec_fn=os.setsid,
        )
    started, deadline = recorder is None, time.time() + 90
    while recorder is not None and time.time() < deadline:
        line = recorder.stdout.readline()
        if not line:
            break
        if "Recorder starting" in line:
            started = True
            break
    if recorder is not None:
        ok(started, "the recorder process starts")
        if not started:
            raise SystemExit("recorder never started")
        # Drain the rest so the pipe never fills and blocks it.
        threading.Thread(target=lambda: [None for _ in recorder.stdout], daemon=True).start()

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        ctx = browser.new_context(permissions=["microphone"])

        def join(identity):
            tok = helper("token", KEY, identity)
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{PORT}/__rec_check.html?url={tok['url']}&token={tok['token']}")
            page.wait_for_function("() => document.title !== 'joining'", timeout=45000)
            if page.title().startswith("error"):
                raise SystemExit(f"{identity} could not publish: {page.title()}")
            return page

        join("rc1111111111")
        ok(True, "one microphone is publishing")
        time.sleep(6)
        join("rc2222222222")
        ok(True, "a second joins six seconds later")

        time.sleep(22)
        helper("stop", KEY)
        time.sleep(9)
        browser.close()

    print("\n— what it wrote —")
    rows = helper("inspect", KEY)
    mix = [r for r in rows if r["kind"] == "mix"]
    tracks = [r for r in rows if r["kind"] == "track"]
    ok(len(mix) == 1, f"one room mix — everyone together, which is how a conversation is followed ({len(mix)})")
    ok(len(tracks) == 2, f'one file per microphone, which is how "who said it" is answered ({len(tracks)})')
    ok(all(r["status"] == "complete" for r in rows),
       f"every file finished cleanly ({', '.join(r['status'] for r in rows)})")
    ok(all(int(r["bytes"] or 0) > 0 for r in rows), "and every one of them has bytes behind it")

    early = next((r for r in tracks if r["uid"] == "rc1111111111"), None)
    late = next((r for r in tracks if r["uid"] == "rc2222222222"), None)
    ok(early and late and late["offset"] - early["offset"] > 3000,
       f"the one who joined later starts later on the timeline "
       f"({early['offset'] if early else '?'}ms vs {late['offset'] if late else '?'}ms)")
    ok(all(r["segs"] > 0 for r in tracks),
       f"and the recorder wrote down WHEN they were talking ({', '.join(str(r['segs']) for r in tracks)} segments)")

    print("\n— is it audio, or just bytes? —")
    for r in rows:
        who = "the mix" if r["kind"] == "mix" else r["uid"]
        ok(r["ogg"] and r["codec"] == "opus" and r["seconds"] > 5,
           f"{who} is real Opus audio, {r['seconds']:.1f}s of it")
        ok(abs(r["seconds"] - (r["dur"] or 0)) <= 2,
           f"and the console's length matches the file ({r['dur']}s vs {r['seconds']:.1f}s)")
        ok(int(r["bytes"] or 0) == r["realBytes"],
           f"and its size matches the object in the bucket ({r['bytes']} vs {r['realBytes']})")
finally:
    try:
        helper("cleanup", KEY)
    except Exception as err:  # noqa: BLE001
        print("cleanup failed:", err, file=sys.stderr)
    httpd.shutdown()
    PAGE.unlink(missing_ok=True)
    if recorder:
        try:
            os.killpg(os.getpgid(recorder.pid), signal.SIGTERM)
            time.sleep(2)
            os.killpg(os.getpgid(recorder.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass

print("\nALL CHECKS PASSED" if fails == 0 else f"\n{fails} CHECK(S) FAILED")
sys.exit(0 if fails == 0 else 1)
