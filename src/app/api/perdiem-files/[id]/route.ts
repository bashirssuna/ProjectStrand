import { getCurrentUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

// Per-diem evidence (activity photos / docs). Restricted to organisation admins.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const ev = await one<{ name: string; storageKey: string | null; mime: string | null; orgId: string }>(
    `SELECT pe.name, pe.storage_key AS "storageKey", pe.mime_type AS mime, pc.org_id AS "orgId"
     FROM perdiem_evidence pe JOIN perdiem_claim pc ON pc.id=pe.claim_id WHERE pe.id=$1`, [id]
  );
  if (!ev) return new Response("Not found", { status: 404 });

  const org = await getUserOrg(user.id);
  const allowed = Boolean(org && org.id === ev.orgId && (org.isOrgAdmin || user.isSuperAdmin));
  if (!allowed) return new Response("Forbidden", { status: 403 });
  if (!ev.storageKey) return new Response("No file stored", { status: 404 });

  try {
    const buf = await readUpload(ev.storageKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": ev.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${ev.name.replace(/"/g, "")}"`,
      },
    });
  } catch (e) {
    // Only a genuinely missing blob is a 404; infrastructure errors must surface.
    if (e instanceof Error && e.message === "FILE_NOT_FOUND")
      return new Response("File not found in storage. It may have been uploaded before durable storage was enabled - please re-upload it.", { status: 404 });
    throw e;
  }
}
