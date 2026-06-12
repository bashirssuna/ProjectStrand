import { getCurrentUser } from "@/server/auth";
import { can } from "@/server/policy";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ attId: string }> }) {
  const { attId } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const att = await one<{ projectId: string; name: string; storageKey: string | null; mime: string | null }>(
    `SELECT r.project_id AS "projectId", a.name, a.storage_key AS "storageKey", a.mime_type AS mime
     FROM requisition_attachment a JOIN requisition r ON r.id=a.requisition_id WHERE a.id=$1`, [attId]
  );
  if (!att) return new Response("Not found", { status: 404 });
  if (!(await can(att.projectId, "project.view"))) return new Response("Forbidden", { status: 403 });
  if (!att.storageKey) return new Response("No file stored", { status: 404 });

  try {
    const buf = await readUpload(att.storageKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": att.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${att.name.replace(/"/g, "")}"`,
      },
    });
  } catch {
    return new Response("File missing on disk", { status: 404 });
  }
}
