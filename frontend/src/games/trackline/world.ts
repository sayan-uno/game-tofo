// The world the track runs through: sky, street, façades, lamps, string lights.
//
// THE LOOK is blue hour — the moment after sunset when the sky is still deep
// blue but the street lights have taken over. That contrast is the whole
// image: cool blue above and in the shadows, warm sodium orange at every light
// source and on every wet surface. Nearly all of the atmosphere here comes
// from that one relationship, not from geometry, which is why the scene can
// stay cheap enough for a phone.
//
// EVERY piece is instanced and recycled in fixed-length slabs that leapfrog
// ahead of the runner, so a two-kilometre run allocates nothing after the
// first frame:
//
//   ground     ONE long quad that follows the runner, texture scrolled by
//              distance — no tiles, no seams, one draw call
//   façades    one textured card per side per slab
//   lamps      pole + glowing globe, alternating sides
//   strings    a catenary of small glowing beads across the street
//   sky        one dome with a painted gradient AND the distant landmark, so
//              the skyline needs no geometry and always sits on the horizon
import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { LANES, LANE_WIDTH } from "../../shared/games/trackline/rules";
import { modelSize, type TracklineModels } from "./models";

/** Metres of shoulder either side of the outer rails. */
const SHOULDER = 3;
/** Ground width; the pack texture is authored to cover exactly this. */
export const GROUND_W = LANES * LANE_WIDTH + 2 * SHOULDER; // 14.8 m
/** How far ahead of / behind the runner the ground reaches. */
const GROUND_AHEAD = 260;
/** Extra behind so the tile-snapped ground can never expose its back edge. */
const GROUND_BEHIND = 45;
/** Street furniture is laid out in slabs this long and recycled. */
const SLAB_LEN = 30;
/** 180 m of street, which is where the fog closes anyway — every slab past
 *  that would be geometry nobody can see. */
const SLABS = 6;
/** How far off the track's edge the pavement furniture stands. */
const KERB = 1.4;
/** The adjacent railway the service trains run on — outside the playable
 *  lanes, so a passing train is scenery and can never touch a runner. */
const SIDE_RAIL_X = 11.4;
/** Clear gap between the side railway and a building's NEAR FACE. Measured to
 *  the face rather than to the model's origin because the three building
 *  models are different depths — placing them all by their centre put the
 *  widest one straight through the railway. */
const BUILDING_CLEARANCE = 1.4;
/** Carriages in a service train, and how they sit end to end. */
const TRAIN_CARS = 5;
const CAR_LEN = 8;
const CAR_GAP = 0.6;
/** Metres covered by one repeat of the pavement texture. */
const PAVING_TILE = 3.2;
/** Metres covered by one repeat of the side-railway bed texture. */
const RAIL_TILE = 0.8;

/** Beads per string-light strand. More, smaller beads read as a real strand;
 *  a handful of big ones read as floating balls, which is what the first cut
 *  looked like. */
const BEADS = 17;

/** Blue hour, in four colours. Everything else is derived from these. */
export const SKY_TOP = new Color3(0.04, 0.06, 0.16);
export const SKY_HORIZON = new Color3(0.17, 0.15, 0.24);
export const LAMP_WARM = new Color3(1.0, 0.66, 0.28);
export const WINDOW_WARM = new Color3(1.0, 0.78, 0.45);
/** What the fog dissolves into — the horizon, so distance reads as depth
 *  rather than as a grey wall. */
export const FOG_COLOUR = new Color3(0.1, 0.1, 0.17);

/** Lane index (fractional mid-change) → world x. Lane 0 is on the left. */
export const laneToX = (lane: number): number => (lane - (LANES - 1) / 2) * LANE_WIDTH;

/** Deterministic per-slab noise so recycled scenery does not repeat in
 *  lockstep — a visible 30 m rhythm reads as a treadmill. Cosmetic only:
 *  never touches the simulation. */
function noise(i: number, k: number): number {
  let h = (i * 374761393 + k * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The sky: a vertical gradient with a low warm band where the city glows,
 *  and the landmark painted straight into it.
 *
 *  Painting the skyline rather than building it is the single cheapest trick
 *  in the scene. The dome follows the camera, so the landmark stays exactly on
 *  the vanishing point for the whole run — which is where the reference keeps
 *  it — at a cost of one texture and no geometry at all. */
function buildSkyTexture(scene: Scene): DynamicTexture {
  const w = 2048;
  const h = 1024;
  const tex = new DynamicTexture("sky", { width: w, height: h }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;

  // A sphere's texture is EQUIRECTANGULAR: v=0 is straight up, v=1 straight
  // down, and v=0.5 is the HORIZON. Getting that wrong is not subtle — the
  // first cut painted the skyline at v=0.86 and it ended up under the road,
  // invisible, while the gradient's bright band sat overhead like a dome.
  const horizon = h * 0.5;
  // MANY stops, in small steps. A band of sky is a small circle on the dome,
  // and a pitched camera projects a small circle as a CURVE — so any stop
  // sharp enough to see becomes a dark arc hanging over the street, which is
  // exactly what a six-stop gradient produced: it read as a mountain range on
  // the skyline and took three passes to recognise as banding rather than
  // geometry. Smooth here costs nothing; a visible edge costs the whole sky.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  const zenith = [5, 7, 15];
  const sunset = [46, 38, 66];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20; // 0 at the zenith, 1 at the horizon
    const k = Math.pow(t, 2.2); // most of the change happens low down
    const c = zenith.map((z, j) => Math.round(z + (sunset[j] - z) * k));
    grad.addColorStop(t * 0.5, `rgb(${c[0]},${c[1]},${c[2]})`);
  }
  grad.addColorStop(0.5, "#2e2642"); // the last of the sunset, on the horizon
  grad.addColorStop(0.62, "#14101e");
  grad.addColorStop(1.0, "#0a0810"); // below the horizon: never seen
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Stars, thinning towards the horizon where the sky is still bright.
  for (let i = 0; i < 500; i++) {
    const x = noise(i, 1) * w;
    const y = noise(i, 2) ** 1.6 * horizon * 0.92;
    const a = (0.25 + noise(i, 3) * 0.55) * (1 - y / horizon);
    ctx.fillStyle = `rgba(210,225,255,${a})`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }

  // A soft warm glow sitting on the horizon: the city's light on the haze.
  const glow = ctx.createLinearGradient(0, horizon - 90, 0, horizon + 10);
  glow.addColorStop(0, "rgba(255,150,70,0)");
  glow.addColorStop(1, "rgba(255,150,70,0.22)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, horizon - 90, w, 100);

  // Distant skyline, standing ON the horizon line.
  ctx.fillStyle = "#080a14";
  for (let x = 0; x < w; ) {
    // Small and dense. Wide, tall blocks on a 900 m dome subtend enough arc to
    // read as a mountain range rather than a distant city — which is exactly
    // what the first cut looked like.
    const bw = 12 + noise(x, 4) * 26;
    const bh = 4 + noise(x, 5) * 20;
    ctx.fillRect(x, horizon - bh, bw + 1, bh + 30);
    for (let k = 0; k < 8; k++) {
      if (noise(x + k, 6) < 0.76) continue;
      ctx.fillStyle = `rgba(255,196,120,${0.2 + noise(x + k, 7) * 0.45})`;
      ctx.fillRect(x + 4 + noise(x + k, 8) * (bw - 8), horizon - bh + 3 + noise(x + k, 9) * (bh - 6), 2.5, 3.5);
      ctx.fillStyle = "#080a14";
    }
    x += bw;
  }

  // The landmark: an open lattice tower with a red beacon, painted at the
  // point the street runs towards. u=0.5 is the +Z direction on Babylon's
  // sphere, which is exactly where the runner is looking.
  const cx = w * 0.5;
  const towerBase = horizon + 6;
  // DISTANT. 300 px on a 1024 px equirectangular map is 53 degrees of sky —
  // at that size the lattice merges into one dark mass and reads as a mountain
  // standing over the street, not as a landmark a few kilometres away. Around
  // 20 degrees is what the eye expects.
  const towerH = 118;
  const legOut = 15;
  const curve = (t: number) => legOut * Math.pow(1 - t, 1.7) + 3;
  // Lighter than the skyline: haze thins anything this far off.
  ctx.strokeStyle = "rgba(38,33,44,0.9)";
  ctx.lineWidth = 2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    for (let t = 0; t <= 1.001; t += 0.04) ctx.lineTo(cx + side * curve(t), towerBase - t * towerH);
    ctx.stroke();
  }
  ctx.lineWidth = 0.9;
  for (let t = 0; t < 1; t += 0.05) {
    const y0 = towerBase - t * towerH;
    const y1 = towerBase - (t + 0.05) * towerH;
    ctx.beginPath();
    ctx.moveTo(cx - curve(t), y0);
    ctx.lineTo(cx + curve(t + 0.05), y1);
    ctx.moveTo(cx + curve(t), y0);
    ctx.lineTo(cx - curve(t + 0.05), y1);
    ctx.stroke();
  }
  ctx.lineWidth = 2.4;
  for (const t of [0.22, 0.44]) {
    ctx.beginPath();
    ctx.moveTo(cx - curve(t) - 4, towerBase - t * towerH);
    ctx.lineTo(cx + curve(t) + 4, towerBase - t * towerH);
    ctx.stroke();
  }
  // Haze around the tower — as a radial falloff, not a rectangle. A rectangle
  // of translucent colour has four visible edges, and on a 900 m dome those
  // edges are metres wide.
  const haze = ctx.createRadialGradient(cx, towerBase - towerH * 0.45, 4, cx, towerBase - towerH * 0.45, towerH * 0.55);
  haze.addColorStop(0, "rgba(255,168,74,0.1)");
  haze.addColorStop(1, "rgba(255,168,74,0)");
  ctx.fillStyle = haze;
  ctx.fillRect(cx - towerH * 0.6, towerBase - towerH * 1.05, towerH * 1.2, towerH * 1.1);
  ctx.fillStyle = "rgba(255,70,60,0.95)";
  ctx.beginPath();
  ctx.arc(cx, towerBase - towerH - 3, 2.2, 0, Math.PI * 2);
  ctx.fill();

  tex.update(false);
  return tex;
}

/** The side railway's bed: ballast, sleepers and two steel rails, painted once
 *  into a small tile. Cheaper than any geometry and, at the angle it is seen
 *  from, indistinguishable from it. */
function buildSideRailTexture(scene: Scene): DynamicTexture {
  const w = 128;
  const h = 128; // one 3.6 m x 0.8 m patch: ballast + one sleeper + two rails
  const tex = new DynamicTexture("sideRail", { width: w, height: h }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = "#232025";
  ctx.fillRect(0, 0, w, h);
  // Ballast grain.
  for (let i = 0; i < 900; i++) {
    const g = 0.1 + noise(i, 11) * 0.22;
    ctx.fillStyle = `rgba(${g * 255},${g * 245},${g * 235},0.9)`;
    ctx.fillRect(noise(i, 12) * w, noise(i, 13) * h, 2, 2);
  }
  // Sleeper across the middle.
  ctx.fillStyle = "#191418";
  ctx.fillRect(4, h * 0.42, w - 8, h * 0.2);
  // Two rails running along it (u is across the bed, v along it).
  for (const u of [0.3, 0.7]) {
    ctx.fillStyle = "#4a4640";
    ctx.fillRect(u * w - 3, 0, 6, h);
    ctx.fillStyle = "#8d8a80"; // the polished top face catches every lamp
    ctx.fillRect(u * w - 1.5, 0, 3, h);
  }
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.vScale = (GROUND_AHEAD + GROUND_BEHIND) / RAIL_TILE;
  return tex;
}

interface Slab {
  z: number;
  parts: InstancedMesh[];
}

export class World {
  private ground: Mesh;
  /** The pavement the buildings actually stand on. */
  private pavement: Mesh;
  private groundMat: StandardMaterial;
  private textureUrl: string | null = null;
  private texMetres = GROUND_W;
  private sky: Mesh;
  private slabs: Slab[] = [];
  private sources: Mesh[] = [];

  private hasModels = false;
  private buildings: Mesh[] = [];
  /** Half the across-street extent of each building source, in metres. */
  private buildingHalf: number[] = [];
  private clutter: Mesh[] = [];
  /** Decorative trains on the adjacent line — see stepTrains. */
  private trains: { parts: InstancedMesh[]; z: number; speed: number; side: number }[] = [];
  private textureUrls: string[] = [];
  /** The z the scenery was last drawn at — the WATCHED runner's, which after
   *  you die is not your own. */
  private lastZ = 0;
  private sideRails: Mesh[] = [];

  constructor(
    scene: Scene,
    trackTexture: Uint8Array | null,
    facadeTexture: Uint8Array | null = null,
    models: TracklineModels | null = null,
    pavementTexture: Uint8Array | null = null
  ) {
    // ---- sky ----
    // Diameter must stay WELL INSIDE the camera's far plane. The dome rides on
    // the camera (infiniteDistance), so its size changes nothing about how it
    // looks — but at 900 across it reached past maxZ=400 and the far plane
    // sliced a disc out of it, showing the clear colour through the middle of
    // the sky. That disc read as a dark mountain standing at the end of the
    // street, and it survived three other explanations before the clip plane
    // turned out to be the cause.
    this.sky = MeshBuilder.CreateSphere("sky", { diameter: 240, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    const skyMat = new StandardMaterial("skyMat", scene);
    skyMat.diffuseColor = new Color3(0, 0, 0);
    skyMat.specularColor = new Color3(0, 0, 0);
    skyMat.emissiveTexture = buildSkyTexture(scene);
    skyMat.disableLighting = true;
    // Backface culling MUST stay on. The sphere is built BACKSIDE, so its
    // faces already point inward at the camera; turning culling off also draws
    // the near wall — the part of the dome between you and the far wall — and
    // that near wall wins the depth test and paints the texture's below-horizon
    // black as a huge dark dome hanging over the street. It read as a mountain
    // range sitting on the skyline for as long as it was off.
    skyMat.backFaceCulling = true;
    this.sky.material = skyMat;
    this.sky.isPickable = false;
    this.sky.infiniteDistance = true; // rides with the camera: always on the horizon
    this.sky.applyFog = false;

    // ---- pavement ----
    // The track quad is only as wide as the track. Without this, the strip
    // between the kerb and the buildings showed the SKY, and the façades
    // appeared to float above a blue void. It sits a hair lower so it can
    // never z-fight with the track on top of it.
    this.pavement = MeshBuilder.CreateGround(
      "pavement",
      { width: 70, height: GROUND_AHEAD + GROUND_BEHIND },
      scene
    );
    const pavMat = new StandardMaterial("pavMat", scene);
    pavMat.diffuseColor = new Color3(0.1, 0.098, 0.11);
    pavMat.specularColor = new Color3(0.18, 0.17, 0.16); // faintly wet too
    pavMat.specularPower = 64;
    if (pavementTexture) {
      // Real paving. A flat colour here was the worst thing left in frame:
      // under the warm lamps an untextured plane reads as bare orange dirt,
      // and it fills a third of the picture. Tiled at roughly a metre per
      // slab, which is what the texture is drawn at.
      const purl = URL.createObjectURL(new Blob([pavementTexture as BlobPart], { type: "image/webp" }));
      this.textureUrls.push(purl);
      const ptex = new Texture(purl, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      ptex.uScale = 70 / PAVING_TILE;
      ptex.vScale = (GROUND_AHEAD + GROUND_BEHIND) / PAVING_TILE;
      ptex.anisotropicFilteringLevel = 8;
      pavMat.diffuseTexture = ptex;
      pavMat.diffuseColor = new Color3(1, 1, 1);
    }
    this.pavement.material = pavMat;
    this.pavement.isPickable = false;
    this.pavement.position.y = -0.02;

    // ---- the side railway ----
    // A bed under each service train. Without it the trains slid along on bare
    // paving and read as barges, not trains; two thin quads and one painted
    // texture is the cheapest possible way to say "there is a line here".
    const railTex = buildSideRailTexture(scene);
    const railMat = new StandardMaterial("railMat", scene);
    railMat.diffuseTexture = railTex;
    railMat.specularColor = new Color3(0.3, 0.28, 0.25);
    railMat.specularPower = 48;
    for (const side of [-1, 1]) {
      const bed = MeshBuilder.CreateGround(
        `sideRail${side}`,
        { width: 3.6, height: GROUND_AHEAD + GROUND_BEHIND },
        scene
      );
      bed.material = railMat;
      bed.isPickable = false;
      bed.position.set(side * SIDE_RAIL_X, -0.01, 0);
      this.sideRails.push(bed);
    }

    // ---- ground ----
    this.ground = MeshBuilder.CreateGround("ground", { width: GROUND_W, height: GROUND_AHEAD + GROUND_BEHIND }, scene);
    this.groundMat = new StandardMaterial("groundMat", scene);
    // Wet road: dark, but with a tight bright specular so every lamp lays a
    // streak down it. That single highlight does more for "it rained" than any
    // amount of albedo work.
    this.groundMat.specularColor = new Color3(0.5, 0.42, 0.35);
    this.groundMat.specularPower = 96;
    this.groundMat.diffuseColor = new Color3(0.85, 0.85, 0.9);
    if (trackTexture) {
      this.textureUrl = URL.createObjectURL(new Blob([trackTexture as BlobPart], { type: "image/webp" }));
      const tex = new Texture(this.textureUrl, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.uScale = 1;
      tex.vScale = (GROUND_AHEAD + GROUND_BEHIND) / this.texMetres;
      tex.anisotropicFilteringLevel = 8;
      this.groundMat.diffuseTexture = tex;
    } else {
      this.groundMat.diffuseColor = new Color3(0.1, 0.1, 0.12);
    }
    this.ground.material = this.groundMat;
    this.ground.isPickable = false;

    // ---- street furniture ----
    // Real models when the pack has them; simple stand-ins when it does not,
    // so a match still runs if a model failed to download.
    const facadeMat = new StandardMaterial("facadeMat", scene);
    if (facadeTexture) {
      const url = URL.createObjectURL(new Blob([facadeTexture as BlobPart], { type: "image/webp" }));
      this.textureUrls.push(url);
      const tex = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
      tex.uScale = 2;
      facadeMat.diffuseTexture = tex;
      facadeMat.emissiveTexture = tex;
      facadeMat.emissiveColor = new Color3(0.22, 0.19, 0.16);
    } else {
      facadeMat.diffuseColor = new Color3(0.16, 0.15, 0.17);
    }
    facadeMat.specularColor = new Color3(0.04, 0.04, 0.05);

    let buildingSrc = models?.building ?? null;
    if (!buildingSrc) {
      const card = MeshBuilder.CreatePlane(
        "facade",
        { width: SLAB_LEN, height: 20, sideOrientation: Mesh.DOUBLESIDE },
        scene
      );
      card.material = facadeMat;
      card.rotation.y = Math.PI / 2;
      card.bakeCurrentTransformIntoVertices();
      buildingSrc = card;
    }
    this.register(buildingSrc);

    let lampSrc = models?.lamp ?? null;
    if (!lampSrc) {
      const pole = MeshBuilder.CreateBox("pole", { width: 0.16, height: 6, depth: 0.16 }, scene);
      const poleMat = new StandardMaterial("poleMat", scene);
      poleMat.diffuseColor = new Color3(0.05, 0.05, 0.06);
      pole.material = poleMat;
      lampSrc = pole;
    }
    this.register(lampSrc);

    const treeSrc = models?.tree ?? null;
    if (treeSrc) this.register(treeSrc);
    // Pavement clutter. Each slab shows a couple of these, chosen per slab, so
    // the street has the incidental junk a real one does instead of reading as
    // a corridor of buildings and lamps.
    this.clutter = [models?.bench, models?.kiosk, models?.car, models?.tree].filter((m): m is Mesh => !!m);
    for (const c of this.clutter) if (c !== treeSrc) this.register(c);

    // The lamp head and the string beads: the warm points the image hangs on.
    // The lamp model carries its own glass, so the globe is only used with the
    // stand-in pole.
    const glowMat = new StandardMaterial("glowMat", scene);
    glowMat.diffuseColor = new Color3(0, 0, 0);
    glowMat.specularColor = new Color3(0, 0, 0);
    glowMat.emissiveColor = LAMP_WARM;
    glowMat.disableLighting = true;
    const globeSrc = MeshBuilder.CreateSphere("globe", { diameter: models?.lamp ? 0.34 : 0.62, segments: 8 }, scene);
    globeSrc.material = glowMat;
    this.register(globeSrc);
    const beadSrc = MeshBuilder.CreateSphere("bead", { diameter: 0.13, segments: 6 }, scene);
    beadSrc.material = glowMat;
    this.register(beadSrc);

    this.hasModels = !!models?.building;
    this.buildings = [models?.building, models?.building2, models?.building3].filter(
      (m): m is Mesh => !!m
    );
    if (this.buildings.length === 0 && buildingSrc) this.buildings = [buildingSrc];
    for (const b of this.buildings) if (b !== buildingSrc) this.register(b);
    // Measure once. The instances are quarter-turned, so what ends up across
    // the street is the source's z extent; the fallback card has no meaningful
    // depth, hence the floor.
    this.buildingHalf = this.buildings.map((b) => Math.max(2, modelSize(b).z / 2));
    for (let i = 0; i < SLABS; i++) {
      const parts: InstancedMesh[] = [];
      const add = (src: Mesh, name: string) => {
        const inst = src.createInstance(`${name}_${i}`);
        inst.isPickable = false;
        parts.push(inst);
        return inst;
      };
      // Two building slots per side, each able to show ANY of the variants —
      // one block repeated down a street is the single most obvious tell that
      // a city is fake, so each slab picks from the set.
      for (const b of this.buildings) {
        add(b, "bldL");
        add(b, "bldR");
      }
      add(lampSrc, "lampL");
      add(lampSrc, "lampR");
      add(globeSrc, "globeL");
      add(globeSrc, "globeR");
      for (const c of this.clutter) {
        add(c, "clutterL");
        add(c, "clutterR");
      }
      for (let b = 0; b < BEADS; b++) add(beadSrc, `bead${b}`);
      this.slabs.push({ z: i * SLAB_LEN, parts });
      this.layout(i);
    }
    // ---- service trains ----
    // Real trains, running on the line beside the street. They are scenery,
    // not obstacles: they live OUTSIDE the four playable lanes, so a passing
    // train can never touch a runner and none of this reaches the simulation.
    // Two of them going opposite ways is what turns a static diorama into a
    // working railway — it is the thing the reference footage never stops
    // doing.
    if (models?.carriage) {
      for (let t = 0; t < 2; t++) {
        const parts: InstancedMesh[] = [];
        for (let c = 0; c < TRAIN_CARS; c++) {
          const inst = models.carriage.createInstance(`svc_${t}_${c}`);
          inst.isPickable = false;
          parts.push(inst);
        }
        this.trains.push({
          parts,
          z: t === 0 ? -120 : 240,
          // One overtakes from behind, one comes the other way. Both move at
          // speeds unlike the runner's, so they are always visibly moving
          // relative to the player rather than pacing them.
          speed: t === 0 ? 26 : -30,
          side: t === 0 ? -1 : 1,
        });
      }
    }

    scene.freezeMaterials();
  }

  private register(mesh: Mesh): void {
    mesh.isPickable = false;
    mesh.isVisible = false; // only the instances draw
    this.sources.push(mesh);
  }

  /** Place one slab's furniture. Called on creation and each time a slab is
   *  recycled ahead of the runner. */
  private layout(i: number): void {
    const slab = this.slabs[i];
    const z0 = slab.z;
    const seed = Math.round(z0 / SLAB_LEN);
    const edge = GROUND_W / 2;
    const p = slab.parts;
    const mid = z0 + SLAB_LEN / 2;

    // Buildings: one per side, stretched to the slab so the street is a solid
    // wall of stone with no gaps, and flipped/nudged per slab so the same block
    // does not read as the same block twice.
    const faceL = SIDE_RAIL_X + 1.8 + BUILDING_CLEARANCE + noise(seed, 11) * 1.6;
    const faceR = SIDE_RAIL_X + 1.8 + BUILDING_CLEARANCE + noise(seed, 12) * 1.6;
    const flipL = noise(seed, 21) > 0.5 ? Math.PI : 0;
    const flipR = noise(seed, 22) > 0.5 ? Math.PI : 0;
    const variants = this.buildings.length;
    const pickL = Math.floor(noise(seed, 41) * variants) % variants;
    const pickR = Math.floor(noise(seed, 42) * variants) % variants;
    for (let v = 0; v < variants; v++) {
      const left = p[v * 2];
      const right = p[v * 2 + 1];
      left.setEnabled(v === pickL);
      right.setEnabled(v === pickR);
      if (v !== pickL && v !== pickR) continue;
      if (this.hasModels) {
        // The models face -X out of the box, so each side turns to look across
        // the street at the other. That quarter turn means the instance's
        // width across the street is the SOURCE's depth, which is why the
        // half-extent is measured on z.
        const half = this.buildingHalf[v];
        left.rotation.set(0, Math.PI / 2 + flipL, 0);
        right.rotation.set(0, -Math.PI / 2 + flipR, 0);
        left.position.set(-(faceL + half), 0, mid);
        right.position.set(faceR + half, 0, mid);
      } else {
        left.position.set(-(faceL + 4), 10, mid);
        right.position.set(faceR + 4, 10, mid);
      }
    }

    // Lamps, offset from each other down the street so the two sides alternate.
    const lampZL = z0 + 6 + noise(seed, 13) * 4;
    const lampZR = z0 + 19 + noise(seed, 14) * 4;
    const lampY = this.hasModels ? 0 : 3;
    const b2 = this.buildings.length * 2;
    p[b2].position.set(-(edge + KERB), lampY, lampZL);
    p[b2 + 1].position.set(edge + KERB, lampY, lampZR);
    p[b2].rotation.set(0, Math.PI / 2, 0);
    p[b2 + 1].rotation.set(0, -Math.PI / 2, 0);
    // The glow sits where the model's lanterns are.
    const globeY = this.hasModels ? 4.6 : 6.1;
    p[b2 + 2].position.set(-(edge + KERB), globeY, lampZL);
    p[b2 + 3].position.set(edge + KERB, globeY, lampZR);

    let next = this.buildings.length * 2 + 4;
    // Two pieces of clutter per side per slab, drawn from the set and turned
    // at random. Everything else stays parked, so the count on screen is fixed
    // however many kinds the pack ships.
    const kinds = this.clutter.length;
    if (kinds > 0) {
      const pickL = Math.floor(noise(seed, 51) * kinds) % kinds;
      const pickR = Math.floor(noise(seed, 52) * kinds) % kinds;
      for (let k = 0; k < kinds; k++) {
        const left = p[next + k * 2];
        const right = p[next + k * 2 + 1];
        const showL = k === pickL && noise(seed, 53) > 0.25;
        const showR = k === pickR && noise(seed, 54) > 0.25;
        left.setEnabled(showL);
        right.setEnabled(showR);
        if (showL) {
          left.position.set(-(edge + KERB + 1.6 + noise(seed, 55) * 1.2), 0, z0 + 20 + noise(seed, 56) * 8);
          left.rotation.set(0, Math.PI / 2 + (noise(seed, 57) - 0.5) * 0.5, 0);
        }
        if (showR) {
          right.position.set(edge + KERB + 1.6 + noise(seed, 58) * 1.2, 0, z0 + 7 + noise(seed, 59) * 8);
          right.rotation.set(0, -Math.PI / 2 + (noise(seed, 60) - 0.5) * 0.5, 0);
        }
      }
      next += kinds * 2;
    }

    // String lights: a catenary slung across the street, the detail that says
    // "festival street" more than anything else in the reference.
    const strandZ = z0 + 4 + noise(seed, 15) * (SLAB_LEN - 8);
    const sag = 1.6;
    for (let b = 0; b < BEADS; b++) {
      const t = b / (BEADS - 1);
      const x = (t - 0.5) * 2 * (edge + 2.4);
      const dip = Math.sin(t * Math.PI) * sag;
      p[next + b].position.set(x, 8.2 - dip, strandZ);
    }
  }

  /** Move the service trains and wrap them when they leave the view. Two float
   *  writes per carriage per frame, and nothing is allocated. */
  private stepTrains(z: number, dt: number): void {
    for (const train of this.trains) {
      train.z += train.speed * dt;
      const len = TRAIN_CARS * (CAR_LEN + CAR_GAP);
      // Recycle well outside the fog, so a train never appears out of nothing
      // in front of the player.
      // Recycle on RANGE, not on direction. Keying the wrap off the train's
      // own sign assumes it is always faster than the runner, and it is not —
      // a runner speeds up all match, overtakes the slower service train, and
      // then that train falls behind forever and is never seen again. Sending
      // whichever end it left from to the opposite end keeps every train
      // sweeping through the view however fast anyone is going.
      const rel = train.z - z;
      if (rel > 200) train.z = z - 150 - len;
      else if (rel < -150 - len) train.z = z + 200;
      const x = train.side * SIDE_RAIL_X;
      for (let c = 0; c < train.parts.length; c++) {
        train.parts[c].position.set(x, 0.35, train.z - c * (CAR_LEN + CAR_GAP));
      }
    }
  }

  /** Dev-only: what the scenery is doing right now, relative to the runner.
   *  A test harness cannot see a passing train in a screenshot it did not
   *  happen to take, so it asks instead. */
  debug(): unknown {
    const z = this.lastZ;
    return {
      trains: this.trains.map((t) => ({
        side: t.side,
        speed: t.speed,
        rel: Number((t.z - z).toFixed(1)),
        visible: t.z - z > -60 && t.z - z < 200,
      })),
      slabZ: this.slabs.map((s) => Math.round(s.z - z)),
      groundZ: Math.round(this.ground.position.z - z),
    };
  }

  /** Called every frame with the local runner's z: scroll the ground under
   *  them and leapfrog any slab that has fallen behind. */
  follow(z: number, dt = 0.016): void {
    // The ground SNAPS to whole texture tiles instead of sliding with a UV
    // offset. A scrolled offset has to cancel the mesh's own movement exactly;
    // get the rate or the sign slightly wrong and the track appears to slide
    // under a runner who never moves — the treadmill look. Snapping removes
    // the possibility: the texture is nailed to world space because the mesh
    // only ever moves by whole repeats of it.
    this.lastZ = z;
    const tile = this.texMetres;
    const want = z + (GROUND_AHEAD - GROUND_BEHIND) / 2;
    this.ground.position.z = Math.round(want / tile) * tile;
    // Same rule for the pavement now that it is textured: snap to whole paving
    // tiles. Sliding it freely under a fixed texture is precisely the
    // treadmill this fix exists to remove.
    this.pavement.position.z = Math.round(want / PAVING_TILE) * PAVING_TILE;
    // Sleepers repeat every 0.8 m, so that is the step the bed may move by.
    const railZ = Math.round(want / RAIL_TILE) * RAIL_TILE;
    for (const bed of this.sideRails) bed.position.z = railZ;
    this.stepTrains(z, dt);
    for (let i = 0; i < SLABS; i++) {
      if (this.slabs[i].z + SLAB_LEN < z - GROUND_BEHIND) {
        this.slabs[i].z += SLABS * SLAB_LEN;
        this.layout(i);
      }
    }
  }

  dispose(): void {
    if (this.textureUrl) URL.revokeObjectURL(this.textureUrl);
    for (const url of this.textureUrls) URL.revokeObjectURL(url);
  }
}
