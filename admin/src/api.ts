// Talking to the console API.
//
// The access token lives in a module variable and NOWHERE else — not
// localStorage, not sessionStorage. A script that manages to run on this page
// can read either of those; it cannot read a closure. The long-lived refresh
// token is never visible to JavaScript at all: it is an httpOnly cookie the
// browser attaches to the refresh call and nothing else.
//
// So a session survives a page reload by asking the server, not by having
// written the credential down somewhere.
// Leave VITE_ADMIN_API_URL EMPTY and the console calls its own origin, which
// the dev server then forwards to the API (see vite.config.ts) — one origin,
// no CORS, one port to forward. Set it to an absolute URL and the console calls
// that instead, which is what production does. One variable, no code change.
const API = (import.meta.env.VITE_ADMIN_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
const BASE = `${API}/${import.meta.env.VITE_ADMIN_PATH}`;

let accessToken: string | null = null;
let onLost: (() => void) | null = null;

export const setSessionLostHandler = (fn: () => void) => {
  onLost = fn;
};
export const setToken = (token: string | null) => {
  accessToken = token;
};
export const hasToken = () => accessToken !== null;

export interface ApiError {
  status: number;
  error: string;
  code?: string;
  retryAfter?: number;
}
export class ApiFailure extends Error {
  constructor(readonly info: ApiError) {
    super(info.error);
  }
}

/** Turn a response into either its body or a failure that SAYS SOMETHING.
 *
 *  The console API answers in JSON. Anything else means the request never got
 *  there — the dev server proxying to a backend that is not running, a gateway,
 *  a crash page. Reporting those as "something went wrong" is how five minutes
 *  of confusion starts, so they are named. */
async function answer<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = null;
  }
  if (body === null) {
    throw new ApiFailure({
      status: res.status,
      error:
        res.status >= 500
          ? `The console API is not answering (HTTP ${res.status}). Is it running? — npm run dev:admin`
          : `Unexpected reply from the console API (HTTP ${res.status})`,
      code: "NOT_JSON",
    });
  }
  if (res.ok) return body as T;
  throw new ApiFailure({
    status: res.status,
    error: typeof body.error === "string" ? body.error : `The console API refused that (HTTP ${res.status})`,
    code: typeof body.code === "string" ? body.code : undefined,
    retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined,
  });
}

/** fetch only rejects when the request never happened at all — no server, no
 *  network, a CORS policy that refused it outright. That is worth saying
 *  plainly rather than dressing up as a server error. */
function unreachable(): ApiFailure {
  return new ApiFailure({
    status: 0,
    error: `Cannot reach the console API at ${API || "this site"}. Is it running?`,
    code: "UNREACHABLE",
  });
}

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "X-Admin-Request": "1", ...(init.headers as Record<string, string>) };
  if (init.body) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(BASE + path, { ...init, headers, credentials: "include" });
}

/** Exchange the refresh cookie for a new access token. Used on boot (to resume
 *  a session across a reload) and once after any 401. */
export async function refresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/session/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "X-Admin-Request": "1" },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) return false;
    accessToken = body.accessToken;
    return true;
  } catch {
    return false;
  }
}

/** Fetch a binary body — recordings — with the same auth and the same one
 *  retry as `call`. Returned as a blob URL so the browser treats it as
 *  same-origin: the studio has to analyse the sound to show who is talking,
 *  and cross-origin audio cannot be analysed at all.
 *
 *  The caller owns the URL and must revokeObjectURL it. */
export async function fetchBlobUrl(path: string): Promise<string> {
  let res: Response;
  try {
    res = await raw(path);
    if (res.status === 401 && (await refresh())) res = await raw(path);
  } catch {
    throw unreachable();
  }
  if (!res.ok) {
    accessToken = res.status === 401 ? null : accessToken;
    if (res.status === 401) onLost?.();
    throw new ApiFailure({ status: res.status, error: `Could not load that recording (${res.status})` });
  }
  return URL.createObjectURL(await res.blob());
}

export async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await raw(path, init);
    // Exactly one retry: the access token is minutes long, so an expiry mid-use
    // is ordinary. A second failure means the session is genuinely gone.
    if (res.status === 401 && (await refresh())) res = await raw(path, init);
  } catch {
    throw unreachable();
  }
  if (res.status === 401) {
    accessToken = null;
    onLost?.();
  }
  return answer<T>(res);
}

/** Sign-in calls carry no token and must not trigger the refresh dance. */
export async function open<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Admin-Request": "1" },
      body: JSON.stringify(body),
    });
  } catch {
    throw unreachable();
  }
  return answer<T>(res);
}

export async function signOut(): Promise<void> {
  try {
    await call("/session/logout", { method: "POST" });
  } catch {
    /* signing out of an already-dead session is still signing out */
  }
  accessToken = null;
}
