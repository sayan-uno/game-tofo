#!/usr/bin/env node
// DEV ONLY — mint short-lived JWTs for existing users so a headless browser can
// reach the lobby without going through Google.
//
//   node tools/e2e/mint.mjs [count] > users.json
//
// Signs with the backend's own JWT_SECRET and the same claim shape the real
// login issues, so the server cannot tell these apart from a browser session.
// Refuses to run against anything but a local backend config: the point is to
// test this machine, and a token minted here should never reach production.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const req = (p) => import(path.join(root, "backend", "node_modules", p));

const { config } = await req("dotenv/lib/main.js");
config({ path: path.join(root, "backend", ".env") });

const { default: pg } = await req("pg/lib/index.js");
const { default: jwt } = await req("jsonwebtoken/index.js");

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error("backend/.env is missing JWT_SECRET or DATABASE_URL");
  process.exit(1);
}

const count = Number(process.argv[2] ?? 6);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  "select id, uid, username from users where username is not null order by created_at asc limit $1",
  [count]
);
await client.end();

if (rows.length === 0) {
  console.error("no users with a username — sign in once through the real lobby first");
  process.exit(1);
}

// Two hours: long enough for a full suite, short enough that a leaked token
// from a test run is worthless by the time anyone finds it.
console.log(
  JSON.stringify(
    rows.map((r) => ({
      uid: r.uid,
      name: r.username,
      token: jwt.sign({ userId: r.id, uid: r.uid, name: r.username }, process.env.JWT_SECRET, { expiresIn: "2h" }),
    }))
  )
);
