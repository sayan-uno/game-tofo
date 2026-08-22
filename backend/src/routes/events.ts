// The events a player can see, and the media behind them.
//
// Media is served through here rather than straight from the bucket because
// the bucket is private: the alternative is making it public, and a public
// bucket is a decision that is easy to make and hard to take back.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { liveEventsForPlayers } from "../services/events.js";
import { getEvidence } from "../platform/evidence.js";

export const playerEventsRouter = Router();

// MEDIA IS PUBLIC, and has to be.
//
// It is fetched by an <img> or a <video> tag, and neither can send an
// Authorization header — so a route behind requireAuth is a route that always
// answers 401 to the only thing that ever asks it. Which is fine: an event
// banner is an advertisement. It is meant to be looked at, it carries nothing
// about any player, and its id is a uuid nobody can guess their way to.
//
// Declared BEFORE the auth gate below, because order is what makes it public.
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
};

playerEventsRouter.get("/:id/media", async (req, res) => {
  const rows = await liveEventsForPlayers(100);
  const found = rows.find((e) => e.id === req.params.id);
  if (!found || found.kind === "html") {
    res.status(404).json({ error: "No such event" });
    return;
  }
  const bytes = await getEvidence(found.body);
  if (!bytes) {
    res.status(404).json({ error: "That file is no longer here" });
    return;
  }
  const ext = found.body.split(".").pop() ?? "";
  res.setHeader("Content-Type", TYPES[ext] ?? "application/octet-stream");
  // An event's media never changes — a new picture is a new event with a new
  // id — so it can be cached hard. Deleting the event stops the list naming
  // it, which is what actually takes it off screen.
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.send(bytes);
});

playerEventsRouter.use(requireAuth);

playerEventsRouter.get("/", async (_req, res) => {
  const rows = await liveEventsForPlayers();
  res.json({
    events: rows.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      pinned: e.pinned,
      itemId: e.itemId,
      createdAt: e.createdAt,
      // html carries its own markup; the other two carry a URL to fetch.
      body: e.kind === "html" ? e.body : `/api/events/${e.id}/media`,
    })),
  });
});
