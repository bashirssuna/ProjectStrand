import { getCurrentUser } from "@/server/auth";
import { can } from "@/server/policy";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

// Serves a refund evidence / proof-of-payment file, scoped to project members.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const f = await one<{ projectId: string; name: string; storageKey: string | null; mime: string | null }>(
    `SELECT r.project_id AS "projectId", f.name, f.storage_key AS "storageKey", f.mime_type AS mime
     FROM refund_file f JOIN refund_request r ON r.id = f.refund_id WHERE f.id=$1`, [id]
  );
  if (!f) return new Response("Not found", { status: 404 });
  if (!(await can(f.projectId, "project.view"))) return new Response("Forbidden", { status: 403 });
  if (!f.storageKey) return new Response("No file stored", { status: 404 });

  try {
    const buf = await readUpload(f.storageKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": f.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${f.name.replace(/"/g, "")}"`,
      },
    });
  } catch (e) {
    // Only a genuinely missing blob is a 404; infrastructure errors must surface.
    if (e instanceof Error && e.message === "FILE_NOT_FOUND")
      return new Response("File not found in storage. It may have been uploaded before durable storage was enabled - please re-upload it.", { status: 404 });
    throw e;
  }
}
