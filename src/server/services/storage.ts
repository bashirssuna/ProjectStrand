import "server-only";
import { writeFile, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

// Local disk storage for development. In production (STORAGE_PROVIDER=s3) this
// module is swapped for signed S3 upload/download URLs; the interface is the same.
const DIR = path.join(process.cwd(), ".uploads");

function safe(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

export async function saveUpload(docId: string, fileName: string, buf: Buffer): Promise<string> {
  await mkdir(DIR, { recursive: true });
  const key = `${docId}__${safe(fileName)}`;
  await writeFile(path.join(DIR, key), buf);
  return key;
}

export async function readUpload(key: string): Promise<Buffer> {
  return readFile(path.join(DIR, path.basename(key)));
}

export async function deleteUpload(key: string): Promise<void> {
  try { await unlink(path.join(DIR, path.basename(key))); } catch { /* already gone */ }
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
