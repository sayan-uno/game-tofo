// The event controller: what players are shown when they arrive.
//
// Media is uploaded here rather than pasted in as a link. A link to somebody
// else's server is a picture that can change after it is approved, disappear
// on a Sunday, or quietly count who looked at it — none of which an admin
// signed up for when they pinned a banner.
import { safeRouter } from "../asyncRouter.js";
import express from "express";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
import { requestOrigin } from "../../services/clientIp.js";
import { createEvent, deleteEvent, listEvents, setPinned, type EventKind } from "../../services/events.js";
import { getEvidence, putEvidence } from "../../platform/evidence.js";
import { publicCatalog } from "../../services/catalog.js";
import { withdrawnItems } from "../../platform/gameLocks.js";
import { logEvent } from "../../services/eventLog.js";

export const eventsRouter = safeRouter();

/** Big enough for a banner or a short clip, small enough that one careless
 *  paste cannot exhaust the process. The global parser stays at 100kb — this
 *  raise applies to exactly one route. */
const UPLOAD_LIMIT = "12mb";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

eventsRouter.get("/events", requireAdmin("moderator"), async (_req, res) => {
  res.json({ events: await listEvents() });
});

eventsRouter.post(
  "/events",
  requireAdmin("admin"),
  requireSudo,
  express.json({ limit: UPLOAD_LIMIT }),
  async (req, res) => {
    const { title, kind, body, pinned, itemId } = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof title === "string" ? title.trim().slice(0, 120) : "";
    if (name.length < 2) {
      res.status(400).json({ error: "Give it a title — it is how you will find it later" });
      return;
    }
    if (kind !== "image" && kind !== "video" && kind !== "html") {
      res.status(400).json({ error: "An event is an image, a video, or a piece of HTML" });
      return;
    }

    // The item this is about, if any. Checked against the real catalogue: an
    // advert that opens the collection at nothing is worse than one that does
    // not open it at all.
    let item: string | null = null;
    if (typeof itemId === "string" && itemId.trim()) {
      const cat = publicCatalog();
      const known = [...cat.characters, ...cat.weapons, ...cat.emotes].some((x) => x.id === itemId.trim());
      if (!known) {
        res.status(400).json({ error: "No such item in the collection" });
        return;
      }
      // …and not one that has been withdrawn. An event that sends players to
      // something they are not allowed to see is worse than one that sends
      // them nowhere: they arrive at a collection with nothing selected and
      // conclude the game is broken.
      if ((await withdrawnItems()).includes(itemId.trim())) {
        res.status(400).json({ error: "That item is withdrawn — players cannot see it" });
        return;
      }
      item = itemId.trim();
    }

    let stored = "";
    if (kind === "html") {
      stored = String(body ?? "").slice(0, 20_000);
      if (!stored.trim()) {
        res.status(400).json({ error: "Nothing to show" });
        return;
      }
    } else {
      // A data URL from the admin's own file picker.
      const raw = String(body ?? "");
      const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(raw);
      if (!m) {
        res.status(400).json({ error: "Choose a file to upload" });
        return;
      }
      const ext = EXT[m[1]];
      if (!ext) {
        res.status(400).json({ error: `${m[1]} is not a format players' browsers can be relied on to show` });
        return;
      }
      const bytes = Buffer.from(m[2], "base64");
      if (bytes.length === 0) {
        res.status(400).json({ error: "That file is empty" });
        return;
      }
      const key = `events/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await putEvidence(key, bytes, m[1]);
      stored = key;
    }

    const row = await createEvent({
      title: name,
      kind: kind as EventKind,
      body: stored,
      pinned: pinned === true,
      itemId: item,
      createdBy: req.admin!.email,
    });
    await audit(req.admin!, {
      action: "event.create",
      targetType: "platform",
      targetId: row.id,
      after: { title: name, kind, pinned: row.pinned, itemId: item },
      ip: requestOrigin(req).ip,
    });
    logEvent({ type: "event.create", data: { id: row.id, title: name, kind, by: req.admin!.email } });
    res.json({ event: row });
  }
);

/** The media, for the console's own preview.
 *
 *  A separate route from the players' one because this side is authenticated
 *  and that side is not, and because an admin must be able to see what they
 *  uploaded even after it has been deleted — the players' route serves only
 *  live events, which is right for players and useless for reviewing what was
 *  taken down. */
eventsRouter.get("/events/:id/media", requireAdmin("moderator"), async (req, res) => {
  const all = await listEvents(200);
  const found = all.find((e) => e.id === req.params.id);
  if (!found || found.kind === "html") {
    res.status(404).json({ error: "No such event" });
    return;
  }
  const bytes = await getEvidence(found.body);
  if (!bytes) {
    res.status(404).json({ error: "That file is no longer in the archive" });
    return;
  }
  const ext = found.body.split(".").pop() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  res.setHeader("Content-Type", types[ext] ?? "application/octet-stream");
  res.send(bytes);
});

eventsRouter.post("/events/:id/pin", requireAdmin("admin"), requireSudo, async (req, res) => {
  const on = (req.body ?? {}).on === true;
  const ok = await setPinned(String(req.params.id), on);
  if (!ok) {
    res.status(404).json({ error: "No such event" });
    return;
  }
  await audit(req.admin!, {
    action: on ? "event.pin" : "event.unpin",
    targetType: "platform",
    targetId: String(req.params.id),
    ip: requestOrigin(req).ip,
  });
  res.json({ ok: true });
});

eventsRouter.delete("/events/:id", requireAdmin("admin"), requireSudo, async (req, res) => {
  const ok = await deleteEvent(String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: "No such event, or it is already gone" });
    return;
  }
  await audit(req.admin!, {
    action: "event.delete",
    targetType: "platform",
    targetId: String(req.params.id),
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "event.delete", data: { id: String(req.params.id), by: req.admin!.email } });
  res.json({ ok: true });
});
