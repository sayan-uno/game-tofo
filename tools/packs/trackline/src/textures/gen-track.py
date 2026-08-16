#!/usr/bin/env python3
"""Generates textures/track.webp — the M1 grey-box track, top-down.

1024x1024 px == 14.8 m x 14.8 m (see GROUND_W in the game's world.ts):
3 m shoulder, four 2.2 m lanes with standard-gauge rails and sleepers, 3 m
shoulder. Tiles vertically (24 sleepers per tile). Deterministic noise.
Run from anywhere: python3 gen-track.py
"""
import os, random
from PIL import Image, ImageDraw, ImageFilter

random.seed(7)
SIZE = 1024
METRES = 14.8
PX = SIZE / METRES
LANES, LANE_W, SHOULDER = 4, 2.2, 3.0

img = Image.new("RGB", (SIZE, SIZE), (40, 40, 44))
px = img.load()
# asphalt noise
for y in range(SIZE):
    for x in range(SIZE):
        n = random.randint(-9, 9)
        px[x, y] = (40 + n, 40 + n, 44 + n)
d = ImageDraw.Draw(img)

def m2px(m):
    return m * PX

# track bed (ballast) between the shoulders
bed_x0, bed_x1 = m2px(SHOULDER), m2px(SHOULDER + LANES * LANE_W)
for y in range(SIZE):
    for x in range(int(bed_x0), int(bed_x1)):
        n = random.randint(-14, 14)
        px[x, y] = (66 + n, 63 + n, 60 + n)
img = img.filter(ImageFilter.GaussianBlur(0.6))
d = ImageDraw.Draw(img)

# kerbs
for kx in (bed_x0, bed_x1):
    d.rectangle([kx - 3, 0, kx + 3, SIZE], fill=(96, 96, 98))
    d.rectangle([kx - 1, 0, kx + 1, SIZE], fill=(120, 120, 122))

# sleepers, tiling: 24 per texture height
N_SLEEPERS = 24
spacing = SIZE / N_SLEEPERS
sleeper_w = m2px(2.0)
sleeper_h = m2px(0.24)
for i in range(LANES):
    cx = m2px(SHOULDER + LANE_W * (i + 0.5))
    for s in range(N_SLEEPERS):
        cy = (s + 0.5) * spacing
        c = 58 + random.randint(-8, 8)
        d.rectangle([cx - sleeper_w / 2, cy - sleeper_h / 2, cx + sleeper_w / 2, cy + sleeper_h / 2],
                    fill=(c, int(c * 0.82), int(c * 0.68)))
        d.line([cx - sleeper_w / 2, cy - sleeper_h / 2, cx + sleeper_w / 2, cy - sleeper_h / 2], fill=(c + 18, int(c * 0.9), int(c * 0.75)))

# rails: standard gauge 1.435 m → ±0.7175 m from lane centre
gauge = m2px(0.7175)
rail_w = max(3, m2px(0.07))
for i in range(LANES):
    cx = m2px(SHOULDER + LANE_W * (i + 0.5))
    for sx in (-1, 1):
        rx = cx + sx * gauge
        d.rectangle([rx - rail_w / 2 - 1, 0, rx + rail_w / 2 + 1, SIZE], fill=(52, 50, 50))   # shadow
        d.rectangle([rx - rail_w / 2, 0, rx + rail_w / 2, SIZE], fill=(150, 152, 158))       # rail head
        d.rectangle([rx - 0.5, 0, rx + 0.5, SIZE], fill=(214, 216, 222))                     # polished centre

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "track.webp")
img.save(out, "WEBP", quality=80, method=6)
print(out, os.path.getsize(out), "bytes")
