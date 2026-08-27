// The console API, assembled.
//
// Everything lives under one secret path segment and nothing is reachable off
// it — the same trick /ops/bots already uses, and for the same reason: a wrong
// guess should look identical to a URL that does not exist. It is a filter
// against scanners, never a gate; assume the path leaks and make sure the
// stack behind it still holds.
//
// Order matters here. CORS first, so a browser gets a usable answer even when
// the request is going to be refused. Then Cloudflare, which is the only gate
// that can turn away a request before any of this code runs on it. Then the
// routes, each of which applies its own session and role checks.
import express, { type Express } from "express";
import { adminErrors, safeRouter } from "./asyncRouter.js";
import { config } from "../config.js";
import { adminCors, cloudflareGate } from "./guard.js";
import { cfAccessConfigured } from "./cfAccess.js";
import { bootstrapFirstAdmin } from "./accounts.js";
import { seedPacks } from "../services/payments.js";
import { authRouter } from "./routes/auth.js";
import { overviewRouter } from "./routes/overview.js";
import { adminsRouter } from "./routes/admins.js";
import { playersRouter } from "./routes/players.js";
import { enforcementRouter } from "./routes/enforcement.js";
import { eventsRouter } from "./routes/events.js";
import { replaysRouter } from "./routes/replays.js";
import { chatsRouter } from "./routes/chats.js";
import { historyRouter } from "./routes/history.js";
import { partiesRouter } from "./routes/parties.js";
import { worldsRouter } from "./routes/worlds.js";
import { islandsRouter } from "./routes/islands.js";
import { voiceRouter } from "./routes/voice.js";
import { reportsRouter } from "./routes/reports.js";
import { analyticsRouter } from "./routes/analytics.js";
import { paymentsRouter } from "./routes/payments.js";
import { pricingRouter } from "./routes/pricing.js";

/** JSON only, so the headers that matter are the ones that stop a browser
 *  guessing at content and stop anything being cached on the way. */
function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
}

export function mountAdmin(app: Express): void {
  const base = `/${config.admin.path}`;
  const router = safeRouter();

  router.use(adminCors());
  router.use(securityHeaders);
  // Preflight must answer before the Cloudflare gate: a browser that cannot
  // complete the preflight reports a CORS error, which is a considerably worse
  // thing to debug than a 404.
  router.options(/.*/, adminCors());
  router.use((req, res, next) => void cloudflareGate(req, res, next));

  router.use("/session", authRouter);
  router.use("/overview", overviewRouter);
  router.use("/admins", adminsRouter);
  router.use("/players", playersRouter);
  router.use("/replays", replaysRouter);
  router.use(voiceRouter);
  router.use(partiesRouter);
  router.use(worldsRouter);
  router.use(islandsRouter);
  router.use(reportsRouter);
  router.use(analyticsRouter);
  // Mounted at the root: it owns /payments/*, and /players/:uid/wallet, which
  // belongs on the player page rather than under a "payments" noun.
  router.use(paymentsRouter);
  router.use(pricingRouter);
  router.use(historyRouter);
  router.use(chatsRouter);
  router.use(eventsRouter);
  // Mounted at the root: it owns /players/:uid/sanctions, /sanctions and
  // /platform, which do not all live under one noun.
  router.use(enforcementRouter);

  // Last, so anything a handler rejected with lands here as JSON.
  router.use(adminErrors);
  app.use(base, router);
  console.log(`✔ Admin console API mounted at ${base}/`);
  if (!cfAccessConfigured()) {
    console.warn(
      "⚠ Cloudflare Access is not configured (CF_ACCESS_TEAM / CF_ACCESS_AUD).\n" +
        "  The console is protected by the secret path, Google sign-in and the authenticator,\n" +
        "  but nothing is stopping requests before they reach this process."
    );
  }
}

/** Called once at boot, before the server listens. */
export async function prepareAdmin(): Promise<void> {
  await bootstrapFirstAdmin();
  // The console must never open on an empty shelf: on a fresh database the
  // admin process may well start before any game process has, and "there are
  // no gem packs" reads as a bug rather than as a first boot.
  await seedPacks();
}
