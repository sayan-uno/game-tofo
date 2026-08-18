// Where a request or a socket actually came from.
//
// This is evidence, so the rule is deliberately paranoid: a header is believed
// ONLY when a proxy we trust is known to have written it. `X-Forwarded-For` is
// appended to by every hop, and the client controls whatever is already in it —
// so with one trusted proxy the honest value is the LAST element (the one our
// proxy added from the socket it saw), not the first. Trusting the first is the
// classic way an "IP log" ends up recording whatever the attacker typed.
//
// TRUSTED_PROXY_HOPS=0 (the default) ignores headers entirely.
import net from "node:net";
import type { Request } from "express";
import type { Socket } from "socket.io";
import { config } from "../config.js";

export interface ClientOrigin {
  ip: string | null;
  /** Two-letter code from Cloudflare, when it is in front. */
  country: string | null;
  ua: string | null;
}

/** Postgres `inet` rejects anything that is not an address, and one bad value
 *  would fail the whole batched insert — so an unparseable address becomes
 *  null rather than an exception. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is
 *  unwrapped, because the same phone must not look like two devices. */
export function normaliseIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (!ip) return null;
  // "[::1]:5432" style, and plain "1.2.3.4:5432"
  if (ip.startsWith("[")) ip = ip.slice(1, ip.indexOf("]") > 0 ? ip.indexOf("]") : undefined);
  else if (ip.split(":").length === 2) ip = ip.split(":")[0];
  if (ip.toLowerCase().startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    if (net.isIP(v4) === 4) ip = v4;
  }
  return net.isIP(ip) ? ip : null;
}

function fromHeaders(headers: Record<string, unknown>): string | null {
  const hops = config.trustedProxyHops;
  if (hops <= 0) return null;
  const cf = headers["cf-connecting-ip"];
  // Cloudflare writes exactly one address and overwrites any client attempt.
  if (typeof cf === "string") return normaliseIp(cf);
  const xff = headers["x-forwarded-for"];
  const list = (typeof xff === "string" ? xff : Array.isArray(xff) ? xff.join(",") : "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  // Count in from the RIGHT: each trusted proxy appended one entry.
  const idx = Math.max(0, list.length - hops);
  return normaliseIp(list[idx]);
}

function country(headers: Record<string, unknown>): string | null {
  if (config.trustedProxyHops <= 0) return null;
  const c = headers["cf-ipcountry"];
  if (typeof c !== "string" || c.length !== 2) return null;
  // Cloudflare uses XX for unknown and T1 for Tor.
  return c === "XX" ? null : c.toUpperCase();
}

const ua = (headers: Record<string, unknown>): string | null => {
  const v = headers["user-agent"];
  return typeof v === "string" && v ? v.slice(0, 400) : null;
};

export function requestOrigin(req: Request): ClientOrigin {
  const headers = req.headers as unknown as Record<string, unknown>;
  return {
    ip: fromHeaders(headers) ?? normaliseIp(req.socket.remoteAddress),
    country: country(headers),
    ua: ua(headers),
  };
}

export function socketOrigin(socket: Socket): ClientOrigin {
  const headers = socket.handshake.headers as unknown as Record<string, unknown>;
  return {
    ip: fromHeaders(headers) ?? normaliseIp(socket.handshake.address),
    country: country(headers),
    ua: ua(headers),
  };
}

/** The client's self-reported device fingerprint, from the socket handshake.
 *  Untrusted by definition — it is a correlation hint for spotting alt
 *  accounts, never an authentication factor — so it is only ever accepted in
 *  the exact shape it is stored in. */
export function deviceHashFrom(raw: unknown): string | null {
  return typeof raw === "string" && /^[0-9a-f]{32}$/.test(raw) ? raw : null;
}
