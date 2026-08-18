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
// Registers every game with the platform (one import per game folder).
import "./games/index.js";
import { registerSockets } from "./sockets/index.js";
import { startMatchmaker } from "./platform/matchmaking.js";
import { clearStaleMatchState } from "./platform/store.js";
import { startChatRetention } from "./services/chat.js";
import { botTelemetry } from "./platform/bots.js";
import { clearOnlineSet } from "./redis.js";
import { flushEvents, startEventLog, stopEventLog } from "./services/eventLog.js";
import { warmSanctionCache } from "./services/sanctions.js";
import { startOpsSnapshot, stopOpsSnapshot } from "./platform/ops.js";
import { startOpsCommands, stopOpsCommands } from "./platform/opsCommands.js";
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
app.use(express.json({ limit: "100kb" }));

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
if (config.role === "game") {
  app.use("/api/auth", authRouter);
  app.use("/api/friends", friendsRouter(io));
  app.use("/api/voice", voiceRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/profile", profileRouter);
  app.use("/api/collection", collectionRouter(io));
  app.use("/api/games", gamesRouter);

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
    // Enforcement reads Redis, so Redis has to know. Without this a flushed
    // cache silently un-bans everyone until their next sanction change.
    const warmed = await warmSanctionCache();
    if (warmed > 0) console.log(`✔ Restored ${warmed} sanctioned player(s) into the enforcement cache`);
    startChatRetention();
    // Same reasoning as the ban cache: a flushed Redis must not silently
    // downgrade a flagged player's replay retention back to thirty days.
    const flagged = await warmReplayTargets();
    if (flagged > 0) console.log(`✔ ${flagged} player(s) on extended replay retention`);
    startReplayWorker();
    startReplaySweeper();
    startOpsSnapshot(io);
    startOpsCommands(io);
  } else {
    await prepareAdmin();
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
  stopEventLog();
  stopReplaySweeper();
  stopReplayWorker();
  await stopOpsCommands();
  // A replay queued in the last few seconds is still in Redis, so nothing is
  // lost by exiting — but draining now means it is in the archive before the
  // process that made it goes away.
  await drainReplays().catch(() => undefined);
  const flushed = await flushEvents();
  if (flushed > 0) console.log(`✔ Wrote ${flushed} pending event(s)`);
  server.close(() => process.exit(0));
  // Never hang a deploy on a socket that will not close.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
