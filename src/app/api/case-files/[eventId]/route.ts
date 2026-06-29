import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });
  const ev = await one<{ fileKey: string | null; fileName: string | null }>(
    `SELECT file_key AS "fileKey", file_name AS "fileName" FROM er_case_event WHERE id=$1 AND org_id=$2`, [eventId, org.id]);
  if (!ev || !ev.fileKey) return new Response("No file", { status: 404 });
  try {
    const buf = await readUpload(ev.fileKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${(ev.fileName || "attachment").replace(/"/g, "")}"`,
      },
    });
  } catch {
    return new Response("File missing on disk", { status: 404 });
  }
}
