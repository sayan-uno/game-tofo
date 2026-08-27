#!/usr/bin/env python3
"""Turn the generated ground art into textures that actually TILE.

A generated image is a picture, not a texture: lay four of them side by side
and every join is a visible seam, and the island's grass is one image repeated
about a hundred and forty times.

The fix is the classic offset-and-blend, and it is worth stating because it is
not obvious that it is exact:

    b = a rolled by half its width and half its height

`b`'s four edges are `a`'s middle, so `b` tiles perfectly — but it now has a
cross-shaped seam down its own centre, where `a`'s edges met. `a` has no seam
there. So the output takes `b` everywhere except near that cross, where it
fades to `a`:

    out = composite(a, b, mask)      mask = 1 on the cross, 0 at the edges

The edges of `out` are therefore `b`'s edges (mask is 0 there), which tile; and
the cross is `a`'s continuous middle, so there is nothing to see. No healing,
no mirroring, no symmetry.

    python3 tools/packs/social/art/build_ground.py

Writes ../src/textures/*.webp. Rebuild the pack afterwards — the pack version
is a content hash, so new textures become a new immutable CDN folder.
"""
import os
from PIL import Image, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "src", "textures"))
os.makedirs(OUT, exist_ok=True)

SIZE = 1024
# Half-width of the fully-`a` band, and where the blend has reached all `b`.
BAND = 0.03
FEATHER = 0.24


def smoothstep(t):
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return t * t * (3 - 2 * t)


def cross_mask(n, small=256):
    """1 on the centre cross, 0 at the edges. Built small and scaled up — the
    ramp is smooth, so nothing is lost and it is a hundred times faster than
    filling a million pixels from Python."""
    px = []
    for y in range(small):
        fy = smoothstep(1 - (abs(y / small - 0.5) - BAND) / FEATHER)
        for x in range(small):
            fx = smoothstep(1 - (abs(x / small - 0.5) - BAND) / FEATHER)
            px.append(int(255 * max(fx, fy)))
    m = Image.new("L", (small, small))
    m.putdata(px)
    return m.resize((n, n), Image.BICUBIC)


MASK = cross_mask(SIZE)


def tileable(src, dst, brightness=1.0, contrast=1.0):
    a = Image.open(os.path.join(HERE, src)).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    if brightness != 1.0:
        a = ImageEnhance.Brightness(a).enhance(brightness)
    if contrast != 1.0:
        a = ImageEnhance.Contrast(a).enhance(contrast)
    # Roll by half in both axes.
    b = Image.new("RGB", (SIZE, SIZE))
    h = SIZE // 2
    b.paste(a.crop((h, h, SIZE, SIZE)), (0, 0))
    b.paste(a.crop((0, h, h, SIZE)), (h, 0))
    b.paste(a.crop((h, 0, SIZE, h)), (0, h))
    b.paste(a.crop((0, 0, h, h)), (h, h))
    out = Image.composite(a, b, MASK)
    path = os.path.join(OUT, dst)
    out.save(path, "WEBP", quality=82, method=5)
    print(f"{dst}: {SIZE}x{SIZE}  {os.path.getsize(path) / 1024:.0f} KB")


# Generated art is lit for a hero shot and arrives a stop or so too contrasty
# for something a scene is going to light again.
tileable("grass_raw.png", "grass.webp", brightness=1.04, contrast=0.9)
tileable("plaza_raw.png", "paving.webp", brightness=1.02, contrast=0.88)
tileable("sand_raw.png", "sand.webp", brightness=1.0, contrast=0.9)
