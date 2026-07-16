import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { config, assertConfig } from "./config.js";
import { redis } from "./redis.js";
import { authRouter } from "./routes/auth.js";
import { friendsRouter } from "./routes/friends.js";
import { voiceRouter } from "./routes/voice.js";
import { registerSockets } from "./sockets/index.js";

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

registerSockets(io);

async function start() {
  await redis.connect();
  console.log("✔ Redis connected");
  server.listen(config.port, () => {
    console.log(`✔ TOFO Games backend listening on http://localhost:${config.port}`);
    console.log(`  Allowing frontend origin: ${config.frontendUrl}`);
  });
}

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
