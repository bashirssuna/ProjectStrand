import { getCurrentUser } from "@/server/auth";
import { canViewProjectFiles } from "@/server/policy";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

// Serves the proof-of-payment file attached to a disbursement voucher.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const v = await one<{ projectId: string | null; orgId: string | null; evidenceKey: string | null; evidenceName: string | null; evidenceMime: string | null }>(
    `SELECT project_id AS "projectId", org_id AS "orgId", evidence_key AS "evidenceKey", evidence_name AS "evidenceName", evidence_mime AS "evidenceMime"
     FROM payment_voucher WHERE id=$1`, [id]
  );
  if (!v) return new Response("Not found", { status: 404 });
  if (v.projectId) {
    if (!(await canViewProjectFiles(v.projectId))) return new Response("Forbidden", { status: 403 });
  } else {
    // standalone (institutional) voucher — org admins only
    const admin = v.orgId ? await one(
      `SELECT m.id FROM org_membership m JOIN role r ON r.id=m.role_id
       WHERE m.org_id=$1 AND m.user_id=$2 AND r.key='org_admin'`, [v.orgId, user.id]) : null;
    if (!admin) return new Response("Forbidden", { status: 403 });
  }
  if (!v.evidenceKey) return new Response("No evidence attached to this voucher", { status: 404 });

  try {
    const buf = await readUpload(v.evidenceKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": v.evidenceMime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${(v.evidenceName || "evidence").replace(/"/g, "")}"`,
      },
    });
  } catch (e) {
    // Only a genuinely missing blob is a 404; infrastructure errors must surface.
    if (e instanceof Error && e.message === "FILE_NOT_FOUND")
      return new Response("File not found in storage. It may have been uploaded before durable storage was enabled - please re-upload it.", { status: 404 });
    throw e;
  }
}
