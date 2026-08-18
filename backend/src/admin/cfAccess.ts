// Cloudflare Access verification.
//
// Cloudflare protects a HOSTNAME, not a machine. If the admin process is
// reachable on a public IP, anyone who finds that IP can connect straight to it
// with a `Host:` header and walk past Access entirely — and origin IPs leak all
// the time, through old DNS records, error pages and scan databases.
//
// So when Access is configured, every request must carry the assertion
// Cloudflare signs, and it is verified against Cloudflare's own public keys.
// That, plus binding the process to localhost behind a tunnel, is what closes
// the back door.
//
// No new dependency: Node can build a public key straight from a JWK, and
// jsonwebtoken verifies against it.
import { createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export const HEADER = "cf-access-jwt-assertion";
export const cfAccessConfigured = (): boolean => Boolean(config.cfAccess.team && config.cfAccess.aud);

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let cache: { at: number; keys: Map<string, ReturnType<typeof createPublicKey>> } | null = null;
/** Cloudflare rotates these; ten minutes is short enough to follow a rotation
 *  and long enough that verification is not an HTTP call per request. */
const CACHE_MS = 10 * 60_000;

async function keys(): Promise<Map<string, ReturnType<typeof createPublicKey>>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.keys;
  const url = `https://${config.cfAccess.team}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cloudflare Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const map = new Map<string, ReturnType<typeof createPublicKey>>();
  for (const jwk of body.keys ?? []) {
    try {
      map.set(jwk.kid, createPublicKey({ key: jwk as unknown as jwt.Secret, format: "jwk" } as never));
    } catch {
      /* a key shape we cannot use is not a reason to reject every request */
    }
  }
  if (map.size === 0) throw new Error("Cloudflare Access returned no usable keys");
  cache = { at: Date.now(), keys: map };
  return map;
}

export interface AccessAssertion {
  email: string;
  sub: string;
}

/** Returns the identity Cloudflare vouched for, or null. Never throws — a
 *  failure to verify is a refusal, not a 500. */
export async function verifyAssertion(token: string | undefined): Promise<AccessAssertion | null> {
  if (!token) return null;
  try {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    if (!kid) return null;
    const key = (await keys()).get(kid);
    if (!key) return null;
    const claims = jwt.verify(token, key as unknown as jwt.Secret, {
      audience: config.cfAccess.aud,
      algorithms: ["RS256"],
    }) as { email?: string; sub?: string };
    if (!claims.email || !claims.sub) return null;
    return { email: claims.email.toLowerCase(), sub: claims.sub };
  } catch {
    return null;
  }
}
