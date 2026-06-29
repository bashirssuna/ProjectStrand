import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });
  const c = await one<{ cvKey: string | null; cvName: string | null }>(
    `SELECT cv_key AS "cvKey", cv_name AS "cvName" FROM candidate WHERE id=$1 AND org_id=$2`, [candidateId, org.id]);
  if (!c || !c.cvKey) return new Response("No CV on file", { status: 404 });
  try {
    const buf = await readUpload(c.cvKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${(c.cvName || "cv").replace(/"/g, "")}"`,
      },
    });
  } catch {
    return new Response("File missing on disk", { status: 404 });
  }
}
