// Filing a report, from the player's side.
//
// This is the piece the whole moderation console was waiting on: until a
// player can say "that one, in that match", every screen behind it is a tool
// for answering a question nobody asked. It is an ordinary POST — off the
// socket, off the match runtime, nothing anybody's frame waits on.
//
// WHAT IT DOES NOT DO is tell the reporter anything about the person they
// reported. Not whether they were already reported, not whether they are a
// bot, not whether anything happened afterwards. A report is not a lookup, and
// a reporting button that leaks is a reporting button people use to probe.
import { Router } from "express";
import { requireAuth, requireAuthEvenIfBanned } from "../middleware/auth.js";
import { logEvent } from "../services/eventLog.js";
import { CATEGORIES, fileAppeal, fileReport, reportsLeftToday } from "../services/reports.js";
import { getSanctions } from "../services/sanctions.js";

export const reportsRouter = Router();

// Declared BEFORE the router-wide guard, and with its own.
//
// A full ban refuses every /api call, which would make the appeal route
// unreachable by exactly the people it exists for — a sanction with no way to
// say "this is wrong" is a decision with no way back. So this one route is
// reachable while banned; everything below it is not.
reportsRouter.post("/appeal", requireAuthEvenIfBanned, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const note = typeof body.note === "string" ? body.note : "";

  // Only somebody actually under a sanction can appeal one — otherwise this is
  // a second, unlimited way to write into the moderation queue.
  const live = await getSanctions(req.auth!.userId);
  if (!Object.keys(live).length) {
    res.status(400).json({ error: "There is nothing to appeal" });
    return;
  }

  const result = await fileAppeal({ userId: req.auth!.userId, uid: req.auth!.uid, note });
  if (!result.ok) {
    res.status(result.reason === "limit" ? 429 : 400).json({
      error:
        result.reason === "limit"
          ? "Your appeal is already in the queue. Somebody will read it."
          : "Say what you want looked at",
    });
    return;
  }
  logEvent({ type: "appeal.filed", uid: req.auth!.uid, data: {} });
  res.json({ ok: true });
});

reportsRouter.use(requireAuth);

/** What the client needs to draw the form: the categories it may offer, and
 *  how many the player has left today. */
reportsRouter.get("/", async (req, res) => {
  res.json({ categories: CATEGORIES, left: await reportsLeftToday(req.auth!.userId) });
});

reportsRouter.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  const category = typeof body.category === "string" ? body.category : "";
  if (!uid) {
    res.status(400).json({ error: "Who are you reporting?" });
    return;
  }

  const result = await fileReport({
    reporterUserId: req.auth!.userId,
    reporterUid: req.auth!.uid,
    subjectUid: uid,
    category,
    note: typeof body.note === "string" ? body.note : null,
    matchKey: typeof body.matchId === "string" ? body.matchId : null,
    lobbyId: typeof body.lobbyId === "string" ? body.lobbyId : null,
  });

  if (!result.ok) {
    const said = {
      self: "You cannot report yourself",
      unknown: "No such player",
      limit: "You have filed a lot of reports today. Try again tomorrow.",
      category: "Pick what went wrong",
    }[result.reason];
    res.status(result.reason === "limit" ? 429 : 400).json({ error: said });
    return;
  }

  // Logged for the same reason everything else is: a wave of reports against
  // one player at one moment is itself a signal, and it is unreadable after
  // the fact if only the winners were written down.
  if (result.id) {
    logEvent({
      type: "report.filed",
      uid: req.auth!.uid,
      matchKey: typeof body.matchId === "string" ? body.matchId : undefined,
      data: { about: uid, category },
    });
  }

  // Duplicate or bot, the answer is the same sentence. The player pressed a
  // button and something happened; nothing else is theirs to know.
  res.json({ ok: true, left: await reportsLeftToday(req.auth!.userId) });
});
