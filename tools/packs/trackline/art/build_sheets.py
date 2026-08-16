#!/usr/bin/env python3
"""Turn the generated art sheets into pack textures."""
import os
from PIL import Image, ImageEnhance, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/workspaces/game-tofo/tools/packs/trackline/src/textures"

# ---- façade -------------------------------------------------------------
# Straight elevation, tiled horizontally along the street. Darkened a little:
# it is lit by the sky and the lamps, not by daylight, and the emissive pass in
# world.ts brings the lit windows back up on its own.
f = Image.open(os.path.join(HERE, "facade_raw.webp")).convert("RGB")
f = f.resize((1024, 1024), Image.LANCZOS)
f = ImageEnhance.Brightness(f).enhance(0.62)
f = ImageEnhance.Color(f).enhance(0.9)
f.save(f"{OUT}/facade.webp", "WEBP", quality=86, method=6)
print("facade.webp", os.path.getsize(f"{OUT}/facade.webp"))

# ---- carriage side ------------------------------------------------------
# The generated sheet is on transparency; crop to the carriage and lay it on a
# dark ground so it can be used as a plain (opaque) side texture.
t = Image.open(os.path.join(HERE, "train_raw.webp")).convert("RGBA")
bbox = t.getbbox()
alpha = t.split()[3]
bbox = alpha.getbbox() or bbox
t = t.crop(bbox)
bg = Image.new("RGBA", t.size, (16, 17, 20, 255))
t = Image.alpha_composite(bg, t).convert("RGB")
t = t.resize((1024, 512), Image.LANCZOS)
t = ImageEnhance.Brightness(t).enhance(0.8)
t.save(f"{OUT}/train.webp", "WEBP", quality=88, method=6)
print("train.webp", os.path.getsize(f"{OUT}/train.webp"), t.size)

# ---- barriers -----------------------------------------------------------
# The two obstacle skins. Kept dark-ish for the same reason as the façade: the
# scene lights them, and the plastic's reflective stripes do the rest.
for name, out_name, size, bright in (
    ("barrier_raw.webp", "barrier.webp", (1024, 512), 0.9),
    ("beam_raw.webp", "beam.webp", (1024, 512), 0.85),
):
    b = Image.open(os.path.join(HERE, name)).convert("RGB").resize(size, Image.LANCZOS)
    b = ImageEnhance.Brightness(b).enhance(bright)
    b.save(f"{OUT}/{out_name}", "WEBP", quality=88, method=6)
    print(out_name, os.path.getsize(f"{OUT}/{out_name}"))

# ---- pavement -----------------------------------------------------------
# The strip between the kerb and the buildings. Before this it was a flat
# untextured plane, and under the scene's warm lamps a flat plane reads as bare
# orange dirt — it was the single most unreal thing left in frame. Tiled small
# (a slab is about a metre), so it needs to be genuinely seamless: the
# generator gets close, and a wrapped cross-fade on each edge closes what is
# left without smearing the pattern.
p = Image.open(os.path.join(HERE, "pavement_raw.webp")).convert("RGB").resize((1024, 1024), Image.LANCZOS)


def seamless(im, band=48):
    """Cross-fade each edge with the opposite one so the tile wraps."""
    w, h = im.size
    px = im.load()
    for i in range(band):
        a = (i + 1) / (band + 1) * 0.5  # 0 at the inside edge, 0.5 at the border
        for x in range(w):
            l = px[x, i]
            r = px[x, h - 1 - i]
            px[x, i] = tuple(round(l[c] * (1 - a) + r[c] * a) for c in range(3))
            px[x, h - 1 - i] = tuple(round(r[c] * (1 - a) + l[c] * a) for c in range(3))
        for y in range(h):
            t = px[i, y]
            b = px[w - 1 - i, y]
            px[i, y] = tuple(round(t[c] * (1 - a) + b[c] * a) for c in range(3))
            px[w - 1 - i, y] = tuple(round(b[c] * (1 - a) + t[c] * a) for c in range(3))
    return im


p = seamless(p)
p = ImageEnhance.Brightness(p).enhance(0.78)
p = ImageEnhance.Color(p).enhance(0.72)  # night: stone goes grey, not brown
p.save(f"{OUT}/pavement.webp", "WEBP", quality=86, method=6)
print("pavement.webp", os.path.getsize(f"{OUT}/pavement.webp"))

# ---- full-height blocker (construction hoarding) ------------------------
# The 2.4 m wall you must go around. It used to borrow the road-barrier skin,
# and a plastic road barrier scaled to two and a half metres is the single
# least believable object a street can contain — it is also the most prominent
# thing in frame, because it is the obstacle. A site hoarding is a real object
# at that size.
hd = Image.open(os.path.join(HERE, "hoarding_raw.webp")).convert("RGB")
hd = hd.crop((14, 14, hd.width - 14, hd.height - 14))  # trim the generator's black edge
hd = hd.resize((512, 768), Image.LANCZOS)
hd = ImageEnhance.Brightness(hd).enhance(0.86)
hd.save(f"{OUT}/hoarding.webp", "WEBP", quality=88, method=6)
print("hoarding.webp", os.path.getsize(f"{OUT}/hoarding.webp"))
