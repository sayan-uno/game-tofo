// DEV ONLY — makes a party for the browser test to open, and cleans it up.
//
//   tsx tools/e2e/seed-party.mts seed    → prints the party key as JSON
//   tsx tools/e2e/seed-party.mts clean <key>
//
// It drives the REAL party log rather than writing rows: what the studio gets
// is what a live party would actually have produced.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(new URL("../../backend/package.json", import.meta.url));
for (const line of readFileSync(new URL("../../backend/.env", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { Client } = require_("pg") as typeof import("pg");
const { redis } = await import("../../backend/src/redis.js");
const {
  noteLobbyState,
  noteLobbyChat,
  noteLobbyEmote,
  noteLobbyJoin,
  noteLobbyMatch,
  noteLobbyMic,
  noteLobbyLeave,
  noteLobbyReady,
  noteLobbyPick,
  noteLobbySearch,
  currentSession,
} = await import("../../backend/src/platform/partyLog.js");
const { deleteEvidence } = await import("../../backend/src/platform/evidence.js");
// The SAME resolution the server does when it broadcasts a lobby, so a player
// with nothing equipped gets the real default instead of an invented id that
// draws as a grey placeholder.
const { resolveCharacter, resolveWeapon } = await import("../../backend/src/services/catalog.js");

const mode = process.argv[2];
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

if (mode === "clean") {
  const key = process.argv[3] ?? "";
  const { rows } = await db.query("select r2_key from party_sessions where key = $1", [key]);
  const files = rows.map((r: { r2_key: string | null }) => r.r2_key).filter(Boolean) as string[];
  if (files.length) await deleteEvidence(files);
  await db.query("delete from party_sessions where key = $1", [key]);
  await db.end();
  redis.disconnect();
  process.exit(0);
}

// Real players, so the studio has real characters to draw.
const { rows: people } = await db.query("select uid, name, username, equipped_character, equipped_weapon from users limit 3");
const LOBBY = "Le2e-party";
await redis.del(`party:open:${LOBBY}`, `party:sign:${LOBBY}`);

// One LEGENDARY in the line-up, always. A legendary character wears a particle
// aura, and particles only advance if the engine is reporting a real frame
// time — which a studio driving its own clock has to arrange for itself. A
// party of starters would draw identically whether that works or not.
const LEGENDARY = "zenith";

const member = (i: number, leader = false) => ({
  uid: people[i].uid,
  name: people[i].username ?? people[i].name,
  character: i === 0 ? LEGENDARY : resolveCharacter(people[i].equipped_character),
  weapon: resolveWeapon(people[i].equipped_weapon),
  isLeader: leader,
  avatarUrl: null,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await noteLobbyState(LOBBY, "solo", [member(0, true)], null);
await noteLobbyState(LOBBY, "squad", [member(0, true), member(1)], null);
const nameOf = (i: number) => people[i].username ?? people[i].name;
// Arrived by invitation from the leader.
await noteLobbyJoin(LOBBY, people[1].uid, nameOf(1), "invite", { uid: people[0].uid, name: nameOf(0) });
await wait(600);
await noteLobbyChat(LOBBY, people[0].uid, nameOf(0), "who is joining?");
// A mic opened, and shut again without a word said — which is precisely the
// case the audio can never account for.
await noteLobbyMic(LOBBY, people[0].uid, nameOf(0), true);
// The leader picks something and the others agree to it — the two things a
// party does before it plays, and neither was in the record.
await noteLobbyPick(LOBBY, people[0].uid, nameOf(0), "trackline");
await noteLobbyReady(LOBBY, people[1].uid, nameOf(1), true);
await noteLobbyEmote(LOBBY, people[1].uid, nameOf(1), "wave");
await wait(600);
if (people[2]) {
  await noteLobbyState(LOBBY, "squad", [member(0, true), member(1), member(2)], null);
  // …and this one let themselves in with the team code.
  await noteLobbyJoin(LOBBY, people[2].uid, nameOf(2), "code", null);
}
// A generous window with all three present. A test that has to hit a
// 600-millisecond gap is a test that fails for reasons of its own.
await wait(1500);
// Then they go and play, and come back. This is the stretch that looks like an
// idle lobby and is not one — the studio has to say so.
// Looked for a match, then went into one — the run-up and the thing itself.
await noteLobbySearch(LOBBY, people[0].uid, nameOf(0), true, "trackline");
await noteLobbyMatch(LOBBY, "start", "e2e-match-key", "trackline");
await wait(1500);
await noteLobbyMatch(LOBBY, "end", "e2e-match-key", "trackline");
await wait(600);
await noteLobbyMic(LOBBY, people[0].uid, nameOf(0), false);
if (people[2]) await noteLobbyLeave(LOBBY, people[2].uid, nameOf(2), "left");
await noteLobbyState(LOBBY, "squad", [member(0, true), member(1)], "trackline");
const session = await currentSession(LOBBY);
await wait(300);
await noteLobbyState(LOBBY, "solo", [member(0, true)], null); // ends it

const { rows } = await db.query("select key, event_count, bytes from party_sessions where key = $1", [session!.key]);
console.log(JSON.stringify({ key: rows[0].key, events: rows[0].event_count, bytes: rows[0].bytes, people: people.length }));
await db.end();
redis.disconnect();
process.exit(0);
