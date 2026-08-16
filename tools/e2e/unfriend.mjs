#!/usr/bin/env node
// DEV ONLY — remove any friendship or pending request between two uids.
//
//   node tools/e2e/unfriend.mjs <uidA> <uidB>
//
// The add-friend test has to leave the database as it found it, or it passes
// once and then reports "no Add button" forever after — which is the correct
// answer for two people who are already friends, and therefore the most
// confusing possible failure.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = (p) => import(path.join(root, "backend", "node_modules", p));
const { config } = await req("dotenv/lib/main.js");
config({ path: path.join(root, "backend", ".env") });
const { default: pg } = await req("pg/lib/index.js");

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node tools/e2e/unfriend.mjs <uidA> <uidB>");
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rowCount } = await client.query(
  `delete from friendships f
   using users ra, users ad
   where ra.id = f.requester_id and ad.id = f.addressee_id
     and ((ra.uid = $1 and ad.uid = $2) or (ra.uid = $2 and ad.uid = $1))`,
  [a, b]
);
await client.end();
console.log(`removed ${rowCount} friendship row(s) between ${a} and ${b}`);
