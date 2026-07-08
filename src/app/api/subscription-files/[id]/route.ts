import { getCurrentUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

// Proof-of-payment files attached to a subscription renewal request. Access:
//  - any platform super-admin (they review and approve renewals), OR
//  - an organisation admin of the organisation that owns the request.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const r = await one<{ orgId: string; key: string | null; name: string | null; mime: string | null }>(
    `SELECT org_id AS "orgId", payment_storage_key AS key, payment_file_name AS name, payment_mime AS mime
     FROM subscription_request WHERE id=$1`, [id]
  );
  if (!r) return new Response("Not found", { status: 404 });

  let allowed = user.isSuperAdmin;
  if (!allowed) {
    const org = await getUserOrg(user.id);
    allowed = Boolean(org && org.id === r.orgId && org.isOrgAdmin);
  }
  if (!allowed) return new Response("Forbidden", { status: 403 });
  if (!r.key) return new Response("No file stored", { status: 404 });

  try {
    const buf = await readUpload(r.key);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": r.mime || "application/octet-stream",
        "Content-Disposition": `inline; filename="${(r.name || "proof").replace(/"/g, "")}"`,
      },
    });
  } catch (e) {
    // Only a genuinely missing blob is a 404; infrastructure errors must surface.
    if (e instanceof Error && e.message === "FILE_NOT_FOUND")
      return new Response("File not found in storage. It may have been uploaded before durable storage was enabled - please re-upload it.", { status: 404 });
    throw e;
  }
}
