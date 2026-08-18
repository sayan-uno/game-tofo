// DEV ONLY — makes a real console session for the browser test to use, and
// cleans it up afterwards.
//
//   tsx tools/e2e/admin-provision.mts provision   → prints JSON on stdout
//   tsx tools/e2e/admin-provision.mts cleanup <email>
//
// It creates a throwaway owner, enrols an authenticator through the REAL
// sign-in endpoint, and hands back the refresh cookie the server set. Nothing
// is faked: the browser test then resumes that session exactly as a returning
// admin would. The only stage skipped is Google's, which cannot be automated
// without putting a bypass in production code.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
for (const line of readFileSync(new URL("../../backend/.env", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { Client } = requireBackend("pg") as typeof import("pg");
const jwt = requireBackend("jsonwebtoken") as typeof import("jsonwebtoken");
const { generateSync } = requireBackend("otplib") as typeof import("otplib");
const { newEnrolment } = await import("../../backend/src/admin/totp.js");

const mode = process.argv[2];
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

if (mode === "cleanup") {
  const email = process.argv[3] ?? "";
  await db.query("delete from admin_audit where admin_email = $1", [email]);
  // The browser test applies a sanction to a real player by clicking through
  // the console; it must not outlive the run.
  await db.query("delete from sanctions where reason like 'e2e%'");
  // Admin activity rows carry no user id, so they need sweeping by address.
  await db.query("delete from event_log where data->>'email' = $1", [email]);
  await db.query("delete from admin_users where email = $1", [email]);
  await db.end();
  process.exit(0);
}

const PORT = process.env.ADMIN_PORT || "4031";
const BASE = `http://localhost:${PORT}/${process.env.ADMIN_PATH}`;
const email = `console-${Date.now()}@check.invalid`;

const enrolment = newEnrolment(email);
const { rows } = await db.query(
  "insert into admin_users (email, name, role, totp_secret_enc) values ($1,$2,'owner',$3) returning id",
  [email, "Console e2e", enrolment.secretEnc]
);
const pending = jwt.sign({ sub: rows[0].id, email, stage: "enrol" }, process.env.ADMIN_JWT_SECRET!, {
  audience: "admin-pending",
  issuer: "tofo-admin",
  expiresIn: "5m",
});

const res = await fetch(`${BASE}/session/enrol`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pending, code: generateSync({ secret: enrolment.secret }) }),
});
if (!res.ok) {
  console.error(`enrolment failed: HTTP ${res.status} ${await res.text()}`);
  await db.query("delete from admin_users where email = $1", [email]);
  await db.end();
  process.exit(1);
}
const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("tofo_admin_rt="));
if (!cookie) {
  console.error("no refresh cookie in the response");
  process.exit(1);
}
const value = cookie.split(";")[0].slice("tofo_admin_rt=".length);
const path = /path=([^;]+)/i.exec(cookie)?.[1] ?? "/";
// A real player for the browser test to open, so the profile is exercised
// against actual data rather than a fixture that cannot go stale.
const sample = await db.query(
  "select uid, coalesce(username, name) label from users where username is not null order by created_at limit 1"
);
await db.end();
console.log(
  JSON.stringify({
    email,
    cookieName: "tofo_admin_rt",
    cookieValue: value,
    cookiePath: path,
    port: PORT,
    samplePlayerUid: sample.rows[0]?.uid ?? null,
    samplePlayerLabel: sample.rows[0]?.label ?? null,
    // The browser test needs to answer a sudo prompt, which means computing a
    // real code. Handing over the secret it just generated is the only way to
    // drive the console the way a person does, with the confirmation intact.
    totpSecret: enrolment.secret,
  })
);
