import { getCurrentUser } from "@/server/auth";
import { can } from "@/server/policy";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const doc = await one<{ projectId: string; name: string; storageKey: string | null; mime: string | null }>(
    `SELECT project_id AS "projectId", name, storage_key AS "storageKey", mime_type AS mime
     FROM project_document WHERE id=$1`, [docId]
  );
  if (!doc) return new Response("Not found", { status: 404 });
  if (!(await can(doc.projectId, "project.view"))) return new Response("Forbidden", { status: 403 });
  if (!doc.storageKey) return new Response("No file stored for this record", { status: 404 });

  try {
    const buf = await readUpload(doc.storageKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": doc.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${doc.name.replace(/"/g, "")}"`,
      },
    });
  } catch (e) {
    // Only a genuinely missing blob is a 404; infrastructure errors must surface.
    if (e instanceof Error && e.message === "FILE_NOT_FOUND")
      return new Response("File not found in storage. It may have been uploaded before durable storage was enabled - please re-upload it.", { status: 404 });
    throw e;
  }
}
