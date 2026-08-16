#!/usr/bin/env python3
"""Composite the track texture: a Meshy wet-street base with real rails placed
at OUR lane positions.

The generated street art is beautiful but its rails are wherever the model felt
like putting them, and the game's rails have to sit exactly where the lanes are
or what you see is not where you run. So the rails come from a second Meshy
image, sampled as a strip and stamped at the true positions.
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance
import random

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 2048
METRES = 14.8              # must equal GROUND_W in world.ts
PX = SIZE / METRES
LANES, LANE_W, SHOULDER = 4, 2.2, 3.0
GAUGE = 0.7175             # half of standard gauge, metres
random.seed(11)

def m2px(m): return m * PX

base = Image.open(os.path.join(HERE, "street_raw.webp")).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)

# --- find a rail in the railed image and cut a strip out of it ---
railsrc = Image.open(os.path.join(HERE, "ground_raw.webp")).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
gray = railsrc.convert("L")
cols = [sum(gray.getpixel((x, y)) for y in range(0, SIZE, 8)) for x in range(SIZE)]
# a rail is a narrow bright ridge: score each column against its neighbourhood
best, bestscore = None, -1
for x in range(40, SIZE - 40):
    local = sum(cols[x - 30:x - 10] + cols[x + 10:x + 30]) / 40
    score = cols[x] - local
    if score > bestscore:
        bestscore, best = score, x
print(f"rail found at x={best} (contrast {bestscore/ (SIZE/8):.1f})")
RAIL_W = max(8, int(m2px(0.075)))
strip = railsrc.crop((best - 14, 0, best + 14, SIZE)).resize((RAIL_W, SIZE), Image.LANCZOS)
strip = ImageEnhance.Brightness(strip).enhance(1.12)

# sleeper look, sampled from the railed image between its rails
sleep_src = railsrc.crop((best + 40, 0, best + 40 + int(m2px(2.0)), int(m2px(0.26))))

out = base.copy()
d = ImageDraw.Draw(out, "RGBA")

# --- track bed: darken the running surface a little so the shoulders read ---
bed0, bed1 = m2px(SHOULDER), m2px(SHOULDER + LANES * LANE_W)
d.rectangle([bed0, 0, bed1, SIZE], fill=(0, 0, 0, 40))

# --- sleepers, then rails, per lane ---
SLEEPER_GAP = 0.62
n_sleepers = int(METRES / SLEEPER_GAP)
for i in range(LANES):
    cx = m2px(SHOULDER + LANE_W * (i + 0.5))
    for s in range(n_sleepers):
        cy = (s + 0.5) * (SIZE / n_sleepers)
        w, h = int(m2px(2.0)), int(m2px(0.26))
        tile = sleep_src.resize((w, h), Image.LANCZOS)
        tile = ImageEnhance.Brightness(tile).enhance(0.72 + random.random() * 0.25)
        out.paste(tile, (int(cx - w / 2), int(cy - h / 2)))
        d.rectangle([cx - w / 2, cy + h / 2 - 2, cx + w / 2, cy + h / 2 + 3], fill=(0, 0, 0, 90))
    for sx in (-1, 1):
        rx = int(cx + sx * m2px(GAUGE) - RAIL_W / 2)
        d.rectangle([rx - 2, 0, rx + RAIL_W + 2, SIZE], fill=(0, 0, 0, 110))   # rail shadow
        out.paste(strip, (rx, 0))

# --- kerbs at the edge of the bed ---
for kx in (bed0, bed1):
    d.rectangle([kx - 4, 0, kx + 4, SIZE], fill=(150, 146, 138, 70))
    d.rectangle([kx - 1, 0, kx + 1, SIZE], fill=(190, 186, 176, 90))

# --- a wash of warm lamp light down both shoulders, as if from the street
#     lights the scene actually has, plus their reflection on the wet road ---
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for side, x in ((-1, m2px(SHOULDER) * 0.45), (1, SIZE - m2px(SHOULDER) * 0.45)):
    for s in range(6):
        cy = (s + 0.5) * SIZE / 6 + random.random() * 60
        for r, a in ((260, 26), (150, 34), (70, 46)):
            gd.ellipse([x - r * 0.7, cy - r, x + r * 0.7, cy + r], fill=(255, 168, 74, a))
        # the streak a wet road throws back
        gd.ellipse([x - 26, cy - 420, x + 26, cy + 420], fill=(255, 150, 60, 16))
glow = glow.filter(ImageFilter.GaussianBlur(38))
out = Image.alpha_composite(out.convert("RGBA"), glow).convert("RGB")

out = out.filter(ImageFilter.SMOOTH)
dest = os.path.join(os.path.dirname(HERE), "..", "..", "..", "..", "..")
target = "/workspaces/game-tofo/tools/packs/trackline/src/textures/track.webp"
out.save(target, "WEBP", quality=88, method=6)
print(target, os.path.getsize(target), "bytes")
