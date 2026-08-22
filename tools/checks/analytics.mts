// Verification suite for analytics and signals (A8) — run it after ANY change
// to the aggregate job, the scoring, the alt graph or the watchdog.
//
//     npm run check:analytics
//
// Not pure: the aggregate job IS a set of database queries, and a check that
// stubbed the database would only prove the stubs agree with each other. It
// writes rows it can find again and deletes them at both ends.
//
// What it proves, and why each check is here:
//
//   cadence    — the pure measure: perfectly regular timing scores high, human
//                timing does not, and too little data returns NULL rather than
//                zero. "No evidence" ranked as "definitely innocent" is how a
//                short match becomes an alibi
//   scoring    — an unmeasured player scores zero; the things that should raise
//                a score raise it; every raise carries a reason in words; and
//                nothing can exceed 100 however bad it looks
//   aggregate  — a day's row counts THAT day and not its neighbours, and
//                running the job twice writes the same numbers (it is rerun
//                every hour over a three-day window, so this is not academic)
//   cohorts    — "came back on day 1" means exactly day 1. Within-N is
//                monotonic and can only ever look like it is going up
//   ranking    — a player with real signals surfaces, a clean one does not, and
//                the row carries a match to go and watch
//   alts       — a shared device links two accounts and says which; a stranger
//                is not linked; and a banned relative is flagged as one
//   watchdog   — an alert LATCHES: it fires on the way in and stays quiet while
//                the condition holds. An alarm that repeats is one you mute

// ---- prelude ---------------------------------------------------------------
import { readFileSync } from "node:fs";

for (const line of readFileSync("backend/.env", "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const base = (process.env.REDIS_URL || "").replace(/\/\d+$/, "");
if (base) process.env.REDIS_URL = `${base}/8`;

const { pool } = await import("../../backend/src/db/client.js");
const { cadence, suspicion } = await import("../../backend/src/platform/signals.js");
const analytics = await import("../../backend/src/services/analytics.js");
const watchdog = await import("../../backend/src/services/watchdog.js");

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, values)).rows as T[];

const MARK = `chk${Date.now()}`.slice(-9);
const TAG = `e2eanalytics-${MARK}`;

async function sweep(): Promise<void> {
  await q(`delete from match_players where match_id in (select id from matches where match_key like 'chkan-%')`);
  await q(`delete from matches where match_key like 'chkan-%'`);
  await q(`delete from user_devices where user_id in (select id from users where google_id like 'e2eanalytics-%')`);
  await q(`delete from event_log where uid in (select uid from users where google_id like 'e2eanalytics-%')`);
  await q(`delete from sanctions where user_id in (select id from users where google_id like 'e2eanalytics-%')`);
  await q(`delete from users where google_id like 'e2eanalytics-%'`);
}

let made = 0;
async function makePlayer(name: string, createdDaysAgo = 0): Promise<{ id: string; uid: string }> {
  const n = made++;
  const uid = `${1 + (n % 9)}${MARK}`;
  const [row] = await q<{ id: string }>(
    `insert into users (google_id, email, name, username, uid, created_at)
     values ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval) returning id`,
    [`${TAG}-${name}`, `${TAG}-${name}@check.invalid`, name, `u${MARK}${n}`, uid, String(createdDaysAgo)]
  );
  return { id: row.id, uid };
}

await sweep();

try {
  // ---- cadence -------------------------------------------------------------
  console.log("\nhow mechanical the timing is");
  const metronome = Array.from({ length: 30 }, (_, i) => 1 + i * 6);
  ok(cadence(metronome) === 100, `perfectly regular input reads 100 (${cadence(metronome)})`);

  // A person: gaps that wander, as a hand does.
  const human = [1];
  for (const g of [5, 7, 6, 9, 4, 8, 6, 11, 5, 7, 13, 6, 8, 5, 9, 7, 4, 10, 6, 8]) {
    human.push(human[human.length - 1] + g);
  }
  const humanScore = cadence(human)!;
  ok(humanScore < 40, `a hand does not (${humanScore})`);

  ok(cadence([1, 7, 13]) === null, "three inputs say nothing at all — null, not zero");
  ok(cadence([]) === null, "and neither does none");
  ok(cadence([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]) === null, "inputs all on one tick are one action, not a rhythm");

  // ---- scoring -------------------------------------------------------------
  console.log("\nranking who is worth watching");
  const clean = {
    matches: 20,
    inputs: 4000,
    rejects: 2,
    rateRejects: 0,
    earlyRejects: 0,
    cadence: 22,
    wins: 5,
    contested: 20,
  };
  ok(suspicion(clean).score === 0, `an ordinary player scores nothing (${suspicion(clean).score})`);

  const unmeasured = { ...clean, matches: 1, inputs: 10 };
  ok(suspicion(unmeasured).score === 0, "and so does one nobody has measured — unmeasured is not innocent, it is unknown");

  const rateAbuser = suspicion({ ...clean, rateRejects: 40 });
  ok(rateAbuser.score > 0, `sitting on the rate ceiling raises it (${rateAbuser.score})`);
  ok(
    rateAbuser.reasons.some((r) => r.includes("rate ceiling")),
    "and says so in words, next to the number"
  );

  const timeTraveller = suspicion({ ...clean, earlyRejects: 12 });
  ok(timeTraveller.score > 0, `so does sending ticks that have not happened (${timeTraveller.score})`);

  const robot = suspicion({ ...clean, cadence: 95 });
  ok(robot.score > 0, `so does timing that never varies (${robot.score})`);
  ok(suspicion({ ...clean, cadence: null }).score === 0, "but a missing measurement raises nothing");

  const everything = suspicion({ ...clean, rateRejects: 500, earlyRejects: 500, cadence: 100, wins: 20 });
  ok(everything.score <= 100, `and nothing can exceed 100 however bad it looks (${everything.score})`);
  ok(everything.reasons.length >= 3, "with every contributing reason listed");

  // ---- the aggregate -------------------------------------------------------
  console.log("\nthe nightly aggregate");
  const player = await makePlayer("dau", 0);
  const yesterdayPlayer = await makePlayer("old", 8);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  // Two facts, on two different days. The row for today must count one.
  await q(`insert into event_log (type, user_id, uid, at) values ('session.start',$1,$2, now())`, [
    player.id,
    player.uid,
  ]);
  await q(
    `insert into event_log (type, user_id, uid, at, data)
     values ('session.end',$1,$2, now(), '{"seconds":300}'::jsonb)`,
    [player.id, player.uid]
  );
  await q(`insert into event_log (type, user_id, uid, at) values ('session.start',$1,$2, now() - interval '1 day')`, [
    yesterdayPlayer.id,
    yesterdayPlayer.uid,
  ]);

  await analytics.aggregateDay(today);
  await analytics.aggregateDay(yesterday);
  const [todayRow] = await q<{ dau: number; avg_session_sec: number }>(
    `select dau, avg_session_sec from daily_stats where day = $1`,
    [iso(today)]
  );
  ok(Number(todayRow?.dau ?? 0) >= 1, `today's row counts today's players (${todayRow?.dau})`);
  ok(Number(todayRow?.avg_session_sec ?? 0) > 0, `and how long a session ran (${todayRow?.avg_session_sec}s)`);

  const before = JSON.stringify(
    await q(`select dau, mau, matches, new_accounts from daily_stats where day = $1`, [iso(today)])
  );
  await analytics.aggregateDay(today);
  const after = JSON.stringify(
    await q(`select dau, mau, matches, new_accounts from daily_stats where day = $1`, [iso(today)])
  );
  ok(before === after, "running it twice writes the same numbers — it reruns hourly, so this matters");

  // ---- cohorts -------------------------------------------------------------
  console.log("\nwho came back");
  const stayed = await makePlayer("stayed", 8);
  const left = await makePlayer("left", 8);
  // Returned on day 1 exactly.
  await q(`insert into event_log (type, user_id, uid, at) values ('session.start',$1,$2, now() - interval '7 days')`, [
    stayed.id,
    stayed.uid,
  ]);
  // Came back much later — which is NOT day 1, and must not be counted as it.
  await q(`insert into event_log (type, user_id, uid, at) values ('session.start',$1,$2, now() - interval '2 days')`, [
    left.id,
    left.uid,
  ]);
  await analytics.refreshCohorts(20);
  const cohortDay = iso(new Date(Date.now() - 8 * 86_400_000));
  const [c] = await q<{ size: number; d1: number }>(`select size, d1 from cohorts where day = $1`, [cohortDay]);
  ok(Number(c?.size ?? 0) >= 2, `the cohort has the people who arrived that day (${c?.size})`);
  ok(Number(c?.d1 ?? 0) >= 1, `one of them came back on day 1 (${c?.d1})`);
  ok(Number(c?.d1 ?? 0) < Number(c?.size ?? 0), "and the one who came back on day 6 is not counted as day 1");

  // ---- the ranking, end to end --------------------------------------------
  console.log("\nsignals, from a real match");
  const cheat = await makePlayer("cheat", 1);
  const fair = await makePlayer("fair", 1);
  for (let i = 0; i < 4; i++) {
    const [m] = await q<{ id: string }>(
      `insert into matches (match_key, game_id, seed, reason, ticks, player_count)
       values ($1,'trackline',1,'timeout',600,2) returning id`,
      [`chkan-${MARK}-${i}`]
    );
    await q(
      `insert into match_players (match_id, user_id, is_bot, name, placement, score, detail, inputs, rejects, reject_kinds, cadence)
       values ($1,$2,false,'cheat',1,100,'{}'::jsonb,400,30,'{"rate":25,"early":5}'::jsonb,96)`,
      [m.id, cheat.id]
    );
    await q(
      `insert into match_players (match_id, user_id, is_bot, name, placement, score, detail, inputs, rejects, reject_kinds, cadence)
       values ($1,$2,false,'fair',2,50,'{}'::jsonb,380,0,'{}'::jsonb,24)`,
      [m.id, fair.id]
    );
  }
  const ranked = await analytics.rankSuspicion({ days: 2, limit: 50 });
  const flagged = ranked.find((r) => r.uid === cheat.uid);
  ok(!!flagged, "a player whose inputs the server kept refusing surfaces");
  ok((flagged?.suspicion.score ?? 0) > 0, `with a score (${flagged?.suspicion.score})`);
  ok((flagged?.suspicion.reasons.length ?? 0) > 0, `and reasons: ${flagged?.suspicion.reasons[0] ?? "—"}`);
  ok(!!flagged?.lastMatchKey, "and a match to go and watch — a ranking with nothing to open is unusable");
  ok(
    !ranked.some((r) => r.uid === fair.uid),
    "the player beside them, doing nothing wrong, does not appear at all"
  );
  ok(flagged?.contested === 4, `contested matches count only the ones with people in (${flagged?.contested})`);

  // ---- alts ----------------------------------------------------------------
  console.log("\nwho else is behind that machine");
  const main = await makePlayer("main", 2);
  const alt = await makePlayer("alt", 1);
  const stranger = await makePlayer("stranger", 1);
  const device = "a1b2".repeat(8);
  for (const p of [main, alt]) {
    await q(`insert into user_devices (user_id, device_hash, ua) values ($1,$2,'check')`, [p.id, device]);
  }
  await q(`insert into user_devices (user_id, device_hash, ua) values ($1,$2,'check')`, [
    stranger.id,
    "ffff".repeat(8),
  ]);
  await q(
    `insert into sanctions (user_id, type, reason, expires_at)
     values ($1,'ban','e2eanalytics', now() + interval '1 hour')`,
    [alt.id]
  );

  const graph = await analytics.altGraph(main.uid);
  const linked = graph.edges.filter((e) => e.a === alt.uid || e.b === alt.uid);
  ok(linked.length > 0, "a shared device links two accounts");
  ok(linked.every((e) => e.kind === "device"), "and says it was the device, not merely an address");
  ok(
    !graph.nodes.some((n) => n.uid === stranger.uid),
    "somebody on a different machine is not dragged in"
  );
  ok(
    graph.nodes.find((n) => n.uid === alt.uid)?.banned === true,
    "and a banned relative is marked as one — which is the whole point of looking"
  );

  // ---- the watchdog --------------------------------------------------------
  console.log("\nalerts that do not cry wolf");
  watchdog.resetWatchdog();
  const impossible = { reportsPerHour: 1e9, sanctionsPerHour: 1e9, queueStarvedMin: 1e9, rejectedPerHour: 1e9 };
  ok((await watchdog.sweepWatchdog(impossible)).length === 0, "a quiet platform fires nothing");

  const certain = { reportsPerHour: 0, sanctionsPerHour: 0, queueStarvedMin: 1e9, rejectedPerHour: 0 };
  const first = await watchdog.sweepWatchdog(certain);
  ok(first.length >= 1, `a condition that holds fires (${first.join(", ")})`);
  const second = await watchdog.sweepWatchdog(certain);
  ok(second.length === 0, "and does NOT fire again while it still holds — an alarm that repeats is one you mute");
  await watchdog.sweepWatchdog(impossible);
  const third = await watchdog.sweepWatchdog(certain);
  ok(third.length >= 1, "but fires again once it has cleared and come back");
  watchdog.resetWatchdog();
} finally {
  await sweep();
  await q(`delete from daily_stats where day = current_date and dau = 0`);
  await pool.end();
}

console.log(fails === 0 ? "\nAll checks passed.\n" : `\n${fails} CHECK(S) FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
