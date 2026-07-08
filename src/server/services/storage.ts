import "server-only";
import { writeFile, mkdir, readFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { q, one } from "@/server/db";

// Uploaded files are persisted in the DATABASE (file_blob, base64-encoded) so
// they survive redeploys and restarts on hosts with ephemeral disks (Render
// wipes the filesystem on every deploy). The .uploads directory is kept as a
// fast local read cache: reads try the disk first, fall back to the DB, and
// re-materialise the cache.
const DIR = path.join(process.cwd(), ".uploads");

function safe(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

// One-shot rescue sweep: files uploaded BEFORE durable storage existed live
// only on the (ephemeral) disk — copy every disk file into the DB the first
// time storage is touched after boot. Runs once per process; per-read
// backfills are deliberately avoided (a fire-and-forget insert can race a
// concurrent delete and resurrect removed bytes).
let sweepOnce: Promise<void> | null = null;
function ensureDiskSweep(): Promise<void> {
  sweepOnce ??= (async () => {
    let names: string[] = [];
    try { names = await readdir(DIR); } catch { return; } // no cache dir yet
    for (const name of names) {
      try {
        const buf = await readFile(path.join(DIR, name));
        await q(`INSERT INTO file_blob (key, data) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
          [name, buf.toString("base64")]);
      } catch { /* skip unreadable entries */ }
    }
  })().catch(() => {});
  return sweepOnce;
}

export async function saveUpload(docId: string, fileName: string, buf: Buffer): Promise<string> {
  await ensureDiskSweep();
  const key = `${docId}__${safe(fileName)}`;
  await q(
    `INSERT INTO file_blob (key, data) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
    [key, buf.toString("base64")]
  );
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(path.join(DIR, key), buf);
  } catch { /* cache only — the DB copy is authoritative */ }
  return key;
}

export async function readUpload(key: string): Promise<Buffer> {
  await ensureDiskSweep();
  const k = path.basename(key);
  const p = path.join(DIR, k);
  try {
    return await readFile(p);
  } catch { /* cache miss — fall through to the DB */ }
  const row = await one<{ data: string }>(`SELECT data FROM file_blob WHERE key=$1`, [k]);
  if (!row) throw new Error("FILE_NOT_FOUND");
  const buf = Buffer.from(row.data, "base64");
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(p, buf);
  } catch { /* cache write is best-effort */ }
  return buf;
}

export async function deleteUpload(key: string): Promise<void> {
  const k = path.basename(key);
  // DB row first (authoritative copy), then the cache file.
  try { await q(`DELETE FROM file_blob WHERE key=$1`, [k]); } catch { /* table may not exist yet on first boot */ }
  try { await unlink(path.join(DIR, k)); } catch { /* already gone */ }
}

export function mimeFor(fileName: string): string {
  const ext = (fileName.toLowerCase().split(".").pop() || "").trim();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    csv: "text/csv", txt: "text/plain", md: "text/markdown",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  };
  return map[ext] || "application/octet-stream";
}
