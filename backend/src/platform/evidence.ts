// Where evidence is kept: match replays now, voice recordings and archived
// logs later.
//
// Two backends behind one interface. In production it is a PRIVATE R2 bucket,
// separate from the one the asset packs live in — that one is world-readable
// and its token is handed to a build script, and neither of those may be true
// of evidence. On a development machine, where those credentials do not exist,
// it is a git-ignored directory, so the whole pipeline can be built and
// verified without a cloud account.
//
// The process says which one it is using at boot. Silently writing evidence to
// a container's temporary disk would be the worst possible failure here: it
// looks like it is working right up until the moment somebody needs the file.
import { promises as fs } from "node:fs";
import path from "node:path";
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";

export type EvidenceBackend = "r2" | "disk";

const conf = config.evidence;
export const evidenceBackend = (): EvidenceBackend =>
  conf.accountId && conf.bucket && conf.accessKeyId && conf.secretAccessKey ? "r2" : "disk";

let client: S3Client | null = null;
function s3(): S3Client {
  return (client ??= new S3Client({
    region: "auto",
    endpoint: `https://${conf.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: conf.accessKeyId, secretAccessKey: conf.secretAccessKey },
  }));
}

const onDisk = (key: string) => path.join(conf.localDir, key);

export async function putEvidence(key: string, body: Buffer, contentType: string): Promise<void> {
  if (evidenceBackend() === "r2") {
    await s3().send(
      new PutObjectCommand({ Bucket: conf.bucket, Key: key, Body: body, ContentType: contentType })
    );
    return;
  }
  const file = onDisk(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

export async function getEvidence(key: string): Promise<Buffer | null> {
  try {
    if (evidenceBackend() === "r2") {
      const res = await s3().send(new GetObjectCommand({ Bucket: conf.bucket, Key: key }));
      const chunks: Uint8Array[] = [];
      // The SDK hands back a web stream in Node 18+.
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    return await fs.readFile(onDisk(key));
  } catch {
    return null;
  }
}

/** A link the console can hand a browser, good for a minute. Nothing in the
 *  evidence bucket is ever public, so this is the only way anything gets out —
 *  and every use of it is audited by the caller. */
export async function evidenceUrl(key: string, seconds = 60): Promise<string | null> {
  if (evidenceBackend() !== "r2") return null;
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: conf.bucket, Key: key }), { expiresIn: seconds });
  } catch {
    return null;
  }
}

/** Everything under a prefix, with when it was written.
 *
 *  Used by the orphan sweep below. Bounded on purpose: this runs on a timer
 *  against a bucket that only grows, and an unbounded listing is a job that
 *  gets slower every day until it stops finishing. */
export async function listEvidence(prefix: string, limit = 500): Promise<{ key: string; at: number }[]> {
  if (evidenceBackend() === "r2") {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const out = await s3().send(new ListObjectsV2Command({ Bucket: conf.bucket, Prefix: prefix, MaxKeys: limit }));
    return (out.Contents ?? []).map((o) => ({ key: o.Key!, at: o.LastModified?.getTime() ?? 0 }));
  }
  const walk = async (dir: string): Promise<{ key: string; at: number }[]> => {
    const found: { key: string; at: number }[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(full)));
      else {
        const stat = await fs.stat(full).catch(() => null);
        found.push({ key: path.relative(conf.localDir, full), at: stat?.mtimeMs ?? 0 });
      }
    }
    return found;
  };
  return (await walk(path.join(conf.localDir, prefix))).slice(0, limit);
}

export async function deleteEvidence(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  if (evidenceBackend() === "r2") {
    // 1000 per request is the S3 limit; retention sweeps are the only caller
    // and they are chunked by the query's own limit long before that.
    await s3().send(
      new DeleteObjectsCommand({ Bucket: conf.bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } })
    );
    return keys.length;
  }
  let gone = 0;
  for (const key of keys) {
    try {
      await fs.unlink(onDisk(key));
      gone++;
    } catch {
      /* already gone is the same outcome */
    }
  }
  return gone;
}

export function describeEvidence(): string {
  return evidenceBackend() === "r2"
    ? `R2 bucket "${conf.bucket}"`
    : `local disk (${path.resolve(conf.localDir)}) — NOT durable`;
}
