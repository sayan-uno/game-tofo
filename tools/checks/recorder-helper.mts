// Node side of check:recorder — the parts that need the backend's own modules.
// Driven by recorder.py, which owns the browser.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require_ = createRequire(new URL("../../backend/package.json", import.meta.url));
for (const line of readFileSync(new URL("../../backend/.env", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { Client } = require_("pg") as typeof import("pg");
const { AccessToken, RoomServiceClient } = require_("livekit-server-sdk") as typeof import("livekit-server-sdk");
const ffmpeg = require_("ffmpeg-static") as string;

const [mode, key, arg] = process.argv.slice(2);
const room = `M${key}`;
const http = (process.env.LIVEKIT_URL ?? "").replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://"));
const rooms = new RoomServiceClient(http, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

if (mode === "alive") {
  // Is a recorder already running? If one is, this check must NOT start a
  // second: they would race for the session lease, one would win, and the
  // result would depend on which — the exact flakiness a check must not have.
  const { recorderHealth } = await import("../../backend/src/recorder/registry.js");
  const health = await recorderHealth();
  console.log(JSON.stringify(health));
  process.exit(0);
}

if (mode === "ready") {
  const why: string[] = [];
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY) why.push("LiveKit credentials");
  if (!process.env.R2_EVIDENCE_BUCKET) why.push("an evidence bucket (R2_EVIDENCE_*)");
  console.log(JSON.stringify({ ready: why.length === 0, why, url: process.env.LIVEKIT_URL ?? null }));
  process.exit(0);
}

if (mode === "setup") {
  const { registerSession } = await import("../../backend/src/recorder/registry.js");
  await rooms.createRoom({ name: room, emptyTimeout: 180 });
  const anchor = Date.now();
  await registerSession({ key, room, scope: "match", anchor, at: anchor });
  console.log(JSON.stringify({ room, anchor }));
  process.exit(0);
}

if (mode === "token") {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, { identity: arg });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  console.log(JSON.stringify({ token: await at.toJwt(), url: process.env.LIVEKIT_URL }));
  process.exit(0);
}

if (mode === "stop") {
  const { unregisterSession } = await import("../../backend/src/recorder/registry.js");
  await unregisterSession(key);
  console.log(JSON.stringify({ stopped: true }));
  process.exit(0);
}

if (mode === "inspect") {
  const { getEvidence } = await import("../../backend/src/platform/evidence.js");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(
    `select kind, uid, status, error, offset_ms as "offset", duration_sec dur, bytes, r2_key key,
            jsonb_array_length(coalesce(speech,'[]'::jsonb)) segs
       from voice_recordings where match_key = $1 order by kind, uid`,
    [key]
  );
  // Every row is checked against the FILE, not merely against itself: a length
  // in the console that the audio does not have is the kind of quiet
  // wrongness that makes a recording useless as evidence.
  for (const row of rows) {
    const body = await getEvidence(row.key);
    row.ogg = body ? body.subarray(0, 4).toString("latin1") === "OggS" : false;
    row.realBytes = body?.length ?? 0;
    row.seconds = 0;
    row.codec = null;
    if (body) {
      const file = join(tmpdir(), `reccheck-${row.uid}-${row.kind}.ogg`);
      writeFileSync(file, body);
      let info = "";
      try {
        execFileSync(ffmpeg, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        info = String((e as { stderr?: Buffer }).stderr ?? "");
      }
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
      row.seconds = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
      row.codec = /Audio: ([a-z0-9]+)/.exec(info)?.[1] ?? null;
    }
  }
  console.log(JSON.stringify(rows));
  await db.end();
  process.exit(0);
}

if (mode === "cleanup") {
  const { deleteEvidence } = await import("../../backend/src/platform/evidence.js");
  const { unregisterSession } = await import("../../backend/src/recorder/registry.js");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await unregisterSession(key).catch(() => undefined);
  const { rows } = await db.query("select r2_key from voice_recordings where match_key = $1", [key]);
  if (rows.length > 0) await deleteEvidence(rows.map((r: { r2_key: string }) => r.r2_key));
  await db.query("delete from voice_recordings where match_key = $1", [key]);
  await db.end();
  await rooms.deleteRoom(room).catch(() => undefined);
  console.log(JSON.stringify({ cleaned: rows.length }));
  process.exit(0);
}
console.error(`unknown mode: ${mode}`);
process.exit(2);
