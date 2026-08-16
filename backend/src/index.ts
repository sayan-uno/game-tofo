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

const missing = assertConfig();
if (missing.length > 0) {
  console.error(`✖ Missing environment variables in backend/.env: ${missing.join(", ")}`);
  console.error("  Fill them in and restart. See backend/.env for instructions.");
  process.exit(1);
}

const app = express();

// The frontend is a completely separate app — everything goes through CORS.
// FRONTEND_URL is the only coupling point on this side.
app.use(
  cors({
    origin: config.frontendUrl,
    credentials: false,
  })
);
app.use(express.json({ limit: "100kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "tofo-games-backend" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.frontendUrl },
  transports: ["websocket", "polling"],
});

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

async function start() {
  await redis.connect();
  console.log("✔ Redis connected");
  // Matches live in this process; their Redis bindings do not. Anything left
  // from a previous run points at a match that no longer exists.
  const stale = await clearStaleMatchState();
  if (stale > 0) console.log(`✔ Cleared ${stale} stale match/matchmaking key(s) from a previous run`);
  startChatRetention();
  server.listen(config.port, () => {
    console.log(`✔ TOFO Games backend listening on http://localhost:${config.port}`);
    console.log(`  Allowing frontend origin: ${config.frontendUrl}`);
  });
}

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
