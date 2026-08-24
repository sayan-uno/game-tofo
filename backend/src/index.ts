import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { config, assertConfig } from "./config.js";
import { redis } from "./redis.js";
import { authRouter } from "./routes/auth.js";
import { friendsRouter } from "./routes/friends.js";
import { voiceRouter } from "./routes/voice.js";
import { chatRouter } from "./routes/chat.js";
import { profileRouter } from "./routes/profile.js";
import { collectionRouter } from "./routes/collection.js";
import { gamesRouter } from "./routes/games.js";
import { noticesRouter } from "./routes/notices.js";
import { reportsRouter } from "./routes/reports.js";
import { playerEventsRouter } from "./routes/events.js";
import { storeRouter } from "./routes/store.js";
import { payHookRouter } from "./routes/payHook.js";
// Registers every game with the platform (one import per game folder).
import "./games/index.js";
import { registerSockets, broadcastLobby } from "./sockets/index.js";
import { startMatchmaker } from "./platform/matchmaking.js";
import { clearStaleMatchState } from "./platform/store.js";
import { startChatRetention } from "./services/chat.js";
import { flushWorldChat, startWorldChatArchive, stopWorldChatArchive } from "./services/worldChat.js";
import { ensureBotPool, loadBotPool } from "./platform/botAccounts.js";
import { clearStaleBotSeats } from "./platform/botSeats.js";
import { clearStaleWorldState, WORLD_CAPACITY } from "./platform/world.js";
import { startWorldLife, stopWorldLife } from "./platform/worldLife.js";
import { botTelemetry } from "./platform/bots.js";
import { clearOnlineSet, clearStalePresence } from "./redis.js";
import { gateReason, gateShut, getFlags, setGate, startMaintenanceWatch } from "./platform/flags.js";
import { refreshWithdrawn, startWithdrawnWatch } from "./platform/gameLocks.js";
import { flushEvents, startEventLog, stopEventLog } from "./services/eventLog.js";
import { startPaymentSweeper, stopPaymentSweeper } from "./platform/paymentSweeper.js";
import { seedPacks } from "./services/payments.js";
import { warmSanctionCache } from "./services/sanctions.js";
import { startOpsSnapshot, stopOpsSnapshot } from "./platform/ops.js";
import { startOpsCommands, stopOpsCommands } from "./platform/opsCommands.js";
import { readiness as voiceReadiness, warmVoiceTargets } from "./platform/voiceRecording.js";
import {
  drainReplays,
  startReplaySweeper,
  startReplayWorker,
  stopReplaySweeper,
  stopReplayWorker,
  warmReplayTargets,
} from "./platform/replay.js";
import { mountAdmin, prepareAdmin } from "./admin/index.js";

const missing = assertConfig();
if (missing.length > 0) {
  console.error(`✖ Missing environment variables in backend/.env: ${missing.join(", ")}`);
  console.error("  Fill them in and restart. See backend/.env for instructions.");
  process.exit(1);
}

const app = express();

// The frontend is a completely separate app — everything goes through CORS.
// FRONTEND_URL is the only coupling point on this side.
//
// Only in the game process: the console has its own, much narrower CORS policy
// (one origin, with credentials), and two policies on one response is a
// browser error rather than a stricter rule.
if (config.role === "game") {
  app.use(
    cors({
      origin: config.frontendUrl,
      credentials: false,
    })
  );
}
// Bodies are capped tight, with ONE exception that has to be declared here
// rather than on the route.
//
// A route-level parser cannot raise a limit the global one has already
// enforced: this middleware runs first, and a twelve-megabyte upload was being
// rejected as too large before the route that knows how to accept it was ever
// reached. So the upload path is skipped here and parses its own body, with
// its own limit, in one place — every other route keeps the tight cap.
const tightJson = express.json({ limit: "100kb" });
app.use((req, res, next) => {
  const isUpload = req.method === "POST" && /\/events$/.test(req.path);
  // The payment webhook reads its OWN raw body (routes/payHook.ts). It has to:
  // a malformed body from an open route must become a logged row, and a parser
  // mounted out here would instead throw before the handler that knows how to
  // record it ever ran.
  const isPayHook = req.method === "POST" && req.path.startsWith("/pay/");
  if (isUpload || isPayHook) return next();
  return tightJson(req, res, next);
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "tofo-games-backend" }));

// How the bots are doing, for tuning. Behind OPS_KEY because it is operational
// detail rather than anything a player should see — and unavailable at all
// until that key is set, so it cannot be left open by forgetting to configure
// it. Counters are process-local and reset on restart; they are a live read of
// this instance, not a history.
app.get("/ops/bots", (req, res) => {
  const key = process.env.OPS_KEY;
  if (!key || req.header("x-ops-key") !== key) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // One block per game: difficulty is a property of a game, and averaging two
  // of them together describes neither.
  const games = Object.fromEntries(
    Object.entries(botTelemetry()).map(([id, t]) => [
      id,
      {
        ...t,
        botWinRate: t.matches ? Math.round((t.botWins / t.matches) * 100) : null,
        avgBotDistance: t.hasDistance && t.botRuns ? Math.round(t.botDistance / t.botRuns) : null,
        avgHumanDistance: t.hasDistance && t.humanRuns ? Math.round(t.humanDistance / t.humanRuns) : null,
      },
    ])
  );
  res.json({ games });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.frontendUrl },
  transports: ["websocket", "polling"],
});

// Everything below belongs to the GAME process and to nothing else.
//
// A process started with ROLE=admin serves the console API (from A1) and must
// carry none of this: not the player routes, and above all not the matchmaker.
// Two matchmakers on one Redis both claim parties from the same pool, and the
// one that wins creates the match in its own memory and emits to its own
// sockets — so the player sits on FINDING PLAYERS for ever while the other
// process's log cheerfully reports a match starting. This branch is what makes
// running a second process safe at all.
if (config.role === "recorder") {
  // Nothing is served. The recorder talks to LiveKit and Redis and to nobody
  // else; there is no route worth exposing and every one would be a way in.
} else if (config.role === "game") {
  // EVERY game route, shut. Before any of them, so nothing has to remember to
  // check — a gate somebody can forget to apply to their new endpoint is not a
  // gate. The admin console is a different process on a different port with
  // its own routes, so this cannot lock an admin out of ending it.
  app.use("/api", (req, res, next) => {
    if (!gateShut()) return next();
    res.status(503).json({ error: gateReason(), code: "MAINTENANCE" });
  });
  app.use("/api/auth", authRouter);
  app.use("/api/friends", friendsRouter(io));
  app.use("/api/voice", voiceRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/profile", profileRouter);
  app.use("/api/collection", collectionRouter(io));
  app.use("/api/games", gamesRouter);
  app.use("/api/notices", noticesRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/events", playerEventsRouter);
  app.use("/api/store", storeRouter(io));
  // OUTSIDE the /api gate, on purpose. A session opened before a maintenance
  // window still has real money in the air, and the SMS that settles it must
  // land whatever else the platform is doing. It carries its own key, its own
  // rate limit and its own body parser — see routes/payHook.ts.
  app.use("/pay", payHookRouter(io));
  registerSockets(io);
  // The packer: fills waiting parties from the pool, then with bots.
  startMatchmaker(io);
} else {
  // The console: its own CORS, its own secret path, its own token audience,
  // and none of the above.
  mountAdmin(app);
}

async function start() {
  await redis.connect();
  console.log("✔ Redis connected");
  // The activity trail buffers in memory and flushes on a timer — start it
  // before anything that might want to record something.
  startEventLog();

  if (config.role === "game") {
    // Matches live in this process; their Redis bindings do not. Anything left
    // from a previous run points at a match that no longer exists.
    const stale = await clearStaleMatchState();
    if (stale > 0) console.log(`✔ Cleared ${stale} stale match/matchmaking key(s) from a previous run`);
    // Same reasoning for the online set: nobody can be connected to a process
    // that has not started, so whatever is in there is a leftover.
    await clearOnlineSet();
    // …and the per-player keys behind it. Until these carried a TTL the only
    // thing that removed one was a clean disconnect, so a crash or a deploy
    // left everybody who happened to be playing marked online for ever — the
    // friends list showing people who had not been there for days.
    const ghosts = await clearStalePresence();
    if (ghosts > 0) console.log(`✔ Cleared ${ghosts} presence key(s) left by a previous run`);
    // Enforcement reads Redis, so Redis has to know. Without this a flushed
    // cache silently un-bans everyone until their next sanction change.
    const warmed = await warmSanctionCache();
    if (warmed > 0) console.log(`✔ Restored ${warmed} sanctioned player(s) into the enforcement cache`);
    startChatRetention();
    // World chat's archive: buffered, flushed on a timer, never on a send.
    startWorldChatArchive();
    // Payment sessions whose grace has run out, marked as such. Bookkeeping
    // only — the Redis reservation carries its own TTL and has already let go,
    // so a sweeper that never runs cannot strand an amount.
    startPaymentSweeper();
    // The shelf, if nothing has put one there yet. `do nothing` on conflict,
    // so a price an admin has changed is never reset by a deploy.
    await seedPacks();

    // ---- worlds and the population that fills them (W1–W3) ----
    //
    // Order matters. The pool has to be in memory before any world is
    // balanced, and the stale state has to be gone before the pool is handed
    // out — a seat key left by a previous run points at a bot this process's
    // hold table has never heard of, which is how one account ends up in two
    // places at once.
    const seatsLeft = await clearStaleBotSeats();
    if (seatsLeft > 0) console.log(`✔ Cleared ${seatsLeft} bot seat key(s) left by a previous run`);
    const worldGhosts = await clearStaleWorldState();
    if (worldGhosts > 0) console.log(`✔ Cleared ${worldGhosts} world membership(s) left by a previous run`);
    const pool = await loadBotPool();
    // Enough to stand up one world plus the seats matches and parties take.
    // Growth beyond this is on demand: worlds mint what they need as real
    // players arrive, so a quiet server never carries a population it is not
    // using. Never fatal — a platform that will not start because it could not
    // make believe is worse than one with a thin room.
    const wanted = Math.round(WORLD_CAPACITY * 1.2);
    const minted = await ensureBotPool(wanted).catch((err: unknown) => {
      console.error("[bots] could not grow the pool at boot:", err);
      return 0;
    });
    console.log(`✔ Bot pool ready (${pool} loaded, ${minted} minted)`);
    // Same reasoning as the ban cache: a flushed Redis must not silently
    // downgrade a flagged player's replay retention back to thirty days.
    const flagged = await warmReplayTargets();
    if (flagged > 0) console.log(`✔ ${flagged} player(s) on extended replay retention`);
    startReplayWorker();
    startReplaySweeper();
    // A party marked live at boot cannot be — nobody is in it.
    const { closeStaleParties } = await import("./platform/partyLog.js");
    await closeStaleParties().catch((e) => console.error("[party] recover:", e));
    const voice = await warmVoiceTargets();
    if (voice > 0) console.log(`✔ ${voice} player(s) flagged for voice recording`);
    // Say it at boot rather than at the moment somebody needed the audio:
    // switched on with nowhere to write is the one failure here that looks
    // like nothing at all until it is quoted as evidence.
    // Read before anything is served: an instance that comes up during a
    // maintenance window must not answer a single request first.
    const bootFlags = await getFlags();
    setGate(bootFlags.maintenance, bootFlags.maintenanceMessage);
    if (bootFlags.maintenance) console.log("⚠ Starting INTO a maintenance window — the platform is shut");

    // Withdrawn items, into memory before the first lobby is drawn: the
    // resolvers read them synchronously on every broadcast.
    const pulled = await refreshWithdrawn();
    if (pulled > 0) console.log(`✔ ${pulled} catalogue item(s) withdrawn`);
    startWithdrawnWatch();

    const voiceState = voiceReadiness();
    if (config.voiceRecording.enabled && !voiceState.ready) {
      console.warn(`⚠ Voice recording is switched ON but cannot run: ${voiceState.why}`);
    }
    // The worlds tick: fills the groups people asked for, keeps the population
    // honest, and gives the rooms something to say.
    startWorldLife(io, { broadcastLobby });
    startOpsSnapshot(io);
    startOpsCommands(io);
    // When a scheduled window falls due: tell everybody, and end every match
    // rather than let them run into a restart that would drop them anyway.
    startMaintenanceWatch(async (flags) => {
      io.emit("platform:maintenance", { active: true, at: flags.maintenanceAt, message: flags.maintenanceMessage });
      const { endAllMatches } = await import("./platform/match.js");
      await endAllMatches(io, "maintenance");
      // …and close every connection. The page can be edited; the socket
      // cannot. See the ops command for the reasoning.
      setTimeout(() => {
        for (const s of io.sockets.sockets.values()) s.disconnect(true);
      }, 1500);
    });
  } else if (config.role === "recorder") {
    const { startRecorder } = await import("./recorder/index.js");
    await startRecorder();
  } else {
    await prepareAdmin();
    // The aggregate job lives HERE, in the console's own process, and not in
    // the game's. It is a handful of heavy grouped reads over the biggest
    // tables the platform has, and the whole point of the two-process split is
    // that work like that can never land on the event loop serving inputs.
    // The cost is that the dashboard stops advancing when the console is down
    // — which is exactly when nobody is reading it.
    const { startAnalytics } = await import("./services/analytics.js");
    startAnalytics();
    console.log("✔ Analytics aggregate running (hourly, three-day rolling rebuild)");
    // And the watches that reach a phone. Here for the same reason: they are
    // aggregate reads, and the game process must never do those.
    const { startWatchdog } = await import("./services/watchdog.js");
    startWatchdog();
  }

  // The recorder has no HTTP surface; a listening socket would only be one
  // more thing that can be reached.
  if (config.role === "recorder") {
    console.log(`✔ TOFO recorder running (role: recorder)`);
    return;
  }

  server.listen(config.port, () => {
    console.log(`✔ TOFO Games backend listening on http://localhost:${config.port} (role: ${config.role})`);
    if (config.role === "game") console.log(`  Allowing frontend origin: ${config.frontendUrl}`);
  });
}

/** Stop cleanly: the last couple of seconds of the activity trail are still in
 *  memory, and losing them on every deploy would put holes in the one record
 *  that is supposed to be complete. */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n… ${signal} — flushing before exit`);
  stopOpsSnapshot();
  stopWorldLife();
  stopEventLog();
  stopWorldChatArchive();
  stopPaymentSweeper();
  stopReplaySweeper();
  stopReplayWorker();
  await stopOpsCommands();
  // A replay queued in the last few seconds is still in Redis, so nothing is
  // lost by exiting — but draining now means it is in the archive before the
  // process that made it goes away.
  await drainReplays().catch(() => undefined);
  const flushed = await flushEvents();
  if (flushed > 0) console.log(`✔ Wrote ${flushed} pending event(s)`);
  const chatter = await flushWorldChat().catch(() => 0);
  if (chatter > 0) console.log(`✔ Wrote ${chatter} pending world message(s)`);
  server.close(() => process.exit(0));
  // Never hang a deploy on a socket that will not close.
  setTimeout(() => process.exit(0), 5000).unref();
}
/** ONE PLAYER'S BAD MESSAGE MUST NOT DISCONNECT EVERY OTHER PLAYER.
 *
 *  Node's default for an unhandled rejection is to exit. On a game server that
 *  means a single malformed emit — an argument in the wrong slot, a payload
 *  where a callback was expected — takes down every session on the process.
 *  That happened: a handler threw while REPORTING an earlier throw, from
 *  inside its own catch, and the whole server went with it.
 *
 *  So the process survives, and says so as loudly as it can. This is a net,
 *  not a licence: every line it prints is a bug that has already caused
 *  somebody an error, and it prints the whole stack so it cannot be ignored.
 *  Handlers still validate their own arguments (see sockets/ack.ts). */
process.on("unhandledRejection", (reason) => {
  console.error("✖ UNHANDLED REJECTION — the process stayed up; this is a bug:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("✖ UNCAUGHT EXCEPTION — the process stayed up; this is a bug:", err);
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
