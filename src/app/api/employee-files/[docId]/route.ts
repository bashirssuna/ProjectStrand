import { getCurrentUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

// Employee personal documents (CV, certificates). Access is restricted to:
//  - the employee who owns the document (their linked login), OR
//  - an organisation admin in the same org.
// Project documents are a completely separate API — these never mix.
export async function GET(_req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const doc = await one<{ name: string; storageKey: string | null; mime: string | null; ownerUserId: string | null; orgId: string }>(
    `SELECT ed.name, ed.storage_key AS "storageKey", ed.mime_type AS mime,
            e.user_id AS "ownerUserId", e.org_id AS "orgId"
     FROM employee_document ed JOIN employee e ON e.id=ed.employee_id WHERE ed.id=$1`, [docId]
  );
  if (!doc) return new Response("Not found", { status: 404 });

  const isOwner = doc.ownerUserId && doc.ownerUserId === user.id;
  let isOrgAdmin = false;
  if (!isOwner) {
    const org = await getUserOrg(user.id);
    isOrgAdmin = Boolean(org && org.id === doc.orgId && (org.isOrgAdmin || user.isSuperAdmin));
  }
  if (!isOwner && !isOrgAdmin) return new Response("Forbidden", { status: 403 });
  if (!doc.storageKey) return new Response("No file stored", { status: 404 });

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
