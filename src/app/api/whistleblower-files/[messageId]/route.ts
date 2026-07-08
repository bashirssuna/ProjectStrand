import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });
  const m = await one<{ fileKey: string | null; fileName: string | null }>(
    `SELECT file_key AS "fileKey", file_name AS "fileName" FROM whistleblower_message WHERE id=$1 AND org_id=$2`, [messageId, org.id]);
  if (!m || !m.fileKey) return new Response("No file", { status: 404 });
  try {
    const buf = await readUpload(m.fileKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${(m.fileName || "attachment").replace(/"/g, "")}"`,
      },
    });
  } catch (e) {
    // Only a genuinely missing blob is a 404; infrastructure errors must surface.
    if (e instanceof Error && e.message === "FILE_NOT_FOUND")
      return new Response("File not found in storage. It may have been uploaded before durable storage was enabled - please re-upload it.", { status: 404 });
    throw e;
  }
}
