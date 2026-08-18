// A Router whose async handlers cannot take the process down.
//
// Express 4 calls a handler and ignores what it returns. An `async` handler
// that rejects therefore produces an unhandled promise rejection, and Node
// ends the process on those — so ONE bad query anywhere in the console kills
// the server for everybody, with no answer sent to the request that caused it.
// That is exactly what happened the first time a query in the replay list was
// wrong, and it is not an acceptable failure mode for the thing you reach for
// when something is already going wrong.
//
// This wraps every handler so a rejection becomes `next(err)`, where the error
// middleware turns it into a 500 with a JSON body — the console then shows a
// message instead of going silent.
import { Router, type IRouter, type NextFunction, type Request, type RequestHandler, type Response } from "express";

const wrap = (fn: RequestHandler): RequestHandler =>
  function wrapped(req, res, next) {
    try {
      const out = (fn as (a: Request, b: Response, c: NextFunction) => unknown)(req, res, next);
      if (out instanceof Promise) out.catch(next);
    } catch (err) {
      next(err as Error);
    }
  };

const METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "all", "use"] as const;

/** Use this instead of express.Router() anywhere in the console. */
export function safeRouter(): IRouter {
  const router = Router();
  for (const method of METHODS) {
    const original = (router as unknown as Record<string, (...a: unknown[]) => unknown>)[method].bind(router);
    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map((a) => (typeof a === "function" ? wrap(a as RequestHandler) : a)));
  }
  return router;
}

/** Last in the chain. Answers in JSON, because the console's client parses
 *  JSON and an HTML error page is what turns a clear failure into
 *  "something went wrong". */
export function adminErrors(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  console.error(`[admin] ${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "The console hit an error handling that. It has been logged.", code: "SERVER_ERROR" });
}
