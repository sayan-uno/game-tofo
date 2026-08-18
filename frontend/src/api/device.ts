// A stable, coarse fingerprint of this browser.
//
// Its ONLY job is linking accounts that share a device, which is how ban
// evasion becomes visible in the admin console. It is deliberately weak: no
// canvas or font probing, nothing that would make it a tracking identifier,
// and nothing that survives a different browser on the same machine.
//
// It is derived rather than stored, so clearing site data does not reset it —
// a stored random id would be cleared by exactly the person we most want to
// recognise. The server treats it as an untrusted hint and never as identity.
const parts = (): string => {
  const s = window.screen;
  return [
    navigator.userAgent,
    navigator.language,
    (navigator.languages ?? []).join(","),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).platform ?? "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    String((navigator as any).hardwareConcurrency ?? ""),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    String((navigator as any).deviceMemory ?? ""),
    `${s.width}x${s.height}x${s.colorDepth}`,
    String(new Date().getTimezoneOffset()),
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
  ].join("|");
};

let cached: string | null = null;

/** 32 lowercase hex characters, or null if the browser cannot hash (an
 *  insecure context). Null is fine — the field is optional everywhere. */
export async function deviceHash(): Promise<string | null> {
  if (cached) return cached;
  try {
    const bytes = new TextEncoder().encode(parts());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    cached = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    return cached;
  } catch {
    return null;
  }
}

/** Whatever has been computed so far, without waiting. The socket handshake
 *  uses this: a first connection that beats the hash simply sends nothing, and
 *  the next reconnect carries it. */
export const deviceHashNow = (): string | null => cached;

// Warm it as soon as the module loads, so it is almost always ready by the
// time a socket opens.
void deviceHash();
