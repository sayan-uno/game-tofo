# Trackline art sources

The `*_raw.webp` files are the generated source images (Meshy, gpt-image-2).
They are kept because the sheets below are derived from them and would
otherwise be unreproducible — a generator returns a different picture every
time, so a lost source means this street can never be tweaked again, only
replaced:

    build_ground.py   street_raw + ground_raw  →  ../src/textures/track.webp
    build_sheets.py   facade_raw, train_raw    →  ../src/textures/facade.webp, train.webp
                      barrier_raw, beam_raw    →  ../src/textures/barrier.webp, beam.webp
                      pavement_raw             →  ../src/textures/pavement.webp
                      hoarding_raw             →  ../src/textures/hoarding.webp

They are NOT in git (see ../README.md) — they are archived on R2 instead:

    npm run pack:restore trackline           # fetch them onto a fresh clone
    npm run pack:sources trackline -- --go   # push a new or changed one back up

The second one is manual. Add a raw image without running it and that image
exists on exactly one disk.

Run either from anywhere; they write straight into the pack source. Rebuild the
pack afterwards (`npm run pack:build trackline`) — the pack version is
a content hash, so new textures become a new immutable CDN folder.

Why the ground is a composite rather than one generated image: the generated
street art puts its rails wherever it likes, and the game's rails must sit
exactly on the lane centres or what you see is not where you run. So the rails
are sampled out of the railed image as a strip and stamped at the true
positions over the rail-free base.
