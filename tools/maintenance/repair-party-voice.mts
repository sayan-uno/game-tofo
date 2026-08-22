// One-off repair for party recordings made before parties had an identity.
//
//     backend/node_modules/.bin/tsx tools/maintenance/repair-party-voice.mts [--apply]
//
// Two things were wrong with the early ones, and both make the console read as
// broken rather than as evidence:
//
//   NO NAME. The old path never resolved the speaker's user id for a party, so
//   the console had a uid and no username to show.
//   NO SESSION. Party audio was filed under the LOBBY id, which is named after
//   whoever was leading. There is no party_sessions row behind it, so the
//   party studio cannot open it at all.
//
// Nothing is deleted here. The audio is somebody's evidence; this only fills
// in what can be recovered from the rows themselves.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(new URL("../../backend/package.json", import.meta.url));
for (const line of readFileSync(new URL("../../backend/.env", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { Client } = require_("pg") as typeof import("pg");
const apply = process.argv.includes("--apply");
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

console.log(apply ? "APPLYING changes\n" : "DRY RUN — pass --apply to make these changes\n");

// ---- names ---------------------------------------------------------------
const { rows: nameless } = await db.query(
  `select v.id, v.uid, u.id as user_id, u.username
     from voice_recordings v join users u on u.uid = v.uid
    where v.user_id is null and v.kind = 'track'`
);
console.log(`${nameless.length} recording(s) have a uid but no linked account:`);
for (const r of nameless) console.log(`  ${r.uid} → ${r.username}`);
if (apply && nameless.length > 0) {
  for (const r of nameless) {
    await db.query("update voice_recordings set user_id = $1 where id = $2", [r.user_id, r.id]);
  }
  console.log("  ↳ linked, so the console shows a name instead of a number");
}

// ---- sessions ------------------------------------------------------------
// Read AFTER the names are linked, or the roster is built from the very gap
// this script just closed and every person appears twice: once as a number and
// once as a name.
const { rows: orphaned } = await db.query(
  `select v.match_key, min(v.started_at) as started, max(coalesce(v.ended_at, v.started_at)) as ended,
          jsonb_agg(distinct jsonb_build_object('uid', v.uid, 'username', u.username))
            filter (where v.kind = 'track') as roster
     from voice_recordings v
     left join users u on u.id = v.user_id
     left join party_sessions p on p.key = v.match_key
    where v.scope = 'lobby' and p.key is null
    group by v.match_key`
);
console.log(`\n${orphaned.length} party recording(s) have no session behind them:`);
for (const r of orphaned) {
  const who = (r.roster ?? []).map((p: { uid: string; username: string | null }) => p.username ?? p.uid).join(", ");
  console.log(`  ${r.match_key}  ${who || "(nobody spoke)"}`);
}
if (apply && orphaned.length > 0) {
  for (const r of orphaned) {
    // The roster is whoever can be recovered — the people who actually spoke.
    // Their arrivals are recorded as the moment recording started, which is
    // the most that can honestly be said about a party nobody wrote down.
    const roster = r.roster ?? [];
    const at = new Date(r.started).getTime();
    await db.query(
      `insert into party_sessions (key, room, started_at, ended_at, roster, events)
       values ($1, $1, $2, $3, $4, $5) on conflict (key) do nothing`,
      [
        r.match_key,
        r.started,
        r.ended,
        JSON.stringify(roster),
        JSON.stringify(roster.map((p: { uid: string; username: string | null }) => ({ ...p, at, event: "joined" }))),
      ]
    );
  }
  console.log("  ↳ sessions created, so these open in the party studio");
}

// ---- what a mix that contains nothing looks like -------------------------
const { rows: silent } = await db.query(
  `select match_key, duration_sec from voice_recordings
    where kind = 'mix' and status = 'complete'
      and coalesce(jsonb_array_length(speech), 0) = 0 and coalesce(duration_sec, 0) > 30`
);
if (silent.length > 0) {
  console.log(`\n${silent.length} room mix(es) contain no speech at all:`);
  for (const r of silent) console.log(`  ${r.match_key}  ${r.duration_sec}s of silence`);
  console.log("  These are from before the mix waited for a microphone. Nothing to repair —");
  console.log("  the console now labels a recording with no speech in it rather than leaving it a mystery.");
}

await db.end();
process.exit(0);
