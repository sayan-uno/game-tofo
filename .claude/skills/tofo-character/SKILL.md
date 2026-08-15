---
name: tofo-character
description: Create, process, verify and publish a TOFO player character, weapon or emote end to end — generate it in Meshy, run it through the asset pipeline, prove it works, upload it to Cloudflare R2, and add it to the game catalog. Use whenever the user asks for a new character, weapon/held prop, or emote/animation, or wants an existing one reprocessed, re-uploaded, or added to Collections.
---

# TOFO character pipeline

Turns "make me a new character" into a live, equippable character. Six stages,
in order. **Do not skip stages 3 or 4** — both exist because a character that
passed the obvious checks shipped anyway and had to be withdrawn.

Tools live in `.claude/skills/tofo-character/tools/`. Run `npm install` there
once. Credentials come from `backend/.env` (gitignored): `MESHY_API_KEY`,
`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
**Use them by reference, never print them.**

---

## 1. Generate in Meshy

Prefer the `meshy` MCP server (configured in `.mcp.json`). Relevant tools:
`meshy_text_to_3d`, `meshy_image_to_3d`, `meshy_rig`, `meshy_animate`,
`meshy_download_model`, `meshy_get_task_status`, `meshy_check_balance`.

If MCP isn't connected, the REST API works the same way:

```bash
curl -sS -H "Authorization: Bearer $MESHY_API_KEY" https://api.meshy.ai/openapi/v1/balance
```

Base URL is `https://api.meshy.ai/openapi/v1`. Generations cost credits — check
the balance first and tell the user what a run will cost before burning it.

**The model must be RIGGED before download.** An unrigged mesh fails stage 3
immediately.

## 2. Download the GLB

Anywhere outside the repo is fine — these are 70–270 MB. Never commit one.

## 3. Build (this is where the gates are)

```bash
cd .claude/skills/tofo-character/tools
node build.mjs <input.glb> <characterId> "<Display Name>" [textureSize]
```

It hard-fails, before writing anything, on:

**Gate 1 — joint names.** All 24 canonical joints, exact names.

**Gate 2 — bind pose.** Every core torso joint within 25° of the canonical rig.
Matching joint *names* is not enough. Meshy binds the Hips ~120° off on roughly
half its rigs while every neighbouring joint lands within a few degrees, and
re-rigging the same mesh reproduces it. It looks fine standing still and tears
the moment a clip plays.

**Always run `realign.mjs` first — not only when Gate 2 fails:**

```bash
node realign.mjs <raw.glb> <conformed.glb>
node build.mjs <conformed.glb> <characterId> "<Display Name>"
```

Why any of this is needed: every clip carries translation, rotation *and* scale
channels on all 24 joints, and a glTF channel REPLACES a node's local transform
rather than composing with it. So a clip drives every character's skeleton to the
same pose in the same units, leaving the inverse bind as the only thing that can
differ. A character is correct exactly when its rest pose IS the pose the clips
drive it to.

**The one thing to understand before touching that tool:** a POSE difference and
an ORIENTATION difference need opposite treatments, and confusing them has now
caused two separate shipped bugs.

| difference | fix | shipped bug when done wrong |
|---|---|---|
| pose (arms 60° low) | move the mesh | "the hands always come out to the front" |
| bind orientation (Hips 120°) | absorb into the bind, move nothing | "the belly is broken" |

Rotating belly vertices by the Hips' 120° while the vertices beside them move 3°
tears the torso open — permanently, baked into the shipped mesh. So `realign.mjs`
absorbs orientation at the ROOT joint only (it has no limb to point along, and
Meshy varies its axis convention freely) and moves the mesh for everything else,
where orientation legitimately encodes limb direction. It then refuses if any
torso joint still needs >45° of mesh rotation. Read its output: `largest mesh
rotation` should be a wrist, never a torso joint.

The reference must be a **clip**, never the canonical character model. The two
express the same skeleton in different units (model: metres with a 0.01 root
scale; clips: centimetres with scale 1). Conforming to the model looks right at
rest, reports 0.000 mm agreement, and detonates on the first animated frame.

Fingers have no joints in the 24-joint rig, so splayed fingers stay splayed —
fix that at generation time.

It also handles automatically: Z-up → Y-up rotation when needed, dropping
Meshy's duplicate emissive map (which otherwise makes the character ignore all
scene lighting), `OPAQUE` + single-sided materials when the alpha channel is
unused, stripping baked clips, and extracting only clips **not** already on the
CDN.

**Texture budget:** dark characters get 2048, others 1024. A near-black
character carries its entire form in dark gradients, which is exactly what
lossy compression throws away — one shipped at 1024 and looked like mush.
Override with the 4th argument if a render says otherwise.

## 4. Verify — never skip

Two things, both required.

**Bind/joint report:**
```bash
node verify.mjs out/characters/<id>/v1/model.glb
```

**Render it.** A file that builds is not a file that looks right. Serve the
built GLB from `frontend/public/_t/`, drive `CharacterRig.create()` in a
headless browser, screenshot it, and *look*:

- Full body, front and side, in `idle`
- One strong pose (`dance-shake-it-off` around frame 45) — deformation shows
  under motion, not at rest
- Play all 9 shipped clips and confirm each returns true

Camera notes, learned the hard way: set `cam.minZ = 0.01` (the default 1.0
clips anything closer), don't reuse the lobby camera's radius/beta limits, and
don't aim at the origin — characters are not centred there. Render full-body at
high resolution and crop with PIL rather than fighting a close-up camera.

Delete `frontend/public/_t/` and any test HTML afterwards.

## 5. Upload

```bash
node upload.mjs          # dry run — shows what would go where
node upload.mjs --go     # actually upload
```

Sets `model/gltf-binary` and `public, max-age=31536000, immutable`.

**It refuses to overwrite an existing object, by design.** Paths are versioned
and cached for a year with no way to purge a player's device. Fixing a live
character means publishing `/v2/` and pointing the catalog at it — never
replacing `/v1/`.

Tell the user the exact destination path before uploading. Then **wait ~20s**
before the first fetch, and verify:

```bash
curl -sS -o /dev/null -w "%{http_code} %{size_download}\n" https://cdn.tofo.in/characters/<id>/v1/model.glb
```

Byte count must match the built file.

**Do not fetch a path the instant the upload returns.** R2 can take a few
seconds to serve a new object, and the CDN caches the 404 it gets in the
meantime — against a path that is now permanently immutable, with no purge
credential in this repo. The object is fine and `HeadObject` proves it, but
the URL is dead and the only fix is to publish a new version and point the
catalog there. This has already cost two characters a version number. If a
fresh path 404s while `HeadObject` finds the object, that is what happened;
a `?cb=` query string returning 200 confirms it.

## 6. Add to the game — only when the user asks

One line in `backend/src/services/catalog.ts`:

```ts
{ id: "<id>", kind: "character", name: "<Name>", key: "characters/<id>/v1/model.glb", rarity: "starter", free: true },
```

New emote:

```ts
{ id: "<slug>", kind: "emote", name: "<Label>", key: "animations/<slug>/v1/anim.glb",
  category: "emote", duration: <s>, loop: false, rootMotion: <bool>, free: true },
```

Nothing else changes anywhere — the Collections page reads the catalog. Then
add the new clip's Meshy source name to `ALREADY_SHIPPED` in `build.mjs`, or the
next character will ship a duplicate of it.

The backend must be restarted to pick up a catalog change.

---

## Weapons and other held props

A prop is not a character: no skeleton, no clips, no bind pose. It does NOT go
through `build.mjs` (both gates would fail on the missing skin). Use:

```bash
node buildProp.mjs <input.glb> <weaponId> "<Display Name>" [lengthMetres] [textureSize]
```

Generate it with the IMAGE route — `meshy_text_to_image` for a design sheet you
can actually look at for 3 credits, then `meshy_image_to_3d`. Ask for the
weapon alone, vertical, on a plain background. Budget ~33 credits: meshy-6
image-to-3d with remesh bills 30, not the 20 the tool's own table implies.

What replaces the rig gates is a CONTRACT with the hand, baked into the model
so the client needs no per-weapon offsets:

- pivot at the grip (where the fist closes), found from the mesh — the fattest
  slice is the crossguard, the thin run below it is the handle
- blade along +Y, and the tool flips the model if the tip came out at -Y
- sized in metres, so it matches the 1.8 m character holding it

The neon is the base colour texture used as its own emissive map — the albedo
is already flat saturated colour over near-black, so the guard stays matte
while the blade lights itself, at zero extra texture bytes.

Upload and catalog work the same way, under `weapons/<id>/v1/model.glb` and a
`WEAPONS` line in `catalog.ts`. `weapon.ts` on the client is where a prop meets
a hand, and its header explains the one thing that matters there — a POSED
skeleton shares the drawn mesh's space and a RESTING one is 100x off.

### The hand has to be closed first

Meshy generates an open, splayed hand ~21cm from wrist to fingertip (a fist is
~10cm), and the canonical rig has no finger joints — `RightHand` is a leaf — so
nothing can ever close it. A weapon hung off that hand passes straight through
a flat palm. This is the single most obvious flaw in a held weapon and it is
not fixable by moving the weapon.

```bash
node gripHand.mjs <in.glb> <out.glb> [radius_cm] [knuckle_cm] [twist_deg]
```

Every finger vertex is rigidly weighted to the one hand joint, so curling them
in the BIND POSE is indistinguishable from the hand having been modelled as a
fist: the fist then rides the hand through every clip, no animation changes,
and the joint list is still the canonical 24. Defaults scale to the hand's own
measured length, and the palm side is detected from the way relaxed fingers
already drift, so it needs no per-character tuning. Run `verify.mjs` after —
the bind report must be identical to the original.

**A fist's tunnel runs across the palm, perpendicular to the forearm.** That,
not the grip transform, is what decides where a held blade can point: with the
arm hanging at the character's side, a truly gripped weapon is stuck within
~30 degrees of horizontal. A vertical blade means the hand is not really
holding it. The `twist_deg` argument bakes forearm pronation to aim that
tunnel — the shipped characters use -45, which swings the blade from across
the chest to out past the hip. Keep it within about ±70 degrees.

**But the handle does not lie straight along that tunnel.** A real sword grip
runs DIAGONALLY across the palm — in between thumb and forefinger, out at the
heel of the hand — about 45 degrees off the knuckles. That diagonal is what
drops the blade from sticking out sideways into the lowered carry a swordsman
actually stands in, and it is the difference between "held" and "held well".
It lives in weapon.ts's grip rotation, costs nothing, and needs no re-bake.

The weapon's grip constants and the characters' baked hands are ONE unit.
Changing either means re-publishing every character together, which is why
they all moved to a new version at the same time.

### Authoring a stance the animation library doesn't have

```bash
node poseClip.mjs <source-anim.glb> <out.glb> <clipName> <offsets.json>
```

Derives a clip from an existing one by rotating named joints — an idle re-posed
into a weapon carry, say. `offsets.json` is `{"Joint": [pitch, yaw, roll]}` in
degrees, applied in each joint's own frame, so whatever motion the source had
(idle's breathing) still runs underneath the new pose. A weapon names its stance
via `WeaponItem.stance`, and the client swaps to it when the weapon is picked up.

Don't guess the angles. Load a reference beside the rig in the harness, apply
offsets live in an `onBeforeRenderObservable` (animations update BEFORE that, so
they stick), and solve numerically against something measurable — the reference
blade's direction, which principal-axis analysis of the most elongated connected
component gets off an unrigged mesh.

**Score the whole pose, not one direction.** A solver told only to match a blade
direction will wreck everything else to get it, and each failure ships looking
fine in a wide shot:

- *Wrist.* Aiming needs pronation and the solver takes it from the wrist. Score
  it as the angle between the hand's finger axis and the forearm's line —
  pronation doesn't appear in that, which is the point — and hold it near its
  resting value.
- *Body clearance.* Treat the blade as a segment from the grip and the limbs as
  segments between their joints — then remember a limb has RADIUS. An upper
  thigh is ~9cm, so 9cm from the axis is zero real gap. A stance shipped with
  2mm between blade and thigh because the gate compared against the axis alone;
  another shipped with the grip itself buried in the leg for the same reason.
  Require axis distance greater than limb radius plus weapon radius plus margin.
- *Palm.* The hand's local +Z is palmward. Its world Z says how far the palm has
  rolled backward — and its world X, how far it has turned to the side. Work the
  SIGN out once and write it down: with the character facing the camera the
  character's own right is world **-X**, so "palm faces right" is `-palm.x`
  near +1. Scoring the palm on the wrong axis, or the right axis with the wrong
  sign, is indistinguishable from a pose that is genuinely wrong.

  "Turn the hand to the right side" is ambiguous and cost a whole round trip:
  it usually means *put the hand out at the body's right*, which is a shoulder
  angle, not *point the palm rightward*, which is forearm twist — and those two
  readings want opposite twists. Say which one back in plain words, or render
  both, before baking a version.

**MEASURE the grip off the mesh; never derive it through a transform.** Every
hand vertex is rigidly weighted to one joint, so the centroid of the curled
finger mass is a constant you can read straight out of the GLB — that is the
grip point, and `_fist`-style analysis gets it in seconds. The alternative,
taking a pre-bake measurement and rotating it through the hand's baked twist,
shipped with the rotation's sense flipped (glTF is right-handed, Babylon is
not, and the twist axis crosses that boundary): X came out positive instead of
negative, the handle hovered 6cm off the side of the fist, and FOUR rounds of
stance tuning went into a fault that was never in the pose. If a hand looks
like it is not holding the weapon, check the grip constant before touching a
single joint angle.

**Solve the grip BACKWARDS from the pose you want.** The grip constant fixes the
angle between the blade and the palm, so choosing it first locks those two
together for good: every arm angle that aims the blade correctly then rolls the
palm to face outward, and every one with the palm right throws the blade tens
of degrees off. That reads as a stance problem and is not one — no amount of
arm tuning escapes a constant. Instead put the arm where it belongs (out at the
side, wrist at rest, palm turned as a hand really holds a hilt), then ask what
grip sends the blade where the art does: one inverse of the hand's world
matrix. Check the answer sits within ~35 degrees of the fist's tunnel so the
handle still reads as gripped, and stop there.

**Never assume which way a joint rotation moves a limb — print it.** A shoulder
roll that was assumed to swing the arm OUT swung it in and forward instead, so
several rounds of "hold it further from the body" each made it worse than doing
nothing: 7cm out and 11cm in front, where a plain hanging arm is 18cm out and
level. One line reporting the hand's offset from the hip in centimetres, before
and after, would have caught it immediately. Report positions, not just angles.

**Aiming a held weapon by rotating the arm is mostly a trap.** The arm carries
the hand, so every degree spent aiming the blade rolls the palm and swings the
blade toward the body. On this rig the plain idle already holds a weapon with a
natural palm and good clearance, so a weapon stance is better built from the
LEGS — feet apart reads as "armed" and costs nothing — with the arm left alone
unless a clearance check is being watched while it moves.

**Forearm TWIST is the one exception, and it is free.** Bending a joint moves
everything downstream of it; twisting the forearm about its own long axis moves
nothing, because the axis runs through the hand. Sweeping `RightForeArm` yaw
left the elbow, hand and wrist metrics identical to the last decimal and changed
only the palm — from 0.829 facing backward at 0, to 0.984 facing the body at
+60, to 0.985 facing outward at -120. Re-solve the grip from the twisted hand
and the blade lands on the same line as before, so the whole change costs one
constant. When the complaint is "the palm faces the wrong way" and everything
else already looks right, this is the knob — not the shoulder, which drags the
hand across the body with it.

A hand carrying a sword down at the side wants the palm turned IN, toward the
thigh. That is +60 here, and it costs something: the handle ends up 114 degrees
off the fist's tunnel rather than 41, because the tunnel twists with the hand
while the blade stays pinned to the reference line. Fixing that properly means
re-baking the fist's `twist_deg` for an inward carry, not re-posing the arm.

When a grip "looks detached", measure before re-posing: the weapon's pivot in
the hand's frame is rigid by construction, so if it reads the same across two
clips the geometry is fine and the problem is the hand's ORIENTATION.

Two traps, each of which cost a debugging cycle:

- **Freeze a clip with `speedRatio = 0`, never `pause()`.** A paused group stops
  writing joint rotations, so per-frame offsets compound into nonsense.
- **A meshopt clip stores rotations as NORMALIZED INT16.** `getArray()` hands
  back values like `-11522`; quaternion maths on those saturates every keyframe
  to a constant and the clip silently drives nothing. Use the accessor's
  `getElement`/`setElement`, which de- and re-normalise.

---

## Rules that came from things going wrong

- **The character id is baked into the URL.** Confirm it with the user *before*
  uploading; changing it afterwards means re-uploading.
- **Root-motion clips travel.** Anything over ~0.5u walks off the lobby
  pedestal. Fine in the collection preview and in a match; never as a lobby idle.
- **Never trust a bounding box on a skinned mesh.** With GPU skinning it
  describes bind-pose vertex data, not what is drawn. `CharacterRig` sizes
  characters from bone positions divided by the skeleton root's scale — the
  mesh box reads 100× off. Do not "fix" that division.
- **Don't ship a character you have not looked at**, however clean the numbers.
- **A verification harness must play a clip before it reads any joint.** In the
  rest pose the joints are a hundredth of the size of the character they belong
  to, so every position read off them is wrong by 100x — and wrong in a way
  that still renders, which is how it gets believed.
- Triangle counts: the live characters are ~10k. Over ~40k is fine for a lobby,
  heavy for a crowded match.
