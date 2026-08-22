// Analytics, signals, and the alt graph.
//
// THE ROLE SPLIT IS THE POINT OF THIS FILE. An analyst sees aggregates and
// nothing else — no uid, no name, no individual anything — because that is
// what the role was defined as on day one and a dashboard is exactly where
// "just this once" starts. So the numbers sit behind `analyst`, and everything
// that names a person sits behind `moderator`.
//
// The dashboards read the nightly table and never the raw log. The signals and
// the graph do read live tables: they are opened deliberately, one question at
// a time, and a stale answer to "who is worth watching" is worse than a slow
// one.
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin } from "../guard.js";
import { audit } from "../audit.js";
import { requestOrigin } from "../../services/clientIp.js";
import { altGraph, rankSuspicion, readCohorts, readDaily, runNightly } from "../../services/analytics.js";

export const analyticsRouter = safeRouter();

/** Totals, funnel and cohorts. The only screen an analyst can open. */
analyticsRouter.get("/analytics", requireAdmin("analyst"), async (req, res) => {
  const days = Math.max(7, Math.min(365, Number(req.query.days ?? 30)));
  const [daily, cohorts] = await Promise.all([readDaily(days), readCohorts(Math.min(days, 60))]);
  res.json({ daily, cohorts, days });
});

/** Rebuild on demand. Useful the first time somebody opens the screen on a
 *  platform whose console has not been running long enough for the hourly job
 *  to have written anything — an empty dashboard reads as a broken one. */
analyticsRouter.post("/analytics/rebuild", requireAdmin("admin"), async (req, res) => {
  await runNightly();
  await audit(req.admin!, { action: "analytics.rebuild", targetType: "platform", ip: requestOrigin(req).ip });
  res.json({ ok: true });
});

/**
 * Who is worth watching.
 *
 * Moderator and up: this names people. It is a RANKING and the response says
 * so in the reasons it carries — the next step is the studio, not a ban.
 */
analyticsRouter.get("/signals", requireAdmin("moderator"), async (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days ?? 14)));
  res.json({ players: await rankSuspicion({ days, limit: 50 }), days });
});

/**
 * Everybody connected to one player, and how.
 *
 * Admin and up, and audited: this is device and address linkage — the console's
 * standing rule is that sensitive READS are logged, not only writes, and
 * "who has been looking at whom" has to stay answerable.
 */
analyticsRouter.get("/signals/alts/:uid", requireAdmin("admin"), async (req, res) => {
  const uid = String(req.params.uid);
  const graph = await altGraph(uid);
  await audit(req.admin!, {
    action: "alts.view",
    targetType: "user",
    targetId: uid,
    after: { linked: graph.nodes.length - 1 },
    ip: requestOrigin(req).ip,
  });
  res.json(graph);
});
